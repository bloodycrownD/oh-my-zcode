import {
  useEnglishSubagentSettings,
  finishSubagentTurn,
} from "../../../helpers/subagent-refresh-conversation.js";
import {
  readSubagentCapture as records,
  waitForSubagentRequest,
  assertSubagentProfile,
  readChildSessionIds,
} from "../../../helpers/subagent-refresh-capture.js";
import { clearAppData } from "../../../helpers/desktop-app.js";
import { saveRefreshProfile } from "../../../helpers/subagent-refresh-settings.js";
import { exportPromptTrajectory } from "../../../helpers/prompt-trajectory-export.js";
import {
  UPSTREAM_ALTERNATE_MODEL,
  UPSTREAM_ALTERNATE_PROVIDER_ID,
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
} from "../../../helpers/upstream-provider.js";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
} from "../../../helpers/v4-conversation.js";

const NAME = "e2e-runtime-reviewer";
const versions = {
  old: {
    model: UPSTREAM_MODEL,
    provider: UPSTREAM_PROVIDER_ID,
    effort: "low",
    prompt: "E2E_SHR_PROFILE_OLD",
    tools: ["Read"],
  },
  new: {
    model: UPSTREAM_ALTERNATE_MODEL,
    provider: UPSTREAM_ALTERNATE_PROVIDER_ID,
    effort: "high",
    prompt: "E2E_SHR_PROFILE_NEW",
    tools: ["Grep"],
  },
  later: {
    model: UPSTREAM_MODEL,
    provider: UPSTREAM_PROVIDER_ID,
    effort: "low",
    prompt: "E2E_SHR_PROFILE_LATER",
    tools: ["Read"],
  },
};

describe("Subagent 配置按父上下文刷新", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SHR01/SHR02/SHR03: Settings 保存后恢复失败 child，当前 turn 固定配置，下一 turn spawn 更新", async function () {
    this.timeout(300000);
    // 解锁说明：fork 的 Host 存储准备 worker 尚未把 lastWorkspaceSession 迁成项目行
    // （tsup 仍打包无 settings 的 legacy worker），ZCodeProject 不会出现在侧栏。
    // 本 case 验证的是用户级 Subagent 配置的按轮刷新，与工作区种类无关，因此走产品默认
    // conversation workspace 的 skipShellReady 路径，避免依赖缺失的项目行。
    await prepareV4ConversationE2E({ skipShellReady: true });
    await useEnglishSubagentSettings();
    await saveProfile("old", true);
    await send(
      "E2E_SHR_FAIL_PARENT",
      `Launch ${NAME} in the background with prompt E2E_SHR_FAIL_CHILD. Finish after receiving the agent id.`,
    );
    await finish("E2E_SHR_FAIL_PARENT_DONE");
    const failure = await waitForSubagentRequest("shr-fail-child", 90000);
    expect(failure.statusCode).toBe(400);
    assertSubagentProfile(failure, versions.old);
    await waitForSubagentRequest("shr-failure-notification", 90000);
    await finish("E2E_SHR_FAILURE_NOTED");
    const parentSessionId = (await getV4PaneSnapshot()).sessionId;
    const originalChildren = await childSessionIds();
    expect(originalChildren.length).toBe(1);
    const parentResult = await waitForSubagentRequest("shr-fail-parent-final", 90000);
    const originalAgentId = /agentId:\s*(agent_[A-Za-z0-9_-]+)/u.exec(
      JSON.stringify(parentResult.requestJson),
    )?.[1];
    expect(originalAgentId).toBeTruthy();

    // SHR02：失败已有历史后保存，不重启 Host/CLI/session，SendMessage 恢复相同 child。
    await saveProfile("new");
    await send(
      "E2E_SHR_RESUME_PARENT",
      `Use SendMessage to resume agentId: ${originalAgentId} with message E2E_SHR_RESUME_CHILD.`,
    );
    const resumed = await waitForSubagentRequest("shr-resume-child", 90000);
    assertSubagentProfile(resumed, versions.new);
    expect(JSON.stringify(resumed.requestJson)).toContain("E2E_SHR_FAIL_CHILD");
    expect(JSON.stringify(resumed.requestJson)).toContain("E2E_SHR_RESUME_CHILD");
    expect(JSON.stringify(resumed.requestJson)).not.toContain(versions.old.prompt);
    await finish("E2E_SHR_RESUME_PARENT_DONE");
    await waitForSubagentRequest("shr-resume-notification", 90000);
    await finish("E2E_SHR_RESUME_NOTED");
    expect(await childSessionIds()).toEqual(originalChildren);
    const resumeContinuation = await waitForSubagentRequest("shr-resume-parent-final", 90000);
    const messages = (
      resumeContinuation.requestJson as {
        messages: Array<{ content: Array<{ type: string; name?: string; input?: unknown }> }>;
      }
    ).messages;
    const call = messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find((part) => part.type === "tool_use" && part.name === "SendMessage");
    expect(call?.input).toMatchObject({ to: originalAgentId });

    // SHR03：fixture 延迟当前父请求的 tool_use，为真实 Settings 操作保留可观测窗口。
    await send("E2E_SHR_STABLE_PARENT", `Launch ${NAME} with prompt E2E_SHR_STABLE_CHILD.`);
    await waitForParentRequestStarted("E2E_SHR_STABLE_PARENT");
    await saveProfile("later");
    // 保存必须早于 child 请求，防止 UI 操作过慢导致旧配置断言产生假阳性。
    expect(
      (await records()).some((record) => record.replay?.fixtureId === "shr-stable-child"),
    ).toBe(false);
    const stable = await waitForSubagentRequest("shr-stable-child", 90000);
    assertSubagentProfile(stable, versions.new);
    expect(JSON.stringify(stable.requestJson)).not.toContain(versions.later.prompt);
    await finish("E2E_SHR_STABLE_PARENT_DONE");

    // SHR01：下一轮 spawn 消费已保存的 model/effort/prompt，父身份保持不变。
    await send("E2E_SHR_NEXT_PARENT", `Launch ${NAME} with prompt E2E_SHR_NEXT_CHILD.`);
    assertSubagentProfile(await waitForSubagentRequest("shr-next-child", 90000), versions.later);
    await finish("E2E_SHR_NEXT_PARENT_DONE");
    expect((await getV4PaneSnapshot()).sessionId).toBe(parentSessionId);
    const exported = await exportPromptTrajectory(parentSessionId!, "subagent-runtime-compact");
    const captured = await records();
    const compacts = captured.filter((r) => r.replay?.fixtureId === "shr-compact");
    // FORK(manual-review)：magic-context 接管上下文后不再产生 legacy auto-compact；
    // 每轮首个请求因 compartment 注入被轨迹导出记为 non-incremental-change。
    // compact 分段断言只在该 case 仍产生 compact 时生效，避免把无关的产品路径漂移
    // 记成 Subagent 按轮刷新的失败；父轨迹总请求数仍是本 case 的有效不变量。
    if (compacts.length > 0) {
      expect(exported.trajectories).toHaveLength(compacts.length + 1);
      expect(
        exported.trajectories.slice(1).every((t) => t.reason === "post-compaction"),
      ).toBe(true);
    }
    expect(exported.trajectories.reduce((sum, t) => sum + t.requestCount, 0)).toBe(10);
  });
});

async function send(marker: string, instruction: string) {
  await sendV4PromptAndWaitAccepted(`${marker}: ${instruction}`, marker, `未接收 ${marker}`);
}
const finish = (token: string) => finishSubagentTurn(token, 90000);
async function waitForParentRequestStarted(marker: string) {
  await browser.waitUntil(
    async () =>
      (await records()).some((record) => {
        const text = JSON.stringify(record.requestJson ?? {});
        return (
          record.path.includes("/messages") &&
          text.includes(marker) &&
          !text.includes("Generate a concise title") &&
          !text.includes("CRITICAL: Respond with TEXT ONLY")
        );
      }),
    { timeout: 30000, timeoutMsg: `父请求未开始 ${marker}` },
  );
}
async function saveProfile(version: keyof typeof versions, create = false) {
  await saveRefreshProfile(
    { name: NAME, description: "Runtime profile refresh test", ...versions[version] },
    create ? undefined : NAME,
  );
}

async function childSessionIds() {
  return readChildSessionIds((await getV4PaneSnapshot()).sessionId!, "id");
}
