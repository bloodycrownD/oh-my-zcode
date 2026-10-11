// T-SVC-2（upstream-v3.15.1-backport，spec §2.1 P4 #20）：session/read 的 `contentProfile="index"`
// 裁剪面——大载荷字段被剥离、结构面逐字段不变，且**不修改入参**（full 侧继续拿原对象）。
//
// 失效形态：task index 每次 turn 完成 / 改标题 / 变可见都 existing-only 读一次 session，旧实现拿
// 回完整历史（长 session 单行可达 ~15MB），host stdio 与 JSON 解析被打满。裁剪只针对 index 读面。
//
// 放 test/ 而不是 src/：测试是纯消费方不进产物（先例见同目录 apply.test.ts / previewText.test.ts）。
import assert from "node:assert/strict";
import test from "node:test";
import { zcodeSessionReadParamsSchema } from "../src/zcode-protocol/index.js";
import { elideSessionSnapshotForIndex } from "../src/zcode-session-content-profile.js";

/** 断言用的扁平 part 形状（运行时数据；schema 面的完备性由最后一条用例覆盖）。 */
interface FixturePart {
  id: string;
  type: string;
  text?: string;
  url?: string;
  callId?: string;
  mediaType?: string;
  name?: string;
  state?: {
    status: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    metadata?: unknown;
  };
}

interface FixtureSnapshot {
  session: { sessionId: string };
  messages: Array<{ info: { messageId: string; role: string }; parts: FixturePart[] }>;
}

function snapshot(): FixtureSnapshot {
  return {
    session: { sessionId: "s-1" },
    messages: [
      {
        info: { messageId: "m-1", role: "assistant" },
        parts: [
          { id: "p-reasoning", type: "reasoning", text: "长推理文本" },
          { id: "p-text", type: "text", text: "用户可见正文" },
          {
            id: "p-tool",
            type: "tool",
            callId: "call-1",
            state: {
              status: "completed",
              input: { path: "/big/file.txt" },
              output: "巨型工具输出",
              metadata: { bytes: 1024 },
            },
          },
          {
            id: "p-file",
            type: "file",
            url: "data:image/png;base64,AAAA",
            mediaType: "image/png",
          },
          { id: "p-file-url", type: "file", url: "zcode-artifact://keep-me" },
          {
            id: "p-tool-error",
            type: "tool",
            callId: "call-2",
            state: { status: "error", input: { cmd: "rm" }, error: "boom", metadata: { retry: 1 } },
          },
        ],
      },
    ],
  };
}

/**
 * 本用例钉的是 parts 形态的裁剪规则，构造完整 `ZCodeSessionStateSnapshot`（settings / projection /
 * runtime 等必填面）对判据没有信息量，因此按结构窄化传入、再窄化取回断言用形状。
 */
function elide(fixture: FixtureSnapshot): FixtureSnapshot {
  return elideSessionSnapshotForIndex(
    fixture as unknown as Parameters<typeof elideSessionSnapshotForIndex>[0],
  ) as unknown as FixtureSnapshot;
}

function partOf(fixture: FixtureSnapshot, index: number): FixturePart {
  const part = fixture.messages[0]?.parts[index];
  assert.ok(part, `缺少第 ${index} 个 part`);
  return part;
}

test("T-SVC-2 index 裁剪剥离 tool/reasoning/data-url 大载荷", () => {
  const elided = elide(snapshot());

  assert.equal(partOf(elided, 0).text, "", "reasoning 文本清空");
  assert.equal(partOf(elided, 1).text, "用户可见正文", "text part 是 index 的搜索面，必须保留");

  const completed = partOf(elided, 2).state;
  assert.deepEqual(completed?.input, {});
  assert.equal(completed?.output, "");
  assert.deepEqual(completed?.metadata, {});

  assert.equal(partOf(elided, 3).url, "data:,", "data URL 载荷换成空占位");
  assert.equal(partOf(elided, 4).url, "zcode-artifact://keep-me", "非 data URL 不动");

  const failed = partOf(elided, 5).state;
  assert.deepEqual(failed?.input, {});
  assert.equal(failed?.error, "");
});

test("T-SVC-2 index 裁剪不改变结构面（数量/顺序/id/type/metadata 键）", () => {
  const original = snapshot();
  const elided = elide(original);

  assert.equal(elided.messages.length, original.messages.length);
  assert.equal(elided.session.sessionId, "s-1");
  assert.deepEqual(
    elided.messages[0]?.parts.map((part) => part.id),
    original.messages[0]?.parts.map((part) => part.id),
  );
  assert.deepEqual(
    elided.messages[0]?.parts.map((part) => part.type),
    original.messages[0]?.parts.map((part) => part.type),
  );
  // 状态机字段（status / callId / mediaType）不参与剥离：可见性与投影策略判定要与 full 同源。
  assert.equal(partOf(elided, 2).state?.status, "completed");
  assert.equal(partOf(elided, 2).callId, "call-1");
  assert.equal(partOf(elided, 3).mediaType, "image/png");
});

test("T-SVC-2 裁剪不修改入参（full 侧继续读到原对象）", () => {
  const original = snapshot();
  const elided = elide(original);

  // 未改动的 part 保持引用相等（不新建对象、不改入参）。
  assert.equal(elided.messages[0]?.parts[1], original.messages[0]?.parts[1]);
  assert.equal(partOf(elided, 3).url, "data:,", "index 侧看到空占位");
  assert.equal(
    partOf(original, 3).url,
    "data:image/png;base64,AAAA",
    "full 侧入参未被改写",
  );
  assert.equal(partOf(original, 0).text, "长推理文本");
  assert.equal(partOf(original, 2).state?.output, "巨型工具输出");
});

test("T-SVC-2 contentProfile 在协议参数 schema 上：仅 full|index，缺省等同 full", () => {
  assert.equal(
    zcodeSessionReadParamsSchema.safeParse({ sessionId: "s-1", contentProfile: "index" }).success,
    true,
  );
  assert.equal(
    zcodeSessionReadParamsSchema.safeParse({ sessionId: "s-1", contentProfile: "full" }).success,
    true,
  );
  const omitted = zcodeSessionReadParamsSchema.parse({ sessionId: "s-1" });
  assert.equal(omitted.contentProfile, undefined);
  assert.equal(
    zcodeSessionReadParamsSchema.safeParse({ sessionId: "s-1", contentProfile: "slim" }).success,
    false,
  );
});
