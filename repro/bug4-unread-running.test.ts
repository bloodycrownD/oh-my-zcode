// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    services: {} as Record<string, unknown>,
    receive: undefined as ((signal: unknown) => void) | undefined,
    mutateTask: vi.fn(async () => ({ unreadAt: 42 })),
    // controller registry 的 live activity；sessions-index 的 phase 才是运行权威。
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

import { deriveTaskLeadingIndicator } from "@/lib/taskListItemPresentation.js";
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

describe("bug 4：蓝点（未读）在任务重新运行后仍被补写", () => {
  it("REPRO 前台完成记录时是终态，离开时已重新 running：不应再写 mark-unread", async () => {
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

    // sessions-index 此时读到的是「已经开始了新一轮」，而不是刚才那次完成。
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

  it("REPRO 运行中但 unreadAt 有值时，列表指示器应是转圈而不是蓝点", () => {
    const indicator = deriveTaskLeadingIndicator(
      { taskId: "task-1", unreadAt: 42 } as never,
      { phase: "running" } as never,
    );

    expect(indicator, "unread 排在 loading 前面会把运行中的转圈顶成蓝点").toBe("loading");
  });
});
