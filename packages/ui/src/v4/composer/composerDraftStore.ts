// composer parity：v4 composer 的 per-session 草稿持久化（新做，轻量 localStorage）。
/* oxlint-disable eslint(max-lines) -- 照搬上游 v3.16.2 同名文件组织面收口（429 行形态），不拆散上游同源实现 */
//
// 旧草稿面（zcodeSessionStore composerDraftByScopeId + chatComposerDraftStorage 写路径）
// 已随 store 收尾删除；本模块是 v4 侧替代——键空间独立（v4 前缀），不与旧键互写，
// 旧键清理仍归 chatComposerDraftStorage 的 janitor。
// 语义：scope = sessionId（draft 态 = "__draft__"）；保存 text + editorStateJson，外部预填在
// Lexical 尚未挂载时额外保存 mention（保证重挂载不降级为纯文本）。
// mode/modelSelection 与正文同 scope 保存；发送只清内容，显式清理才删除整个 scope。
// 附件不入草稿（objectUrl/File 不可序列化，localPath 附件重启后归属难校验——
// 与「v4 composer 不做附件草稿持久化」的裁决一致）。
//
// upstream-v316-fullsync P7 续批（对照上游 v3.16.2 同名文件 429L 形态深度重写）：
// - 新增组织意图面 projectId/taskGroupId（分组草稿继承），__draft__ 态按 ComposerScope
//   （clientNamespace/hostId/projectId 三元）分 key；正式 session 仍按工作区隔离且不落组织态。
// - 新增 PendingTaskDraft 家族（占位 draftId ↔ workspace 绑定/命令占用）与
//   workspace scope 记忆（rememberComposerWorkspaceScope）。
// - omz 自研字段（lastPlanTransitionId/lastPermissionGrantId/initializeFromNewTask）保留；
//   空白删除语义沿用 omz（结构化状态在场不删 scope），读取侧按上游收敛为非空白才认。
import { logger } from "@/logger.js";
import {
  modelSelectionSchema,
  remoteHostIdFromWorkspaceIdentity,
  type ModelSelection,
} from "@zcode/shared";
import { submissionModeSchema, type SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";
import type { ComposerPromptContexts } from "@/v4/composer/composerPromptContexts.js";

export interface V4ComposerDraft {
  text: string;
  /** 未提交草稿的组织意图；真实任务归属始终由 Host 管理。 */
  projectId?: string | null;
  taskGroupId?: string | null;
  editorStateJson?: string;
  mention?: ComposerMentionPrefill;
  /**
   * 队列撤回恢复的四类上下文 chip 载体（纯数据）。
   * 撤回只在原 session 有效，但恢复态必须随草稿一起持久化：切 scope/刷新回来由草稿重建
   * chip 再参与重发序列化，不能让尾块只活在组件 state（否则切走再回来就静默丢尾块）。
   */
  promptContexts?: ComposerPromptContexts;
  /** 有合法 mode 表示已经初始化；没有模型仍是明确空态，不能按旧文本草稿补默认。 */
  mode?: SubmissionMode;
  planEnabled?: boolean;
  /** 已处理的工具变更，防止重连快照再次覆盖用户选择。 */
  lastPlanTransitionId?: string;
  lastPermissionGrantId?: string;
  modelSelection?: ModelSelection;
  /** 首次分享导入等待公共新任务初始化；不能由空 Session snapshot 抢先填充。 */
  initializeFromNewTask?: true;
  updatedAt: number;
}

/**
 * composer 内容局部更新：`text` 在场即正文写入，编辑器结构与 mention 必须重算；
 * 只写上下文载体（chip 增删/发送清空）时不得顺手清掉 mention 与 editorState。
 */
export type V4ComposerDraftContentPatch = Partial<
  Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention" | "promptContexts">
>;

/**
 * 值形态或函数形态的内容更新（composer/B-2）。
 * 函数形态让「同一 tick 内连续两次 chip 增删」基于 store 中最新草稿累积，
 * 不再需要组件内 `restoredPromptContextsRef` 渲染期镜像。
 */
export type V4ComposerDraftContentUpdate =
  | V4ComposerDraftContentPatch
  | ((current: V4ComposerDraft) => V4ComposerDraftContentPatch);

interface V4DraftFile {
  version: 1;
  legacyClaimed?: boolean;
  scopes: Record<string, V4ComposerDraft>;
}

const STORAGE_KEY_PREFIX = "zcode-v4-composer-drafts:v1:";
export const V4_DRAFT_SCOPE_ROOT = "__draft__";

export interface ComposerScope {
  clientNamespace: string;
  hostId: string;
  projectId: string | null;
}

export function composerScopeKey(scope: ComposerScope): string {
  return JSON.stringify([scope.clientNamespace, scope.hostId, scope.projectId]);
}

export interface PendingTaskDraft {
  draftId: string;
  workspacePath?: string;
  commandId?: string;
  sessionId?: string | null;
}

function pendingTaskKey(scope: ComposerScope): string {
  return `zcode-pending-task-draft:v1:${composerScopeKey(scope)}`;
}
export function readPendingTaskDraft(scope: ComposerScope): PendingTaskDraft | null {
  try {
    const raw = getStorage()?.getItem(pendingTaskKey(scope));
    const value = raw ? JSON.parse(raw) : null;
    return value &&
      typeof value.draftId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.draftId) &&
      (value.workspacePath === undefined || typeof value.workspacePath === "string") &&
      (value.commandId === undefined || typeof value.commandId === "string") &&
      (value.sessionId == null || typeof value.sessionId === "string")
      ? value
      : null;
  } catch {
    return null;
  }
}
function writePendingTaskDraft(scope: ComposerScope, value: PendingTaskDraft | null): void {
  const storage = getStorage();
  // 未保存身份时不得先分配目录，否则刷新又会失去草稿入口。
  if (!storage) throw new Error("composer.draft-storage-unavailable");
  if (value) storage.setItem(pendingTaskKey(scope), JSON.stringify(value));
  else storage.removeItem(pendingTaskKey(scope));
}
export function ensurePendingTaskDraft(scope: ComposerScope): PendingTaskDraft {
  const current = readPendingTaskDraft(scope);
  if (current) return current;
  const next = { draftId: crypto.randomUUID() };
  writePendingTaskDraft(scope, next);
  return next;
}
export function bindPendingTaskDraft(
  scope: ComposerScope,
  draftId: string,
  workspacePath: string,
): void {
  const current = readPendingTaskDraft(scope);
  if (current?.draftId === draftId && current.workspacePath !== workspacePath)
    writePendingTaskDraft(scope, { ...current, workspacePath });
}
export function completePendingTaskDraft(scope: ComposerScope, draftId: string): void {
  if (readPendingTaskDraft(scope)?.draftId === draftId) writePendingTaskDraft(scope, null);
}
export function markPendingTaskDraftCommand(
  scope: ComposerScope,
  draftId: string,
  commandId: string,
  sessionId: string | null,
): void {
  const current = readPendingTaskDraft(scope);
  if (current?.draftId !== draftId) return;
  if (current.commandId && current.commandId !== commandId)
    throw new Error("composer.draft-submission-pending");
  writePendingTaskDraft(scope, { ...current, commandId, sessionId });
}
export function releasePendingTaskDraftCommand(
  scope: ComposerScope,
  draftId: string,
  commandId: string,
): void {
  const current = readPendingTaskDraft(scope);
  if (current?.draftId !== draftId || current.commandId !== commandId) return;
  writePendingTaskDraft(scope, { draftId, workspacePath: current.workspacePath });
}

export function resolveComposerScope(
  projectId: string | null | undefined,
  workspaceIdentity?: string,
  clientNamespace = "desktop",
): ComposerScope {
  return {
    clientNamespace,
    hostId: workspaceIdentity
      ? (remoteHostIdFromWorkspaceIdentity(workspaceIdentity) ?? workspaceIdentity)
      : "local",
    projectId: projectId ?? null,
  };
}

function workspaceScopeKey(
  path: string,
  identity: string | undefined,
  clientNamespace: string,
): string {
  return `zcode-composer-workspace-scope:v1:${JSON.stringify([clientNamespace, identity?.trim() || path])}`;
}
export function rememberComposerWorkspaceScope(
  path: string,
  identity: string | undefined,
  scope: ComposerScope,
): void {
  try {
    getStorage()?.setItem(
      workspaceScopeKey(path, identity, scope.clientNamespace),
      JSON.stringify(scope),
    );
  } catch (error) {
    warnStorageFailure(workspaceScopeKey(path, identity, scope.clientNamespace), error);
  }
}
export function readComposerWorkspaceScope(
  path: string,
  identity: string | undefined,
  clientNamespace = "desktop",
): ComposerScope | undefined {
  try {
    const raw = getStorage()?.getItem(workspaceScopeKey(path, identity, clientNamespace));
    const value = raw ? JSON.parse(raw) : null;
    if (
      value?.clientNamespace === clientNamespace &&
      value.hostId === resolveComposerScope(null, identity, clientNamespace).hostId &&
      (value.projectId === null || typeof value.projectId === "string")
    )
      return value;
  } catch {
    /* 旧版没有导航身份，不能从目录猜项目。 */
  }
  return undefined;
}

function draftStorageKey(
  path: string,
  identity: string | undefined,
  scopeId: string,
  scope?: ComposerScope,
): string {
  // 同目录可以属于多个项目；新建草稿按组织归属隔离，正式 session 仍按工作区隔离。
  return scopeId === V4_DRAFT_SCOPE_ROOT && scope
    ? `zcode-v4-composer-project-drafts:v1:${composerScopeKey(scope)}`
    : getV4ComposerDraftStorageKey(path, identity);
}
const warnedStorageKeys = new Set<string>();

function warnStorageFailure(key: string, error: unknown) {
  if (warnedStorageKeys.has(key)) return;
  warnedStorageKeys.add(key);
  logger.warn("[v4-composer-draft] 草稿持久化访问失败", {
    error: error instanceof Error ? error.message : String(error),
    key,
  });
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getV4ComposerDraftStorageKey(
  workspacePath: string,
  workspaceIdentity?: string,
): string {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(workspaceKey)}`;
}

function readDraftFile(key: string): V4DraftFile {
  const storage = getStorage();
  try {
    const raw = storage?.getItem(key);
    if (!raw) return { version: 1, scopes: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.scopes)) {
      return { version: 1, scopes: {} };
    }
    const scopes = Object.fromEntries(
      Object.entries(parsed.scopes).flatMap(([scopeId, value]) => {
        const draft = readDraft(value);
        return draft ? [[scopeId, draft]] : [];
      }),
    );
    const file: V4DraftFile = {
      version: 1,
      scopes,
      ...(parsed.legacyClaimed === true ? { legacyClaimed: true } : {}),
    };
    // 读取可发生在 React render；旧空记录只过滤，物理清理由明确写入负责。
    return file;
  } catch (error) {
    warnStorageFailure(key, error);
    return { version: 1, scopes: {} };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PROMPT_CONTEXT_KEYS = [
  "codeComments",
  "conversationSelections",
  "webElements",
  "pptxElements",
] as const;

function hasPromptContexts(contexts: V4ComposerDraft["promptContexts"]): boolean {
  return Boolean(
    contexts &&
    (contexts.codeComments.length > 0 ||
      contexts.conversationSelections.length > 0 ||
      contexts.webElements.length > 0 ||
      contexts.pptxElements.length > 0),
  );
}

/**
 * 读取撤回上下文载体：四类数组必须齐备。
 * 条目字段由本地 parser 产出，这里只校验到「对象数组」；坏记录整体丢弃，
 * 避免 chip 渲染读到半截字段。
 */
function readDraftPromptContexts(value: unknown): ComposerPromptContexts | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !PROMPT_CONTEXT_KEYS.every((key) => {
      const list = value[key];
      return Array.isArray(list) && list.every((item) => isRecord(item));
    })
  ) {
    return undefined;
  }
  return value as unknown as ComposerPromptContexts;
}

function readDraft(value: unknown): V4ComposerDraft | null {
  if (!isRecord(value) || typeof value.text !== "string") return null;
  const rawPromptContexts = readDraftPromptContexts(value.promptContexts);
  const promptContexts = hasPromptContexts(rawPromptContexts) ? rawPromptContexts : undefined;
  // 只有上下文没有正文的撤回草稿同样是真实内容（例如纯选区/纯代码注释队列项），
  // 空正文且无上下文才按空草稿丢弃。
  if (!value.text.trim() && !promptContexts) return null;
  const mode = submissionModeSchema.safeParse(value.mode);
  const selection = modelSelectionSchema.safeParse(value.modelSelection);
  // 坏 options 不应连带丢掉可确定的模型身份；不读取旧 provider/model/thought 别名。
  const identity = isRecord(value.modelSelection)
    ? modelSelectionSchema.safeParse({
        providerId: value.modelSelection.providerId,
        modelId: value.modelSelection.modelId,
      })
    : null;
  const modelSelection = selection.success
    ? selection.data
    : identity?.success
      ? identity.data
      : undefined;
  const mention = value.mention;
  const hasMention =
    isRecord(mention) &&
    ["id", "category", "label", "value", "markdown"].every(
      (key) => typeof mention[key] === "string",
    ) &&
    ["files", "skills", "commands", "subagents", "whiteboards", "sessions", "plugins"].includes(
      String(mention.category),
    );
  return {
    text: value.text,
    ...(promptContexts ? { promptContexts } : {}),
    ...(value.taskGroupId === null || typeof value.taskGroupId === "string"
      ? { taskGroupId: value.taskGroupId as string | null }
      : {}),
    ...(value.projectId === null || (typeof value.projectId === "string" && value.projectId.trim())
      ? { projectId: value.projectId as string | null }
      : {}),
    ...(typeof value.editorStateJson === "string"
      ? { editorStateJson: value.editorStateJson }
      : {}),
    ...(hasMention ? { mention: mention as unknown as ComposerMentionPrefill } : {}),
    ...(mode.success ? { mode: mode.data === "plan" ? ("build" as const) : mode.data } : {}),
    ...(typeof value.planEnabled === "boolean"
      ? { planEnabled: value.planEnabled }
      : mode.success
        ? { planEnabled: mode.data === "plan" }
        : {}),
    ...(typeof value.lastPermissionGrantId === "string"
      ? { lastPermissionGrantId: value.lastPermissionGrantId }
      : {}),
    ...(typeof value.lastPlanTransitionId === "string"
      ? { lastPlanTransitionId: value.lastPlanTransitionId }
      : {}),
    ...(modelSelection ? { modelSelection } : {}),
    ...(value.initializeFromNewTask === true && !mode.success
      ? { initializeFromNewTask: true as const }
      : {}),
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

function writeDraftFile(key: string, file: V4DraftFile) {
  const storage = getStorage();
  if (!storage) {
    return false;
  }
  try {
    const serialized =
      Object.keys(file.scopes).length || file.legacyClaimed ? JSON.stringify(file) : null;
    if (storage.getItem(key) === serialized) return true;
    if (serialized === null) storage.removeItem(key);
    else storage.setItem(key, serialized);
    warnedStorageKeys.delete(key);
    return true;
  } catch (error) {
    // 配额/隐私模式失败只降级为不持久化，不影响输入。
    warnStorageFailure(key, error);
    return false;
  }
}

export function readV4ComposerDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
  scope?: ComposerScope,
): V4ComposerDraft | null {
  const key = draftStorageKey(workspacePath, workspaceIdentity, scopeId, scope);
  const file = readDraftFile(key);
  const draft = file.scopes[scopeId];
  if (!draft || typeof draft.text !== "string") {
    // 旧记录只有显式项目归属才能认领；未归类历史不能靠最近目录猜测。
    if (!file.legacyClaimed && scopeId === V4_DRAFT_SCOPE_ROOT && scope?.projectId) {
      const legacy = readDraftFile(getV4ComposerDraftStorageKey(workspacePath, workspaceIdentity))
        .scopes[scopeId];
      if (legacy?.projectId === scope.projectId) return legacy;
    }
    return null;
  }
  return draft;
}

export function persistV4ComposerDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
  draft: Omit<V4ComposerDraft, "updatedAt">,
  scope?: ComposerScope,
) {
  const key = draftStorageKey(workspacePath, workspaceIdentity, scopeId, scope);
  const file = readDraftFile(key);
  const hadDraft = Boolean(file.scopes[scopeId]);
  // 正文/模型各自更新草稿时不能抹掉项目意图；显式新建传 null 才清除项目归属。
  const savedGroupId = file.scopes[scopeId]?.taskGroupId;
  const savedProjectId = file.scopes[scopeId]?.projectId;
  const next = {
    ...draft,
    ...(draft.taskGroupId === undefined && savedGroupId !== undefined
      ? { taskGroupId: savedGroupId }
      : {}),
    ...(draft.projectId === undefined && savedProjectId !== undefined
      ? { projectId: savedProjectId }
      : {}),
  };
  // promotion 以后任务归属由 Host 查询；浏览器 Session 草稿不保留组织态副本。
  if (scopeId !== V4_DRAFT_SCOPE_ROOT) {
    delete next.projectId;
    delete next.taskGroupId;
  }
  // omz：空白删除语义沿用本仓——结构化状态（editorState/mention/上下文载体/mode/model）
  // 在场不删 scope；上游只看正文，会在保留编辑器结构时丢掉空正文草稿，omz Session 恢复链
  // 依赖这些结构字段。
  if (
    !next.text.trim() &&
    !next.editorStateJson &&
    !next.mention &&
    !hasPromptContexts(next.promptContexts) &&
    !next.mode &&
    !next.modelSelection &&
    !next.initializeFromNewTask
  ) {
    delete file.scopes[scopeId];
  } else {
    file.scopes[scopeId] = { ...next, updatedAt: Date.now() };
  }
  // 新 key 首次写入即结束旧目录认领；保留旧数据，避免删除失败或换目录后复活正文。
  if (
    scopeId === V4_DRAFT_SCOPE_ROOT &&
    scope?.projectId &&
    (hadDraft ||
      Boolean(file.scopes[scopeId]) ||
      readDraftFile(getV4ComposerDraftStorageKey(workspacePath, workspaceIdentity)).scopes[scopeId]
        ?.projectId === scope.projectId)
  )
    file.legacyClaimed = true;
  return writeDraftFile(key, file);
}

/** 旧版关闭分组草稿只撤销 placement；不能连带清空正在编辑的正文和项目。 */
export function clearV4ComposerDraftTaskGroup(
  workspacePath: string,
  workspaceIdentity?: string,
  scope?: ComposerScope,
) {
  const key = draftStorageKey(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, scope);
  const file = readDraftFile(key);
  const draft = readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, scope);
  if (!draft || draft.taskGroupId === undefined) return true;
  // 分组只是草稿的组织意图；关闭时必须沿用项目 key，不能修改同目录的其他项目。
  delete draft.taskGroupId;
  file.scopes[V4_DRAFT_SCOPE_ROOT] = draft;
  if (scope?.projectId) file.legacyClaimed = true;
  return writeDraftFile(key, file);
}

export function clearV4ComposerDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
  scope?: ComposerScope,
) {
  const key = draftStorageKey(workspacePath, workspaceIdentity, scopeId, scope);
  const file = readDraftFile(key);
  const hadDraft = Boolean(file.scopes[scopeId]);
  delete file.scopes[scopeId];
  // 新 key 首次写入即结束旧目录认领；保留旧数据，避免删除失败或换目录后复活正文。
  if (
    scopeId === V4_DRAFT_SCOPE_ROOT &&
    scope?.projectId &&
    (hadDraft ||
      Boolean(file.scopes[scopeId]) ||
      readDraftFile(getV4ComposerDraftStorageKey(workspacePath, workspaceIdentity)).scopes[scopeId]
        ?.projectId === scope.projectId)
  )
    file.legacyClaimed = true;
  return writeDraftFile(key, file);
}
