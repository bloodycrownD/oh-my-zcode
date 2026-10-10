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
 *      exec output limit]` + 尾」，体积 ≤ 上限（预算已扣 marker，不依赖 slack）；
 *      未超限文件字节不变。截断触发是收尾状态判定：kill/竞态标志之外兜一次
 *      stat，覆盖「子进程自然退出 + 看门狗从未落窗」的主事故形态（uix/B-1），
 *      且结果面附不改 status 的截断说明（N-1/C-1）。
 *
 * 分层（对应 round-2 审查 P2）：
 *   - env 解析 / 请求级优先级 / 截断 helper：**直测**，不 spawn，任何主机可跑；
 *   - 真实失控命令（a）：用 `node -e` 死循环灌输出，**不依赖 Git-bash**——
 *     `bash-shell-provider.ts` 在没有 Git-bash 的主机会回落到 cmd.exe，
 *     而请求形状（`shellProfile: "posix-bash"`）与具体 shell 无关，仍然选中
 *     Bash 合并输出文件路径，因此用例在两类主机上都能验证「taskkill 杀进程 →
 *     子进程确认退出后截断」的真实链路。
 *
 * CI 矩阵登记（uix/G-3d）：**POSIX kill 链**（`process-tree.ts` 两阶段
 * SIGTERM→SIGKILL escalation、`terminateProcessTree` 的 POSIX 分支）在本 CI
 * 矩阵中**仅类型检查 + 人工验收**——真实失控命令用例（T-C1-4a）在 Windows 上
 * 只走 taskkill 分支，POSIX 两阶段杀树没有自动化断言；合并前按 fix-spec 以
 * 人工验收登记，不写平台条件化的 flaky 用例。
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
const {
  BASH_OUTPUT_NOT_TRUNCATED_NOTICE,
  BASH_OUTPUT_TRUNCATED_NOTICE,
  truncateBashOutputAfterKill,
  truncateBashOutputFileKeepHeadTail,
} = await import("../dist/exec/bash-file-output.js");
const {
  BASH_OUTPUT_TRUNCATE_WAIT_MS,
  BASH_RUNTIME_OUTPUT_LIMIT_BYTES,
  FORCE_EXIT_AFTER_KILL_MS,
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
/** 自然退出用例：命令毫秒级跑完，余量留给 shell 起飞与截断收尾。 */
const NATURAL_EXIT_TOTAL_MS = 30_000;
/**
 * 逃逸用例：5s 看门狗 + 7s 截断等待上界（escape）+ 自退脚本的存活窗口 + 收尾。
 * 17s 自退窗口保证「杀树 completion 悬挂」期间进程仍在，逼 waitForPromise 超时。
 */
const ESCAPE_SELF_EXIT_MS = 15_000;
const ESCAPE_TOTAL_MS =
  WATCHDOG_INTERVAL_MS + BASH_OUTPUT_TRUNCATE_WAIT_MS + ESCAPE_SELF_EXIT_MS + 30_000;

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

/**
 * 自然退出用例：把 sizeBytes 输出写完就立刻退出——看门狗 5s 轮询根本落不了窗，
 * 两标志皆 false，正是 uix/B-1 的主事故形态（旧代码在此场景完全不截断）。
 */
async function createOversizeExitScript(workspace, scriptName, sizeBytes) {
  const scriptPath = join(workspace.rootDir, scriptName);
  await writeFile(
    scriptPath,
    [
      "const chunk = 'omz-natural-exit-payload\\n'.repeat(1024);",
      `for (let written = 0; written < ${sizeBytes}; written += chunk.length) {`,
      "  process.stdout.write(chunk);",
      "}",
    ].join("\n"),
    "utf8",
  );
  return scriptPath;
}

/**
 * 逃逸用例：写完超限输出后挂住不退出，`ESCAPE_SELF_EXIT_MS` 后自行退出。
 * 配合 StalledKillAdapter（杀树 completion 永不 settle）把截断等待逼到上界。
 */
async function createEscapeScript(workspace, scriptName) {
  const scriptPath = join(workspace.rootDir, scriptName);
  await writeFile(
    scriptPath,
    [
      "const chunk = 'omz-escape-payload\\n'.repeat(1024);",
      "for (let written = 0; written < 2 * 1024 * 1024; written += chunk.length) {",
      "  process.stdout.write(chunk);",
      "}",
      `setTimeout(() => process.exit(0), ${ESCAPE_SELF_EXIT_MS});`,
    ].join("\n"),
    "utf8",
  );
  return scriptPath;
}

/** 杀树 completion 永不 settle 的 adapter：确定性地把截断推进逃逸分支（uix/C-1）。 */
class StalledKillAdapter extends NodeExecutionAdapter {
  terminateProcessTree() {
    return new Promise(() => {});
  }
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

test("T-C1-3a: 超限文件被改写成 头+标记+尾，整体体积 ≤ 上限（预算已扣 marker）", async () => {
  const workspace = createWorkspace();
  try {
    // uix/B-2：1MiB 下限场景双跑（4MiB 与 1.5MiB 两档文件）。窗口预算 =
    // limit - marker 上界，头尾各半；截断后「头 + 标记 + 尾」必须整体 ≤ limit，
    // 不再依赖 256B slack（marker 文案一变旧实现即越界）。
    const budget = MIB - TRUNCATE_MARKER_SLACK_BYTES;
    const windowKeep = Math.floor(budget / 2);
    for (const fileSizeMiB of [4, 1.5]) {
      const target = join(workspace.rootDir, `oversize-${fileSizeMiB}.log`);
      const payload = Buffer.from("omz-truncate-payload\n".repeat(Math.round(fileSizeMiB * MIB)));
      await writeFile(target, payload);
      const result = await truncateBashOutputFileKeepHeadTail(target, MIB);
      assert.ok(result, `超限文件必须被截断（${fileSizeMiB}MiB）`);
      const after = await readFile(target);
      assert.ok(
        after.length <= MIB,
        `截断后 ${after.length} 超出上限 ${MIB}（预算已扣 marker，不含 slack）`,
      );
      assert.equal(result.finalBytes, after.length);
      const text = after.toString("utf8");
      assert.match(text, /\[truncated \d+ bytes by omz exec output limit\]/);
      // 头 = 原文件开头，尾 = 原文件结尾，中间只剩一行标记
      const payloadText = payload.toString("utf8");
      assert.equal(
        text.startsWith(payloadText.slice(0, windowKeep)),
        true,
        "头部必须是原文件开头（窗口按预算收缩）",
      );
      assert.equal(
        text.endsWith(payloadText.slice(-windowKeep)),
        true,
        "尾部必须是原文件结尾（窗口按预算收缩）",
      );
      assert.equal(result.removedBytes, payload.length - budget);
    }
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
        truncatedSize <= MIB,
        `截断后 ${truncatedSize} 必须 ≤ 上限 ${MIB}（预算已扣 marker，不含 slack）`,
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

test(
  "T-C1-4b: 子进程自然退出但文件超限 → 收尾仍截断为头尾+标记（uix/B-1 主事故形态）",
  { timeout: NATURAL_EXIT_TOTAL_MS },
  async () => {
    const workspace = createWorkspace();
    let adapter;
    try {
      // 2MiB 输出 + 1MiB 上限，写完立刻退出：看门狗 5s 轮询落不了窗，
      // outputLimitExceeded / outputLimitDetected 两标志皆 false——旧代码在此
      // 场景完全不截断；修复后收尾 stat 兜底仍然截断。
      const scriptPath = await createOversizeExitScript(workspace, "omz-natural-exit.mjs", 2 * MIB);
      adapter = createAdapter(workspace, { ZCODE_EXEC_OUTPUT_LIMIT_BYTES: String(MIB) });
      const request = createBashExecutionRequest({
        command: `node "${scriptPath}"`,
        sessionId: "sess_natural_exit",
        toolCallId: "call_natural_exit",
        persistOutput: "always",
      });
      const result = await adapter.run(request);
      // 自然退出不是 killed：exitCode 0、status completed、无取消语义。
      assert.equal(result.exitCode, 0);
      assert.equal(result.status, "completed");
      assert.equal(result.cancelled, false);
      assert.equal(result.timedOut, false);
      const outputFile = execOutputPath(
        workspace.rootDir,
        "sess_natural_exit",
        "call_natural_exit",
      );
      const after = await readFile(outputFile, "utf8");
      assert.ok(after.length <= MIB, `自然退出+超限也必须截断到 ≤ 上限（实得 ${after.length}）`);
      assert.match(after, /\[truncated \d+ bytes by omz exec output limit\]/);
      assert.ok(after.startsWith("omz-natural-exit-payload\n"), "头部必须是输出起点");
    } finally {
      await adapter?.close().catch(() => undefined);
      workspace.cleanup();
    }
  },
);

test(
  "T-C1-4c: 截断发生时 status 仍 completed，结果面附截断说明（N-1）",
  { timeout: NATURAL_EXIT_TOTAL_MS },
  async () => {
    const workspace = createWorkspace();
    let adapter;
    try {
      const scriptPath = await createOversizeExitScript(
        workspace,
        "omz-natural-exit-2.mjs",
        2 * MIB,
      );
      adapter = createAdapter(workspace, { ZCODE_EXEC_OUTPUT_LIMIT_BYTES: String(MIB) });
      const request = createBashExecutionRequest({
        command: `node "${scriptPath}"`,
        sessionId: "sess_natural_exit_2",
        toolCallId: "call_natural_exit_2",
        persistOutput: "always",
      });
      const result = await adapter.run(request);
      // N-1：文件被物理截断后用户必须看得见，但 status 不谎报 killed。
      assert.equal(result.status, "completed");
      assert.equal(result.cancelled, false);
      assert.equal(result.error?.type, "output_limit");
      assert.equal(
        result.error?.message,
        BASH_OUTPUT_TRUNCATED_NOTICE,
        "结果面必须附不改 status 的截断说明",
      );
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

// ── T-C1-6：截断收尾 helper 直测（uix/G-3a） ───────────────────────────────

test("T-C1-6a: settled（close 已发生）→ 截断生效并返回结果", async () => {
  const workspace = createWorkspace();
  try {
    const target = join(workspace.rootDir, "settled.log");
    const payload = Buffer.from("omz-settled-payload\n".repeat(2 * MIB));
    await writeFile(target, payload);
    const result = await truncateBashOutputAfterKill({
      filePath: target,
      closePromise: Promise.resolve(),
      limitBytes: MIB,
    });
    assert.ok(result, "settled 且超限必须返回截断结果");
    assert.ok(result.removedBytes > 0);
    assert.ok(result.finalBytes <= MIB, "预算扣 marker 后不得超出上限");
    assert.match(result.marker, /\[truncated \d+ bytes by omz exec output limit\]/);
    const after = await readFile(target);
    assert.equal(after.length, result.finalBytes);
  } finally {
    workspace.cleanup();
  }
});

test("T-C1-6b: 未 settle（close/kill 悬挂）→ 跳过截断并留 not truncated 说明", async () => {
  const workspace = createWorkspace();
  const notes = [];
  try {
    const target = join(workspace.rootDir, "never-settles.log");
    const payload = Buffer.from("omz-never-settle\n".repeat(2 * MIB));
    await writeFile(target, payload);
    const result = await truncateBashOutputAfterKill({
      filePath: target,
      closePromise: new Promise(() => {}),
      killCompletion: new Promise(() => {}),
      limitBytes: MIB,
      // 显式小等待（默认 7s 太慢）：逃逸分支要被确定性地走到。
      waitMs: 40,
      onDebug: (message) => notes.push(message),
    });
    assert.equal(result, undefined, "未 settle 不得截断");
    const after = await readFile(target);
    assert.equal(after.length, payload.length, "逃逸时文件必须字节不变");
    assert.equal(notes.length, 1, "逃逸必须留一句 debug 说明");
    assert.match(notes[0], /output file not truncated/, "逃逸说明必须带 not truncated");
    assert.match(notes[0], /never-settles\.log/, "逃逸说明必须带文件路径");
    // 本进程里此刻只剩这一段等待（两个悬挂 Promise + 唯一 timer）：用例能跑完
    // 即证明截断等待期 timer 持活（keepAlive），没有被事件循环提前丢弃（uix/C-1）。
  } finally {
    workspace.cleanup();
  }
});

test("T-C1-6c: killCompletion 缺省（竞态路径无杀树可等）→ 等 close 后照常截断", async () => {
  const workspace = createWorkspace();
  try {
    const target = join(workspace.rootDir, "no-kill.log");
    const payload = Buffer.from("omz-no-kill\n".repeat(2 * MIB));
    await writeFile(target, payload);
    // close 延迟一Tick 落地：证明 helper 真的在等 close，而不是碰巧立即成功。
    const closeAfterTick = new Promise((resolve) => setTimeout(resolve, 20));
    const result = await truncateBashOutputAfterKill({
      filePath: target,
      closePromise: closeAfterTick,
      limitBytes: MIB,
    });
    assert.ok(result, "killCompletion 缺省不应妨碍 settled 截断（竞态路径）");
    assert.ok(result.finalBytes <= MIB);
    const after = await readFile(target);
    assert.match(after.toString("utf8"), /\[truncated \d+ bytes by omz exec output limit\]/);
  } finally {
    workspace.cleanup();
  }
});

test("T-C1-6d: IO 失败（文件不存在）→ 吞错返回 undefined 并留 debug 说明", async () => {
  const workspace = createWorkspace();
  const notes = [];
  try {
    const result = await truncateBashOutputAfterKill({
      filePath: join(workspace.rootDir, "missing-after-settle.log"),
      closePromise: Promise.resolve(),
      limitBytes: MIB,
      onDebug: (message) => notes.push(message),
    });
    assert.equal(result, undefined, "IO 失败必须吞错，不抛给 run() 收尾");
    assert.equal(notes.length, 1, "IO 失败必须留一句 debug 说明");
    assert.match(notes[0], /ENOENT/);
    assert.match(notes[0], /output file not truncated/, "IO 失败说明同样带 not truncated");
  } finally {
    workspace.cleanup();
  }
});

// ── T-C1-7：逃逸路径与等待上界锚点（uix/C-1） ──────────────────────────────

test(
  "T-C1-7a: 逃逸路径（杀树 completion 悬挂）→ 结果 message 附「output file not truncated」",
  { timeout: ESCAPE_TOTAL_MS },
  async () => {
    const workspace = createWorkspace();
    let adapter;
    try {
      // 看门狗 5s 时杀树（被 override 成永不 settle）；脚本写完 2MiB 后挂到
      // ESCAPE_SELF_EXIT_MS 自行退出，让 exit 先落地、再让截断等待越过 7s 上界。
      const scriptPath = await createEscapeScript(workspace, "omz-escape.mjs");
      adapter = new StalledKillAdapter({
        outputRootDir: workspace.rootDir,
        processEnv: {
          ...process.env,
          ZCODE_STORAGE_DIR: workspace.storageDir,
          ZCODE_EXEC_OUTPUT_LIMIT_BYTES: String(MIB),
        },
      });
      const request = createBashExecutionRequest({
        command: `node "${scriptPath}"`,
        sessionId: "sess_escape",
        toolCallId: "call_escape",
        persistOutput: "always",
      });
      // run_in_background 即事故路径（与 T-C1-4a 同）：前台 run() 会把
      // output_limit 结算的 artifact 归一化删除，文件保留语义只在后台路径成立。
      const started = await adapter.runBashWithBackgroundLifecycle(request, { mode: "explicit" });
      assert.equal(started.kind, "backgrounded");
      if (started.kind !== "backgrounded") return;
      const snapshot = await adapter.waitForBackgroundTask(started.task.taskId);
      assert.ok(snapshot, "后台任务必须有终态");
      const result = snapshot.result;
      assert.equal(result?.cancelled, true, "超限 kill 仍以 cancelled 结算");
      assert.match(result?.error?.message ?? "", /output file exceeded 1MiB/);
      // uix/C-1：逃逸（child/tree 未在等待上界内 settle）必须在结果 message 附注。
      assert.match(
        result?.error?.message ?? "",
        /output file not truncated/,
        "逃逸路径必须附「输出未截断」可见信号",
      );
      assert.ok(
        result?.error?.message.includes(BASH_OUTPUT_NOT_TRUNCATED_NOTICE),
        "附注须与 helper 输出的常量一致",
      );
      const outputFile = execOutputPath(workspace.rootDir, "sess_escape", "call_escape");
      const size = (await stat(outputFile)).size;
      assert.ok(size > MIB, `逃逸时原文件必须保持未截断（实得 ${size}）`);
    } finally {
      await adapter?.close().catch(() => undefined);
      workspace.cleanup();
    }
  },
);

test("T-C1-7b: 截断等待上界严格大于 kill 上界（锚点关系，uix/C-1）", () => {
  assert.ok(
    BASH_OUTPUT_TRUNCATE_WAIT_MS > FORCE_EXIT_AFTER_KILL_MS,
    `截断等待 ${BASH_OUTPUT_TRUNCATE_WAIT_MS}ms 必须严格大于 kill 上界 ${FORCE_EXIT_AFTER_KILL_MS}ms`,
  );
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
