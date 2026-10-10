import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecutionRequest } from "@zcode/contracts";

export const DEFAULT_TIMEOUT_MS = 300_000;
const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const DEFAULT_INLINE_OUTPUT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_PERSISTED_OUTPUT_BYTES = 50 * 1024 * 1024;
/**
 * Bash 合并输出文件的软上限默认值。
 * 原为 5GiB：失控命令（子代理后台死循环灌 stdout）曾把单文件写到 5.13GiB、
 * 5 次共 25.7GB。下调到 256MiB——已知最大的合法构建输出在几十 MiB 量级，
 * 仍留一个数量级余量，同时把事故单文件上限压低 20 倍。
 * 需要临时放大用 env `ZCODE_EXEC_OUTPUT_LIMIT_BYTES` 覆盖（见下方 resolver）。
 */
export const BASH_RUNTIME_OUTPUT_LIMIT_BYTES = 256 * 1024 * 1024;
/** env 覆盖的合法区间：低于 1MiB 会误杀正常构建，高于 1GiB 失去保护意义。 */
export const MIN_EXEC_OUTPUT_LIMIT_BYTES = 1 * 1024 * 1024;
export const MAX_EXEC_OUTPUT_LIMIT_BYTES = 1024 * 1024 * 1024;
export const IO_DRAIN_TIMEOUT_MS = 1_000;
export const FORCE_EXIT_AFTER_KILL_MS = 5_000;
/**
 * 超限杀进程后、物理截断前等待「子进程关闭 + 杀树收尾」的总上界。
 * 必须**严格大于** `FORCE_EXIT_AFTER_KILL_MS`（5s）：close 事件要等持有继承 fd
 * 的后代全部退出才触发，而 5s 处 ZCode 已强制销毁流。若两档等长，「等到流被
 * 销毁」与「截断等待超时」几乎同时发生，截断会在写者刚死透的边界上被跳过。
 * 留 2s 余量（7s）让杀树收尾先于截断超时见分晓。
 * 上界只是防挂死；正常路径 close/taskkill 都在毫秒级完成。
 */
export const BASH_OUTPUT_TRUNCATE_WAIT_MS = 7_000;
export const DEFAULT_PROGRESS_THRESHOLD_MS = 2_000;
export const DEFAULT_PROGRESS_INTERVAL_MS = 1_000;
export const DEFAULT_PROGRESS_TAIL_BYTES = 4 * 1024;

export function resolveDefaultOutputRootDir(processEnv: NodeJS.ProcessEnv = process.env): string {
  const storageRoot = processEnv.ZCODE_STORAGE_DIR?.trim() || join(homedir(), ".omz");
  return join(storageRoot, "cli", "exec");
}

/**
 * 解析 env `ZCODE_EXEC_OUTPUT_LIMIT_BYTES`（字节数）覆盖的执行输出上限。
 *
 * 范式参照 `bash-output-policy.ts` 的 `resolveBashMaxOutputLength`：
 * 合法区间收敛到 `MIN..MAX`，缺失/空串/非法/越界一律回落默认值。
 * 注意这里不做"钳到边界"：用户把 10MiB 写成 512KiB 或把 5GiB 写成 2GiB，
 * 都是配置事故，静默按边界执行会让用户对着错误的行为排错；回落默认值 +
 * debug 说明才能真正暴露问题。
 *
 * `onDebug` 用于把回落原因告诉宿主（adapter 层不持有 logger，调用方自定去向）。
 */
export function resolveBashRuntimeOutputLimitBytes(
  processEnv: NodeJS.ProcessEnv = process.env,
  onDebug?: (message: string) => void,
): number {
  const raw = processEnv.ZCODE_EXEC_OUTPUT_LIMIT_BYTES;
  if (raw === undefined || raw.trim() === "") return BASH_RUNTIME_OUTPUT_LIMIT_BYTES;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (
    !Number.isFinite(parsed) ||
    parsed < MIN_EXEC_OUTPUT_LIMIT_BYTES ||
    parsed > MAX_EXEC_OUTPUT_LIMIT_BYTES
  ) {
    onDebug?.(
      `ZCODE_EXEC_OUTPUT_LIMIT_BYTES="${raw}" is outside ${MIN_EXEC_OUTPUT_LIMIT_BYTES}..${MAX_EXEC_OUTPUT_LIMIT_BYTES} bytes; using default ${BASH_RUNTIME_OUTPUT_LIMIT_BYTES}`,
    );
    return BASH_RUNTIME_OUTPUT_LIMIT_BYTES;
  }
  return parsed;
}

/** 把上限字节数渲染成人读的单位串（如 "256MiB"、"2GiB"），用于 output_limit 文案。 */
export function formatExecOutputLimitBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return String(bytes);
  const gib = 1024 * 1024 * 1024;
  const mib = 1024 * 1024;
  if (bytes >= gib && bytes % gib === 0) return `${bytes / gib}GiB`;
  if (bytes >= mib && bytes % mib === 0) return `${bytes / mib}MiB`;
  return `${bytes} bytes`;
}

export function isExpectedChildStdinClosureError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

export function isBashMergedOutputRequest(request: ExecutionRequest): boolean {
  return request.command.mode === "shell" && request.command.shellProfile === "posix-bash";
}

export function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

export function abortSignalReason(signal: AbortSignal | undefined): unknown {
  if (!signal || !("reason" in signal)) return undefined;
  return (signal as AbortSignal & { reason?: unknown }).reason;
}

/**
 * 有界等待：目标 Promise 先落地返回 true，超过 timeoutMs 返回 false。
 *
 * `keepAlive`（uix/C-1，截断等待专用）：默认 timer unref——「losing timeout」
 * 不应在目标 Promise 已完成后继续单独保活 CLI。但 await 中的 Promise 本身不
 * 保活事件循环：截断等待期若整个进程只剩这一段等待（裸一次性消费方、测试
 * 进程），unref timer 会被事件循环提前丢弃、等待被静默放弃——T-C1-6b 实证
 * （node --test 下事件循环排空后等待直接消失，后续用例连锁取消）。
 * 截断是收尾正确性的一部分（超限文件必须有界），值得为这 ≤7s 持活；
 * ZCode CLI 宿主本来就有长驻句柄（stdin/REPL、其它在飞执行），持活不改变宿主行为。
 */
export function waitForPromise(
  promise: Promise<unknown>,
  timeoutMs: number,
  options: { keepAlive?: boolean } = {},
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(completed);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    if (options.keepAlive === true) {
      // 等待期必须持活，否则事件循环可能在等待见分晓前排空（见上方注释）。
      timer.ref?.();
    } else {
      // losing timeout 不应在目标 Promise 已完成后继续单独保活 CLI。
      timer.unref?.();
    }
    void promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

export function formatTimeoutDuration(timeoutMs: number): string {
  if (!Number.isFinite(timeoutMs) || timeoutMs < MS_PER_SECOND) {
    return `${Math.max(0, Math.round(timeoutMs))}ms`;
  }

  if (timeoutMs < MS_PER_MINUTE) {
    return `${formatUnitValue(timeoutMs / MS_PER_SECOND)}s`;
  }

  if (timeoutMs < MS_PER_HOUR) {
    return `${formatUnitValue(timeoutMs / MS_PER_MINUTE)}m`;
  }

  return `${formatUnitValue(timeoutMs / MS_PER_HOUR)}h`;
}

function formatUnitValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/u, "");
}
