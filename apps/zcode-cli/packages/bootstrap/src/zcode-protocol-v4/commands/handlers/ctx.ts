// magic-context 本地控制命令组（S22 的桌面执行面）：ctxStatus / ctxReduce / ctxExpand / ctxRecomp。
//
// 与 CLI/TUI 的关系：语义**只有一份**，落在 `bootstrap/src/ctx-commands`。本文件是那份实现在
// v4 命令通道上的薄壳——把 kind 翻回命令名、把 payload 的参数文本递进去、把结果包成
// `ctxCommand` ACK。桌面 composer 敲 `/ctx-status` 时不再走 `sendText`（那会把命令原文
// 当成 prompt 发给模型），而是发一条这里就地消费的命令。
//
// 与 goal 的差别：goal 是目标状态写入（改 target、续跑 turn），所以要过 active-turn barrier；
// `/ctx-*` 不起 turn、不入队、不碰对话历史，跑完只有一段文本，因此**不**走 goal 那套
// barrier / held queue / CAS，只做一次 record 查找 + 一次同步执行。
import type { CommandEnvelope, CommandResult } from "@zcode/shared/zcode-protocol-v4";
import {
  CTX_COMMAND_NAME_BY_KIND,
  runCtxCommand,
  type CtxCommandHost,
  type CtxCommandName,
} from "../../../ctx-commands/index.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";

type CtxCommandKind = keyof typeof CTX_COMMAND_NAME_BY_KIND;
type CtxHandler = (host: V4CommandCoreHost, envelope: CommandEnvelope) => Promise<CommandResult>;

/**
 * 四种 kind 的参数文本取法。
 *
 * `/ctx-reduce` 的 `tags` 必带（空串也要带，好让服务端回「用法」而不是安静地排空队）；
 * expand / recomp 的 `range` 缺省即空文本，服务端据此走各自的默认分支
 * （`/ctx-expand` 无参回用法，`/ctx-recomp` 无参即 full）。
 */
function readArgs(kind: CtxCommandKind, envelope: CommandEnvelope): string {
  const payload = envelope.payload as { range?: string } | { tags?: string } | undefined;
  if (kind === "ctxReduce") return (payload as { tags?: string } | undefined)?.tags ?? "";
  return (payload as { range?: string } | undefined)?.range ?? "";
}

async function runCtxKind(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
  kind: CtxCommandKind,
): Promise<CommandResult> {
  const record = requireRecord(host, envelope.sessionId);
  const name: CtxCommandName = CTX_COMMAND_NAME_BY_KIND[kind];
  // effective 开关仍只认 App 暴露的那一次求值（与 CLI 侧同一个值、同一份门），这里只做
  // 转发；「关」的判定与文案都在共享实现里，桌面不会得到另一套说法。
  const ctxHost: CtxCommandHost = {
    isMagicContextEnabled: () => record.app.isMagicContextEnabled?.() === true,
    sessionId: record.app.sessionId,
  };
  return {
    command: kind,
    response: await runCtxCommand(name, readArgs(kind, envelope), ctxHost),
    type: "ctxCommand",
  };
}

const ctxStatus: CtxHandler = (host, envelope) => runCtxKind(host, envelope, "ctxStatus");
const ctxReduce: CtxHandler = (host, envelope) => runCtxKind(host, envelope, "ctxReduce");
const ctxExpand: CtxHandler = (host, envelope) => runCtxKind(host, envelope, "ctxExpand");
const ctxRecomp: CtxHandler = (host, envelope) => runCtxKind(host, envelope, "ctxRecomp");

export const ctxHandlers = { ctxExpand, ctxRecomp, ctxReduce, ctxStatus };
