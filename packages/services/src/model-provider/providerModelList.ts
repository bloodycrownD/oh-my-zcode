import { createServiceLogger } from "../logger/serviceLogger.js";
import { normalizeApiKeyForHeader } from "../providers/api/apiKeyHeaders.js";

/** 拉取模型列表请求的默认超时时间（与设置页交互预期匹配）。 */
export const PROVIDER_MODEL_LIST_TIMEOUT_MS = 15_000;

/** Anthropic Messages 协议要求固定版本头；缺失时列表端点会直接拒绝。 */
const ANTHROPIC_VERSION = "2023-06-01";

export interface ProviderModelListInput {
  readonly providerId: string;
}

export interface ProviderModelListResult {
  readonly models: string[];
}

/**
 * Provider 有效配置里拉取模型列表所需的字段。
 * apiKey 与 headers 由主机本地读取并注入请求——renderer 不把它们作为该 RPC 的参数，
 * 返回值也只有模型 ID（renderer 表单本身持有 Key，此处不构成「Key 不进 renderer」）。
 */
export interface ProviderModelListSource {
  // Provider Overlay 的字段可能显式为 null（未覆盖），按「未配置」处理。
  readonly apiType?: string | null;
  readonly baseUrl?: string | null;
  readonly apiKey?: string | null;
  /** legacy 导入保留的自定义请求头；同名显式鉴权头随后覆盖它。 */
  readonly headers?: Record<string, string> | null;
}

export type ProviderModelListSourceReader = (
  providerId: string,
) => ProviderModelListSource | undefined;

export type ProviderModelLister = (
  input: ProviderModelListInput,
) => Promise<ProviderModelListResult>;

/**
 * 从 Provider 的 OpenAI 兼容端点（含 Anthropic Messages）读取可选模型 ID。
 * 网络出口必须使用 Host 侧 transport（renderer 有 CORS 且无代理配置），
 * 日志与错误信息一律不包含 API Key 与自定义头值。
 *
 * 路径兼容（各家网关差异实测）：Anthropic 协议的消息端点是 `{base}/v1/messages`，
 * 列表按同约定先试 `/v1/models`；但部分双面网关（如 DeepSeek 的 `/anthropic`）只在
 * OpenAI 面提供列表——404/405 时依次回落，最终尝试源站根路径的 OpenAI 风格端点
 * （同一 API Key 在两面通用）。OpenAI 协议先试 `/models` 再补 `/v1/models`。
 */
export function createProviderModelLister(dependencies: {
  readonly readSource: ProviderModelListSourceReader;
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
}): ProviderModelLister {
  const log = createServiceLogger("provider-model-list");
  const timeoutMs = dependencies.timeoutMs ?? PROVIDER_MODEL_LIST_TIMEOUT_MS;

  return async (input) => {
    const source = dependencies.readSource(input.providerId);
    if (!source) {
      throw new Error(`供应商不存在: ${input.providerId}`);
    }

    const baseUrl = source.baseUrl?.trim().replace(/\/+$/, "") ?? "";
    if (!baseUrl) {
      throw new Error("该供应商未配置 Base URL，无法拉取模型列表。");
    }
    const candidates = buildModelListCandidates(baseUrl, source.apiType);

    const apiKey = source.apiKey?.trim() ? normalizeApiKeyForHeader(source.apiKey) : "";
    const anthropicProtocol = source.apiType === "anthropic-messages";
    const customHeaders = readCustomHeaders(source.headers);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // 超时覆盖整个候选链（含响应体读取结束），避免服务端只发响应头就挂住连接。
    try {
      const tried: string[] = [];
      let lastStatus: number | null = null;
      for (const candidate of candidates) {
        const response = await fetchCandidate(
          dependencies.fetch,
          candidate,
          { apiKey, anthropicProtocol, customHeaders },
          timeoutMs,
          controller.signal,
        );
        if (response.ok) {
          const models = await readModelIdsFromResponse(
            response,
            input.providerId,
            log,
            timeoutMs,
            controller.signal,
          );
          return { models };
        }
        lastStatus = response.status;
        // 404/405 = 该路径不存在，换下一条候选；其它状态码（鉴权/限流/服务端错误）
        // 与路径无关，重试没有意义，直接抛出。
        if (response.status === 404 || response.status === 405) {
          tried.push(candidate.label);
          continue;
        }
        const hint =
          response.status === 401 || response.status === 403 ? "（请检查 API Key 是否正确）" : "";
        throw new Error(`拉取模型列表失败：HTTP ${response.status}${hint}`);
      }
      throw new Error(
        `未找到模型列表端点（已尝试 ${tried.join("、")}，最后状态 HTTP ${lastStatus ?? 404}）。`,
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

/** 单条候选端点：label 用于错误提示（不含完整 URL，避免泄露内网地址细节）。 */
interface ModelListCandidate {
  readonly url: string;
  readonly label: string;
  /** protocol=按 api 类型约定发头；bearer=源站 OpenAI 面固定 Bearer。 */
  readonly auth: "protocol" | "bearer";
}

function buildModelListCandidates(
  baseUrl: string,
  apiType: string | null | undefined,
): ModelListCandidate[] {
  const isAnthropic = apiType === "anthropic-messages";
  let originBase = "";
  try {
    const origin = new URL(baseUrl);
    originBase = `${origin.protocol}//${origin.host}`;
  } catch {
    throw new Error("该供应商的 Base URL 不是合法地址。");
  }
  const candidates: ModelListCandidate[] = isAnthropic
    ? [
        // Anthropic 原生（api.anthropic.com）与带路径前缀的网关（如 openrouter.ai/api）
        { url: `${baseUrl}/v1/models`, label: "/v1/models", auth: "protocol" },
        { url: `${baseUrl}/models`, label: "/models", auth: "protocol" },
        // 双面网关（如 DeepSeek 的 /anthropic 面没有列表），源站 OpenAI 面兜底
        { url: `${originBase}/v1/models`, label: "源站 /v1/models", auth: "bearer" },
        { url: `${originBase}/models`, label: "源站 /models", auth: "bearer" },
      ]
    : [
        { url: `${baseUrl}/models`, label: "/models", auth: "protocol" },
        { url: `${baseUrl}/v1/models`, label: "/v1/models", auth: "protocol" },
        // OpenAI 类型也可能配了带路径前缀的基址（如误配到 /anthropic 面），
        // 基址候选全 404 时同样回落源站根路径。
        { url: `${originBase}/v1/models`, label: "源站 /v1/models", auth: "bearer" },
        { url: `${originBase}/models`, label: "源站 /models", auth: "bearer" },
      ];
  const seen = new Set<string>();
  return candidates.filter((candidate) =>
    seen.has(candidate.url) ? false : (seen.add(candidate.url), true),
  );
}

/** 单条候选请求的鉴权材料；自定义头来自配置，显式鉴权头同名时覆盖它。 */
interface ModelListRequestAuth {
  readonly apiKey: string;
  readonly anthropicProtocol: boolean;
  readonly customHeaders?: Record<string, string>;
}

/** 只接受字符串字典；非字符串值不进入请求，避免畸形配置把非法头带出去。 */
function readCustomHeaders(
  headers: Record<string, string> | null | undefined,
): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  const entries = Object.entries(headers).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function timeoutMessage(timeoutMs: number): string {
  const duration = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} 毫秒`;
  return `拉取模型列表超时（${duration}）。`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function fetchCandidate(
  fetchImpl: typeof fetch,
  candidate: ModelListCandidate,
  auth: ModelListRequestAuth,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Response> {
  // 先铺开自定义头，再写显式鉴权头：同名（HTTP 头名大小写不敏感，统一转小写）
  // 时以本端点的鉴权为准，自定义头不得覆盖 Key——headers 可能含 x-api-key 类秘密，
  // 日志与错误一律不输出取值。
  const headers: Record<string, string> = { accept: "application/json" };
  for (const [name, value] of Object.entries(auth.customHeaders ?? {})) {
    const normalizedName = name.trim().toLowerCase();
    if (normalizedName) {
      headers[normalizedName] = value;
    }
  }
  if (auth.apiKey) {
    headers.authorization = `Bearer ${auth.apiKey}`;
    if (auth.anthropicProtocol && candidate.auth === "protocol") {
      // Anthropic SDK 标准头；与 Bearer 双发，只认其中一种的网关不受影响。
      headers["x-api-key"] = auth.apiKey;
      headers["anthropic-version"] = ANTHROPIC_VERSION;
    }
  }
  try {
    return await fetchImpl(candidate.url, { method: "GET", headers, signal });
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      throw new Error(timeoutMessage(timeoutMs));
    }
    throw new Error(
      `拉取模型列表失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readModelIdsFromResponse(
  response: Response,
  providerId: string,
  log: ReturnType<typeof createServiceLogger>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string[]> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    // 全链超时覆盖响应体读取：这里的中断先按超时译文，否则才是响应体不是合法 JSON。
    if (signal.aborted || isAbortError(error)) {
      throw new Error(timeoutMessage(timeoutMs));
    }
    throw new Error(`拉取模型列表失败：HTTP ${response.status}，响应不是合法 JSON。`);
  }
  const models = readModelIds(payload);
  log.debug(undefined, "provider model list resolved", {
    providerId,
    count: models.length,
  });
  return models;
}

/** OpenAI 与 Anthropic 的列表响应同形：模型 ID 位于 data[].id。 */
function readModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return [];
  }
  const ids = new Set<string>();
  for (const entry of data) {
    const rawId =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"
          ? (entry as { id: string }).id
          : "";
    // 端点可能返回空串或纯空白 ID；这类条目不能进入可选列表。
    const normalized = rawId.trim();
    if (normalized) {
      ids.add(normalized);
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}
