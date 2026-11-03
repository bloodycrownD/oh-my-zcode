import { describe, expect, it } from "vitest";
import type { ModelSelectionView } from "@zcode/services";
import { resolveComposerSelection } from "@/v4/composer/resolveComposerSelection.js";

const preferred = {
  providerId: "p",
  modelId: "m1",
  options: { reasoningLevel: "low" },
};

function view(overrides: Partial<ModelSelectionView> = {}): ModelSelectionView {
  return {
    revision: 1,
    preferredSelection: preferred,
    providers: [
      {
        providerId: "p",
        providerName: "P",
        templateId: "t",
        config: { visibility: "visible" },
        models: [
          {
            modelId: "m1",
            config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
          },
          {
            modelId: "plain",
            config: { optionSpecs: { reasoningLevel: { values: ["low"] } } },
          },
        ],
      },
    ],
    ...overrides,
  } as ModelSelectionView;
}

describe("resolveComposerSelection", () => {
  it("有效选择原样保留，以 View 的 effectiveSelection 为准", () => {
    const selection = { providerId: "p", modelId: "m1", options: { reasoningLevel: "high" } };
    const ready = view({ effectiveSelection: selection });
    const resolved = resolveComposerSelection({ view: ready, draftSelection: selection });
    expect(resolved.source).toBe("draft");
    expect(resolved.selection).toEqual(selection);
  });

  it.each(["reasoning-level-missing", "reasoning-level-not-supported"] as const)(
    "%s 用 completeNewModelSelection 补同一 provider/model 的有效档",
    (selectionIssue) => {
      const stale = { providerId: "p", modelId: "m1", options: { reasoningLevel: "max" } };
      const ready = view({
        selectionIssue,
        effectiveSelection: { providerId: "p", modelId: "m1" },
      });
      const resolved = resolveComposerSelection({ view: ready, draftSelection: stale });
      // 补的是该模型现有档位里的最高档，而不是目录首选。
      expect(resolved.source).toBe("reasoning-completed");
      expect(resolved.selection).toEqual({
        providerId: "p",
        modelId: "m1",
        options: { reasoningLevel: "high" },
      });
      expect(stale.options.reasoningLevel).toBe("max");
    },
  );

  it("Root 草稿硬失效选择回落到 View preferredSelection", () => {
    const stale = { providerId: "gone", modelId: "m1" };
    const ready = view({ selectionIssue: "provider-not-found", effectiveSelection: null });
    expect(resolveComposerSelection({ view: ready, draftSelection: stale })).toEqual({
      selection: preferred,
      source: "preferred",
    });
    const modelGone = view({ selectionIssue: "model-not-found", effectiveSelection: null });
    expect(resolveComposerSelection({ view: modelGone, draftSelection: stale }).selection).toEqual(
      preferred,
    );
  });

  it("Session 硬失效选择优先用 Session 有效选择，再退到 preferred", () => {
    const sessionSelection = {
      providerId: "p",
      modelId: "m1",
      options: { reasoningLevel: "high" },
    };
    const stale = { providerId: "gone", modelId: "m1" };
    const ready = view({ selectionIssue: "provider-not-found", effectiveSelection: null });
    expect(
      resolveComposerSelection({ view: ready, draftSelection: stale, sessionSelection }),
    ).toEqual({ selection: sessionSelection, source: "session" });
    expect(
      resolveComposerSelection({
        view: ready,
        draftSelection: stale,
        sessionSelection: { providerId: "gone", modelId: "m1" },
      }).selection,
    ).toEqual(preferred);
  });

  it("Session 草稿没有选择时用 SessionConfig 选择，失效时用 preferred", () => {
    const sessionSelection = {
      providerId: "p",
      modelId: "m1",
      options: { reasoningLevel: "high" },
    };
    const ready = view({ selectionIssue: "selection-missing", effectiveSelection: null });
    expect(resolveComposerSelection({ view: ready, sessionSelection })).toEqual({
      selection: sessionSelection,
      source: "session",
    });
    expect(
      resolveComposerSelection({
        view: ready,
        sessionSelection: { providerId: "gone", modelId: "m1" },
      }).selection,
    ).toEqual(preferred);
  });

  it("View 迟到 ready 时同一输入重新解析：先保留原意图，ready 后修复", () => {
    const stale = { providerId: "gone", modelId: "m1" };
    // 未 ready 不能把失效当事实，也不清掉用户选择。
    expect(resolveComposerSelection({ view: null, draftSelection: stale })).toEqual({
      selection: stale,
      source: "draft",
    });
    const ready = view({ selectionIssue: "provider-not-found", effectiveSelection: null });
    expect(resolveComposerSelection({ view: ready, draftSelection: stale }).selection).toEqual(
      preferred,
    );
  });

  it("没有 View 时保留草稿或 Session 原意图；两者都没有则 unresolved", () => {
    const draftSelection = { providerId: "p", modelId: "m1" };
    expect(resolveComposerSelection({ view: null, draftSelection })).toEqual({
      selection: draftSelection,
      source: "draft",
    });
    expect(resolveComposerSelection({ view: null, sessionSelection: draftSelection })).toEqual({
      selection: draftSelection,
      source: "session",
    });
    expect(resolveComposerSelection({ view: null })).toEqual({ source: "unresolved" });
  });

  it("目录没有可用候选时返回 unresolved，交给提交门禁阻断", () => {
    const empty = view({
      preferredSelection: undefined,
      providers: [],
      selectionIssue: "provider-not-found",
      effectiveSelection: null,
    });
    expect(
      resolveComposerSelection({
        view: empty,
        draftSelection: { providerId: "gone", modelId: "m" },
      }),
    ).toEqual({ source: "unresolved" });
  });

  it("草稿选择缺失时 Root 使用 preferred，Session 选择优先", () => {
    const ready = view({
      selectionIssue: "selection-missing",
      effectiveSelection: null,
    });
    expect(resolveComposerSelection({ view: ready })).toEqual({
      selection: preferred,
      source: "preferred",
    });
    const sessionSelection = {
      providerId: "p",
      modelId: "plain",
      options: { reasoningLevel: "low" },
    };
    expect(resolveComposerSelection({ view: ready, sessionSelection }).selection).toEqual(
      sessionSelection,
    );
  });
});
