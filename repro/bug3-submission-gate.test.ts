import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveEffectiveModelSelection } from "../packages/provider/src/effective-model-selection.js";
import { completeNewModelSelection } from "../packages/provider/src/model-selection-config.js";
import { createComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";

// 当前目录只支持 low 档；草稿里残留的是旧目录的 high 档。
const registry = {
  providers: [
    {
      providerId: "p",
      config: { visibility: "visible" },
      models: [
        {
          modelId: "m",
          config: { optionSpecs: { reasoningLevel: { values: ["low"] } } },
        },
      ],
    },
  ],
} as never;

const staleSelection = {
  providerId: "p",
  modelId: "m",
  options: { reasoningLevel: "high" },
};

describe("bug 3：无法发送（草稿模型选择失效 → 提交门禁静默为 null）", () => {
  it("失效档位按主动选模型规则补档后，提交配置不再为 null", () => {
    const effective = resolveEffectiveModelSelection({
      selection: staleSelection,
      registry,
    });

    // 解析层的事实：校验失败时只保留 provider/model，丢掉 options。
    expect(effective.effectiveSelection).not.toBeNull();
    expect(effective.effectiveSelection?.options).toBeUndefined();

    // 修复点：View ready 且明确 reasoning-level-* 时补最高有效档。派生逻辑已抽到
    // resolveComposerSelection，这里用同一 helper 复现结果，并用源级断言防止调用点回退。
    const source = fs.readFileSync(
      new URL("../packages/ui/src/v4/composer/resolveComposerSelection.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('"reasoning-level-missing"');
    expect(source).toContain('"reasoning-level-not-supported"');
    expect(source).toContain("completeNewModelSelection");
    const hookSource = fs.readFileSync(
      new URL("../packages/ui/src/v4/composer/useDraftConfigControl.ts", import.meta.url),
      "utf8",
    );
    expect(hookSource).toContain("resolveComposerSelection({");

    const completed = completeNewModelSelection(registry, effective.effectiveSelection as never);
    expect(completed?.options?.reasoningLevel).toBe("low");

    const config = createComposerSubmissionConfig(
      {
        mode: "yolo",
        planEnabled: false,
        modelSelection: completed as never,
      },
      registry,
    );

    expect(config, "修复后按钮与 Enter 都不能再因为档位失效而静默为 null").not.toBeNull();
  });

  it("对照 合法档位可以构造提交配置", () => {
    const config = createComposerSubmissionConfig(
      {
        mode: "yolo",
        planEnabled: false,
        modelSelection: {
          providerId: "p",
          modelId: "m",
          options: { reasoningLevel: "low" },
        } as never,
      },
      registry,
    );
    expect(config).not.toBeNull();
  });
});
