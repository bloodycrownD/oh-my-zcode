import { describe, expect, it } from "vitest";
import { buildTurnManifestEntry } from "../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/turn-manifest-entry.js";
import { selectColdRowPage } from "../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/session-row-manifest.js";

// 复刻 model-only 轮：turn 由一条 user 消息触发，但该 user 消息没有可见 userInput row，
// 轮内第一条能映射到 messageId 的 row 是 assistantText。
const modelOnlyRows = [
  { kind: "turnHeader", rowId: 1, turnId: "msg_user", state: "completed" },
  { kind: "assistantText", rowId: 2, turnId: "msg_user", text: "answer" },
] as never;

describe("bug 2：长会话截断（manifest 游标错位）", () => {
  it("REPRO model-only 轮的 firstMessageId 必须是触发该轮的 user 消息", () => {
    const entry = buildTurnManifestEntry({
      turnId: "msg_user",
      triggerMessageId: "msg_user",
      ordinal: 1,
      rows: modelOnlyRows,
      messageIdForRow: (rowId) => (rowId === 2 ? "msg_assistant" : undefined),
      rowCountSource: "projection",
      branchGeneration: 1,
    });

    expect(entry).not.toBeNull();
    expect(
      entry?.turn.firstMessageId,
      "firstMessageId 落到轮内 assistant 上，正文读游标会从轮中间开始",
    ).toBe("msg_user");
  });

  it("REPRO messageIds 必须包含触发该轮的 user 消息", () => {
    const entry = buildTurnManifestEntry({
      turnId: "msg_user",
      triggerMessageId: "msg_user",
      ordinal: 1,
      rows: modelOnlyRows,
      messageIdForRow: (rowId) => (rowId === 2 ? "msg_assistant" : undefined),
      rowCountSource: "projection",
      branchGeneration: 1,
    });

    expect(
      entry?.turn.messageIds,
      "缺 trigger messageId 会让页内 messageId 过滤漏掉该轮",
    ).toContain("msg_user");
  });

  it("REPRO 页游标不能是轮内 assistant，否则整页物化缺行", () => {
    // 关键：游标必须由真实的 manifest 构建结果驱动，而不是手写一个坏值；
    // 这样修好 builder 之后，这条用例会跟着转绿。
    const entry = buildTurnManifestEntry({
      turnId: "msg_user",
      triggerMessageId: "msg_user",
      ordinal: 1,
      rows: modelOnlyRows,
      messageIdForRow: (rowId) => (rowId === 2 ? "msg_assistant" : undefined),
      rowCountSource: "projection",
      branchGeneration: 1,
    });
    expect(entry).not.toBeNull();

    const page = selectColdRowPage(
      {
        turns: [
          {
            turnId: "msg_user",
            ordinal: 1,
            rowCount: 2,
            firstMessageId: entry?.turn.firstMessageId ?? null,
          },
          {
            turnId: "msg_next",
            ordinal: 2,
            rowCount: 1,
            firstMessageId: "msg_next",
          },
        ],
        firstRowId: 1,
        rowIdBaseByTurnId: new Map([
          ["msg_user", 1],
          ["msg_next", 3],
        ]),
        turnIdByMessageId: new Map([
          ["msg_assistant", "msg_user"],
          ["msg_next", "msg_next"],
        ]),
      } as never,
      { beforeRowId: 3, limit: 1 },
    );

    expect(page.kind).toBe("page");
    if (page.kind === "page") {
      expect(
        page.plan.limitBefore,
        "正文读下界应含页首轮的 user 消息，不能从轮内 assistant 开始",
      ).toBe("msg_user");
    }
  });
});
