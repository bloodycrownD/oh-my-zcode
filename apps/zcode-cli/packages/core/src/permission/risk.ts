import type { RiskLevel } from "@zcode/contracts";

/** 风险等级的全序：值越大越严。写死顺序，避免比较时再猜字符串语义。 */
const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * 取两档风险中更严的一档（`low < medium < high < critical`）。
 * 用于把多个判定来源合并成一份决策时不降级——例如 doom-loop ask 与 guarded
 * 危险命令的单次确认合并时，危险命令的 high 不能被 doom 自报的 medium 覆盖。
 */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}
