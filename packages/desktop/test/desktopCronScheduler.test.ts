import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { utilityProcess as electronUtilityProcess } from "electron";
import { hostCronRunMessageSchema } from "@zcode/shared";
import { spawnCronScheduler } from "../src/main/desktopCronScheduler.js";

vi.mock("electron", () => ({
  utilityProcess: {
    fork: vi.fn(),
  },
}));

vi.mock("../src/main/desktopRuntimeEnv.js", () => ({
  buildHostProcessEnv: vi.fn(() => ({})),
  schedulerModulePath: "/tmp/zcode-scheduler.js",
}));

class MockSchedulerProcess extends EventEmitter {
  pid: number | undefined = 12345;
  postMessage = vi.fn();
  kill = vi.fn(() => true);
}

describe("desktopCronScheduler", () => {
  // FORK：off-peak 调度生产面（offpeak-dispatch-request / OffPeakRun 转发链）已删，
  // 仅保留 task-groups 对存量 off_peak_task_id 的归类（见 packages/shared/src/validation.ts），
  // 这里只回归 cron 快照转发。
  it("forwards and validates the saved cron project directory snapshot", async () => {
    const kind = "cron";
    {
      const child = new MockSchedulerProcess();
      const host = { postMessage: vi.fn() };
      vi.mocked(electronUtilityProcess.fork).mockReturnValue(child as never);
      const scheduler = spawnCronScheduler({
        hostProcessLocalEnv: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        resolveDispatchHost: () => host as never,
      });
      const execution = {
        workspacePath: "/frozen",
        workspaceIdentity: "remote:server:s:/frozen",
        projectId: "p",
        hostId: "remote:server:s",
        additionalDirectories: [],
      };
      child.emit("message", {
        ...execution,
        type: `${kind}-dispatch-request`,
        prompt: "run",
        automationId: "a",
        runId: "r",
      });
      const frame = host.postMessage.mock.calls[0]?.[0];
      expect(frame).toMatchObject(execution);
      expect(hostCronRunMessageSchema.parse(frame)).toMatchObject(execution);
      const disposing = scheduler.dispose();
      child.emit("exit", 0);
      await disposing;
    }
  });

  it("立即执行时直接向 scheduler 发送 wake 消息", () => {
    const child = new MockSchedulerProcess();
    vi.mocked(electronUtilityProcess.fork).mockReturnValue(child as never);

    const scheduler = spawnCronScheduler({
      hostProcessLocalEnv: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      resolveDispatchHost: () => null,
    });

    scheduler.wake("automation-1");

    expect(child.postMessage).toHaveBeenCalledWith({
      type: "scheduler-wake",
      automationId: "automation-1",
    });
  });

  it("进入退出状态后停止向 Host 派发新任务", async () => {
    const child = new MockSchedulerProcess();
    const host = { postMessage: vi.fn() };
    vi.mocked(electronUtilityProcess.fork).mockReturnValue(child as never);
    const scheduler = spawnCronScheduler({
      hostProcessLocalEnv: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      resolveDispatchHost: () => host as never,
    });

    const disposing = scheduler.dispose();
    child.emit("message", {
      type: "cron-dispatch-request",
      runId: "run-after-dispose",
      automationId: "automation-1",
      prompt: "test",
      workspacePath: "C:/repo",
    });

    expect(host.postMessage).not.toHaveBeenCalled();
    expect(child.postMessage).toHaveBeenCalledWith({
      type: "cron-dispatch-result",
      runId: "run-after-dispose",
      ok: false,
      failureKind: "transient",
      error: "app is shutting down",
    });
    child.emit("exit", 0);
    await disposing;
  });

  // FORK：scheduler 自采样链路（processResourceSelfHeapSource）已随资源遥测面删除，
  // scheduler-resource-sample 消息不再有消费方，相关用例不再回归。
});
