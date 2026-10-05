import type { TaskChatToolCall } from "./taskChatMessageTypes.js";

export interface TaskChatToolCallTreeNode {
  toolCall: TaskChatToolCall;
  childToolCalls: TaskChatToolCallTreeNode[];
}
