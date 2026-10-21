import type { ZCodeModelTrajectoryMessage } from "@zcode/services";

export function trajectoryToolOutputs(message: ZCodeModelTrajectoryMessage): string[] {
  return message.parts.flatMap((part) =>
    part.kind === "tool-result" ? [formatTrajectoryToolPayload(part.output)] : [],
  );
}

export function trajectoryToolCallInputs(message: ZCodeModelTrajectoryMessage): string[] {
  return message.parts.flatMap((part) =>
    part.kind === "tool-call" ? [formatTrajectoryToolPayload(part.input)] : [],
  );
}

/**
 * 该消息是否含错误（显示侧红标）：tool-result 的 output 与 tool-call 的 input 两侧都查。
 * 复用 trajectoryToolPayloadErrorText（结构化 error-text 判定单源），
 * 状态判定（join）只看 output，input 分支的语义在此保持原样。
 */
export function trajectoryToolHasError(message: ZCodeModelTrajectoryMessage): boolean {
  return message.parts.some(
    (part) =>
      (part.kind === "tool-result" && trajectoryToolPayloadErrorText(part.output) !== undefined) ||
      (part.kind === "tool-call" && trajectoryToolPayloadErrorText(part.input) !== undefined),
  );
}

export function trajectoryToolMetadata(message: ZCodeModelTrajectoryMessage): {
  names: string;
  ids: string;
} {
  const parts = message.parts.filter(
    (part) => part.kind === "tool-result" || part.kind === "tool-call",
  );
  return {
    names: parts.flatMap((part) => (part.toolName ? [part.toolName] : [])).join(", "),
    ids: parts
      .flatMap((part) => (part.toolCallId ? [displayTrajectoryToolCallId(part.toolCallId)] : []))
      .join(", "),
  };
}

function displayTrajectoryToolCallId(toolCallId: string): string {
  return toolCallId.startsWith("call_") ? toolCallId.slice("call_".length) : toolCallId;
}

function formatTrajectoryToolPayload(value: unknown): string {
  if (typeof value === "string") return value;
  // Tool Result 的错误采用结构化包装；展示与复制都应使用真实错误文本，避免泄漏传输层 JSON。
  const errorText = trajectoryToolPayloadErrorText(value);
  if (errorText !== undefined) return errorText;
  if (isStringContentObject(value)) return value.content;
  if (value === undefined) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function trajectoryToolPayloadErrorText(value: unknown): string | undefined {
  return isErrorTextObject(value) ? value.value : undefined;
}

function isErrorTextObject(value: unknown): value is { type: "error-text"; value: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "error-text" &&
    "value" in value &&
    typeof value.value === "string"
  );
}

function isStringContentObject(value: unknown): value is { content: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    typeof value.content === "string"
  );
}
