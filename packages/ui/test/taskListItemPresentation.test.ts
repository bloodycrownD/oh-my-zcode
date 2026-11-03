import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { deriveTaskLeadingIndicator } from "@/lib/taskListItemPresentation.js";
import type { TaskListRowActivity } from "@/v4/taskListRowActivity.js";

const task = (patch: Partial<ZCodeTaskMeta> = {}) =>
  ({ taskId: "t", workspacePath: "/w", updatedAt: 1, ...patch }) as ZCodeTaskMeta;

const activity = (phase: TaskListRowActivity["phase"]) =>
  ({ phase, lastActivityAt: 1, hasBackgroundWork: false }) as TaskListRowActivity;

describe("deriveTaskLeadingIndicator", () => {
  it("运行中但仍有上一轮 unread：loading 优先，转圈不能被蓝点顶掉", () => {
    expect(deriveTaskLeadingIndicator(task({ unreadAt: 42 }), activity("running"))).toBe("loading");
    expect(deriveTaskLeadingIndicator(task({ unreadAt: 42 }), activity("prewarming"))).toBe(
      "loading",
    );
  });

  it("completed + unread：显示未读蓝点", () => {
    expect(
      deriveTaskLeadingIndicator(
        task({ unreadAt: 42, status: "completed" }),
        activity("completedSuccess"),
      ),
    ).toBe("unread");
  });

  it("error 状态：实时 phase 或持久化 status 都显示错误", () => {
    expect(deriveTaskLeadingIndicator(task({}), activity("error"))).toBe("error");
    // sessions-index 未水合时只能回退持久化终态。
    expect(deriveTaskLeadingIndicator(task({ status: "error" }), null)).toBe("error");
  });

  it("无状态：不把持久化 running 当成实时运行", () => {
    expect(deriveTaskLeadingIndicator(task({}), null)).toBe("none");
    expect(deriveTaskLeadingIndicator(task({ status: "running" }), null)).toBe("none");
    expect(
      deriveTaskLeadingIndicator(task({ status: "completed" }), activity("completedSuccess")),
    ).toBe("none");
  });
});
