// @vitest-environment jsdom
import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  persistV4ComposerConfig,
  readV4ComposerConfig,
} from "@/v4/composer/composerConfigStore.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  resolveComposerScope,
} from "@/v4/composer/composerDraftStore.js";
import { initializeNewTaskDraft } from "@/v4/composer/newTaskDraft.js";
import { prepareComposerRecentReceipt, readComposerRecent } from "@/lib/composerRecent.js";
import { PendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";

const scope = resolveComposerScope("project-1", undefined, "desktop");
const sentSelection = {
  providerId: "p",
  modelId: "chosen",
  options: { reasoningLevel: "high" },
};

// 目录里 chosen 不是第一项；New Task 回落时最容易暴露「排第一个的模型」。
const view = {
  revision: 1,
  preferredSelection: { providerId: "p", modelId: "first", options: { reasoningLevel: "low" } },
  providers: [
    {
      providerId: "p",
      providerName: "P",
      templateId: "t",
      config: { visibility: "visible" },
      models: [
        {
          modelId: "first",
          config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
        },
        {
          modelId: "chosen",
          config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
        },
      ],
    },
  ],
} as never;

beforeEach(() => localStorage.clear());

describe("bug 1：模式/模型不缓存", () => {
  it("REPRO 空正文时切模式/模型：文字草稿仍要求非空，配置由独立 store 持久化", () => {
    persistV4ComposerDraft(
      "/repo",
      undefined,
      "s-empty",
      { text: "", mode: "yolo", modelSelection: sentSelection },
      scope,
    );
    // B2：空正文不得写入文字草稿（否则侧栏会出现幽灵草稿行）。
    expect(
      readV4ComposerDraft("/repo", undefined, "s-empty", scope),
      "空正文不应留下文字草稿",
    ).toBeNull();

    persistV4ComposerConfig(
      "/repo",
      undefined,
      "s-empty",
      { mode: "yolo", modelSelection: sentSelection },
      scope,
    );
    const restored = readV4ComposerConfig("/repo", undefined, "s-empty", scope);
    expect(restored, "空正文的用户配置不应丢失").not.toBeNull();
    expect(restored?.mode).toBe("yolo");
    expect(restored?.modelSelection).toEqual(sentSelection);
  });

  it("sendText 携带 composer 回执时写 v2 Recent，New Task 恢复上次选择", () => {
    // 用真实 localStorage：registry 写入后，initializeNewTaskDraft 读的是同一份存储。
    const storage = localStorage;
    const registry = new PendingCommandRegistry({ storage, now: () => 1 });
    const receipt = prepareComposerRecentReceipt(scope, {
      mode: "yolo",
      modelSelection: sentSelection,
    });
    const envelope = {
      commandId: "cmd-send-text",
      clientId: "client",
      sessionId: "session-1",
      issuedAt: 1,
      type: "sendText",
      payload: { text: "hello" },
    } as never;

    // 源级断言：真实调用点必须让非 createSession 的提交也带 composer 回执。
    // 行为本身由真机 E2E 验证，这里防止调用点回退。
    // jsdom 环境下 import.meta.url 不是 file: URL，按仓库根解析源码路径。
    const sessionPaneSource = fs.readFileSync("packages/ui/src/v4/SessionPane.tsx", "utf8");
    expect(sessionPaneSource).toContain('type === "createSession" || recentReceipt');

    registry.record(envelope, {
      workspace: { workspacePath: "/repo" },
      composer: receipt,
    } as never);
    registry.applyAck(envelope, { status: "accepted" } as never);

    expect(
      readComposerRecent("/repo", undefined, storage, scope),
      "sendText 是常规发送路径，被接纳后必须留下 Recent",
    ).not.toBeNull();

    // 症状本身：没有 Recent 时，New Task 回落到 build + 目录第一项。
    const draft = initializeNewTaskDraft(
      { text: "", updatedAt: 0 },
      "/repo",
      undefined,
      view,
      scope,
    );
    expect(draft.mode, "应恢复上次发送的 yolo").toBe("yolo");
    expect(
      (draft.modelSelection as { modelId?: string } | undefined)?.modelId,
      "应恢复上次发送的 chosen",
    ).toBe("chosen");
  });

  it("对照 createSession 携带 composer 回执时 v2 Recent 会写入", () => {
    const storage = localStorage;
    const registry = new PendingCommandRegistry({ storage, now: () => 1 });
    const receipt = prepareComposerRecentReceipt(scope, {
      mode: "yolo",
      modelSelection: sentSelection,
    });
    const envelope = {
      commandId: "cmd-create-session",
      clientId: "client",
      sessionId: "session-2",
      issuedAt: 1,
      type: "createSession",
      payload: { firstInput: { text: "hello" } },
    } as never;

    registry.record(envelope, {
      workspace: { workspacePath: "/repo" },
      composer: receipt,
    } as never);
    registry.applyAck(envelope, { status: "accepted" } as never);

    expect(readComposerRecent("/repo", undefined, storage, scope)).not.toBeNull();
  });
});
