// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    services: {} as Record<string, unknown>,
    receive: undefined as ((signal: unknown) => void) | undefined,
    mutateTask: vi.fn(async (_input?: unknown) => ({ unreadAt: 42 })),
    // sessions-index 的 live phase 才是运行权威；tasks-index 的 sticky 终态不参与。
    activities: [] as Array<{
      address: { taskId: string; workspacePath: string };
      activity: { phase: string };
    }>,
    tabs: {
      tabs: [{ id: "tab-1", kind: "workspace", workspacePath: "/repo" }],
      activeTabId: "tab-1",
    },
    session: {
      taskNavHistory: {
        entries: [{ kind: "task", taskId: "task-1", workspacePath: "/repo" }],
        cursor: 0,
      },
      getWorkspaceState: () => ({ activeTaskId: "task-1" }),
    },
  };
});

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => mocks.services,
}));
vi.mock("@/hooks/usePlatform.js", () => ({ useOptionalPlatform: () => null }));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStoreApi: () => ({ getState: () => mocks.tabs }),
}));
vi.mock("@/store/tabStore.js", () => ({ isWorkspaceTab: () => true }));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: Object.assign(() => 0, { getState: () => mocks.session }),
}));
vi.mock("@/store/zcodeSessionStoreNavigation.js", () => ({
  onTaskNavigationCommitted: () => ({ dispose() {} }),
}));
vi.mock("@/v4/windowControllerTaskListRegistry.js", () => ({
  getWindowControllerTaskListRegistry: () => ({ readActivities: () => mocks.activities }),
}));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));

import { useProjectUnreadSignals } from "@/project-sidebar/useProjectUnreadSignals.js";

const unreadWrites = () =>
  mocks.mutateTask.mock.calls.filter(
    (call) =>
      (call[0] as { mutation?: { kind?: string } } | undefined)?.mutation?.kind === "mark-unread",
  );

beforeEach(() => {
  mocks.mutateTask.mockClear();
  mocks.activities = [];
  mocks.receive = undefined;
  mocks.services = {
    windowControllerService: {
      onDynamicTaskUnreadSignal: () => (listener: (signal: unknown) => void) => {
        mocks.receive = listener;
        return { dispose() {} };
      },
      mutateTask: mocks.mutateTask,
    },
  };
});

afterEach(cleanup);

describe("useProjectUnreadSignals 运行态守卫", () => {
  it("前台完成后任务已重新运行：blur 补写跳过 mark-unread", async () => {
    renderHook(() => useProjectUnreadSignals([{ workspacePath: "/repo" }], async () => {}));
    await waitFor(() => expect(mocks.receive).toBeTypeOf("function"));

    // 完成信号到达时用户正在看这个任务：只记录，不立即写。
    act(() => {
      mocks.receive?.({
        address: { taskId: "task-1", workspacePath: "/repo" },
        updatedAt: 10,
        status: "completed",
      });
    });
    expect(unreadWrites(), "查看中不应立即写未读").toHaveLength(0);

    // sessions-index 此时读到的是「已经开始了新一轮」，不是刚才那次完成。
    mocks.activities = [
      {
        address: { taskId: "task-1", workspacePath: "/repo" },
        activity: { phase: "running" },
      },
    ];

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(unreadWrites(), "任务已重新运行，blur 补写不应把上一轮完成写成新的未读").toHaveLength(0);
  });

  it("对照：没有新一轮运行时仍按前台完成补写未读", async () => {
    renderHook(() => useProjectUnreadSignals([{ workspacePath: "/repo" }], async () => {}));
    await waitFor(() => expect(mocks.receive).toBeTypeOf("function"));

    act(() => {
      mocks.receive?.({
        address: { taskId: "task-1", workspacePath: "/repo" },
        updatedAt: 10,
        status: "completed",
      });
    });
    mocks.activities = [
      {
        address: { taskId: "task-1", workspacePath: "/repo" },
        activity: { phase: "completedSuccess" },
      },
    ];
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    await waitFor(() => expect(unreadWrites()).toHaveLength(1));
  });
});
