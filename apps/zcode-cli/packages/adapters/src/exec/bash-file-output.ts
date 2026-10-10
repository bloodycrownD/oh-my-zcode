import { subscribeBashOutputProgress } from "./bash-progress-poller.js";
import { buildBashOutputPreview } from "./bash-output-preview.js";
import { constants } from "node:fs";
import { lstat, mkdir, open, rm, stat, statfs, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { decodeExecutionOutputBuffer } from "./outputEncoding.js";
import { BASH_OUTPUT_TRUNCATE_WAIT_MS, waitForPromise } from "./execution-utils.js";
import type { ExecutionStreamResult, ExecutionOutputPreview } from "@zcode/contracts";

const OUTPUT_WATCH_INTERVAL_MS = 5_000;
const OUTPUT_FILE_MODE = 0o600;
const PROGRESS_TAIL_MAX_BYTES = 4096;
/** 截断后文件头部保留的字节数：保住开头的命令回显/早期报错，最常用的诊断段。 */
export const BASH_OUTPUT_TRUNCATE_HEAD_KEEP_BYTES = 1024 * 1024;
/** 截断后文件尾部保留的字节数：保住结尾的失败摘要。 */
export const BASH_OUTPUT_TRUNCATE_TAIL_KEEP_BYTES = 1024 * 1024;
/** 截断标记行的长度预算（字节）。截断窗口预算（budget）要先扣掉它，防止贴边越界。 */
export const BASH_OUTPUT_TRUNCATE_MARKER_MAX_BYTES = 256;
/**
 * 结果面截断说明（N-1/C-1）：不改 status，只保证「文件被物理截断」对用户可见。
 * 截断实际生效时附 TRUNCATED 文案——status 仍如实反映命令自身结局（completed
 * 不谎报 killed、也不静默）；逃逸/IO 失败时附 NOT_TRUNCATED 文案。
 */
export const BASH_OUTPUT_TRUNCATED_NOTICE = "output file truncated (head/tail kept)";
export const BASH_OUTPUT_NOT_TRUNCATED_NOTICE = "output file not truncated";

export interface BashOutputTruncationResult {
  /** 被一行标记替换掉的中间字节数（= 原体积 - 头 - 尾）。 */
  removedBytes: number;
  /** 截断后的文件体积（头 + 标记行 + 尾）。 */
  finalBytes: number;
  /** 替换用的标记行原文。 */
  marker: string;
}

/**
 * 把超限的 Bash 合并输出文件物理截断成「头 + 一行标记 + 尾」。
 *
 * 与 `capForegroundArtifactStream` 的区别：后者只保留头部并 truncate，结尾的
 * 报错摘要会整段丢失；这里头尾各留 ~1MiB，中间替换成
 * `[truncated N bytes by omz exec output limit]`，保住「开头命令回显 +
 * 结尾失败原因」两段最常用诊断信息，同时让落盘体积重新有界。
 *
 * 头尾窗口按上限收缩：预算先扣掉标记行（`budget = limitBytes -
 * BASH_OUTPUT_TRUNCATE_MARKER_MAX_BYTES`，`headKeep + tailKeep <= budget`），
 * 保证截断后体积「头 + 标记 + 尾」整体 ≤ limitBytes——否则上限被调小
 * （env 覆盖到 1MiB）时，两级默认窗口反而会让截断结果超出上限，"物理截断"
 * 失去意义（1MiB 下限场景早先正是靠 256B slack 贴边过关，marker 文案一变即越界）。
 *
 * 上游看门狗（watchLimit）每 5s 才 stat 一次，杀进程那一刻文件通常已经超调到
 * 上限 + 一个轮询间隔的写入量，因此判据用 `size <= limitBytes` 直接放行。
 *
 * IO 失败（文件被占用/权限/已消失）由调用方记日志吞掉——截断只是收尾优化，
 * 不能让它反过来丢掉执行结果。
 */
export async function truncateBashOutputFileKeepHeadTail(
  filePath: string,
  limitBytes: number,
  headKeepBytes: number = BASH_OUTPUT_TRUNCATE_HEAD_KEEP_BYTES,
  tailKeepBytes: number = BASH_OUTPUT_TRUNCATE_TAIL_KEEP_BYTES,
): Promise<BashOutputTruncationResult | undefined> {
  const handle = await open(filePath, "r+");
  try {
    const { size } = await handle.stat();
    if (size <= limitBytes) return undefined;
    // 窗口按上限收缩：两级之和不得超过「上限 - 标记行预算」，否则小上限下
    // 截断结果（头 + 标记 + 尾）反而比上限还大。
    const budget = Math.max(0, limitBytes - BASH_OUTPUT_TRUNCATE_MARKER_MAX_BYTES);
    const headKeep = Math.min(Math.max(0, headKeepBytes), Math.floor(budget / 2));
    const tailKeep = Math.min(Math.max(0, tailKeepBytes), Math.max(0, budget - headKeep));
    const headLength = Math.min(size, headKeep);
    const tailLength = Math.min(size - headLength, tailKeep);
    const removedBytes = size - headLength - tailLength;
    const head = await readExact(handle, headLength, 0);
    // 头尾窗口已覆盖整个文件（文件比收缩后的两级窗口加起来还小）时不存在中间段，
    // 退化成「保留头部」，不做二次写入。
    if (removedBytes <= 0) {
      await handle.truncate(head.length);
      return { removedBytes: 0, finalBytes: head.length, marker: "" };
    }
    const tail = await readExact(handle, tailLength, size - tailLength);
    const marker = `\n[truncated ${removedBytes} bytes by omz exec output limit]\n`;
    const content = Buffer.concat([head, Buffer.from(marker, "utf8"), tail]);
    await handle.write(content, 0, content.length, 0);
    // 只 truncate 不 fsync：页缓存里的数据由 OS 负责落盘，进程被 kill 不回退。
    await handle.truncate(content.length);
    return { removedBytes, finalBytes: content.length, marker };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** 定长读取；短读继续补，避免把缓冲区里的空洞当成真实输出。 */
async function readExact(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/**
 * 看门狗超限杀进程后的收尾：把文件物理截断成「头 + 标记行 + 尾」。
 *
 * 时序（judge P1-1）：`terminateProcessTree` 是即发即忘的——Windows taskkill 与
 * POSIX 两阶段信号都是异步，root shell 的 exit 事件只代表组长退出，持有继承 fd
 * 的后代可能仍在往同一文件写。因此截断必须等 close 与杀树收尾都完成，否则刚写入
 * 的「头 + 标记 + 尾」会被活着的写者重新撑大（标记行被埋进中间，落盘体积上限
 * 形同虚设）。这也是 watchLimit 的 onLimit 只触发 requestStop、绝不在回调内截断
 * 的原因。
 *
 * 有界等待：杀树永不完成时不能挂死 run() 的收尾，超时即跳过截断（保留原文件，
 * 与修复前行为一致，不因清理失败丢掉执行结果）。
 *
 * 返回值 = 截断结果或 undefined（跳过/未生效/IO 失败）。调用方据此在结果面附
 * 一句不改 status 的可见说明（N-1/C-1）：生效 → BASH_OUTPUT_TRUNCATED_NOTICE，
 * 逃逸或 IO 失败 → BASH_OUTPUT_NOT_TRUNCATED_NOTICE。
 *
 * 截断失败（文件被占用/权限/已消失）只经 onDebug 说明，不抛错。
 */
export async function truncateBashOutputAfterKill(args: {
  filePath: string;
  /** 子进程 close 事件（stdio 全部关闭）——见 run.ts 的 closePromise。 */
  closePromise: Promise<void>;
  /** 杀树收尾（taskkill / POSIX 两阶段）；未触发杀树时缺省。 */
  killCompletion?: Promise<void>;
  limitBytes: number;
  /** 总等待上界，默认 BASH_OUTPUT_TRUNCATE_WAIT_MS。 */
  waitMs?: number;
  onDebug?: (message: string) => void;
}): Promise<BashOutputTruncationResult | undefined> {
  const settleWaits: Promise<unknown>[] = [args.closePromise];
  if (args.killCompletion) settleWaits.push(args.killCompletion);
  const settled = await waitForPromise(
    Promise.all(settleWaits),
    args.waitMs ?? BASH_OUTPUT_TRUNCATE_WAIT_MS,
    // 持活（uix/C-1）：等待期 timer 若 unref，事件循环可能在本段等待见分晓前
    // 排空（裸消费方/测试进程实证，见 T-C1-6b），截断被静默放弃。CLI 宿主有
    // 长驻句柄，持活不改变宿主行为，只兜住「只剩这段等待」的形态。
    { keepAlive: true },
  );
  if (!settled) {
    args.onDebug?.(
      `exec output truncation skipped (output file not truncated): child/tree did not settle within ${
        args.waitMs ?? BASH_OUTPUT_TRUNCATE_WAIT_MS
      }ms (${args.filePath})`,
    );
    return undefined;
  }
  try {
    return await truncateBashOutputFileKeepHeadTail(args.filePath, args.limitBytes);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    // Windows 上文件被其它句柄占用、POSIX 上权限不足都会走到这里；
    // 保留原文件并说明原因，绝不因为清理失败丢掉执行结果。
    args.onDebug?.(
      `exec output truncation failed (output file not truncated, ${code}) for ${args.filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/**
 * 截断触发用的轻判定：文件是否已超上限（只 stat 比大小，不读内容）。
 * 收尾分支用它兜底「子进程自然退出 + 看门狗 5s 轮询从未落窗」的主事故形态——
 * 那时 outputLimitExceeded / outputLimitDetected 两标志皆 false，但超限文件
 * 仍必须截断（uix/B-1）。
 * stat 失败（文件缺失/不可读）按「不超限」处理：真去截断也只会以 IO 失败收场
 * 并留 debug 说明，这里不过度猜测。
 */
export async function isBashOutputOverLimit(
  filePath: string,
  limitBytes: number,
): Promise<boolean> {
  try {
    const { size } = await stat(filePath);
    return size > limitBytes;
  } catch {
    return false;
  }
}

/** Bash 只持有文件身份和观察器；原始输出由子进程写入，不经过 Node collector。 */
export class BashFileOutput {
  private handle?: FileHandle;
  private created = false;
  private prepared = false;
  private watchTimer?: NodeJS.Timeout;
  private unsubscribeProgress?: () => void;
  private progressDelay?: NodeJS.Timeout;

  constructor(
    readonly path: string,
    private readonly platform: NodeJS.Platform,
    private readonly legacyEncoding: string | null,
  ) {}

  get fd(): number | undefined {
    return this.handle?.fd;
  }

  async prepare(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const existing = await lstat(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    // Windows 的 append-only 句柄被 MSYS 判为只读；Windows 必须用 w。

    const flags =
      this.platform === "win32"
        ? "w"
        : constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);
    this.handle = await open(this.path, flags, OUTPUT_FILE_MODE);
    this.created = existing === undefined;
    this.prepared = true;
  }

  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    // fd 清理失败不能覆盖取消/退出结果，也不能阻止 adapter 释放其它生命周期资源。
    await handle?.close().catch(() => undefined);
  }

  async discard(): Promise<void> {
    await this.close();
    if (this.created) {
      // 清理失败不能覆盖取消/spawn 的真实结果，也不能删除原有文件。
      await rm(this.path, { force: true }).catch(() => undefined);
    }
    this.prepared = false;
  }

  watchLimit(maxBytes: number, onLimit: () => void): void {
    this.stopWatching();
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void stat(this.path)
        .then(
          (file) => {
            // stat 可以在 exit 或后台移交之后才返回；旧观察器不能终止新状态。
            if (this.watchTimer !== timer || file.size <= maxBytes) return;
            this.stopWatching();
            onLimit();
          },
          () => undefined,
        )
        .finally(() => {
          checking = false;
        });
    }, OUTPUT_WATCH_INTERVAL_MS);
    timer.unref();
    this.watchTimer = timer;
  }

  stopWatching(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.unsubscribeProgress?.();
    if (this.progressDelay) clearTimeout(this.progressDelay);
    this.watchTimer = undefined;
    this.unsubscribeProgress = undefined;
    this.progressDelay = undefined;
  }

  watchProgress(
    maxBytes: number,
    delayMs: number,
    intervalMs: number,
    onRead: (output: ExecutionStreamResult, preview: ExecutionOutputPreview) => void,
  ): void {
    this.unsubscribeProgress?.();
    this.unsubscribeProgress = undefined;
    if (this.progressDelay) clearTimeout(this.progressDelay);
    this.progressDelay = setTimeout(() => {
      this.progressDelay = undefined;
      let previousLines = 0;
      this.unsubscribeProgress = subscribeBashOutputProgress(intervalMs, async (isActive) => {
        const output = await readBashOutput(
          this.path,
          Math.min(maxBytes, PROGRESS_TAIL_MAX_BYTES),
          true,
          this.legacyEncoding,
        );
        // 共享 interval 仍在服务其他任务；取消/重订阅后必须丢弃本订阅迟到的读取。
        if (!isActive()) return;
        const preview = buildBashOutputPreview(
          output.text,
          output.bytesRead,
          output.bytes,
          previousLines,
        );
        previousLines = preview.totalLines;
        onRead(output, preview);
      });
    }, delayMs);
    this.progressDelay.unref();
  }

  async result(maxBytes: number): Promise<ExecutionStreamResult> {
    if (!this.prepared) return { text: "", bytes: 0, truncated: false };
    try {
      const { bytesRead: _bytesRead, ...result } = await readBashOutput(
        this.path,
        maxBytes,
        false,
        this.legacyEncoding,
      );
      return result;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
      return {
        text: `<bash output unavailable: output file ${this.path} could not be read (${code}).>`,
        bytes: 0,
        truncated: false,
      };
    }
  }
}

export async function readBashOutput(
  path: string,
  maxBytes: number,
  tail: boolean,
  legacyEncoding: string | null,
): Promise<ExecutionStreamResult & { bytesRead: number }> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, Math.max(0, maxBytes));
    const offset = tail ? size - length : 0;
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const read = await handle.read(buffer, bytesRead, length - bytesRead, offset + bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    return {
      text: decodeExecutionOutputBuffer(buffer.subarray(0, bytesRead), legacyEncoding),
      bytes: size,
      bytesRead,
      truncated: size > bytesRead,
      artifactPath: path,
      artifactBytes: size,
      artifactTruncated: false,
    };
  } finally {
    await handle.close();
  }
}

export async function diagnoseLostBashOutput(outputPath: string): Promise<string | undefined> {
  try {
    const outputDirectory = dirname(outputPath);
    const fileSystem = await statfs(outputDirectory, { bigint: true });
    const availableMegabytes = (fileSystem.bavail * fileSystem.bsize) / (1024n * 1024n);
    const recoveryHint = "Free up space on this filesystem.";
    if (availableMegabytes < 0n) return undefined;
    if (availableMegabytes < 10n) {
      return `Command output was lost: the temp filesystem at ${outputDirectory} is full (${availableMegabytes}MB free). The child process's stdout/stderr writes failed with ENOSPC. ${recoveryHint}`;
    }
    if (fileSystem.files > 0n && fileSystem.ffree < 1000n) {
      return `Command output was lost: the temp filesystem at ${outputDirectory} is out of inodes (${fileSystem.ffree} free). The child process's stdout/stderr writes failed with ENOSPC. ${recoveryHint}`;
    }
  } catch {

  }
  return undefined;
}
