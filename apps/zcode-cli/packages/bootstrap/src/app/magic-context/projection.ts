/**
 * 双向投影：ZCode `RuntimeMessageEntry[]` ↔ magic-context `MessageLike[]`，外加调度器
 * 的键名适配（snake_case `MagicContextConfig` → 包内 camelCase `SchedulerConfig`）。
 *
 * 从 `../magic-context-turn-transform.ts` 拆出（Step 3 / phase-facade，零行为）。
 * 为什么单独成文件：反投影是 **ZCode 侧的知识**（ZCode 用 `kind:"attachment"` 与独立的
 * `role:"tool"` entry，而 magic-context/OpenCode 把 tool 结果挂在一条 user 消息的 part
 * 上），所以它必须写在宿主侧；且这一层是纯函数（无 IO、无模块级状态），可以脱离 DB
 * 单独验收。`isUnchanged` 是 `rebuildEntry` 的**严格镜像**，两者必须成对维护。
 */

import type { RuntimeAttachmentEntry, RuntimeMessageEntry } from "@zcode/core";
import type { ModelMessageContent, ModelMessageContentBlock } from "@zcode/contracts";

/** 从 entry 联合反推 metadata 类型（core 未从 barrel 导出该接口，不为此扩公共面）。 */
type EntryMetadata = NonNullable<RuntimeMessageEntry["metadata"]>;
import {
  createScheduler as createPackageScheduler,
  type MagicContextConfig,
  type MessageLike,
  type Scheduler,
} from "@zcode/magic-context";

// ─────────────────────────────────────────────────────────────────────────────
// 反投影：MessageLike[] → RuntimeMessageEntry[]
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface ToolPart {
  type: "tool";
  callID?: unknown;
  tool?: unknown;
  providerExecuted?: unknown;
  state?: { status?: unknown; input?: unknown; output?: unknown; error?: unknown };
}

function isToolPart(part: unknown): part is ToolPart {
  return isRecord(part) && part.type === "tool";
}

/** 结果态的 tool part 过滤器——必须带类型谓词，否则 filter 只会给出 `unknown[]`。 */
function isCompletedToolPart(part: unknown): part is ToolPart {
  return isToolPart(part) && (part.state?.status === "completed" || part.state?.status === "error");
}

function isAttachment(entry: RuntimeMessageEntry): entry is RuntimeAttachmentEntry {
  return entry.kind === "attachment";
}

function textOf(parts: readonly unknown[]): string {
  return parts
    .filter(isRecord)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n\n");
}

/** m[0] 注入的壁画 part 形状（上游 inject-compartments.ts `prependM0M1Messages`）：
 *  `{ type: "file", mime: "image/png", url: dataUrl, synthetic: true }`。 */
function isSyntheticImageFilePart(
  part: Record<string, unknown>,
): part is Record<string, unknown> & { mime: string; url: string } {
  return (
    part.type === "file" &&
    typeof part.mime === "string" &&
    part.mime.startsWith("image/") &&
    typeof part.url === "string" &&
    part.url.length > 0
  );
}

/**
 * FORK（bugfix-batch-20261011 / Step 15，D5）：从 synthetic head 的 parts 里提取
 * **图片**块，转成 provider-neutral 的 {@link ModelImageContentBlock}。
 *
 * 为什么需要它：mural 渲染链（本批 D5）把项目记忆壁画渲染成 PNG data URL，由包内
 * `inject-compartments` 以上述 `file` part 注入 m[0] head。反投影原来只取 text
 * part，图片会被静默丢掉——「渲染了但模型永远看不到」。这里把 image part 提出来
 * 放进 attachment 的 `mediaBlocks`（core `RuntimeAttachmentEntry` 的本批新增字段），
 * 由 core 的 provider 请求投影追加进 user message content。
 *
 * 无图片 part 时返回 undefined：attachment 形状与改动前逐字节一致（可选字段缺席），
 * 所有既有比较/落盘路径零变化。
 */
function mediaBlocksOf(parts: readonly unknown[]): ModelMessageContentBlock[] | undefined {
  const blocks: ModelMessageContentBlock[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (isSyntheticImageFilePart(part)) {
      blocks.push({ type: "image", mediaType: part.mime, dataUrl: part.url });
      continue;
    }
    // 直接的 image part（mediaType + dataUrl）同样接受：块联合是封闭的，多认一种
    // 已注册形状不改变「未知 type 惰性忽略」的透传语义。
    if (
      part.type === "image" &&
      typeof part.mediaType === "string" &&
      typeof part.dataUrl === "string" &&
      part.dataUrl.length > 0
    ) {
      blocks.push({ type: "image", mediaType: part.mediaType, dataUrl: part.dataUrl });
    }
  }
  return blocks.length > 0 ? blocks : undefined;
}

function contentBlocksOf(parts: readonly unknown[]): ModelMessageContentBlock[] {
  const blocks: ModelMessageContentBlock[] = [];
  for (const part of parts) {
    if (!isRecord(part) || part.type === "tool") continue;
    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "reasoning" && typeof part.text === "string") {
      blocks.push({
        type: "reasoning",
        text: part.text,
        ...(isRecord(part.providerOptions)
          ? { providerOptions: part.providerOptions as Record<string, unknown> }
          : {}),
      });
      continue;
    }
    // image / video / file / resource_link / 未来新增的块：正投影是 `{...block}`
    // 拷贝，这里再拷一次即回到原值。ZCode 的块联合是封闭的，所以未知 `type`
    // 必须经 `unknown` 过渡——magic-context 的透传语义（"按 type 收窄，未知即惰性"）
    // 只有这样才能表达。
    blocks.push({ ...part } as unknown as ModelMessageContentBlock);
  }
  return blocks;
}

function normalizeContent(content: ModelMessageContent): ModelMessageContentBlock[] {
  const blocks =
    typeof content === "string"
      ? content.length > 0
        ? [{ type: "text" as const, text: content }]
        : []
      : [...content];
  // 空 text block 与「没有 content」在 wire 上等价：正投影把 `""` 变成
  // `[{type:"text",text:""}]`，不归一化就会把每一条空回复误判成"被改写"。
  return blocks.filter((block) => !(block.type === "text" && block.text.length === 0));
}

function sameContent(left: ModelMessageContent, right: ModelMessageContent): boolean {
  const leftBlocks = normalizeContent(left);
  const rightBlocks = normalizeContent(right);
  if (leftBlocks.length !== rightBlocks.length) return false;
  return leftBlocks.every((block, index) => {
    const other = rightBlocks[index];
    return other !== undefined && JSON.stringify(block) === JSON.stringify(other);
  });
}

function toolOutputOf(part: ToolPart): string {
  if (typeof part.state?.output === "string") return part.state.output;
  return typeof part.state?.error === "string" ? part.state.error : "";
}

/**
 * 重建后的消息与原始 entry 等价时**复用原始 entry 对象**。
 *
 * 这是 m[0]/m[1] 与 cache 前缀稳定性的关键：transform 没碰过的消息必须以原对象
 * （连同 `metadata.source` / `tokens` / `cacheControl`）进入双投影，否则每一 pass
 * 都会因对象身份变化而抖动。
 *
 * 这里**不复用**包里的 `projectMessageUnchanged` 作为判定：它对带 toolCalls 的
 * assistant 一律返回 false（于是每 pass 都重建、丢掉 metadata 与 cacheControl 落点），
 * 又对纯文本 user 消息只看 role、不看内容（于是 §N§ 打标会被静默丢弃）。本函数是
 * `rebuildEntry` 的严格镜像：任何"重建后与原消息不同"的情形都判定为已改动。
 */
function isUnchanged(message: MessageLike, original: RuntimeMessageEntry): boolean {
  // FORK（Step 15 / D5）：attachment 的正投影是「text part + 每条 mediaBlock 一个
  // synthetic part」（包侧 projectRuntimeEntry 同款）。计数规则与包侧
  // `projectMessageUnchanged` 保持一致：1 个 text + N 个 media part 计入未改动。
  // 纯文本附件（N=0）仍是 parts.length === 1，与改动前逐字节等价。
  if (isAttachment(original)) {
    const expectedMediaCount = original.mediaBlocks?.length ?? 0;
    return (
      message.parts.length === 1 + expectedMediaCount &&
      isRecord(message.parts[0]) &&
      message.parts[0]!.type === "text" &&
      message.parts.every((part, index) => index === 0 || !isRecord(part) || part.type !== "text")
    );
  }
  const source = original.message;
  const parts = message.parts;
  const toolResults = parts.filter(isCompletedToolPart);

  // ZCode 的 tool 结果是独立 entry；正投影把它折成一条 user 消息上的 tool part。
  if (source.role === "tool") {
    if (toolResults.length !== 1 || message.info.role !== "user") return false;
    const only = toolResults[0]!;
    if ((only.state?.status === "error") !== (source.isError === true)) return false;
    if (only.callID !== source.toolCallId || only.tool !== (source.toolName ?? "")) return false;
    return sameContent(toolOutputOf(only), source.content);
  }

  if (message.info.role !== source.role) return false;
  if (parts.some(isToolPart) && source.role !== "assistant") return false;
  if (!sameContent(contentBlocksOf(parts), source.content)) return false;

  const calls = source.role === "assistant" ? parts.filter(isToolPart) : [];
  const expected = source.toolCalls ?? [];
  if (calls.length !== expected.length) return false;
  return calls.every((call, index) => {
    const want = expected[index];
    return (
      want !== undefined &&
      call.callID === want.id &&
      call.tool === want.name &&
      JSON.stringify(call.state?.input) === JSON.stringify(want.input)
    );
  });
}

/**
 * 剥离重建条目继承来的「注入身份」元数据（幽灵消息事故 2026-10-23）。
 *
 * `inputPresentation` 的语义是「这段内容就是被准入的那条输入，request 组装要按
 * mid-turn 注入包装（"The user sent a new message"）」；重建条目内容已与被准入
 * 输入不同（isUnchanged 为 false 才走重建），继承即伪造注入身份——事故里一段
 * assistant 旁白借此被当作用户新消息注入运行中的轮。
 *
 * `source`（real_user 气泡身份）**保留**：§N§ 打标（tag-messages）是日常合法改写，
 * user 气泡在 provider projection 的身份与 cache 锚定依赖它（既有测试 #4）。
 *
 * FORK（spec phase-identity-guard / Step 8，取自 `ff8b4522`）：上游同形实现就在
 * `magic-context-turn-transform.ts` 的 `rebuildEntry` 前，拆分后落本文件。升级
 * magic-context / 重新同步上游时，把 `ff8b4522` 的这两道守卫（本函数 +
 * `originalPairsWithMessage`）按同形重新贴回 `rebuildEntry` 的 metadata 整拷行与
 * `projectMagicContextEntries` 的 original 查找点；语义一字不动（单参、不引入
 * `roleChanged`）。
 */
function sanitizeRebuiltMetadata(metadata: EntryMetadata | undefined): EntryMetadata | undefined {
  if (metadata === undefined || metadata.inputPresentation === undefined) return metadata;
  const next: EntryMetadata = { ...metadata };
  delete next.inputPresentation;
  return next;
}

/**
 * 配对守卫（幽灵消息事故 2026-10-23，取自 `ff8b4522`）：只有 role 一致的 original
 * 才允许作为重建模板/原样保留的依据。MC 压缩重排会让 `originals`（按消息 id 查找
 * 的原 entry 映射）与 transform 输出错位，把「真实 user_steer 输入」的元数据嫁接到
 * 无关内容上（实测：一段 assistant 旁白被包装成 "The user sent a new message" 注入）。
 *
 * ZCode 的 tool entry 在 MC 投影里是带 tool part 的 user 消息（见 `isUnchanged` 的
 * tool 分支），这一对组合同样合法。断配对后**仍调用** `rebuildEntry(message, undefined)`：
 * 不调用等于把条目直接丢掉（内容蒸发），正确语义是「重建、但不带模板」。
 */
function originalPairsWithMessage(original: RuntimeMessageEntry, message: MessageLike): boolean {
  if (isAttachment(original)) return false;
  const originalRole = original.message.role;
  const messageRole = message.info.role ?? "user";
  if (originalRole === messageRole) return true;
  return originalRole === "tool" && messageRole === "user";
}

function rebuildEntry(
  message: MessageLike,
  original: RuntimeMessageEntry | undefined,
): RuntimeMessageEntry {
  const parts = message.parts;
  // FORK（spec phase-identity-guard / Step 8）：重建条目按定义与「被准入的那条输入」
  // 不再是同一字节（isUnchanged 为 false 才走重建），不得继承输入身份元数据
  // （inputPresentation）。这类元数据一旦被嫁接到无关内容上，request 组装
  // （projectIncomingMessageEntries）会把该内容包装成 "The user sent a new message"
  // 的真实用户注入。原样保留的条目（isUnchanged 通过）不经过这里，身份链不受影响。
  const metadata = sanitizeRebuiltMetadata(
    original && !isAttachment(original) ? original.metadata : undefined,
  );
  const toolResults = parts.filter(isCompletedToolPart);
  // magic-context 把 tool 结果挂在一条 user 消息上，ZCode 建模为独立
  // `role:"tool"` entry —— 按 OpenCode 的 `toModelMessages` 规则拆回去。
  if (toolResults.length > 0 && message.info.role === "user") {
    const only = toolResults[0]!;
    const failed = only.state?.status === "error";
    return {
      message: {
        role: "tool",
        content: toolOutputOf(only),
        toolCallId: typeof only.callID === "string" ? only.callID : "",
        toolName: typeof only.tool === "string" ? only.tool : "",
        ...(failed ? { isError: true } : {}),
      },
      ...(metadata ? { metadata } : {}),
    };
  }

  const content = contentBlocksOf(parts);
  const role = message.info.role === "unknown" ? "user" : (message.info.role ?? "user");
  const calls = role === "assistant" ? parts.filter(isToolPart) : [];
  return {
    message: {
      role: role as "user" | "assistant" | "system" | "tool",
      content: content.length === 0 ? "" : content,
      ...(calls.length === 0
        ? {}
        : {
            toolCalls: calls.map((call, index) => ({
              id: typeof call.callID === "string" ? call.callID : `mc_call_${index}`,
              name: typeof call.tool === "string" ? call.tool : "",
              input: call.state?.input,
              ...(call.providerExecuted === true ? { providerExecuted: true } : {}),
            })),
          }),
    },
    ...(metadata ? { metadata } : { metadata: { source: "legacy_synthetic" as const } }),
  };
}

function magicContextAttachment(message: MessageLike): RuntimeMessageEntry {
  const mediaBlocks = mediaBlocksOf(message.parts);
  return {
    kind: "attachment",
    content: textOf(message.parts),
    // FORK（Step 15 / D5）：壁画 PNG 走 mediaBlocks 上路（见 mediaBlocksOf）。
    ...(mediaBlocks === undefined ? {} : { mediaBlocks }),
    metadata: { source: "magic_context" },
  };
}

/**
 * m[0]/m[1] 的落位。
 *
 * 正投影把它们 unshift 到数组最前，而 ZCode 的 system prompt 是 `entries[0]`。
 * 照搬会让"注入上下文"排在 system 指令之前——OpenCode 里不存在这个差异（它的
 * system prompt 不在 messages 里）。所以这里把它们挪到**开头连续 system 段之后**：
 * 既保住"本轮之前"的语义，又不改 provider projection 的任何规则
 * （`reorderAttachmentLikeEntries` 见到 provider-visible 的 meta attachment 只会
 * 维持它相对前一个 bubble stop 的位置）。
 */
function hoistHeadsAfterSystemPrefix(entries: RuntimeMessageEntry[]): {
  entries: RuntimeMessageEntry[];
  headPositions: number[];
} {
  const isHead = (entry: RuntimeMessageEntry | undefined): boolean =>
    entry !== undefined && isAttachment(entry) && entry.metadata.source === "magic_context";
  if (!isHead(entries[0])) {
    return {
      entries,
      headPositions: entries.flatMap((entry, index) => (isHead(entry) ? [index] : [])),
    };
  }
  let headCount = 0;
  while (headCount < entries.length && isHead(entries[headCount])) headCount += 1;
  const heads = entries.slice(0, headCount);
  const rest = entries.slice(headCount);
  let systemCount = 0;
  while (systemCount < rest.length) {
    const candidate = rest[systemCount]!;
    if (isAttachment(candidate) || candidate.message.role !== "system") break;
    systemCount += 1;
  }
  return {
    entries: [...rest.slice(0, systemCount), ...heads, ...rest.slice(systemCount)],
    headPositions: Array.from({ length: heads.length }, (_, index) => systemCount + index),
  };
}

export function projectMagicContextEntries(
  messages: readonly MessageLike[],
  originals: ReadonlyMap<string, RuntimeMessageEntry>,
): { entries: RuntimeMessageEntry[]; syntheticHeadPositions: number[] } {
  const flat: RuntimeMessageEntry[] = [];
  for (const message of messages) {
    if (message.info.syntheticHead === true) {
      flat.push(magicContextAttachment(message));
      continue;
    }
    // FORK（spec phase-identity-guard / Step 8）：originals 按 MC 消息 id 查找；MC
    // 压缩重排会让 id 与构建期快照错位，把「真实 user_steer 输入」的元数据嫁接到
    // 无关内容上。role 不符的配对一律断开，重建走无模板路径（内容仍保留）。
    const original =
      typeof message.info.id === "string" ? originals.get(message.info.id) : undefined;
    const paired =
      original !== undefined && originalPairsWithMessage(original, message) ? original : undefined;
    flat.push(paired && isUnchanged(message, paired) ? paired : rebuildEntry(message, paired));
  }
  const { entries, headPositions } = hoistHeadsAfterSystemPrefix(flat);
  return { entries, syntheticHeadPositions: headPositions };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 包内 `features/magic-context/scheduler.ts` 的真身（S21 落地）消费 camelCase 的
 * `SchedulerConfig`，而本文件持的是 snake_case 的 `MagicContextConfig`——这里只做
 * 键名映射，判据（brand-new session 跳过、tokens 模式换算 contextLimit 等）全部
 * 归包内权威实现。原 Step 19b 的最小版 scheduler 已随真身落地删除。
 */
export function createZCodeScheduler(config: MagicContextConfig): Scheduler {
  return createPackageScheduler({
    executeThresholdPercentage: config.execute_threshold_percentage,
    ...(config.execute_threshold_tokens === undefined
      ? {}
      : { executeThresholdTokens: config.execute_threshold_tokens }),
  });
}
