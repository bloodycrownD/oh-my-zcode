// FORK：Off-Peak 派发面（`offPeakTaskId` / `activeOffPeakTaskId` / `resolveTurnOffPeakTaskId`）
// 已随官方端点全清移除；`buildTurnToolDisallowlist` 也不再从 prompt-turn 导出，只剩
// 「automation 轮隐藏 cron 写工具 + 合并调用方 denylist」这一支。
// 因此本文件改为经 `startPromptTurn` 的真实 admission 载荷做行为断言。
import { describe, expect, it, vi } from "vitest";
import { startPromptTurn } from "../src/zcode-protocol-v4/commands/prompt-turn.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";
import type { V4SessionRecordView } from "../src/zcode-protocol-v4/commands/types.js";

const CRON_TOOLS = ["CronCreate", "CronUpdate", "CronDelete"];

async function runPrompt(params: {
  inputId: string;
  automationId?: string;
  toolDisallowlist?: readonly string[];
}) {
  const sendInput = vi.fn(async () => ({ kind: "queued" as const, queueItemId: "q1" }));
  const record = {
    app: createFakeApp(undefined, {
      sendInput: sendInput as ReturnType<typeof createFakeApp>["sendInput"],
    }),
    workspace: { workspacePath: "/test/automation" },
    persistence: "immediate",
    traceContext: { traceId: "trace-automation", sessionId: "sess_test" },
  } as unknown as V4SessionRecordView;
  await startPromptTurn({ getRecord: () => record }, record, {
    content: "p",
    ...(params.toolDisallowlist ? { toolDisallowlist: params.toolDisallowlist } : {}),
    ...(params.automationId ? { automationId: params.automationId } : {}),
    inputId: params.inputId,
  });
  const options = sendInput.mock.calls[0]?.[1] as
    | { toolDisallowlist?: readonly string[] }
    | undefined;
  return { options, record, sendInput };
}

describe("automation 轮的工具隐藏（经 startPromptTurn 行为）", () => {
  it("automation 轮只隐藏三个 cron 写工具", async () => {
    const { options } = await runPrompt({ automationId: "automation-1", inputId: "input-1" });
    expect(options?.toolDisallowlist).toEqual(expect.arrayContaining([...CRON_TOOLS]));
    expect(options?.toolDisallowlist).toHaveLength(CRON_TOOLS.length);
    expect(options?.toolDisallowlist).not.toContain("SendMessage");
    expect(options?.toolDisallowlist).not.toContain("Workflow");
  });

  it("显式 automationId 与调用方已有 denylist 合并去重", async () => {
    const { options } = await runPrompt({
      automationId: "automation-1",
      inputId: "input-1",
      toolDisallowlist: ["CronCreate", "Workflow"],
    });
    expect(options?.toolDisallowlist).toEqual(
      expect.arrayContaining([...CRON_TOOLS, "Workflow"]),
    );
    expect(options?.toolDisallowlist).toHaveLength(4);
  });

  it("普通用户轮不追加任何隐藏", async () => {
    const { options } = await runPrompt({ inputId: "user-input-1" });
    expect(options).not.toHaveProperty("toolDisallowlist");
  });

  it("automation-<id>:run:<id> 形式的 inputId 同样触发自动化隐藏", async () => {
    const { options } = await runPrompt({ inputId: "automation-1:run:x" });
    expect(options?.toolDisallowlist).toEqual(expect.arrayContaining([...CRON_TOOLS]));
  });

  it("不足 automation- 前缀主体的 inputId 不误判", async () => {
    const { options } = await runPrompt({ inputId: "automation-" });
    expect(options).not.toHaveProperty("toolDisallowlist");
  });

  it("admission 之后记录上的 automation 身份被还原", async () => {
    const { record } = await runPrompt({ automationId: "automation-1", inputId: "input-1" });
    expect(record.activeAutomationId).toBeUndefined();
  });
});
