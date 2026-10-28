import type { CommandAck, CommandType } from "@zcode/shared/zcode-protocol-v4";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import type { V4VisibleSlashCommand } from "@/v4/slashCommands.js";

/**
 * `/ctx-*` 是会话自身的上下文控制面，不起 turn、不入队、不需要模型就绪——所以在
 * `ensureDraftModelReadyForSend` 之前就地消费：让一条纯本地的读命令不必先备好模型。
 * 没有会话时（draft 首条）无处可作用，明确提示而不是把 `/ctx-status` 当 prompt 发出去。
 *
 * 这四条不携带 Submission（没有模型/模式/队列语义），因此不受 draft promotion 与
 * held-queue choice 影响——它们本来就不进对话；也因此从不携带 baseRevision（CAS
 * 只属于 resumeGoal 等命令），派发时不需要 revision 形参。
 */

type CtxCommand = Extract<V4VisibleSlashCommand, { kind: "ctxCommand" }>;

/**
 * 注入的派发能力：SessionPane 内的 `dispatchCommand` 闭包（绑定 workspace/草稿的最近
 * 提交捕获与 envelope 记账），跨模块无法复制，只能由调用方给。本模块只用前三参。
 */
type DispatchCommand = (
  type: CommandType,
  payload: Record<string, unknown>,
  targetSessionId: string,
) => Promise<CommandAck>;

/** `/ctx-reduce|expand|recomp` 的回执只有 1~3 行，给一个够读完的定时。 */
const CTX_COMMAND_TIMED_NOTICE_MS = 12_000;

/**
 * `/ctx-*` 的结果呈现。
 *
 * 复用**已存在**的 notice toast（`variant="info"` 把首行当标题、余下按 `whitespace-pre-line`
 * 渲染正文，宽度 `min(536px, 100vw-2rem)`），不新造组件。选它而不是插进对话流，是因为这
 * 四个命令的产物就是一段给人读的文本，进历史会污染时间线——CLI/TUI 侧同样只把文本回给
 * 用户，从不落进对话。
 *
 * 时长按「要不要读完」分档：`/ctx-status` 是多行报告，常驻到用户关掉；其余三条是确认，
 * 定时消失。两种都 `dismissible`，常驻的那条也留了关闭按钮。
 */
function presentCtxCommandAck(ack: CommandAck, intl: IntlInstance, command: CtxCommand): void {
  if (ack.status !== "accepted" && ack.status !== "noop") {
    logger.warn(`[v4-pane] /${command.displayText} 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
    toast(ack.message ?? intl.formatMessage({ id: "chat.ctx.rejected" }), {
      dismissible: true,
      position: "bottom-center",
      variant: "warning",
    });
    return;
  }
  const response = ack.result?.type === "ctxCommand" ? ack.result.response : undefined;
  const text = response ?? intl.formatMessage({ id: "chat.ctx.noResponse" });
  toast(text, {
    dismissible: true,
    // 多行报告常驻，其余定时；`durationMs: 0` 是 toast 既有的「不自动消失」语义。
    durationMs: command.command === "ctxStatus" ? 0 : CTX_COMMAND_TIMED_NOTICE_MS,
    position: "bottom-center",
    variant: "info",
  });
}

/** `/ctx-*` → v4 命令 type/payload；range 逐字携带，文法只在服务端解析。 */
function buildCtxCommandRequest(command: CtxCommand): {
  type: CommandType;
  payload: Record<string, unknown>;
} {
  return {
    type: command.command,
    payload:
      command.command === "ctxReduce"
        ? { tags: command.range ?? "" }
        : command.range
          ? { range: command.range }
          : {},
  };
}

/** 与 `ConversationComposerSendResult` 的同名成员逐字一致（本模块不引组件模块的运行时面）。 */
export type CtxCommandDispatchResult = "sent" | "blocked";

/**
 * 消费一条 `/ctx-*`：有会话就地派发并呈现 ACK，没有会话则提示需要会话。
 *
 * magic-context 本地控制命令不经 prompt 通道，服务端就地执行完把一段文本回在 ACK 的
 * `ctxCommand.response` 里。派发成功/失败都以 toast 呈现（`presentCtxCommandAck`），
 * 因此这里不返回 ACK，也不必走通用 slash 的「被拒绝」告警分支。
 */
export async function dispatchCtxCommand(params: {
  command: CtxCommand;
  sessionId: string | null;
  intl: IntlInstance;
  dispatch: DispatchCommand;
}): Promise<CtxCommandDispatchResult> {
  const { command, sessionId, intl, dispatch } = params;
  if (!sessionId) {
    toast(intl.formatMessage({ id: "chat.ctx.sessionRequired" }));
    return "blocked";
  }
  const { type, payload } = buildCtxCommandRequest(command);
  const ack = await dispatch(type, payload, sessionId);
  presentCtxCommandAck(ack, intl, command);
  return "sent";
}
