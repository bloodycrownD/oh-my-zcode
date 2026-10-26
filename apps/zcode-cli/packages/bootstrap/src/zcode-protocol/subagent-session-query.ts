import { Buffer } from "node:buffer";
import {
  createSessionId,
  SessionEventType,
  selectActiveConversationBranch,
  selectActiveConversationBranchIds,
  type BackgroundTaskInfo,
  type MessageId,
  type MessageWithParts,
  type SessionEvent,
  type SessionId,
  type SessionInfo,
  type SessionProjection,
  type SessionStorePort,
  type ToolPart,
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
} from "@zcode/contracts";
import type { ZCodeSessionEndedSubagent, ZCodeSessionRunningSubagent } from "@zcode/shared";

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "subagent"]);
const CANCELLATION_PATTERN = /abort|cancel|interrupt|stop/i;

interface SubagentCandidate {
  agentId?: string;
  childSessionId: string;
  runInBackground: boolean;
  output: Record<string, unknown> | null;
  part: ToolPart;
  subagentType: string;
  summary?: string;
  startedAt?: number;
  stoppedAt?: number;
  stoppedStatus?: "success" | "failed" | "cancelled";
  title: string;
}

interface SubagentEventRelation {
  agentId?: string;
  childSessionId?: string;
  description?: string;
  startedAt?: number;
  stoppedAt?: number;
  stoppedStatus?: "success" | "failed" | "cancelled";
  subagentType?: string;
  summary?: string;
}

interface SessionSubagentProjection {
  revision: number;
  running: ZCodeSessionRunningSubagent[];
  ended: ZCodeSessionEndedSubagent[];
}

interface ProjectSessionSubagentsInput {
  revision: number;
  parentSession: SessionInfo;
  messages: readonly MessageWithParts[];
  childSessionsById: ReadonlyMap<string, SessionInfo>;
  childMessagesById: ReadonlyMap<string, readonly MessageWithParts[]>;
  childProjectionsById: ReadonlyMap<string, SessionProjection>;
  parentProjection?: SessionProjection;
  parentEvents?: readonly SessionEvent[];
  /**
   * 已经算好的候选（fix-c19 的窄读路径）。给出时**不再**从 `messages` 重算：窄读拿不到
   * 正文，`messages` 会是空数组，重算会得到「没有子会话」。
   */
  candidates?: readonly SubagentCandidate[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringField(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = nonEmptyString(source[key]);
    if (value) return value;
  }
  return undefined;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function agentIdFromLaunchAcknowledgement(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return nonEmptyString(value.match(/(?:^|\n)agentId:\s*([^\s(]+)/)?.[1]);
}

function contentBlocksToText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((block) => nonEmptyString(asRecord(block).text))
    .filter((item): item is string => Boolean(item))
    .join("\n\n");
  return text || undefined;
}

function subagentEventRelations(
  events: readonly SessionEvent[] | undefined,
): ReadonlyMap<string, SubagentEventRelation> {
  const relations = new Map<string, SubagentEventRelation>();
  for (const event of events ?? []) {
    if (
      event.type !== SessionEventType.SubagentSpawned &&
      event.type !== SessionEventType.SubagentStopped
    ) {
      continue;
    }
    const payload = asRecord(event.payload);
    const parentToolCallId = stringField(payload, "parentToolCallId");
    if (!parentToolCallId) continue;
    const current = relations.get(parentToolCallId) ?? {};
    if (event.type === SessionEventType.SubagentSpawned) {
      relations.set(parentToolCallId, {
        ...current,
        agentId: stringField(payload, "agentId") ?? current.agentId,
        childSessionId: stringField(payload, "childSessionId") ?? current.childSessionId,
        description: stringField(payload, "description", "prompt") ?? current.description,
        startedAt: event.timestamp.getTime(),
        subagentType: stringField(payload, "agentType") ?? current.subagentType,
      });
      continue;
    }
    const status = stringField(payload, "status");
    relations.set(parentToolCallId, {
      ...current,
      agentId: stringField(payload, "agentId") ?? current.agentId,
      childSessionId: stringField(payload, "childSessionId") ?? current.childSessionId,
      stoppedAt: event.timestamp.getTime(),
      stoppedStatus:
        status === "cancelled" || status === "stopped"
          ? "cancelled"
          : status === "failed" || status === "error"
            ? "failed"
            : "success",
      summary:
        stringField(payload, "summaryText", "result", "error", "description") ?? current.summary,
    });
  }
  return relations;
}

function activeBranchMessages(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
): MessageWithParts[] {
  return selectActiveConversationBranch(messages, {
    branchCutAfterMessageId: session.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: session.revert?.createdMessageID,
    rewindKeptMessageIds: session.revert?.keptMessageIDs,
    rewindTargetMessageId: session.revert?.targetMessageID,
  });
}

function candidateFromToolPart(
  part: ToolPart,
  relation?: SubagentEventRelation,
): SubagentCandidate | null {
  if (!SUBAGENT_TOOL_NAMES.has(part.tool)) return null;
  const completedOutput =
    part.state.status === "completed" ? nonEmptyString(part.state.output) : undefined;
  const output = parseJsonObject(completedOutput);
  const input = asRecord(part.state.input);
  const stateMetadata = "metadata" in part.state ? asRecord(part.state.metadata) : {};
  const metadata = { ...asRecord(part.metadata), ...stateMetadata };
  const agentId =
    stringField(output ?? {}, "agentId") ??
    // 后台 Agent 的持久化 launch ACK 是纯文本，cold query 未携带
    // 临时 spawn event 时无法恢复 childSessionId，导致真实 running Agent 被整条跳过。
    // 标准 ACK 自带 agentId，按该稳定字段恢复，与 runtime 的 session id 规则对齐。
    agentIdFromLaunchAcknowledgement(completedOutput) ??
    stringField(metadata, "agentId") ??
    relation?.agentId;
  const childSessionId =
    stringField(output ?? {}, "childSessionId") ??
    stringField(metadata, "childSessionId") ??
    relation?.childSessionId ??
    (agentId ? createSessionId(`subagent_${agentId}`) : undefined);
  if (!childSessionId) return null;
  const title =
    stringField(output ?? {}, "description") ??
    stringField(input, "description") ??
    stringField(metadata, "description") ??
    relation?.description ??
    stringField(input, "prompt") ??
    "Subagent";
  return {
    childSessionId,
    runInBackground: input.run_in_background === true,
    part,
    output,
    agentId: agentId ?? part.callID,
    subagentType:
      stringField(output ?? {}, "agentType") ??
      stringField(metadata, "agentType") ??
      relation?.subagentType ??
      stringField(input, "subagent_type", "agent", "agentType") ??
      "subagent",
    title,
    summary:
      contentBlocksToText(output?.content) ??
      stringField(output ?? {}, "result", "summary") ??
      (part.state.status === "error" ? nonEmptyString(part.state.error) : undefined) ??
      relation?.summary,
    ...(relation?.startedAt !== undefined ? { startedAt: relation.startedAt } : {}),
    ...(relation?.stoppedAt !== undefined ? { stoppedAt: relation.stoppedAt } : {}),
    ...(relation?.stoppedStatus ? { stoppedStatus: relation.stoppedStatus } : {}),
  };
}

function candidatesFromToolParts(
  parts: Iterable<ToolPart>,
  relations: ReadonlyMap<string, SubagentEventRelation>,
): SubagentCandidate[] {
  const candidates = new Map<string, SubagentCandidate>();
  for (const part of parts) {
    const candidate = candidateFromToolPart(part, relations.get(part.callID));
    if (candidate) candidates.set(candidate.childSessionId, candidate);
  }
  return [...candidates.values()];
}

function collectCandidates(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
  parentEvents?: readonly SessionEvent[],
): SubagentCandidate[] {
  const relations = subagentEventRelations(parentEvents);
  const parts: ToolPart[] = [];
  for (const message of activeBranchMessages(session, messages)) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      parts.push(part);
    }
  }
  return candidatesFromToolParts(parts, relations);
}

/**
 * 子会话候选的**窄读**（fix-c19）：不读父会话全文，只读「Agent 类 tool part」。
 *
 * 旧实现 `collectCandidates(parentSession, await store.messages(...))` 为拿这几个候选读了
 * 整条 active 分支（长会话 3012 message / 29MB 正文，实测 ~490ms，占窗口化首屏 mergeMs
 * 的 87%）。候选的**全部输入**就是 `Agent` / `Task` / `subagent` 三类 tool part 的
 * `state`（input / output / metadata）——正文一个字都不需要。
 *
 * 两段读：
 *   ① `listSessionMessageIndex`（只读排序键，O(n) 但每行只有几列）+ 与全量路径**同一个**
 *      裁断实现（`selectActiveConversationBranchIds`）得到 active id 序；
 *   ② `readActiveBranchToolParts`（SQL 侧按 tool 名过滤，只解码命中的 part）。
 *
 * 端口缺席（旧宿主 / 内存 store）返回 `null`，调用方退回全量 `messages()`：窄读是优化，
 * 不是语义前提（与 `readChildOutcomeMessages` 同一纪律）。
 */
export async function readSubagentCandidatesNarrow(
  store: Pick<SessionStorePort, "readActiveBranchToolParts" | "listSessionMessageIndex">,
  session: SessionInfo,
  parentEvents?: readonly SessionEvent[],
): Promise<SubagentCandidate[] | null> {
  if (!store.readActiveBranchToolParts || !store.listSessionMessageIndex) return null;
  const index = await store.listSessionMessageIndex({ sessionID: session.id });
  const activeMessageIds = selectActiveConversationBranchIds(
    index.map((entry) => String(entry.id)),
    {
      branchCutAfterMessageId: session.revert?.branchCutAfterMessageID,
      rewindCreatedMessageId: session.revert?.createdMessageID,
      rewindKeptMessageIds: session.revert?.keptMessageIDs,
      rewindTargetMessageId: session.revert?.targetMessageID,
    },
  );
  const entries = await store.readActiveBranchToolParts({
    sessionID: session.id,
    toolNames: [...SUBAGENT_TOOL_NAMES],
    activeMessageIds: activeMessageIds as MessageId[],
  });
  return candidatesFromToolParts(
    entries.map((entry) => entry.part),
    subagentEventRelations(parentEvents),
  );
}

/**
 * 子会话候选的**唯一决策点**：先复用 resume 给的内存正文，再试窄读，最后才退全量。
 *
 * 抽出来是为了让「走哪条路」可被单测钉住（`listSessionSubagents` 的接线只是调用它）：
 *   - `persisted`：resume 已经把正文读进内存（live 会话 / 有 historyMode:"full" 的旧宿主）；
 *   - `narrow`：消息索引 + 按 tool 名的 part 读（view-only 首屏的主路径，省一次全文读）；
 *   - `full`：端口缺席，退回 `messages()`（窄读是优化，不是语义前提）。
 *
 * `messages` 只在 `persisted` / `full` 下非空；窄读路径给空数组——调用方必须把
 * `candidates` 一起交给 `projectSessionSubagents`，否则它会按空正文重算出「没有子会话」。
 */
export async function resolveSubagentCandidates(
  store: Pick<
    SessionStorePort,
    "messages" | "readActiveBranchToolParts" | "listSessionMessageIndex"
  >,
  session: SessionInfo,
  options: {
    persistedMessages?: readonly MessageWithParts[];
    parentEvents?: readonly SessionEvent[];
  } = {},
): Promise<{
  candidates: readonly SubagentCandidate[];
  messages: readonly MessageWithParts[];
  source: "persisted" | "narrow" | "full";
}> {
  if (options.persistedMessages) {
    return {
      candidates: collectCandidates(session, options.persistedMessages, options.parentEvents),
      messages: options.persistedMessages,
      source: "persisted",
    };
  }
  const narrow = await readSubagentCandidatesNarrow(store, session, options.parentEvents).catch(
    () => null,
  );
  if (narrow !== null) {
    return { candidates: narrow, messages: [], source: "narrow" };
  }
  const messages = await store.messages({ sessionID: session.id });
  return {
    candidates: collectCandidates(session, messages, options.parentEvents),
    messages,
    source: "full",
  };
}

export function collectSubagentChildSessionIds(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
  parentEvents?: readonly SessionEvent[],
): string[] {
  return collectCandidates(session, messages, parentEvents).map(
    (candidate) => candidate.childSessionId,
  );
}

/**
 * 候选本体（`childSessionId` 之外还带 title/agentId/part 等投影要用的字段）。
 *
 * 导出它是为了让窄读与全量读汇到**同一份**候选判定：`listSessionSubagents` 先算一次，
 * 再交给 `projectSessionSubagents({ candidates })`，避免它按空 `messages` 重算出「没有子会话」。
 */
export function collectSubagentCandidates(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
  parentEvents?: readonly SessionEvent[],
): SubagentCandidate[] {
  return collectCandidates(session, messages, parentEvents);
}

function lastChildOutcome(messages: readonly MessageWithParts[] | undefined): {
  endedAt?: number;
  status?: "success" | "failed" | "cancelled";
  summary?: string;
} {
  if (!messages || messages.length === 0) return {};
  const assistantMessages = messages.filter((message) => message.info.role === "assistant");
  const last = assistantMessages.at(-1);
  if (!last || last.info.role !== "assistant") return {};
  // stream recovery 作废的半截 assistant 带 error 落盘，但子会话紧接着会从锚点
  // 重发；它是最后一条只说明恢复仍在进行或进程已退出，都不是「子会话失败」的终态。
  if (last.info.error && last.info.error.name === STREAM_RECOVERY_DISCARDED_ERROR_NAME) {
    return {};
  }
  const text = last.parts
    .flatMap((part) => (part.type === "text" && part.ignored !== true ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n\n");
  const errorName = last.info.error?.name;
  const errorSummary = last.info.error
    ? (stringField(last.info.error.data ?? {}, "message", "error", "detail") ?? errorName)
    : undefined;
  const hasToolRound = last.parts.some((part) => part.type === "tool");
  return {
    ...(last.info.time.completed ? { endedAt: last.info.time.completed } : {}),
    ...(text || errorSummary ? { summary: text || errorSummary } : {}),
    ...(errorName
      ? { status: CANCELLATION_PATTERN.test(errorName) ? "cancelled" : "failed" }
      : // assistant 发出 tool call 后，该 model step 也会写 completed/finish；
        // 但 child session 仍在执行 Bash 等工具，不能把“本轮结束”当成“子会话终态”。
        // 只有不含 tool part 的最终 assistant message 才能提供成功 outcome。
        !hasToolRound && (last.info.time.completed || last.info.finish)
        ? { status: "success" }
        : {}),
  };
}

function findBackgroundTask(
  projection: SessionProjection | undefined,
  candidate: SubagentCandidate,
): BackgroundTaskInfo | undefined {
  return projection?.backgroundTasks.find(
    (task) =>
      task.taskKind === "subagent" &&
      (task.childSessionId === candidate.childSessionId ||
        task.toolCallId === candidate.part.callID ||
        task.taskId === candidate.agentId),
  );
}

function runningStatus(input: {
  background?: BackgroundTaskInfo;
  candidate: SubagentCandidate;
  childOutcome: ReturnType<typeof lastChildOutcome>;
  childProjection?: SessionProjection;
  parentProjection?: SessionProjection;
}): ZCodeSessionRunningSubagent["status"] | undefined {
  if (input.background?.status === "running") {
    return input.background.blocked ? "blocked" : "running";
  }
  if (input.childProjection?.status === "waiting") return "waiting";
  if (input.childProjection?.status === "running") return "running";
  // async Agent 的父 tool part 在 launch ACK 后立即标成 completed，
  // partial parent projection 又可能暂时不带仍运行的 background task。此时仅按
  // tool part 会把 child 误判为 ended，并在 cold seed 时清空 V4 running 行。
  // child 还没有终态输出、spawn relation 也没有 stop 时，background input 本身
  // 是可恢复的 running 事实；真实终态仍由 background/child projection/outcome 优先。
  if (
    input.candidate.runInBackground &&
    input.background === undefined &&
    input.childProjection === undefined &&
    input.candidate.stoppedStatus === undefined &&
    input.childOutcome.status === undefined
  ) {
    return "running";
  }
  if (
    input.parentProjection?.activeToolCalls.some(
      (tool) =>
        tool.toolCallId === input.candidate.part.callID &&
        (tool.status === "pending" || tool.status === "running"),
    )
  ) {
    return "running";
  }
  return input.parentProjection &&
    (input.candidate.part.state.status === "pending" ||
      input.candidate.part.state.status === "running")
    ? "running"
    : undefined;
}

function terminalBackgroundStatus(
  task: BackgroundTaskInfo | undefined,
): ZCodeSessionEndedSubagent["status"] | undefined {
  switch (task?.status) {
    case "completed":
      return "success";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "timed_out":
    case "spawn_error":
      return "failed";
    case "lost":
      return "lost";
    default:
      return undefined;
  }
}

function endedStatus(input: {
  background?: BackgroundTaskInfo;
  candidate: SubagentCandidate;
  childOutcome: ReturnType<typeof lastChildOutcome>;
  childProjection?: SessionProjection;
}): ZCodeSessionEndedSubagent["status"] {
  const backgroundStatus = terminalBackgroundStatus(input.background);
  if (backgroundStatus) return backgroundStatus;
  if (input.childProjection?.status === "error") return "failed";
  if (input.childProjection?.status === "completed") return "success";
  if (input.candidate.part.state.status === "error") {
    return CANCELLATION_PATTERN.test(input.candidate.part.state.error) ? "cancelled" : "failed";
  }
  if (input.candidate.stoppedStatus) return input.candidate.stoppedStatus;
  const outputStatus = stringField(input.candidate.output ?? {}, "status");
  if (outputStatus === "cancelled" || outputStatus === "stopped") return "cancelled";
  if (outputStatus === "failed" || outputStatus === "error") return "failed";
  if (outputStatus === "async_launched") return input.childOutcome.status ?? "lost";
  if (input.candidate.part.state.status === "completed") return "success";
  return input.childOutcome.status ?? "lost";
}

function startedAt(
  candidate: SubagentCandidate,
  background?: BackgroundTaskInfo,
): number | undefined {
  if (background?.startedAt) return background.startedAt.getTime();
  if (candidate.startedAt !== undefined) return candidate.startedAt;
  return "time" in candidate.part.state ? candidate.part.state.time.start : undefined;
}

/**
 * 子会话「终态输出」的**窄读**：只取最后一条 assistant 消息（`lastChildOutcome` 的唯一输入）。
 *
 * 为什么不是 `store.messages({sessionID: child})`：一个长会话的下级 Agent 数量与每个 child
 * 的轮次都会增长（实测 152 个 child / 15.8k 消息 / 89k part），全量读 = 152 次
 * message+part 全表扫（实测 2.3~3.6s），而 `lastChildOutcome` 只消费
 * `assistantMessages.at(-1)` 一条。冷开首屏为这份「用不上的尾部」付了整个会话的正文读。
 *
 * 读法：消息索引与 `messages()` 同一权威序 → 从尾部向前找第一条 role=assistant 的消息 →
 * `messageWithParts` 单条读回。`lastChildOutcome([message])` 与
 * `lastChildOutcome(全部消息)` 逐值相同（它只取最后一条 assistant）。索引/单条读端口缺席
 * （旧宿主、内存 store）时退回全量 `messages()`：窄读是优化，不是语义前提。
 */
export async function readChildOutcomeMessages(
  store: Pick<SessionStorePort, "messages" | "messageWithParts" | "listSessionMessageIndex">,
  sessionID: SessionId,
): Promise<MessageWithParts[]> {
  if (!store.listSessionMessageIndex || !store.messageWithParts) {
    return await store.messages({ sessionID });
  }
  const index = await store.listSessionMessageIndex({ sessionID });
  // 从尾部向前扫：终态输出几乎总在最后一条，退到 file/step 尾巴的概率很低。
  for (let position = index.length - 1; position >= 0; position -= 1) {
    const messageId = index[position]?.id;
    if (messageId === undefined) continue;
    const message = await store.messageWithParts({ sessionID, messageID: messageId });
    if (message?.info.role === "assistant") return [message];
  }
  return [];
}

export function projectSessionSubagents(
  input: ProjectSessionSubagentsInput,
): SessionSubagentProjection {
  const running: ZCodeSessionRunningSubagent[] = [];
  const ended: ZCodeSessionEndedSubagent[] = [];
  const candidates =
    input.candidates ?? collectCandidates(input.parentSession, input.messages, input.parentEvents);
  for (const candidate of candidates) {
    const childSession = input.childSessionsById.get(candidate.childSessionId);
    if (!childSession || childSession.taskType !== "subagent_child") continue;
    const childProjection = input.childProjectionsById.get(candidate.childSessionId);
    const background = findBackgroundTask(input.parentProjection, candidate);
    const childOutcome = lastChildOutcome(input.childMessagesById.get(candidate.childSessionId));
    const liveStatus = runningStatus({
      background,
      candidate,
      childOutcome,
      childProjection,
      parentProjection: input.parentProjection,
    });
    const common = {
      childSessionId: candidate.childSessionId,
      ...(candidate.agentId ? { agentId: candidate.agentId } : {}),
      toolCallId: candidate.part.callID,
      subagentType: candidate.subagentType,
      title: candidate.title,
      ...(startedAt(candidate, background) !== undefined
        ? { startedAt: startedAt(candidate, background) }
        : {}),
    };
    if (liveStatus) {
      running.push({ ...common, status: liveStatus });
      continue;
    }
    const stateEndedAt =
      "time" in candidate.part.state && "end" in candidate.part.state.time
        ? candidate.part.state.time.end
        : undefined;
    ended.push({
      ...common,
      status: endedStatus({ background, candidate, childOutcome, childProjection }),
      ...(candidate.summary || childOutcome.summary
        ? { summary: candidate.summary ?? childOutcome.summary }
        : {}),
      endedAt:
        background?.completedAt?.getTime() ??
        candidate.stoppedAt ??
        stateEndedAt ??
        childOutcome.endedAt ??
        childSession.time.updated,
    });
  }
  running.sort(
    (left, right) =>
      (right.startedAt ?? 0) - (left.startedAt ?? 0) ||
      right.childSessionId.localeCompare(left.childSessionId),
  );
  ended.sort(
    (left, right) =>
      (right.endedAt ?? 0) - (left.endedAt ?? 0) ||
      right.childSessionId.localeCompare(left.childSessionId),
  );
  return { revision: input.revision, running, ended };
}

function encodeCursor(item: ZCodeSessionEndedSubagent): string {
  return Buffer.from(
    JSON.stringify({ childSessionId: item.childSessionId, endedAt: item.endedAt ?? 0 }),
  ).toString("base64url");
}

function decodeCursor(cursor: string | undefined): {
  childSessionId: string;
  endedAt: number;
} | null {
  if (!cursor) return null;
  try {
    const value = asRecord(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown,
    );
    const childSessionId = nonEmptyString(value.childSessionId);
    const endedAt = value.endedAt;
    return childSessionId && typeof endedAt === "number" ? { childSessionId, endedAt } : null;
  } catch {
    return null;
  }
}

export function paginateEndedSubagents(
  ended: readonly ZCodeSessionEndedSubagent[],
  options: { cursor?: string; limit: number },
): { items: ZCodeSessionEndedSubagent[]; nextCursor?: string } {
  const cursor = decodeCursor(options.cursor);
  const start = cursor
    ? ended.findIndex(
        (item) =>
          (item.endedAt ?? 0) < cursor.endedAt ||
          ((item.endedAt ?? 0) === cursor.endedAt &&
            item.childSessionId.localeCompare(cursor.childSessionId) < 0),
      )
    : 0;
  if (start < 0) return { items: [] };
  const items = ended.slice(start, start + options.limit);
  const last = items.at(-1);
  return {
    items,
    ...(last && start + items.length < ended.length ? { nextCursor: encodeCursor(last) } : {}),
  };
}
