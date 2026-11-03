import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearV4ComposerConfig,
  getV4ComposerConfigStorageKey,
  persistV4ComposerConfig,
  readV4ComposerConfig,
} from "@/v4/composer/composerConfigStore.js";
import { V4_DRAFT_SCOPE_ROOT } from "@/v4/composer/composerDraftStore.js";

const selection = {
  providerId: "personal-provider",
  modelId: "model-a",
  options: { reasoningLevel: "high" },
};
const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
};
const workspace = "/workspace";
const read = (scope = "session-a") => readV4ComposerConfig(workspace, undefined, scope);

describe("Composer 配置独立持久化", () => {
  beforeEach(() => {
    values.clear();
    vi.stubGlobal("window", { localStorage: storage });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("空正文下保存模式、模型与 Plan，并在同 scope 读回", () => {
    persistV4ComposerConfig(workspace, undefined, V4_DRAFT_SCOPE_ROOT, {
      mode: "yolo",
      planEnabled: true,
      modelSelection: selection,
    });
    expect(read(V4_DRAFT_SCOPE_ROOT)).toMatchObject({
      mode: "yolo",
      planEnabled: true,
      modelSelection: selection,
    });
  });

  it("plan 枚举归一化为 build + planEnabled", () => {
    persistV4ComposerConfig(workspace, undefined, "session-a", { mode: "plan" });
    expect(read()).toMatchObject({ mode: "build", planEnabled: true });
  });

  it("缺失键与损坏 JSON 返回 null，读取不写盘", () => {
    expect(read()).toBeNull();
    const key = getV4ComposerConfigStorageKey(workspace);
    storage.setItem(key, "{not json");
    const write = vi.spyOn(storage, "setItem");
    const remove = vi.spyOn(storage, "removeItem");
    expect(read()).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("空配置与 Plan=false 不写记录，清除后整 key 移除", () => {
    const key = getV4ComposerConfigStorageKey(workspace);
    persistV4ComposerConfig(workspace, undefined, V4_DRAFT_SCOPE_ROOT, {});
    expect(storage.getItem(key)).toBeNull();
    persistV4ComposerConfig(workspace, undefined, V4_DRAFT_SCOPE_ROOT, { planEnabled: false });
    expect(storage.getItem(key)).toBeNull();
    persistV4ComposerConfig(workspace, undefined, V4_DRAFT_SCOPE_ROOT, { mode: "edit" });
    expect(read(V4_DRAFT_SCOPE_ROOT)?.mode).toBe("edit");
    clearV4ComposerConfig(workspace, undefined, V4_DRAFT_SCOPE_ROOT);
    expect(read(V4_DRAFT_SCOPE_ROOT)).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });

  it("scope 与 workspace identity 隔离：Root、Session、远端与同目录项目互不覆盖", () => {
    const p = { clientNamespace: "desktop", hostId: "local", projectId: "p" };
    const q = { ...p, projectId: "q" };
    persistV4ComposerConfig(workspace, undefined, V4_DRAFT_SCOPE_ROOT, { mode: "yolo" }, p);
    persistV4ComposerConfig(workspace, undefined, V4_DRAFT_SCOPE_ROOT, { mode: "build" }, q);
    persistV4ComposerConfig(workspace, undefined, "session-a", { mode: "edit" });
    persistV4ComposerConfig(workspace, "remote-a", "session-a", { mode: "guarded" });
    expect(readV4ComposerConfig(workspace, undefined, V4_DRAFT_SCOPE_ROOT, p)?.mode).toBe("yolo");
    expect(readV4ComposerConfig(workspace, undefined, V4_DRAFT_SCOPE_ROOT, q)?.mode).toBe("build");
    expect(read("session-a")?.mode).toBe("edit");
    expect(readV4ComposerConfig(workspace, "remote-a", "session-a")?.mode).toBe("guarded");
    expect(read("session-b")).toBeNull();
  });

  it("坏模型 options 只丢选项叶子，保留可确定的模型身份", () => {
    const key = getV4ComposerConfigStorageKey(workspace);
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        scopes: { "session-a": { modelSelection: { ...selection, options: 7 }, updatedAt: 1 } },
      }),
    );
    expect(read()?.modelSelection).toEqual({
      providerId: selection.providerId,
      modelId: selection.modelId,
    });
  });

  it("存储抛错不能让 Composer 崩溃", () => {
    vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    expect(() => read()).not.toThrow();
    expect(read()).toBeNull();
    expect(() =>
      persistV4ComposerConfig(workspace, undefined, "session-a", { mode: "build" }),
    ).not.toThrow();
  });
});
