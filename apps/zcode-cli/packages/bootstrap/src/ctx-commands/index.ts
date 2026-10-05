// `/ctx-*` 共享实现的公开面。
//
// 单独一个子路径导出（`@zcode/bootstrap/ctx-commands`）而不是并进包根 `@zcode/bootstrap`：
// CLI 侧的 `command-center/handlers/ctx.ts` 需要的只是这一个模块，若走包根就会把整个
// bootstrap（协议层、app 装配、插件…）静态拉进 TUI 的模块图——那份图今天是被
// `bootstrap-loader.ts` 动态 import 刻意延后的。子路径让「命令面只静态依赖这一小块」
// 继续成立，而 `@zcode/magic-context` 在本模块内仍然是动态 import。
export { formatCtxStatus } from "./format-ctx-status.js";
export {
  CTX_COMMAND_KIND_BY_NAME,
  CTX_COMMAND_NAME_BY_KIND,
  parseExpandArgs,
  parseRecompArgs,
  runCtxCommand,
  type CtxCommandHost,
  type CtxCommandName,
} from "./run-ctx-command.js";
