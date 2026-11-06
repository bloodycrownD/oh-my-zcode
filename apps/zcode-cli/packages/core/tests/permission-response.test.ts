import { describe, expect, it } from "vitest";
import { CoreErrorType, type PermissionUpdate } from "@zcode/contracts";
import { validatePermissionResponse } from "../src/tool/executor/permission-response.js";

const PROJECT_RULE_UPDATE: PermissionUpdate[] = [
  {
    behavior: "allow",
    rules: [{ ruleContent: "npm test", toolName: "Bash" }],
    type: "addRules",
  },
];

function thrownBy(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected the response validation to throw");
}

// SA-B14：单次确认 / 不提供始终允许时，应答夹带项目规则必须硬失败。
// 这两条是纯函数契约，executor 的两处调用点（guarded 与 approvalMode）都依赖它。
describe("validatePermissionResponse", () => {
  it("rejects project rules on a single-use response", () => {
    expect(
      thrownBy(() =>
        validatePermissionResponse({ decision: "allow", permissionUpdates: PROJECT_RULE_UPDATE }, true),
      ),
    ).toMatchObject({ type: CoreErrorType.InvalidInput });
  });

  it("accepts the same response when the ask is neither single-use nor no-always-allow", () => {
    expect(() =>
      validatePermissionResponse({ decision: "allow", permissionUpdates: PROJECT_RULE_UPDATE }, false),
    ).not.toThrow();
  });

  it("rejects project rules when the ask declares no-always-allow", () => {
    expect(
      thrownBy(() =>
        validatePermissionResponse(
          { decision: "allow", permissionUpdates: PROJECT_RULE_UPDATE },
          false,
          { noAlwaysAllow: true },
        ),
      ),
    ).toMatchObject({ type: CoreErrorType.InvalidInput });
  });

  // 反向约束：no-always-allow 只收窄持久化规则，会话级更新只由 once 约束。
  it("keeps session updates legal for a no-always-allow ask and illegal for a single-use ask", () => {
    expect(() =>
      validatePermissionResponse(
        { decision: "allow", sessionPermissionUpdates: PROJECT_RULE_UPDATE },
        false,
        { noAlwaysAllow: true },
      ),
    ).not.toThrow();
    expect(
      thrownBy(() =>
        validatePermissionResponse(
          { decision: "allow", sessionPermissionUpdates: PROJECT_RULE_UPDATE },
          true,
        ),
      ),
    ).toMatchObject({ type: CoreErrorType.InvalidInput });
  });
});
