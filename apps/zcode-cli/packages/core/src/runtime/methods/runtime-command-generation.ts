import { SessionEventType, traceContextToLogContext } from "../deps.js";
import type { SessionEvent } from "../deps.js";
import type { RuntimeCommand } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";

export function isStaleBranchRuntimeCommand(
  runtime: AgentRuntimeInternal,
  command: RuntimeCommand,
): boolean {
  if (
    command.mode !== "task-notification" &&
    command.mode !== "subagent-message" &&
    command.mode !== "control-only-turn"
  ) {
    return false;
  }
  if (command.mode !== "task-notification") {
    if (command.branchGeneration === runtime.branchGeneration) return false;
  } else {
    // 通知入队后、出队前可能又发生一次 rewind（长回合下队列等待可达分钟级）。此时任务
    // 已在 rewind 时被重盖到新分支，但命令上盖的仍是入队那一刻的旧代际——按任务**当前**
    // 代际判定，才能让「启动轮保留的工作」在 rewind 后仍然通知到模型。
    const task =
      command.taskId === undefined ? undefined : runtime.runtimeTaskRegistry.get(command.taskId);
    const effectiveGeneration = task?.branchGeneration ?? command.branchGeneration;
    if (effectiveGeneration === runtime.branchGeneration) return false;
  }
  // rewind 与后台 completion 存在竞态；命令即使已入队，也必须在持久化和
  // provider 注入前再次校验 generation，旧分支结果只留诊断日志。
  // task-notification 走 info：它是唯一会让「已完成的后台工作」从模型视野里彻底消失的
  // 丢弃路径，debug 级在常规日志里等于不存在。
  const details = {
    ...traceContextToLogContext(command.traceContext),
    branchGeneration: command.branchGeneration,
    commandId: command.id,
    currentBranchGeneration: runtime.branchGeneration,
    event: "runtime.command.stale_branch_dropped",
    mode: command.mode,
    module: "core.runtime",
  };
  if (command.mode === "task-notification") {
    runtime.logger?.info?.("Dropped queued stale-branch task notification", details);
  } else {
    runtime.logger?.debug?.("Dropped queued stale-branch runtime command", details);
  }
  return true;
}

export function isStaleBranchRuntimeTaskEvent(
  runtime: AgentRuntimeInternal,
  event: SessionEvent,
): boolean {
  if (
    event.type !== SessionEventType.BackgroundTaskUpdated &&
    event.type !== SessionEventType.BackgroundTaskCompleted &&
    event.type !== SessionEventType.SubagentMessage &&
    event.type !== SessionEventType.SubagentStopped
  ) {
    return false;
  }
  const payload =
    event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : {};
  const taskId =
    typeof payload.taskId === "string"
      ? payload.taskId
      : typeof payload.agentId === "string"
        ? payload.agentId
        : undefined;
  if (!taskId) return false;
  const task = runtime.runtimeTaskRegistry.get(taskId);
  if (!task || task.branchGeneration === runtime.branchGeneration) return false;
  runtime.logger?.debug("Dropped stale-branch runtime task event", {
    branchGeneration: task.branchGeneration,
    currentBranchGeneration: runtime.branchGeneration,
    event: "runtime.task_event.stale_branch_dropped",
    eventType: event.type,
    module: "core.runtime",
    taskId,
  });
  return true;
}
