// composer parity：v4 composer 的 per-scope 配置持久化（mode / modelSelection / planEnabled）。
//
// 2026-11-03 CR 修复：配置与文字草稿分离。文字草稿继续遵守
// docs/ui/composer-text-draft-persistence.md 的「无正文不算草稿」规则（composerDraftStore
// 只保存非空白正文），这里只保存用户显式选择的配置，避免空正文写入制造幽灵草稿行。
// 键空间与文字草稿一样按 workspace identity 隔离，文件结构同为 version + scopes；
// Root 草稿按项目 scope 隔离，正式 session 按 workspace identity + session id 隔离。
// 缺失键、损坏 JSON 或空配置都返回 null，不抛错、不在读取时写盘。
import { logger } from "@/logger.js";
import { modelSelectionSchema, type ModelSelection } from "@zcode/shared";
import { submissionModeSchema, type SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import { V4_DRAFT_SCOPE_ROOT, composerScopeKey, type ComposerScope } from "./composerDraftStore.js";

export interface V4ComposerConfig {
  /** plan 已归一化为 build + planEnabled，读取方不需要再识别 plan 枚举。 */
  mode?: SubmissionMode;
  planEnabled?: boolean;
  modelSelection?: ModelSelection;
  updatedAt: number;
}

interface V4ComposerConfigFile {
  version: 1;
  scopes: Record<string, V4ComposerConfig>;
}

const STORAGE_KEY_PREFIX = "zcode-v4-composer-config:v1:";

function workspaceScopeKey(workspacePath: string, workspaceIdentity?: string): string {
  return workspaceIdentity?.trim() || workspacePath;
}

/** 正式 session 与未归类 Root 共用 workspace key；项目 Root 使用项目隔离 key。 */
export function getV4ComposerConfigStorageKey(
  workspacePath: string,
  workspaceIdentity?: string,
): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(
    workspaceScopeKey(workspacePath, workspaceIdentity),
  )}`;
}

function configStorageKey(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
  scope?: ComposerScope,
): string {
  // 与 composerDraftStore 一致：项目 Root 按组织归属隔离，正式 session 仍按工作区隔离。
  if (scopeId === V4_DRAFT_SCOPE_ROOT && scope) {
    return `${STORAGE_KEY_PREFIX}project:${encodeURIComponent(composerScopeKey(scope))}`;
  }
  return getV4ComposerConfigStorageKey(workspacePath, workspaceIdentity);
}

const warnedStorageKeys = new Set<string>();

function warnStorageFailure(key: string, error: unknown) {
  if (warnedStorageKeys.has(key)) return;
  warnedStorageKeys.add(key);
  logger.warn("[v4-composer-config] 配置持久化访问失败", {
    error: error instanceof Error ? error.message : String(error),
    key,
  });
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfig(value: unknown): V4ComposerConfig | null {
  if (!isRecord(value)) return null;
  const parsedMode = submissionModeSchema.safeParse(value.mode);
  // 与文字草稿读取保持同一归一化：历史 plan 枚举拆成 build + planEnabled。
  const mode = parsedMode.success
    ? parsedMode.data === "plan"
      ? ("build" as const)
      : parsedMode.data
    : undefined;
  const planEnabled =
    typeof value.planEnabled === "boolean"
      ? value.planEnabled
      : parsedMode.success
        ? parsedMode.data === "plan"
        : undefined;
  const selection = modelSelectionSchema.safeParse(value.modelSelection);
  // 坏 options 不应连带丢掉可确定的模型身份；与 composerDraftStore 同口径。
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
  const config: V4ComposerConfig = {
    ...(mode ? { mode } : {}),
    ...(planEnabled !== undefined ? { planEnabled } : {}),
    ...(modelSelection ? { modelSelection } : {}),
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
  // planEnabled=false 单独存在不构成配置；只有 mode/模型/显式开启 Plan 才值得落盘。
  return config.mode || config.modelSelection || config.planEnabled === true ? config : null;
}

function readConfigFile(key: string): V4ComposerConfigFile {
  try {
    const raw = getStorage()?.getItem(key);
    if (!raw) return { version: 1, scopes: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.scopes)) {
      return { version: 1, scopes: {} };
    }
    return {
      version: 1,
      scopes: Object.fromEntries(
        Object.entries(parsed.scopes).flatMap(([scopeId, value]) => {
          const config = readConfig(value);
          return config ? [[scopeId, config]] : [];
        }),
      ),
    };
  } catch (error) {
    warnStorageFailure(key, error);
    return { version: 1, scopes: {} };
  }
}

function writeConfigFile(key: string, file: V4ComposerConfigFile): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    const serialized = Object.keys(file.scopes).length ? JSON.stringify(file) : null;
    if (storage.getItem(key) === serialized) return true;
    if (serialized === null) storage.removeItem(key);
    else storage.setItem(key, serialized);
    warnedStorageKeys.delete(key);
    return true;
  } catch (error) {
    // 配额/隐私模式失败只降级为不持久化，不影响当前编辑与发送。
    warnStorageFailure(key, error);
    return false;
  }
}

export function readV4ComposerConfig(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
  scope?: ComposerScope,
): V4ComposerConfig | null {
  const key = configStorageKey(workspacePath, workspaceIdentity, scopeId, scope);
  return readConfigFile(key).scopes[scopeId] ?? null;
}

export interface V4ComposerConfigInput {
  mode?: SubmissionMode;
  planEnabled?: boolean;
  modelSelection?: ModelSelection;
}

export function persistV4ComposerConfig(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
  config: V4ComposerConfigInput,
  scope?: ComposerScope,
): boolean {
  const key = configStorageKey(workspacePath, workspaceIdentity, scopeId, scope);
  const file = readConfigFile(key);
  // 写入前走同一归一化，避免把 plan 枚举或坏模型写进存储。
  const normalized = readConfig({ ...config, updatedAt: Date.now() });
  if (!normalized) delete file.scopes[scopeId];
  else file.scopes[scopeId] = normalized;
  return writeConfigFile(key, file);
}

export function clearV4ComposerConfig(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
  scope?: ComposerScope,
): boolean {
  const key = configStorageKey(workspacePath, workspaceIdentity, scopeId, scope);
  const file = readConfigFile(key);
  delete file.scopes[scopeId];
  return writeConfigFile(key, file);
}
