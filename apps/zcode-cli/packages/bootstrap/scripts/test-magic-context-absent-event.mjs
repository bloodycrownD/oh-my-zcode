#!/usr/bin/env node
/**
 * mc/A-1 — `magic_context.transform_absent` 的生产可达性与发射点单点化。
 *
 * ============================================================================
 * 这一步要钉死什么
 * ============================================================================
 *
 * ⑤-5a 之后 transform 缺席有三条事件路径：disabled / import_failed /
 * db_null:<细分>。但 disabled 那条**在生产不可达**：`create-app.ts` 的 enabled
 * gate 关着时工厂模块根本不 import，事件只由工厂内部的 disabled 分支发——
 * flag 关的用户看到的是「0 条事件 + 0 条 transform pass」的纯静默（mc/A-1）。
 * 绿地测试之所以全绿，是因为它们绕开 create-app 直构工厂（T4），测的正是
 * 生产不可达的那条路径。
 *
 * 修法（cr-fix-spec mc/A-1，r3/r4 微修版）：
 *   ① 零依赖 leaf `src/app/magic-context-absent-event.ts` 持有事件名常量、
 *      reason union 与 emit helper；生产发射点（logger event 字段赋值处）只剩
 *      它一处；
 *   ② create-app 的 enabled gate 补 else 分支，调 leaf 的
 *      `emitMagicContextTransformAbsent(logger, "disabled", ...)`；
 *   ③ import_failed 与工厂内 db_null/disabled 分支全部改调 leaf。
 *
 * 本脚本四组断言：
 *   E1 create-app 装配路径（子进程，enabled!==true）：
 *      a. `module.register` resolve hook 断言 magic-context-turn-transform
 *         模块**零加载**（flag 关时连 import 请求都不该发生）；
 *      b. hook 活性自检（哨兵模块必经 resolve，证明 hook 真的在链路上）；
 *      c. 可控 dataDir（MAGIC_CONTEXT_DB_DIR → 临时目录）断言无 db 文件；
 *      d. 子进程回传日志断言捕获 `disabled` 事件（leaf emit 的形状）。
 *   E2 leaf emit helper 进程内直测：事件名/reason/detail/module 四字段形状，
 *      以及 reason 取值域与真实发射值逐字一致。
 *   E3 工厂 db_null 细分守卫（mc/C-1）：表驱动直测导出的
 *      `describeStorageUnavailability`——refusal 无 blockers 时**不**误判
 *      migration_guard（与包内 storage-unavailable-reason.ts:24 同口径）。
 *
 * 隔离（硬规矩）：子进程所有写路径都经 env 显式改指临时目录——
 * `ZCODE_STORAGE_DIR`（storage/session db）、`MAGIC_CONTEXT_DB_DIR` +
 * `MAGIC_CONTEXT_LOG_PATH`（magic-context 库与日志）、`HOME`/`USERPROFILE`
 * （用户级配置目录），**绝不触碰用户真实的 `~/.omz`**（RULE.md 已登记 S30
 * 事故；data-path.ts 的 TEST-ISOLATION GUARD 记载了两次未隔离测试迁移真实库
 * 的事故）。
 *
 * 依赖已构建的 dist：`pnpm --filter @zcode/bootstrap build`（leaf 模块、工厂
 * 与 create-app 都从 dist 加载，与 test-boot-busy-retry /
 * test-magic-context-turn-transform 同一手法；发布原始 TypeScript 的
 * `@zcode/shared` / `@zcode/model-option-map` / `@zcode/provider` 经
 * registerHooks 改指到它们的编译产物）。
 *
 * Exits 0 on success, 1 on any failed assertion（node:test 自行置退出码）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const NODE = process.execPath;

// @zcode/shared / @zcode/model-option-map / @zcode/provider 的包入口发布的是原始
// TypeScript（`exports["."] = "./src/index.ts"`），裸 node 既无法把内部 `.js`
// 说明符改指到 `.ts`，也会在 strip-only 模式下拒绝参数属性。与
// magic-context/scripts/test-boot-busy-retry.mjs 同一手法：只改解析，不桩被测代码。
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map", "@zcode/provider"]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const segments = specifier.split("/");
    const packageName = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : TS_SOURCE_PACKAGES.has(segments.slice(0, 2).join("/"))
        ? segments.slice(0, 2).join("/")
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

const DIST_APP = fileURLToPath(new URL("../dist/app/", import.meta.url));
const CREATE_APP_DIST_URL = pathToFileURL(join(DIST_APP, "create-app.js")).href;
const FACTORY_DIST_URL = pathToFileURL(join(DIST_APP, "magic-context-turn-transform.js")).href;
for (const dist of [CREATE_APP_DIST_URL, FACTORY_DIST_URL]) {
  if (!existsSync(fileURLToPath(dist))) {
    throw new Error(
      `missing ${fileURLToPath(dist)} — run \`pnpm --filter @zcode/bootstrap build\` first`,
    );
  }
}

const { MAGIC_CONTEXT_TRANSFORM_ABSENT_EVENT, emitMagicContextTransformAbsent } = await import(
  pathToFileURL(join(DIST_APP, "magic-context-absent-event.js")).href
);
const { describeStorageUnavailability } = await import(FACTORY_DIST_URL);

// ── E2：leaf emit helper 进程内直测 ─────────────────────────────────────────

function capturingLogger() {
  const entries = [];
  const logger = {
    info() {},
    debug() {},
    warn(message, context) {
      entries.push({ level: "warn", message, context });
    },
    error(_error, _context) {},
    child() {
      return logger;
    },
  };
  return { logger, entries };
}

test("E2a: leaf emit helper 产出约定的四字段形状", () => {
  const { logger, entries } = capturingLogger();
  emitMagicContextTransformAbsent(logger, "disabled", "detail-text");
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.level, "warn");
  assert.equal(entry.context.module, "bootstrap");
  assert.equal(entry.context.event, MAGIC_CONTEXT_TRANSFORM_ABSENT_EVENT);
  assert.equal(entry.context.reason, "disabled");
  assert.equal(entry.context.detail, "detail-text");
});

test("E2b: reason 取值域与真实发射值逐字一致（含 db_null: 前缀）", () => {
  const reasons = [
    "disabled",
    "import_failed",
    "db_null:migration_guard",
    "db_null:fence",
    "db_null:pending_or_unclassified",
  ];
  for (const reason of reasons) {
    const { logger, entries } = capturingLogger();
    // 形状正确 ⇒ union 之外的值在编译期就被拒（这里是运行期直测，逐个过一遍）。
    emitMagicContextTransformAbsent(logger, reason, `detail-${reason}`);
    assert.equal(entries[0].context.reason, reason);
  }
});

// ── E3：db_null 细分守卫（mc/C-1，表驱动） ──────────────────────────────────

/** 包内 `MigrationOnOpenRefusal` 的最小形状（只填 describeStorageUnavailability 读的字段）。 */
function refusal(overrides = {}) {
  return {
    persistedVersion: 90,
    supportedVersion: 94,
    serverPids: [4242],
    ...overrides,
  };
}

const STORAGE_UNAVAILABILITY_CASES = [
  {
    name: "refusal 带阻塞进程 ⇒ migration_guard",
    input: refusal({ serverPids: [111, 222] }),
    expected: "db_null:migration_guard",
  },
  {
    name: "refusal 仅 blockingProcesses（serverPids 空）⇒ migration_guard",
    input: refusal({ serverPids: [], blockingProcesses: [{ kind: "process", pid: 333 }] }),
    expected: "db_null:migration_guard",
  },
  {
    name: "refusal 无 blockers 但 unreadableFile ⇒ migration_guard（守卫的 || 分支）",
    input: refusal({ serverPids: [], unreadableFile: "C:\\omz\\server.json" }),
    expected: "db_null:migration_guard",
  },
  {
    name: "mc/C-1：refusal 无 blockers ⇒ 不误判 migration_guard",
    input: refusal({ serverPids: [], blockingProcesses: [] }),
    expected: "db_null:pending_or_unclassified",
  },
  {
    name: "mc/C-1：refusal 无 blockers 且无 unreadableFile ⇒ 不误判 migration_guard",
    input: refusal({ serverPids: [] }),
    expected: "db_null:pending_or_unclassified",
  },
  {
    name: "无 refusal、无 fence ⇒ pending_or_unclassified 兜底",
    input: null,
    expected: "db_null:pending_or_unclassified",
  },
];

test("E3: describeStorageUnavailability 表驱动细分（mc/C-1 守卫）", () => {
  for (const testCase of STORAGE_UNAVAILABILITY_CASES) {
    const outcome = describeStorageUnavailability(testCase.input);
    assert.equal(
      outcome.reason,
      testCase.expected,
      `${testCase.name}: 期望 ${testCase.expected}，实际 ${outcome.reason}`,
    );
    assert.ok(outcome.detail.length > 0, `${testCase.name}: detail 不能为空`);
  }
});

// ── E1：create-app 装配路径（子进程） ───────────────────────────────────────

/**
 * create-app 装配路径的子进程驱动。
 *
 * 三件事在一根进程里完成：
 *   1. `module.register` resolve hook 全程监视：每个解析说明符追加一行 JSON 到
 *      hook 观测日志（enabled!==true 时 magic-context-turn-transform 应为零条）；
 *      哨兵模块是用来证明 hook 活在链路上的活性自检（driver 自己的静态 import
 *      发生在注册之前，观测不到，所以哨兵必须在注册之后再 import）。
 *   2. 调 `createZCodeApp`（真实装配路径，不绕门），storage/db/log/home 全部经
 *      env 改指临时目录。
 *   3. 结束时把「app 是否建成 / db 文件是否存在 / 捕获到的 warn 事件」打成一行
 *      JSON 回传父进程；resolve hook 的观测由父进程直接读观测日志。
 *
 * 子进程里对被测代码只做**观测**，不断言、不桩：断言在父进程统一做，失败信息
 * 因此能带上 node:test 的上下文。
 *
 * hook 形态说明：inline `registerHooks({ resolve(...) })`（与父进程同一手法）。
 * 单独 hooks 模块（`register("路径")`）在本机 Node 22.22 上实测不触发，故不用。
 */
const DRIVER_SOURCE = `import { registerHooks } from "node:module";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HOOK_LOG = process.env.ZCODE_TEST_HOOK_LOG;
const SENTINEL_SPECIFIER = "./sentinel.mjs";
const REPO_ROOT = ${JSON.stringify(REPO_ROOT)};
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map", "@zcode/provider"]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    // 观测：specifier + 最终落点（core 的 turn-loop helper 与本文件同基名但不同模块，
    // 判「工厂模块零加载」必须看解析落点，不能只看 specifier 字符串）。
    appendFileSync(HOOK_LOG, JSON.stringify({ specifier, url: resolved.url }) + "\\n");
    // TS-source 包重定向（与父进程同一手法）：@zcode/shared 等包入口发布的是原始
    // TypeScript，裸 node 加载不了，改指到同布局的编译产物。只改解析，不桩被测代码。
    const segments = specifier.split("/");
    const packageName = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : TS_SOURCE_PACKAGES.has(segments.slice(0, 2).join("/"))
        ? segments.slice(0, 2).join("/")
        : null;
    if (packageName !== null) {
      const distRoot = \`\${REPO_ROOT}packages/\${packageName.slice("@zcode/".length)}/dist/\`;
      const subpath = specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
      for (const candidate of [\`\${distRoot}\${subpath}.js\`, \`\${distRoot}\${subpath}/index.js\`]) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
      throw new Error(\`no compiled dist for "\${specifier}" — build \${packageName} first\`);
    }
    return resolved;
  },
});

// 活性自检：哨兵模块必经 resolve hook（注册之后的第一个真实文件解析）。
await import(SENTINEL_SPECIFIER);

const entries = [];
const logger = {
  info() {},
  debug() {},
  warn(message, context) {
    entries.push({ level: "warn", message, context });
  },
  error(message, _error, context) {
    entries.push({ level: "error", message, context });
  },
  child() {
    return logger;
  },
};
const loggerFactory = {
  createLogger() {
    return logger;
  },
  withContext() {
    return logger;
  },
  setLevel() {},
};

const { createZCodeApp } = await import(${JSON.stringify(CREATE_APP_DIST_URL)});
const providerRegistry = {
  getView() {
    return { providers: [] };
  },
  validateSelection() {
    return { ok: false, reason: "test stub: no provider" };
  },
  getProvider() {
    return undefined;
  },
  getModel() {
    return undefined;
  },
};

let appError;
let closeError;
try {
  const app = await createZCodeApp({
    providerRegistry,
    skipUserConfig: true,
    version: "0.0.0-absent-event-test",
    sessionId: "ses_absent_event_disabled",
    workingDirectory: process.env.ZCODE_TEST_WORKSPACE,
    env: process.env,
    loggerFactory,
    // 关掉 MCP：本用例与 MCP 无关，省掉 adapter 的 import 与端口。
    runtimeConfig: {
      mcp: { enabled: false },
      magicContext: { enabled: false },
    },
  });
  try {
    await app.close();
  } catch (error) {
    closeError = error instanceof Error ? error.message : String(error);
  }
} catch (error) {
  appError = error instanceof Error ? error.message : String(error);
}

// resolve hook 写观测日志是同步 append，但跑在 hooks 线程：收尾前让出一轮。
await new Promise((resolve) => setTimeout(resolve, 50));

const report = {
  appError,
  closeError,
  dbFileExists: existsSync(join(process.env.MAGIC_CONTEXT_DB_DIR, "magic-context.db")),
  warnEvents: entries
    .filter((entry) => entry.context?.event === "magic_context.transform_absent")
    .map((entry) => entry.context),
};
process.stdout.write("DRIVER-REPORT " + JSON.stringify(report) + "\\n");

// ── 阳性对照（在报告之后） ──────────────────────────────────────────────────
// 「零加载」断言的可信度取决于「hook + 落点判据确实能抓到工厂加载」。这里在报告
// 之后主动 import 一次工厂模块：hook 观测日志里 control 标记之后的工厂解析必须
// 出现（父进程据此反向验证判据），而 control 标记之前保持零条。
appendFileSync(HOOK_LOG, JSON.stringify({ control: true }) + "\\n");
await import(${JSON.stringify(FACTORY_DIST_URL)});
await new Promise((resolve) => setTimeout(resolve, 50));
`;

const SENTINEL_SOURCE = `export const SENTINEL = true;\n`;

/**
 * 工厂模块的判据：解析落点（file URL）里的这一段路径。core 的 turn-loop helper
 * 是 `runtime/helpers/magic-context-turn-transform.js`，不含 `app/` 段，因此不会被
 * 误判为工厂。
 */
const FACTORY_MODULE_MARKER = "bootstrap/dist/app/magic-context-turn-transform.js";

/** 跑一次 create-app 装配子进程；返回回传报告 + resolve hook 观测日志。 */
async function runCreateAppDriver() {
  const tempRoot = mkdtempSync(join(tmpdir(), "omz-absent-event-"));
  const dbDir = join(tempRoot, "mc-db");
  const storageDir = join(tempRoot, "storage");
  const workspaceDir = join(tempRoot, "workspace");
  const homeDir = join(tempRoot, "home");
  const hookLog = join(tempRoot, "resolve-hook.log");
  for (const dir of [dbDir, storageDir, workspaceDir, homeDir]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(hookLog, "");
  writeFileSync(join(tempRoot, "driver.mjs"), DRIVER_SOURCE);
  writeFileSync(join(tempRoot, "sentinel.mjs"), SENTINEL_SOURCE);

  try {
    const child = spawn(NODE, [join(tempRoot, "driver.mjs")], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ZCODE_TEST_WORKSPACE: workspaceDir,
        ZCODE_TEST_HOOK_LOG: hookLog,
        // 隔离：所有写路径改指 tempRoot，绝不碰真实 ~/.omz。
        ZCODE_STORAGE_DIR: storageDir,
        MAGIC_CONTEXT_DB_DIR: dbDir,
        MAGIC_CONTEXT_LOG_PATH: join(dbDir, "magic-context.log"),
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exit = await new Promise((resolve) => {
      child.on("close", resolve);
    });
    const reportLine = stdout.split("\n").find((line) => line.startsWith("DRIVER-REPORT "));
    if (!reportLine) {
      throw new Error(`driver 未回传报告（exit ${exit}）\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    const hookLogLines = readFileSync(hookLog, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    // control 标记之前 = create-app 装配窗口；之后 = 子进程主动做的阳性对照。
    const controlIndex = hookLogLines.findIndex((line) => line.control === true);
    const windowResolutions =
      controlIndex === -1 ? hookLogLines : hookLogLines.slice(0, controlIndex);
    const controlResolutions = controlIndex === -1 ? [] : hookLogLines.slice(controlIndex + 1);
    return {
      controlResolutions,
      exit,
      report: JSON.parse(reportLine.slice(14)),
      stderr,
      windowResolutions,
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

test("E1: create-app enabled!==true 装配路径——事件可达且工厂模块零加载", async () => {
  const { controlResolutions, exit, report, stderr, windowResolutions } =
    await runCreateAppDriver();
  assert.equal(exit, 0, `driver 应正常退出；stderr:\n${stderr}`);
  assert.equal(report.appError, undefined, `createZCodeApp 不该失败：${report.appError}`);
  assert.equal(report.closeError, undefined, `app.close 不该失败：${report.closeError}`);
  // hook 活性自检：哨兵必须经过 resolve hook（否则「零加载」断言没有意义）。
  const sentinelResolution = windowResolutions.find(
    (resolution) => resolution.specifier === "./sentinel.mjs",
  );
  assert.ok(sentinelResolution, "哨兵模块必须被 resolve hook 观察到（hook 活在链路上）");
  assert.ok(
    windowResolutions.length > 1,
    `resolve hook 应观察到多次解析（create-app 的依赖图），实际 ${windowResolutions.length} 条`,
  );
  // mc/A-1 主断言：disabled 装配路径下**工厂模块**（bootstrap 侧
  // magic-context-turn-transform）零加载。core 的 turn-loop helper
  // （runtime/helpers/magic-context-turn-transform）是同基名的另一个模块、恒被加载，
  // 不在此断言范围内——所以判据看解析落点而不是 specifier 字符串。
  const factoryResolutions = windowResolutions.filter((resolution) =>
    String(resolution.url).includes(FACTORY_MODULE_MARKER),
  );
  assert.deepEqual(
    factoryResolutions,
    [],
    "enabled!==true 时不允许解析/加载 bootstrap 的 magic-context-turn-transform 工厂模块",
  );
  // 阳性对照：同一根 hook、同一个落点判据，在子进程主动 import 工厂时必须抓到——
  // 否则「零加载」可能只是因为判据写错（永远匹配不上）。
  assert.ok(
    controlResolutions.some((resolution) => String(resolution.url).includes(FACTORY_MODULE_MARKER)),
    "阳性对照：hook 必须能抓到一次真实的工厂模块解析（否则零加载断言无效）",
  );
  // 可控 dataDir：factory 没跑 ⇒ 没有库文件。
  assert.equal(report.dbFileExists, false, "disabled 装配不允许创建 magic-context.db");
  // 事件可达：disabled 由 create-app 侧经 leaf 发射（生产唯一发射点）。
  assert.equal(
    report.warnEvents.length,
    1,
    `disabled 装配必须恰好捕获一条 transform_absent，实际 ${report.warnEvents.length} 条`,
  );
  assert.equal(report.warnEvents[0].event, MAGIC_CONTEXT_TRANSFORM_ABSENT_EVENT);
  assert.equal(report.warnEvents[0].reason, "disabled");
  assert.equal(report.warnEvents[0].module, "bootstrap");
  assert.match(report.warnEvents[0].detail, /magicContext.enabled is false/);
});
