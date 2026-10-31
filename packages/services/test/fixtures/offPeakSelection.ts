import type { ModelSelectionView } from "@zcode/provider";
// FORK(upgrade-316)：OFF_PEAK_PROVIDER_IDS 已随 off-peak 计费面删除；本 fixture 只是为
// modelSelectionReadinessSource 提供一份通用双 Provider 视图，改用字面量 providerId。

/** 两个域同时存在，用于锁定工具只能选择当前账号域，不能按 Provider 顺序猜。 */
export function offPeakSelectionView(
  values: readonly string[] = ["disabled", "high", "max"],
): ModelSelectionView {
  return {
    revision: 1,
    providers: (["bigmodel", "zai"] as const).map((family) => ({
      providerId: family === "zai" ? "fixture:zai" : "fixture:bigmodel",
      config: { visibility: "hidden" },
      models: [family === "zai" ? "ZAI-only" : "BigModel-only", "GLM-5.2"].map((modelId) => ({
        modelId,
        config: {
          enabled: true,

          properties: {
            requiresMfjsToolSchema: false,
            contextWindow: 200000,
            inputFormat: {
              supportsText: true,
              supportsImage: false,
              supportsVideo: false,
              supportsAudio: false,
              supportsPdf: false,
            },
            outputFormat: { supportsText: true },
            supportsToolCall: true,
            supportsJsonSchemaOutput: false,
            supportsNativeWebSearch: false,
            supportsMidConversationSystem: false,
          },
          optionSpecs: {
            reasoningLevel: { values, map: "{}" },
            maxOutputTokens: { max: 32000, map: "{}" },
          },
        },
      })),
    })),
  };
}
