import { ModelSelectionFacade, type ProviderRegistryFacadeSource } from "@zcode/provider";
import { resolveLegacyReasoningLevel } from "./legacy-reasoning-level.js";

/** Host 与受管理 Worker 共用身份分类；解析仍由纯 Provider Facade 负责。 */
export function createNodeModelSelectionFacade(
  source: ProviderRegistryFacadeSource,
): ModelSelectionFacade {
  // FORK（D-4）：账号 Overlay 整删后不再需要 provider 身份分类，仅保留档位归一化。
  return new ModelSelectionFacade(source, resolveLegacyReasoningLevel);
}
