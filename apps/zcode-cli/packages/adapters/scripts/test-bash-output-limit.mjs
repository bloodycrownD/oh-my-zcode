#!/usr/bin/env node
/**
 * Step 16 / T-C1 — exec 输出上限与超限截断验收（bugfix-batch-20261009 ⑥）。
 *
 * 覆盖三道护栏里与本包相关的两条：
 *   1. 上限下调 + env 覆盖（6a）：默认 256MiB、`ZCODE_EXEC_OUTPUT_LIMIT_BYTES`
 *      合法区间 1MiB..1GiB、非法/越界回落默认并提一句 debug；
 *      请求不再硬填 `maxPersistedBytes`（judge P1-2：request 值优先级最高，
 *      硬填会把 env 与 adapter 默认一起架空），前后台走同一解析链。
 *   2. 杀进程后物理截断（6b）：文件被改写成「头 + `[truncated N bytes by omz
 *      exec output limit]` + 尾」，体积 ≤ 上限 + 标记行；未超限文件字节不变。
 *
 * 分层（对应 round-2 审查 P2）：
 *   - env 解析 / 请求级优先级 / 截断 helper：**直测**，不 spawn，任何主机可跑；
 *   - 真实失控命令（a）：用 `node -e` 死循环灌输出，**不依赖 Git-bash**——
 *     `bash-shell-provider.ts` 在没有 Git-bash 的主机会回落到 cmd.exe，
 *     而请求形状（`shellProfile: "posix-bash"`）与具体 shell 无关，仍然选中
 *     Bash 合并输出文件路径，因此用例在两类主机上都能验证「taskkill 杀进程 →
 *     子进程确认退出后截断」的真实链路。
 *
 * 隔离：测试内显式 `ZCODE_STORAGE_DIR` 指向临时目录，绝不触碰真实 `~/.omz`。
 *
 * 运行前需先构建：`pnpm --filter @zcode/contracts build`、
 * `pnpm --filter @zcode/magic-context build`、`pnpm --filter @zcode/adapters build`
 * （本脚本 import 编译产物 `dist/`，并用 resolve 钩子把发布原始 TS 的 workspace
 *  包改指到同布局 dist，手法同 `test-magic-context-domain.mjs`）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map"]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const packageName = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : TS_SOURCE_PACKAGES.has(`${specifier.split("/").slice(0, 2).join("/")}`)
        ? `${specifier.split("/").slice(0, 2).join("/")}`
        : null;
    if (packageName !== null) {
      const distRoot = `${REPO_ROOT}packages/${packageName.slice("@zcode/".length)}/dist/`;
      const subpath = specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
      for (const candidate of [`${distRoot}${subpath}.js`, `${distRoot}${subpath}/index.js`]) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
      throw new Error(`no compiled dist for "${specifier}" — build ${packageName} first`);
    }
    return nextResolve(specifier, context);
  },
});

// 动态 import：resolve 钩子必须先注册，否则 adapters 的 dist 链在加载期就解析失败。
const { NodeExecutionAdapter } = await import("../dist/exec/node-execution-adapter.js");
const { truncateBashOutputFileKeepHeadTail } = await import("../dist/exec/bash-file-output.js");
const {
  BASH_RUNTIME_OUTPUT_LIMIT_BYTES,
  MAX_EXEC_OUTPUT_LIMIT_BYTES,
  MIN_EXEC_OUTPUT_LIMIT_BYTES,
  formatExecOutputLimitBytes,
  resolveBashRuntimeOutputLimitBytes,
} = await import("../dist/exec/execution-utils.js");

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
/** 截断标记行的长度上界预算（helper 内同类常量）。 */
const TRUNCATE_MARKER_SLACK_BYTES = 256;
const WATCHDOG_INTERVAL_MS = 5_000;
/** 5s 轮询看门狗 + 杀树 + 截断，留足余量。 */
const OVERSIZE_TOTAL_MS = WATCHDOG_INTERVAL_MS + 30_000;

// ── 公共工具 ────────────────────────────────────────────────────────────────

/** 同步建临时目录：让用例体可以用同步 try/finally 收尾。 */
function createWorkspace() {
  // ZCODE_STORAGE_DIR 必须显式指向临时目录（RULE：绝不写真实 ~/.omz）。
  const storageDir = mkdtempSync(join(tmpdir(), "omz-exec-output-limit-"));
  const rootDir = join(storageDir, "cli", "exec");
  // adapter 自己是懒建目录的；直测 helper 的用例要自己先建好。
  mkdirSync(rootDir, { recursive: true });
  return {
    storageDir,
    rootDir,
    cleanup: () => {
      // Windows 上若残留句柄，EPERM/EBUSY 属预期；best-effort 清理不能让用例假失败。
      void rm(storageDir, { recursive: true, force: true }).catch((error) => {
        if (error?.code === "EPERM" || error?.code === "EBUSY") return;
        throw error;
      });
    },
  };
}

/** 去掉注释，让静态守卫只面对真实代码（否则解释性注释会误报）。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

/** 真实落盘路径（与 base 的 outputPathsForRequest 同一构造）。 */
function execOutputPath(rootDir, sessionId, toolCallId) {
  return join(rootDir, sessionId, `${toolCallId}-stdout.log`);
}

function createAdapter(workspace, env, onDebug) {
  return new NodeExecutionAdapter({
    outputRootDir: workspace.rootDir,
    processEnv: { ...process.env, ZCODE_STORAGE_DIR: workspace.storageDir, ...env },
    ...(onDebug ? { onDebug } : {}),
  });
}

/**
 * 复刻 core `src/tool/handlers/bash.ts` 的 createExecutionRequest 在 6a 之后的形状：
 * command 固定 `mode:"shell" + shellProfile:"posix-bash"`（选中 Bash 合并输出文件路径），
 * **不再填 `maxPersistedBytes`**——上限交给 adapter 侧解析链。
 * 这条复刻是「request 级」用例的地基：只要哪一天硬填回来，下面的断言立刻红。
 */
function createBashExecutionRequest(args) {
  return {
    command: { mode: "shell", command: args.command, shellProfile: "posix-bash" },
    cwd: process.cwd(),
    timeoutMs: 0,
    outputLimit: {
      maxInlineBytes: 30_000,
      maxBufferBytes: 30_000,
      ...(args.maxPersistedBytes === undefined ? {} : { maxPersistedBytes: args.maxPersistedBytes }),
      persistOutput: args.persistOutput ?? "on_truncate",
    },
    trace: {
      traceId: "trace-test",
      spanId: "span-test",
      parentSpanId: undefined,
      sessionId: args.sessionId,
      turnId: "turn-test",
      attributes: { toolCallId: args.toolCallId, toolName: "Bash" },
    },
  };
}

/** 失控命令：死循环往 stdout 灌行。node -e 表达，cmd / bash 都能跑。 */
async function createFloodScript(workspace) {
  const scriptPath = join(workspace.rootDir, "omz-flood.mjs");
  await writeFile(
    scriptPath,
    [
      'process.stdout.write("omz-flood-head-line\\n");',
      "let line = 0;",
      "const timer = setInterval(() => {",
      "  for (let batch = 0; batch < 200; batch += 1) {",
      '    process.stdout.write(`omz-flood-line-${line++}\\n`);',
      "  }",
      "}, 5);",
      "process.on('exit', () => clearInterval(timer));",
    ].join("\n"),
    "utf8",
  );
  return scriptPath;
}

/**
 * 未超限用例：把固定 payload 写进临时脚本再 `node <file>` 执行。
 * 不用 `node -e "..."` 内联：payload 里的引号会让 cmd/bash 两种引用规则互相打架
 * （本次开发时内联版在 cmd 回落主机上直接把参数解析炸掉，用例假失败）。
 */
async function createPinnedOutputScript(workspace, scriptName, payload) {
  const scriptPath = join(workspace.rootDir, scriptName);
  await writeFile(
    scriptPath,
    `process.stdout.write(${JSON.stringify(payload)});\n`,
    "utf8",
  );
  return scriptPath;
}

// ── T-C1-1：env 解析（直测） ────────────────────────────────────────────────

test("T-C1-1a: env 缺省/空串回落默认 256MiB", () => {
  assert.equal(BASH_RUNTIME_OUTPUT_LIMIT_BYTES, 256 * MIB);
  assert.equal(resolveBashRuntimeOutputLimitBytes({}), 256 * MIB);
  assert.equal(
    resolveBashRuntimeOutputLimitBytes({ ZCODE_EXEC_OUTPUT_LIMIT_BYTES: "" }),
    256 * MIB,
  );
  assert.equal(
    resolveBashRuntimeOutputLimitBytes({ ZCODE_EXEC_OUTPUT_LIMIT_BYTES: "   " }),
    256 * MIB,
  );
});

test("T-C1-1b: 合法 env 覆盖生效（含区间边界 1MiB / 1GiB）", () => {
  assert.equal(
    resolveBashRuntimeOutputLimitBytes({ ZCODE_EXEC_OUTPUT_LIMIT_BYTES: "2097152" }),
    2 * MIB,
  );
  assert.equal(resolveBashRuntimeOutputLimitBytes({ ZCODE_EXEC_OUTPUT_LIMIT_BYTES: "1048576" }), MIB);
  assert.equal(
    resolveBashRuntimeOutputLimitBytes({ ZCODE_EXEC_OUTPUT_LIMIT_BYTES: "1073741824" }),
    GIB,
  );
  assert.equal(MIN_EXEC_OUTPUT_LIMIT_BYTES, MIB);
  assert.equal(MAX_EXEC_OUTPUT_LIMIT_BYTES, GIB);
});

test("T-C1-1c: 越界/非法值回落默认并提一句 debug", () => {
  const notes = [];
  const onDebug = (message) => notes.push(message);
  // 越界：低于下限、高于上限
  assert.equal(
    resolveBashRuntimeOutputLimitBytes({ ZCODE_EXEC_OUTPUT_LIMIT_BYTES: String(MIB - 1) }, onDebug),
    256 * MIB,
  );
  assert.equal(
    resolveBashRuntimeOutputLimitBytes({ ZCODE_EXEC_OUTPUT_LIMIT_BYTES: String(GIB + 1) }, onDebug),
    256 * MIB,
  );
  // 非法：非数字、带单位后缀、零、负数、小数
  for (const bad of ["abc", "10MiB", "-1", "0", "1.5", "256mib"]) {
    assert.equal(
      resolveBashRuntimeOutputLimitBytes({ ZCODE_EXEC_OUTPUT_LIMIT_BYTES: bad }, onDebug),
      256 * MIB,
      `expected "${bad}" to fall back to the default`,
    );
  }
  assert.equal(notes.length, 8, "每次回落都必须留一句 debug 说明");
  for (const message of notes) assert.match(message, /ZCODE_EXEC_OUTPUT_LIMIT_BYTES=/);
  // 合法值不制造 debug 噪音
  const quiet = [];
  assert.equal(
    resolveBashRuntimeOutputLimitBytes(
      { ZCODE_EXEC_OUTPUT_LIMIT_BYTES: String(4 * MIB) },
      (message) => quiet.push(message),
    ),
    4 * MIB,
  );
  assert.deepEqual(quiet, []);
});

// ── T-C1-2：请求级优先级（judge P1-2 回潮网） ───────────────────────────────

test("T-C1-2a: 请求不填 maxPersistedBytes 时 env 覆盖直达 watchdog 上限", () => {
  const workspace = createWorkspace();
  try {
    const request = createBashExecutionRequest({
      command: "true",
      sessionId: "sess_precedence",
      toolCallId: "call_precedence",
    });
    assert.equal("maxPersistedBytes" in request.outputLimit, false);
    const adapter = createAdapter(workspace, { ZCODE_EXEC_OUTPUT_LIMIT_BYTES: String(2 * MIB) });
    // persistedOutputLimit 是 watchdog（watchLimit）与后台 aggregate 预算读的同一个值。
    assert.equal(adapter.persistedOutputLimit(request), 2 * MIB);
  } finally {
    workspace.cleanup();
  }
});

test("T-C1-2b: 优先级链 request > options > env > 默认", () => {
  const workspace = createWorkspace();
  try {
    const env = { ZCODE_EXEC_OUTPUT_LIMIT_BYTES: String(2 * MIB) };
    const adapter = createAdapter(workspace, env);
    assert.equal(
      adapter.persistedOutputLimit(
        createBashExecutionRequest({
          command: "true",
          sessionId: "sess_request",
          toolCallId: "call_request",
          maxPersistedBytes: 8 * MIB,
        }),
      ),
      8 * MIB,
    );

    const withOption = new NodeExecutionAdapter({
      outputRootDir: workspace.rootDir,
      processEnv: { ...process.env, ZCODE_STORAGE_DIR: workspace.storageDir, ...env },
      maxPersistedOutputBytes: 4 * MIB,
    });
    assert.equal(
      withOption.persistedOutputLimit(
        createBashExecutionRequest({
          command: "true",
          sessionId: "sess_option",
          toolCallId: "call_option",
        }),
      ),
      4 * MIB,
    );

    const defaulted = new NodeExecutionAdapter({
      outputRootDir: workspace.rootDir,
      processEnv: { ZCODE_STORAGE_DIR: workspace.storageDir },
    });
    assert.equal(
      defaulted.persistedOutputLimit(
        createBashExecutionRequest({
          command: "true",
          sessionId: "sess_default",
          toolCallId: "call_default",
        }),
      ),
      256 * MIB,
    );
  } finally {
    workspace.cleanup();
  }
});

test("T-C1-2c: 非法 env 在请求级回落默认 256MiB（不按边界猜测）", () => {
  const workspace = createWorkspace();
  const notes = [];
  try {
    const adapter = createAdapter(
      workspace,
      { ZCODE_EXEC_OUTPUT_LIMIT_BYTES: "10GiB" },
      (message) => notes.push(message),
    );
    assert.equal(
      adapter.persistedOutputLimit(
        createBashExecutionRequest({
          command: "true",
          sessionId: "sess_invalid",
          toolCallId: "call_invalid",
        }),
      ),
      256 * MIB,
    );
    assert.equal(notes.length, 1, "回落默认必须留一句 debug 说明");
  } finally {
    workspace.cleanup();
  }
});

test("T-C1-2d: 请求级回潮网——core/adapters 不再硬填 maxPersistedBytes", () => {
  // 跨包静态守卫：P1-2 的回归形态是「某处又写死 maxPersistedBytes」，
  // 行为测试要灌满上限才暴露；这里直接读源码钉住形状。
  const coreBashHandler = join(
    REPO_ROOT,
    "apps/zcode-cli/packages/core/src/tool/handlers/bash.ts",
  );
  const backgroundLifecycle = join(
    REPO_ROOT,
    "apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-lifecycle.ts",
  );
  for (const file of [coreBashHandler, backgroundLifecycle]) {
    assert.ok(existsSync(file), `missing source file: ${file}`);
  }
  const coreSource = stripComments(readFileSync(coreBashHandler, "utf8"));
  const lifecycleSource = stripComments(readFileSync(backgroundLifecycle, "utf8"));
  assert.equal(
    coreSource.includes("maxPersistedBytes"),
    false,
    "core createExecutionRequest 不得再硬填 maxPersistedBytes（会把 env 覆盖架空）",
  );
  assert.equal(
    coreSource.includes("MAX_RUNTIME_PERSISTED_OUTPUT_BYTES"),
    false,
    "core 的 5GiB 上限常量应随硬填一起移除",
  );
  assert.equal(
    lifecycleSource.includes("maxPersistedBytes"),
    false,
    "后台 lifecycle 不得再硬填 maxPersistedBytes（否则 env 对 run_in_background / auto_on_timeout 不生效）",
  );
});

// ── T-C1-3：截断 helper（直测） ─────────────────────────────────────────────

test("T-C1-3a: 超限文件被改写成 头+标记+尾，体积 ≤ 上限+标记余量", async () => {
  const workspace = createWorkspace();
  try {
    const target = join(workspace.rootDir, "oversize.log");
    // 4MiB 文件 + 1MiB 上限：头/尾窗口按上限收缩到各 512KiB。
    const payload = Buffer.from("omz-truncate-payload\n".repeat(4 * MIB));
    await writeFile(target, payload);
    const result = await truncateBashOutputFileKeepHeadTail(target, MIB);
    assert.ok(result, "超限文件必须被截断");
    const after = await readFile(target);
    assert.ok(
      after.length <= MIB + TRUNCATE_MARKER_SLACK_BYTES,
      `截断后 ${after.length} 超出上限+标记余量`,
    );
    const text = after.toString("utf8");
    assert.match(text, /\[truncated \d+ bytes by omz exec output limit\]/);
    // 头 = 原文件开头，尾 = 原文件结尾，中间只剩一行标记
    const payloadText = payload.toString("utf8");
    assert.equal(text.startsWith(payloadText.slice(0, 512 * 1024)), true, "头部必须是原文件开头");
    assert.equal(text.endsWith(payloadText.slice(-512 * 1024)), true, "尾部必须是原文件结尾");
    assert.equal(result.removedBytes, payload.length - MIB);
    assert.equal(result.finalBytes, after.length);
  } finally {
    workspace.cleanup();
  }
});

test("T-C1-3b: 未超限文件字节不变（helper 直返 undefined 且不落笔）", async () => {
  const workspace = createWorkspace();
  try {
    const target = join(workspace.rootDir, "undersize.log");
    const before = Buffer.from("omz-not-truncated\n".repeat(1024));
    await writeFile(target, before);
    const result = await truncateBashOutputFileKeepHeadTail(target, 256 * MIB);
    assert.equal(result, undefined, "未超限文件不应被截断");
    const after = await readFile(target);
    assert.equal(after.length, before.length, "字节数必须原样保留");
    assert.equal(after.equals(before), true, "内容必须逐字节不变");
  } finally {
    workspace.cleanup();
  }
});

test("T-C1-3c: 上限 ≥ 2MiB 时头尾保留默认 1MiB 窗口（不按上限收缩）", async () => {
  const workspace = createWorkspace();
  try {
    const target = join(workspace.rootDir, "default-window.log");
    // 8MiB 文件 + 4MiB 上限：窗口（各 1MiB）之和 2MiB 已低于上限，不再收缩。
    const payload = Buffer.from("omz-window-payload\n".repeat(8 * MIB));
    await writeFile(target, payload);
    const result = await truncateBashOutputFileKeepHeadTail(target, 4 * MIB);
    assert.ok(result, "超限文件必须被截断");
    const after = await readFile(target);
    assert.ok(after.length <= 2 * MIB + TRUNCATE_MARKER_SLACK_BYTES, "默认窗口下 2MiB+标记");
    assert.ok(after.length >= 2 * MIB, "头尾各 1MiB 默认窗口必须保留");
    const text = after.toString("utf8");
    const payloadText = payload.toString("utf8");
    assert.equal(text.startsWith(payloadText.slice(0, MIB)), true, "头部取默认 1MiB 窗口");
    assert.equal(text.endsWith(payloadText.slice(-MIB)), true, "尾部取默认 1MiB 窗口");
    assert.equal(result.finalBytes, after.length);
  } finally {
    workspace.cleanup();
  }
});

test("T-C1-3d: 文件不存在时抛错（由调用方记日志吞掉，不静默成功）", async () => {
  const workspace = createWorkspace();
  try {
    await assert.rejects(
      () => truncateBashOutputFileKeepHeadTail(join(workspace.rootDir, "missing.log"), MIB),
      /ENOENT/,
    );
  } finally {
    workspace.cleanup();
  }
});

// ── T-C1-4：真实失控命令（taskkill 杀进程 → 确认退出后截断） ────────────────

test(
  "T-C1-4a: 真实 node 死循环灌爆输出 → 看门狗杀进程 → 文件截断为头尾+标记",
  { timeout: OVERSIZE_TOTAL_MS },
  async () => {
    const workspace = createWorkspace();
    let adapter;
    try {
      const scriptPath = await createFloodScript(workspace);
      adapter = createAdapter(workspace, { ZCODE_EXEC_OUTPUT_LIMIT_BYTES: String(MIB) });
      const request = createBashExecutionRequest({
        command: `node "${scriptPath}"`,
        sessionId: "sess_flood",
        toolCallId: "call_flood",
        persistOutput: "always",
      });
      // run_in_background 即事故路径：后台 Bash 不带超时计时器，
      // 唯一闸门就是 5s 轮询的看门狗。
      const started = await adapter.runBashWithBackgroundLifecycle(request, { mode: "explicit" });
      assert.equal(started.kind, "backgrounded");
      if (started.kind !== "backgrounded") return;
      const snapshot = await adapter.waitForBackgroundTask(started.task.taskId);
      assert.ok(snapshot, "后台任务必须有终态");
      assert.equal(snapshot.status, "cancelled", "看门狗超限必须以 cancelled 结算");
      assert.equal(snapshot.result?.exitCode, 137, "超限杀进程固定 exitCode 137");
      assert.match(
        snapshot.result?.error?.message ?? "",
        /output file exceeded 1MiB/,
        "文案必须带上限值（原硬编码 5GB 已动态化）",
      );

      const outputFile = execOutputPath(workspace.rootDir, "sess_flood", "call_flood");
      // 等终态时截断已完成：文件应已是「头 + 标记 + 尾」。
      const truncatedSize = (await stat(outputFile)).size;
      assert.ok(
        truncatedSize <= MIB + TRUNCATE_MARKER_SLACK_BYTES,
        `截断后 ${truncatedSize} 必须 ≤ 上限 ${MIB} + 标记余量`,
      );
      const text = await readFile(outputFile, "utf8");
      assert.match(text, /\[truncated \d+ bytes by omz exec output limit\]/);
      assert.ok(text.startsWith("omz-flood-head-line\n"), "头部必须是输出起点");
      assert.match(text, /omz-flood-line-0\n/);
      const tailWindow = text.slice(Math.max(0, text.length - 4096));
      const tailLines = tailWindow.match(/omz-flood-line-(\d+)/g) ?? [];
      assert.ok(tailLines.length > 0, "尾部必须保留最后写入的行");
      const lastLine = Number(tailLines.at(-1).split("-").at(-1));
      assert.ok(lastLine > 1_000, `尾部应是写入后期的行（实得 ${lastLine}）`);
    } finally {
      await adapter?.close().catch(() => undefined);
      workspace.cleanup();
    }
  },
);

// ── T-C1-5：env 覆盖端到端 + 未超限文件字节不变 ────────────────────────────

test(
  "T-C1-5a: env 覆盖 2MiB 时未超限文件字节不变",
  { timeout: OVERSIZE_TOTAL_MS },
  async () => {
    const workspace = createWorkspace();
    let adapter;
    try {
      adapter = createAdapter(workspace, { ZCODE_EXEC_OUTPUT_LIMIT_BYTES: String(2 * MIB) });
      // 输出量约 51KiB，远低于 2MiB：不应触发看门狗，文件字节原样保留。
      const payload = "omz-under-limit-payload\n".repeat(2500);
      const scriptPath = await createPinnedOutputScript(
        workspace,
        "omz-under-limit.mjs",
        payload,
      );
      const request = createBashExecutionRequest({
        command: `node "${scriptPath}"`,
        sessionId: "sess_under",
        toolCallId: "call_under",
        persistOutput: "always",
      });
      const started = await adapter.runBashWithBackgroundLifecycle(request, { mode: "explicit" });
      assert.equal(started.kind, "backgrounded");
      if (started.kind !== "backgrounded") return;
      const snapshot = await adapter.waitForBackgroundTask(started.task.taskId);
      assert.equal(snapshot?.status, "completed", "未超限任务必须正常完成");
      const text = await readFile(execOutputPath(workspace.rootDir, "sess_under", "call_under"), "utf8");
      assert.equal(text, payload, "未超限输出必须逐字节保留");
      assert.equal(text.includes("[truncated "), false, "未超限不得出现截断标记");
    } finally {
      await adapter?.close().catch(() => undefined);
      workspace.cleanup();
    }
  },
);

test("T-C1-5b: 上限文案随 env 覆盖变化", () => {
  assert.equal(formatExecOutputLimitBytes(256 * MIB), "256MiB");
  assert.equal(formatExecOutputLimitBytes(2 * MIB), "2MiB");
  assert.equal(formatExecOutputLimitBytes(GIB), "1GiB");
  assert.equal(formatExecOutputLimitBytes(0), "0");
});

// ── 进程报告 ────────────────────────────────────────────────────────────────

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — exec output limit + head/tail truncation (T-C1)"
      : `TEST FAIL — exec output limit + head/tail truncation (exit ${code})`,
  );
});
