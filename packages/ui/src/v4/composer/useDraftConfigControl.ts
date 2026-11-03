/* eslint-disable max-lines -- Composer 草稿 owner 同时收口选择、正文与提交生命周期，保持单一状态边界。 */
// 当前编辑由 Composer 持有；进入已有 Session 从当前快照恢复权限/Plan，在线只响应新变化。
// 菜单点击立即保存 Renderer 意图，Prewarm 与 Submission 只消费它，不反向覆盖。
//
// 2026-11-03 CR 修复（B1/B2/B3）：
// - draft 只保存用户原意图；失效模型/档位的修复只体现在派生的 resolvedSelection，
//   不再在 render 阶段写回 draft，也不会被自动持久化。
// - 文字草稿（composerDraftStore）仍要求非空正文；mode/modelSelection/planEnabled 走
//   composerConfigStore，两者分开写，清空正文不会产生幽灵草稿行、也不会丢配置。
// - Session 的失效修复不再依赖 firstSnapshot：每次 render 按当前 View 重新派生。
//
// Workspace presentation 水合只提供 mode 与 slash commands；模型候选、能力和首选值
// 统一来自目标 Host ModelSelectionView。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZCODE_AGENT_PROVIDER, resolveExecutionState } from "@zcode/shared";
import type {
  ZCodeConfigOption,
  ModelSelection,
  ZCodeProvider,
  ZCodeSlashCommand,
} from "@zcode/shared";
import type {
  SessionConfigState,
  SessionRuntimeAvailability,
} from "@zcode/shared/zcode-protocol-v4";
import type { IModelSelectionService } from "@zcode/services";
import { completeNewModelSelection } from "@zcode/provider";
import {
  useModelSelectionServiceView,
  type ModelSelectionRead,
} from "@/hooks/useModelSelectionView.js";
import { submissionModeSchema } from "@zcode/shared/zcode-protocol-v4";
import { prepareWorkspaceWithZCodeSessionService } from "@/hooks/useWorkspacePrepare.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { initializeNewTaskDraft } from "@/v4/composer/newTaskDraft.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import { resolveComposerScope, composerScopeKey } from "@/v4/composer/composerDraftStore.js";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import {
  readV4ComposerConfig,
  persistV4ComposerConfig,
  clearV4ComposerConfig,
} from "@/v4/composer/composerConfigStore.js";
import { resolveComposerSelection } from "@/v4/composer/resolveComposerSelection.js";
import { resolveAppFollowupMode } from "@/v4/composer/followupModeSettings.js";
import { logger } from "@/logger.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/** 目录水合单飞（per workspaceKey）：draft、已有 session 和严格模式双挂载共享一次 RPC。 */
const workspaceCatalogHydrationFlights = new Map<string, Promise<void>>();

export function applyDraftModelSelection(
  current: Partial<SessionConfigState>,
  model: ModelSelection,
): Partial<SessionConfigState> {
  const next = {
    ...current,
    modelSelection: {
      providerId: model.providerId,
      modelId: model.modelId,
      ...(model.options ? { options: { ...model.options } } : {}),
    },
    provider: model.providerId,
    model: model.modelId,
  };
  // thought 是模型的附属配置。切模型后保留源 thought 会让首发前配置屏障
  // 在目标模型已切成功后把它当成“同模型显式切 thought”再次写入，必须先清除。
  delete next.thought;
  return next;
}

export function shouldHydrateWorkspaceCatalog(params: {
  configOptions: readonly ZCodeConfigOption[];
  sessionId: string | null;
  slashCommands: readonly ZCodeSlashCommand[];
}): boolean {
  const hasModePresentation = params.configOptions.some(
    (option) => option.category === "mode" && option.type === "select",
  );
  // slashCommands 属于 workspace identity，不会随已有 session projection 恢复。
  // 因此已有 session 只要目录为空也必须独立水合；mode 目录也不再借模型目录间接提供。
  return params.slashCommands.length === 0 || !hasModePresentation;
}

export interface DraftConfigControl {
  modelSelectionRead: ModelSelectionRead;
  /** Renderer 下一次提交的配置；恢复采用当前权限，在线授权只同步对应字段。 */
  draftConfig: Partial<SessionConfigState>;
  /** 草稿已选 config（partial）；createSession 时经 buildDraftCreateConfigPayload 携带。 */
  draftConfigRef: React.RefObject<Partial<SessionConfigState>>;
  /** 当前草稿生命周期冻结的初始化 config；只供 prewarm/createSession 建立时使用。 */
  resolveInitialDraftConfig: () => Partial<SessionConfigState> | undefined;
  composerDraft: V4ComposerDraft;
  updateComposerContent: (
    content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">,
  ) => void;
  replaceComposerDraft: (draft: Omit<V4ComposerDraft, "updatedAt">) => void;
  /** 新任务被接纳后，把当前完整 Root Draft 原子式转移到真实 Session scope。 */
  promoteComposerDraft: (createdSessionId: string) => void;
  /** 在提交前捕获原意图；只在权威 accepted 后调用返回函数。 */
  captureAcceptedModelSelection: (
    selection: ModelSelection,
    expectedSelection?: ModelSelection,
  ) => () => void;
  handleDraftSelectModel: (modelProvider: string, model: string, reasoningLevel?: string) => void;
  handleDraftSelectThought: (thought: string) => void;
  handleDraftSwitchMode: (mode: string) => void;
}

interface ComposerState {
  scopeKey: string;
  workspaceKey: string;
  /** Root 草稿的 New Task 代际；用于区分「同一草稿重进」与「显式新建」。 */
  draftFocusVersion?: number;
  draft: V4ComposerDraft;
  initialization: "new-task" | "session" | "promotion";
  promotedSessionId?: string;
}

export function useDraftConfigControl(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZCodeProvider;
  /** 会话切换恢复文字/模型，权限和 Plan 使用当前快照。 */
  sessionId: string | null;
  /** 仅匹配当前 Session 的首份投影可用作初始化；null 表示还没恢复完成。 */
  sessionConfig?: Partial<SessionConfigState> | null;
  /**
   * 会话的 runtime 态（IS3 / Step 10）。`viewOnly` 的首屏种子刻意不含 planEnabled /
   * thoughtLevels / permissionGrant —— 这里据此把「不知道」保持成空态，等激活后的
   * 全量种子再补一次，而不是先写一个默认值。
   */
  sessionRuntime?: SessionRuntimeAvailability;
  /** provider registry 已通过 renderer readiness 门禁后才允许拉起 Agent。 */
  agentStartupAllowed?: boolean;
  modelSelectionService: IModelSelectionService | null;
}): DraftConfigControl {
  const {
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    sessionConfig,
    sessionRuntime = "live",
    agentStartupAllowed = true,
    modelSelectionService,
  } = params;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const zcodeSessionService = useZCodeSessionService(workspacePath, null, workspaceIdentity);
  const { settings: sharedSettings } = useSettings();
  const appFollowupMode = resolveAppFollowupMode(sharedSettings);
  const scopeId = sessionId ?? V4_DRAFT_SCOPE_ROOT;
  const clientNamespace = useComposerClientNamespace();
  const draftProjectId = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftProjectId,
  );
  const rootScope = useMemo(
    () => resolveComposerScope(draftProjectId, workspaceIdentity, clientNamespace),
    [draftProjectId, workspaceIdentity, clientNamespace],
  );
  const draftFocusVersion = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftFocusVersion ?? 0,
  );
  // New Task 可以复用同一个 pane；无文字时必须重新取 Recent，不能只清磁盘留旧内存。
  const scopeKey = JSON.stringify([
    workspaceKey,
    scopeId,
    sessionId === null ? draftFocusVersion : null,
    sessionId === null ? composerScopeKey(rootScope) : null,
  ]);
  const navigationInitialization = useZCodeSessionStore((state) => {
    const workspace = state.workspaces[workspaceKey];
    return workspace?.activeTaskId === sessionId &&
      workspace?.composerInitialization?.taskId === sessionId
      ? workspace.composerInitialization
      : undefined;
  });
  const loadedScopes = useMemo(() => {
    const build = (restoreConfigWithoutText: boolean): ComposerState => {
      const saved = readV4ComposerDraft(workspacePath, workspaceIdentity, scopeId, rootScope);
      const persistedConfig = readV4ComposerConfig(
        workspacePath,
        workspaceIdentity,
        scopeId,
        rootScope,
      );
      // 文字草稿里的旧配置优先（兼容旧记录）；config store 补齐空正文场景的配置。
      // 显式 New Task 且没有文字草稿时回到默认来源（Recent/目录首选），不恢复上一代的
      // 空正文配置；文字草稿本身就携带配置，仍按草稿恢复。
      const restoreConfig = Boolean(saved) || restoreConfigWithoutText;
      const config: Pick<V4ComposerDraft, "mode" | "planEnabled" | "modelSelection"> = restoreConfig
        ? {
            mode: saved?.mode ?? persistedConfig?.mode,
            planEnabled: saved?.planEnabled ?? persistedConfig?.planEnabled,
            modelSelection: saved?.modelSelection ?? persistedConfig?.modelSelection,
          }
        : {};
      const draft: V4ComposerDraft = saved
        ? { ...saved }
        : { text: "", updatedAt: 0, ...navigationInitialization?.config };
      // 持久配置是用户显式意图，Root 与 Session 都恢复；Session 没有表达的字段
      // 由下方 resolved* 从当前 Snapshot 补齐，Snapshot 派生值不写回 draft/config。
      if (config.mode) draft.mode = config.mode;
      if (config.planEnabled !== undefined) draft.planEnabled = config.planEnabled;
      if (config.modelSelection) draft.modelSelection = config.modelSelection;
      return {
        scopeKey,
        workspaceKey,
        draftFocusVersion,
        draft,
        initialization:
          sessionId === null || (!saved && navigationInitialization) ? "new-task" : "session",
      };
    };
    return { restore: build(true), fresh: build(false) };
  }, [scopeKey]);
  const loadedScope = loadedScopes.restore;
  const [storedState, setStoredState] = useState(loadedScope);
  // 显式 New Task 会递增 draftFocusVersion；同一 mounted pane 内从旧代际切换过来时，
  // 上一代的空正文配置不能被当成当前草稿的配置。
  const switchedDraftGeneration =
    sessionId === null &&
    storedState.workspaceKey === workspaceKey &&
    storedState.scopeKey !== scopeKey &&
    storedState.draftFocusVersion !== undefined &&
    storedState.draftFocusVersion !== draftFocusVersion;
  // 首发是同一 pane 的地址迁移，保持其间的新编辑；换页或卸载不保留第二份配置。
  let currentState: ComposerState =
    storedState.scopeKey === scopeKey
      ? storedState
      : storedState.workspaceKey === workspaceKey && storedState.promotedSessionId === sessionId
        ? {
            ...storedState,
            scopeKey,
            initialization: "promotion",
            promotedSessionId: undefined,
          }
        : switchedDraftGeneration
          ? loadedScopes.fresh
          : loadedScope;
  let draft = currentState.draft;
  const modelSelectionRead = useModelSelectionServiceView(
    modelSelectionService,
    true,
    "remote-waiting",
    {
      selection: draft.modelSelection ?? null,
    },
  );
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  // 初始化只发生在「本次 New Task 还没有任何配置意图」时；失效修复与 Session 恢复
  // 不再写 draft，而是由下方 resolved* 派生，避免把用户临时不可用的选择固化。
  if (currentState.initialization === "new-task" && !draft.mode && modelSelectionView) {
    draft = initializeNewTaskDraft(
      draft,
      workspacePath,
      workspaceIdentity,
      modelSelectionView,
      rootScope,
    );
  }
  if (draft !== currentState.draft) currentState = { ...currentState, draft };
  if (currentState !== storedState) setStoredState(currentState);
  const stateRef = useRef(currentState);
  stateRef.current = currentState;
  // 原因：只派生展示/提交结果，保留 draft 原意图。View 迟到 ready（含 Session 首次快照）
  // 都会在下一次 render 重新解析，不再依赖 firstSnapshot 的一次性状态。
  const resolvedSelection = useMemo(
    () =>
      resolveComposerSelection({
        view: modelSelectionView,
        draftSelection: draft.modelSelection,
        sessionSelection: sessionId ? sessionConfig?.modelSelection : undefined,
      }).selection,
    [modelSelectionView, draft.modelSelection, sessionId, sessionConfig?.modelSelection],
  );
  // 用户显式表达过的 mode/Plan 优先；Session 没有表达时由当前 Snapshot 补齐。
  // 真实新授权/Plan 变化会清掉本地覆盖（见上方观察 effect），重新回到 Snapshot。
  const sessionMode = sessionConfig
    ? (() => {
        const parsed = submissionModeSchema.safeParse(sessionConfig.mode);
        return parsed.success && parsed.data !== "plan" ? parsed.data : "build";
      })()
    : undefined;
  // view-only 种子不知道 planEnabled 时不写成 false，等激活后的全量种子。
  const sessionPlanEnabled =
    sessionConfig && (sessionRuntime === "live" || typeof sessionConfig.planEnabled === "boolean")
      ? resolveExecutionState(sessionConfig).planEnabled
      : undefined;
  const resolvedMode = draft.mode ?? sessionMode;
  const resolvedPlanEnabled = draft.planEnabled ?? sessionPlanEnabled ?? false;
  const draftConfig = useMemo<Partial<SessionConfigState>>(
    () => ({
      mode: resolvedMode,
      planEnabled: resolvedPlanEnabled,
      modelSelection: resolvedSelection,
      provider: resolvedSelection?.providerId ?? "",
      model: resolvedSelection?.modelId ?? "",
      thought: resolvedSelection?.options?.reasoningLevel ?? "",
    }),
    [resolvedMode, resolvedPlanEnabled, resolvedSelection],
  );
  const draftConfigRef = useRef(draftConfig);
  draftConfigRef.current = draftConfig;
  const persistDraft = useCallback(
    (value: V4ComposerDraft) => {
      const workspace = useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspacePath, workspaceIdentity);
      return persistV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        // 首发已绑定但 React 尚未切换地址时，新输入也属于已创建的会话。
        stateRef.current.promotedSessionId ?? scopeId,
        scopeId === V4_DRAFT_SCOPE_ROOT
          ? {
              ...value,
              projectId:
                workspace.draftProjectId !== undefined ? workspace.draftProjectId : value.projectId,
              taskGroupId:
                workspace.draftTaskGroupId !== undefined
                  ? workspace.draftTaskGroupId
                  : value.taskGroupId,
            }
          : value,
        rootScope,
      );
    },
    [workspacePath, workspaceIdentity, scopeId, rootScope],
  );
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (navigationInitialization)
      useZCodeSessionStore
        .getState()
        .consumeComposerInitialization(workspacePath, navigationInitialization, workspaceIdentity);
  }, [scopeKey, navigationInitialization, workspacePath, workspaceIdentity]);
  const isCurrentScope = useCallback(
    () =>
      mountedRef.current &&
      stateRef.current.scopeKey === scopeKey &&
      (sessionId !== null ||
        (useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
          .draftFocusVersion ?? 0) === draftFocusVersion),
    [scopeKey, sessionId, workspacePath, workspaceIdentity, draftFocusVersion],
  );
  // 配置与文字草稿分开持久化：这里的写入只来自用户动作/New Task 初始化/accepted 回执，
  // Session Snapshot 的派生修复不落盘。
  const persistConfig = useCallback(
    (value: V4ComposerDraft) => {
      return persistV4ComposerConfig(
        workspacePath,
        workspaceIdentity,
        // 首发已绑定但 React 尚未切换地址时，配置也属于已创建的会话。
        stateRef.current.promotedSessionId ?? scopeId,
        {
          mode: value.mode,
          planEnabled: value.planEnabled,
          modelSelection: value.modelSelection,
        },
        scopeId === V4_DRAFT_SCOPE_ROOT ? rootScope : undefined,
      );
    },
    [workspacePath, workspaceIdentity, scopeId, rootScope],
  );
  const commitDraft = useCallback(
    (next: V4ComposerDraft, options: { persistConfig?: boolean } = {}) => {
      const nextState = { ...stateRef.current, draft: next };
      stateRef.current = nextState;
      setStoredState(nextState);
      // 文字草稿只写非空白正文；配置写入独立键，不会留下空正文草稿行。
      persistDraft(next);
      if (options.persistConfig) persistConfig(next);
    },
    [persistConfig, persistDraft],
  );
  // 用户未改配置时，本次 New Task 的初始化结果（mode + Recent 模型）也要落 config store，
  // 否则空正文草稿切回会丢；scopeKey 保证每个 New Task 生命周期只写一次。
  const initializedConfigScopeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isCurrentScope() || currentState.initialization !== "new-task" || !draft.mode) return;
    if (initializedConfigScopeRef.current === scopeKey) return;
    initializedConfigScopeRef.current = scopeKey;
    persistConfig(draft);
  }, [currentState.initialization, draft, isCurrentScope, persistConfig, scopeKey]);
  // 真实新授权/Plan 工具变化按最新 Snapshot 更新对应字段：只清掉本次打开期间的本地覆盖，
  // 派生值随即回到 Snapshot；这是事件同步，不是 render 阶段的失效修复。
  const observedSessionConfigRef = useRef<{
    scopeKey: string;
    permissionGrantId?: string;
    planTransitionId?: string;
  } | null>(null);
  useEffect(() => {
    if (sessionId === null || !sessionConfig) return;
    const next = {
      scopeKey,
      permissionGrantId: sessionConfig.permissionGrant?.interactionId,
      planTransitionId: sessionConfig.planTransition?.toolCallId,
    };
    const previous = observedSessionConfigRef.current;
    observedSessionConfigRef.current = next;
    // 首次快照只建立观察基线，不重放历史授权。
    if (!previous || previous.scopeKey !== scopeKey) return;
    const clearField = (field: "mode" | "planEnabled") => {
      const current = stateRef.current;
      if (current.scopeKey !== scopeKey || current.draft[field] === undefined) return;
      const nextDraft = { ...current.draft };
      delete nextDraft[field];
      const nextState = { ...current, draft: nextDraft };
      stateRef.current = nextState;
      setStoredState(nextState);
    };
    if (next.permissionGrantId && next.permissionGrantId !== previous.permissionGrantId)
      clearField("mode");
    if (next.planTransitionId && next.planTransitionId !== previous.planTransitionId)
      clearField("planEnabled");
  }, [
    scopeKey,
    sessionId,
    sessionConfig?.permissionGrant?.interactionId,
    sessionConfig?.planTransition?.toolCallId,
  ]);
  const updateComposerDraft = useCallback(
    (update: (current: V4ComposerDraft) => V4ComposerDraft) => {
      // 旧 scope 的延迟编辑器回调不能写入刚切换到的会话。
      if (!isCurrentScope()) return;
      commitDraft(update(stateRef.current.draft), { persistConfig: true });
    },
    [commitDraft, isCurrentScope],
  );
  const updateDraftConfig = useCallback(
    (update: (current: Partial<SessionConfigState>) => Partial<SessionConfigState>) => {
      if (!isCurrentScope()) return;
      const current = stateRef.current.draft;
      const nextConfig = update(draftConfigRef.current);
      const parsedMode = submissionModeSchema.safeParse(nextConfig.mode);
      // 导入等待目录期间的显式选择也是有效选择，不能再被默认初始化覆盖。
      const mode = parsedMode.success ? parsedMode.data : (current.mode ?? "build");
      const next: V4ComposerDraft = {
        ...current,
        mode,
        modelSelection: nextConfig.modelSelection,
      };
      commitDraft(next, { persistConfig: true });
      // 同一事件内随后提交时不必等待 re-render 的派生结果。
      const selection = next.modelSelection;
      draftConfigRef.current = {
        mode: next.mode,
        // 只改模型/档位时保留当前派生 Plan（Session 的 Plan 可能来自 Snapshot）。
        planEnabled: nextConfig.planEnabled ?? next.planEnabled ?? false,
        modelSelection: selection,
        provider: selection?.providerId ?? "",
        model: selection?.modelId ?? "",
        thought: selection?.options?.reasoningLevel ?? "",
      };
    },
    [commitDraft, isCurrentScope],
  );
  const captureAcceptedModelSelection = useCallback(
    (selection: ModelSelection, expectedSelection: ModelSelection = selection): (() => void) => {
      const original = stateRef.current.draft.modelSelection;
      const effective = draftConfigRef.current.modelSelection;
      // 对象键顺序不是选择身份；协议重建同一选择时不能因此丢掉 accepted 写回。
      if (
        effective?.providerId !== expectedSelection.providerId ||
        effective.modelId !== expectedSelection.modelId ||
        effective.options?.reasoningLevel !== expectedSelection.options?.reasoningLevel
      )
        return () => {};
      return () => {
        // 自动对应只在本次提交被接纳后固定；旧 ACK 不得覆盖期间的新意图或新 scope。
        if (
          stateRef.current.scopeKey !== scopeKey ||
          stateRef.current.draft.modelSelection !== original
        )
          return;
        updateComposerDraft((current) => ({ ...current, modelSelection: selection }));
      };
    },
    [scopeKey, updateComposerDraft],
  );
  const resolveInitialDraftConfig = useCallback((): Partial<SessionConfigState> | undefined => {
    if (!draftConfigRef.current.mode) return undefined;
    const config = { ...draftConfigRef.current };
    if (appFollowupMode) {
      config.followupMode = appFollowupMode;
    }
    return config;
  }, [appFollowupMode]);

  const updateComposerContent = useCallback(
    (content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">) => {
      if (!isCurrentScope()) return;
      // 只改正文：config store 不参与，避免普通键入/发送清空正文时重写配置。
      commitDraft({
        ...stateRef.current.draft,
        editorStateJson: undefined,
        mention: undefined,
        ...content,
      });
    },
    [commitDraft, isCurrentScope],
  );
  const replaceComposerDraft = useCallback(
    (replacement: Omit<V4ComposerDraft, "updatedAt">) => {
      if (!isCurrentScope()) return;
      // 撤回/恢复携带独立 Submission 配置，属于用户意图，需要同步 config store。
      commitDraft({ ...replacement, updatedAt: Date.now() }, { persistConfig: true });
    },
    [commitDraft, isCurrentScope],
  );

  const promoteComposerDraft = useCallback(
    (createdSessionId: string) => {
      if (!isCurrentScope() || scopeId !== V4_DRAFT_SCOPE_ROOT) return;
      const targetSessionId = createdSessionId.trim();
      if (!targetSessionId) return;
      // 首发 Snapshot 可能迟到：空正文只在内存交接配置，有新文字则先写目标再删来源。
      const written = persistV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        targetSessionId,
        stateRef.current.draft,
      );
      if (!written) return;
      // Root→session 迁移配置：新会话从自己的 scope 读回，不依赖 Root 残留。
      persistV4ComposerConfig(
        workspacePath,
        workspaceIdentity,
        targetSessionId,
        stateRef.current.draft,
      );
      clearV4ComposerConfig(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, rootScope);
      const next = { ...stateRef.current, promotedSessionId: targetSessionId };
      stateRef.current = next;
      setStoredState(next);
      clearV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, rootScope);
    },
    [scopeId, isCurrentScope, workspaceIdentity, workspacePath, rootScope],
  );

  // ── workspace 目录水合（见文件头说明）──
  // 目录已 ready（reload/广播/上次水合写过）则跳过；否则读取最小 workspace presentation。
  useEffect(() => {
    const isDraft = sessionId === null;
    const store = useZCodeSessionStore.getState();
    const workspaceState = store.getWorkspaceState(workspacePath, workspaceIdentity);
    if (!agentStartupAllowed) {
      // V4 目录水合曾在无模型时直接进入 RPC，虽然 Host 不会启动 CLI，
      // renderer 仍会把正常等待态记成 hydration error。readiness 未通过时保持 idle；
      // registry 就绪后依赖变化会自动重新进入本 effect。
      store.setConfigOptionsStatus(workspacePath, "idle", workspaceIdentity);
      return;
    }
    const configOptions = workspaceState.configOptions ?? [];
    const hasModePresentation = configOptions.some(
      (option) => option.category === "mode" && option.type === "select",
    );
    const hasSlashCommandCatalog = workspaceState.slashCommands.length > 0;
    const shouldHydrateCatalog = shouldHydrateWorkspaceCatalog({
      configOptions,
      sessionId,
      slashCommands: workspaceState.slashCommands,
    });
    logger.debug("[v4-workspace-catalog] hydration check", {
      catalogScope: isDraft ? "draft" : "known-session",
      hasModePresentation,
      hasSlashCommandCatalog,
      flightInProgress: workspaceCatalogHydrationFlights.has(workspaceKey),
      configOptionsStatus: workspaceState.configOptionsStatus,
      workspaceKey,
    });
    const existingFlight = workspaceCatalogHydrationFlights.get(workspaceKey);
    if (existingFlight) {
      return;
    }
    if (!shouldHydrateCatalog) {
      return;
    }

    store.setConfigOptionsStatus(workspacePath, "loading", workspaceIdentity);
    const flight = prepareWorkspaceWithZCodeSessionService({
      workspacePath,
      workspaceIdentity,
      provider: displayProvider,
      zcodeSessionService,
    })
      .then((prepareResult) => {
        const baseOptions = prepareResult.configOptions ?? [];
        logger.debug("[v4-workspace-catalog] hydration done", {
          catalogScope: isDraft ? "draft" : "known-session",
          optionCount: baseOptions.length,
          slashCommandCount: prepareResult.slashCommands?.length ?? 0,
          modeCurrentValue: String(
            baseOptions.find((option) => option.category === "mode" && option.type === "select")
              ?.currentValue ?? "",
          ),
          workspaceKey,
        });
        const latest = useZCodeSessionStore.getState();
        latest.setConfigOptions(workspacePath, baseOptions, workspaceIdentity);
        latest.setConfigOptionsStatus(workspacePath, "ready", workspaceIdentity);
        latest.setSlashCommands(
          workspacePath,
          prepareResult.slashCommands ?? [],
          workspaceIdentity,
        );
      })
      .catch((error) => {
        useZCodeSessionStore
          .getState()
          .setConfigOptionsStatus(workspacePath, "error", workspaceIdentity);
        logger.warn(`[v4-workspace-catalog] workspace 目录水合失败: ${String(error)}`);
      })
      .finally(() => {
        workspaceCatalogHydrationFlights.delete(workspaceKey);
      });
    workspaceCatalogHydrationFlights.set(workspaceKey, flight);
  }, [
    agentStartupAllowed,
    displayProvider,
    sessionId,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    zcodeSessionService,
  ]);

  const handleDraftSelectModel = useCallback(
    (modelProvider: string, model: string, reasoningLevel?: string) => {
      const modelId = modelProvider ? `${modelProvider}/${model}` : model;
      const parsedSelection = parseModelPickerValue(modelId);
      // 原因：调档后解析尚未返回时，菜单仍使用同 Host 的保留目录；只读 ready view
      // 会把随后主动选模写成无档位意图，永久显示“—”。目录仅用于选模，不放行提交。
      const catalog =
        modelSelectionView ??
        (modelSelectionRead.state.status === "loading" ? modelSelectionRead.state.catalog : null);
      const modelSelection = reasoningLevel
        ? { ...parsedSelection, options: { reasoningLevel } }
        : catalog
          ? (completeNewModelSelection(catalog, parsedSelection) ?? parsedSelection)
          : parsedSelection;
      logger.debug("[v4-draft-config] select model", {
        modelProvider,
        model,
        modelId,
        modelSelectionProviderId: modelSelection.providerId,
        modelSelectionModelId: modelSelection.modelId,
        workspacePath,
        workspaceIdentity: workspaceIdentity ?? null,
      });
      updateDraftConfig((current) => applyDraftModelSelection(current, modelSelection));
    },
    [
      modelSelectionView,
      modelSelectionRead.state,
      updateDraftConfig,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const handleDraftSelectThought = useCallback(
    (thought: string) => {
      updateDraftConfig((current) => {
        const providerId = current.modelSelection?.providerId ?? current.provider?.trim();
        const modelId = current.modelSelection?.modelId ?? current.model?.trim();
        if (!providerId || !modelId) return { ...current, thought };
        const reasoningLevel = thought.trim();
        return {
          ...current,
          modelSelection: {
            providerId,
            modelId,
            ...(reasoningLevel
              ? {
                  options: {
                    ...current.modelSelection?.options,
                    reasoningLevel,
                  },
                }
              : {}),
          },
          thought,
        };
      });
    },
    [updateDraftConfig],
  );

  const handleDraftSwitchMode = useCallback(
    (mode: string) => {
      if (!isCurrentScope()) return;
      const current = stateRef.current.draft;
      let next: V4ComposerDraft;
      if (mode === "plan" || mode === "plan-off") {
        const resolvedMode = submissionModeSchema.safeParse(draftConfigRef.current.mode);
        next = {
          ...current,
          // Session 的当前权限来自 Snapshot（draft.mode 可能为空），不能回退成 build。
          mode:
            current.mode === "plan"
              ? "build"
              : (current.mode ?? (resolvedMode.success ? resolvedMode.data : "build")),
          planEnabled: mode === "plan",
        };
      } else {
        // 模式与模型同属当前 scope；不再写全局偏好，避免别的任务反向覆盖。
        const parsed = submissionModeSchema.safeParse(mode);
        if (!parsed.success) return;
        next = { ...current, mode: parsed.data };
      }
      commitDraft(next, { persistConfig: true });
      draftConfigRef.current = {
        ...draftConfigRef.current,
        mode: next.mode,
        planEnabled: next.planEnabled ?? false,
      };
    },
    [commitDraft, isCurrentScope],
  );

  return {
    modelSelectionRead,
    draftConfig,
    draftConfigRef,
    resolveInitialDraftConfig,
    composerDraft: draft,
    updateComposerContent,
    replaceComposerDraft,
    promoteComposerDraft,
    captureAcceptedModelSelection,
    handleDraftSelectModel,
    handleDraftSelectThought,
    handleDraftSwitchMode,
  };
}

/** createSession payload 的草稿 config 片段（无选择时返回空对象，不携带 config 键）。 */
export function buildDraftCreateConfigPayload(
  draftConfig: Partial<SessionConfigState>,
  appFollowupMode?: SessionConfigState["followupMode"] | null,
): { config?: Partial<SessionConfigState> } {
  const config: Partial<SessionConfigState> = { ...draftConfig };
  if (appFollowupMode) {
    config.followupMode = appFollowupMode;
  }
  return Object.keys(config).length > 0 ? { config } : {};
}
