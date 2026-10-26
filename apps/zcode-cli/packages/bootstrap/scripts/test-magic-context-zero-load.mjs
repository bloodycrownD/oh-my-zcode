#!/usr/bin/env node
/**
 * mc/IM1 — 关闭态**包级**零加载（spec 口径① / Step 7）。
 *
 * ============================================================================
 * 这条守卫判什么，不判什么
 * ============================================================================
 *
 * `test-magic-context-absent-event.mjs` 判的是**宿主侧**：关闭态不解析 bootstrap 的
 * MC 装配模块（旧门面 / `app/magic-context/` 目录 / 生产入口）。它**看不到
 * `@zcode/magic-context` 包本身**——所以「E1 全绿」曾被读成「零加载达成」，而实测
 * 单 import `dist/app/create-app.js` 仍解析包内 **231 个文件**（Step 5 之前）。
 *
 * 本脚本收的就是那一段（spec `:106` / `:198`）：
 *
 *   ① `@zcode/magic-context` 包内 **M0 白名单之外**的解析数 = 0；
 *   ② `bootstrap/dist/app/magic-context/**` 与旧门面
 *      `dist/app/magic-context-turn-transform.js` 的解析数 = 0
 *      （`effective-enabled.js` 白名单放行——它是零 MC 依赖的门控层，关闭态本来就该
 *      被 `create-app.ts` / `runtime-config.ts` 静态加载）；
 *   ③ M0 内的文件数 ≤ 实测上限 3（`schema` + `language` + `prompt-surface-key`）。
 *
 * **不写「MC 模块计数为 0」**——那不是可成立的口径：宿主 `adapters/src/config/schema.ts`
 * 在模块顶层求值 `MagicContextConfigSchema`（配置装载是每次启动的必经路径，早于任何
 * 开关判定），M0 必然加载。判据只能是「M0 之外为零」。
 *
 * ============================================================================
 * 窗口的**两个根**（ZL-1：根扎错地方 = 假绿）
 * ============================================================================
 *
 * 关闭态窗口在同一子进程里解析**两个生产入口**，缺一不可：
 *
 *   `dist/app/create-app.js`          —— 装配面（工厂 / 插件 / 端口接线）
 *   `dist/zcode-protocol/server.js`   —— **协议入口**：`magic-context-memories.ts` 与
 *                                        `magic-context-config.ts` 的静态导入方
 *
 * 只 root create-app 时，「handler 顶层把 barrel 静态导入加回来」这一**本门禁自身
 * 要防的回归**发生在 `server.js` 的依赖图里，而门禁根本没 import 它 —— 全绿也
 * 什么都没证明。`server.js` 在关闭态是零 MC 包内解析（实测 0），成本约 300 条解析
 * / 0.3s 量级，必须常驻窗口。
 *
 * **根是死的会退化**：窗口里必须真的出现 `server.js` 的解析记录（第 2 组断言的活性
 * 半条），否则「server 根下零加载」退化成「没 import 过 server」。
 *
 * ============================================================================
 * M0 白名单（**显式**，不含「大概这些」）
 * ============================================================================
 *
 *   `dist/host/config/schema.js`          窄子路径 `@zcode/magic-context/host/config/schema` 的载荷
 *   `dist/host/config/language.js`        schema 的 `.refine(isValidLanguageCode)` 值导入（模块顶层求值）
 *   `dist/core/shared/prompt-surface-key.js` schema 的 key 校验叶子（零 import）
 *   + **zod 4.6.5 闭包**（M0 三个文件的唯一外部依赖；版本断言见下）
 *
 * M0 之所以是这三个而不是更多：`host/config/schema.ts:51` 曾从
 * `core/shared/prompt-surface.js` 取校验函数，那个文件又拉
 * `harness-provider-map.js` → 闭包 4 个文件。Step 5 把函数抽成零依赖叶子
 * `prompt-surface-key.ts` 并改指，闭包塌到 3。**若有人把这一行改回
 * `prompt-surface.js`，本测试会因为 `prompt-surface.js` / `harness-provider-map.js`
 * 落在 M0 之外而立即变红**（这正是「闭包塌到 3」的常驻守卫）。
 *
 * ============================================================================
 * 为什么测试可信（三条活性/阳性证明）
 * ============================================================================
 *
 * 1. **hook 活性**：驱动进程注册 hook 之后的第一个真实解析必须是哨兵模块。
 * 2. **窗口非空且真的走了配置装载**：窗口内必须**确实**解析到 M0 三个文件
 *    （尤其 `host/config/schema.js`）。否则「M0 之外为 0」可能只是因为窗口里什么
 *    都没加载——那是假绿。
 * 3. **判据有量程**（控制段）：窗口结束后再 `import("@zcode/magic-context")` 一次
 *    barrel，M0 之外的解析数必须 **> 50**（实测 231）。这条同时是「把某处窄子路径
 *    改回 barrel 会不会红」的常驻形式：同一判据能把 231 个文件全部标红。
 *    真正的变异验证（改 `adapters/src/config/schema.ts` 回 barrel → 重建 → 本脚本
 *    变红 → 改回）在 Step 5/7 的交付记录里，不写进测试本体（测试不该改源码）。
 *
 * ============================================================================
 * zod 版本判据：以 **MC 自己的 manifest 解析**为准（ZL-2）
 * ============================================================================
 *
 * 关闭态窗口里实测有 **19 个 zod 根**：1×4.6.5（根 `node_modules/zod`）+ 18×
 * 3.25.76（`@zcode/contracts` 一份 + `@jimp/*` 十六份 + `zod-to-json-schema` 一份）。
 * 旧写法取「窗口里第一条 `/node_modules/zod/` 解析」——它绿只是因为
 * `adapters/config/schema.ts` 的 `import { z } from "zod"` 恰好排在窄子路径导入之前。
 * 那是**语句顺序的偶然**：MC 的 zod 换成 3.x 而根位仍是 4.6.5 时，旧断言照样绿，
 * 正是它声称要防的「zod3 静默失真」。
 *
 * 现在的判据：`createRequire(<mc>/package.json).resolve("zod/package.json")` ——
 * 「MC 实际用哪个 zod」在 Node 解析语义下只有这一个正确答案。窗口扫描降级为
 * **辅助信息**（打印出来供排查）+ 一条不依赖顺序的活性断言（窗口里必须出现 MC
 * 解析出的那一份 zod，否则版本钉住的是一份没人用的副本）。
 *
 * ============================================================================
 * 隔离与前置
 * ============================================================================
 *
 * 驱动子进程所有写路径经 env 改指临时目录（`ZCODE_STORAGE_DIR` /
 * `MAGIC_CONTEXT_DB_DIR` / `MAGIC_CONTEXT_LOG_PATH` / `HOME` / `USERPROFILE`），
 * **绝不触碰真实 `~/.omz`**（与 absent-event 同一条 RULE）。
 *
 * 前置：`pnpm --filter @zcode/bootstrap build` + `pnpm --filter @zcode/adapters build`
 * + `pnpm --filter @zcode/magic-context build`（脚本直接从 dist 加载，不跑 tsc）。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const NODE = process.execPath;

const BOOTSTRAP_DIST = join(REPO_ROOT, "apps/zcode-cli/packages/bootstrap/dist/");
const BOOTSTRAP_DIST_APP = join(BOOTSTRAP_DIST, "app/");
const CREATE_APP_DIST = join(BOOTSTRAP_DIST_APP, "create-app.js");
/** 协议入口：`magic-context-memories.ts` / `magic-context-config.ts` 的静态导入方。 */
const PROTOCOL_SERVER_DIST = join(BOOTSTRAP_DIST, "zcode-protocol/server.js");
const FACTORY_SHIM_DIST = join(BOOTSTRAP_DIST_APP, "magic-context-turn-transform.js");
const EFFECTIVE_ENABLED_DIST = join(BOOTSTRAP_DIST_APP, "magic-context", "effective-enabled.js");
const MC_PACKAGE_ROOT = join(REPO_ROOT, "apps/zcode-cli/packages/magic-context");
const MC_PACKAGE_JSON = join(MC_PACKAGE_ROOT, "package.json");
const MC_DIST_INDEX = join(MC_PACKAGE_ROOT, "dist/index.js");

for (const dist of [
  CREATE_APP_DIST,
  PROTOCOL_SERVER_DIST,
  FACTORY_SHIM_DIST,
  EFFECTIVE_ENABLED_DIST,
  MC_DIST_INDEX,
]) {
  if (!existsSync(dist)) {
    throw new Error(
      `missing ${dist} — run \`pnpm --filter @zcode/bootstrap build\` / ` +
        "`pnpm --filter @zcode/magic-context build` first",
    );
  }
}

/**
 * M0 白名单：关闭态**允许**解析的包内文件（包内相对路径，`dist/` 之后的部分）。
 *
 * 上限写死 3（spec `:187` 的预期值与 Step 5 实测一致）。新增成员必须同时改 spec 的
 * IM1 与「模块数口径」①，并说明为什么它不能推迟到开态加载。
 */
const M0_PACKAGE_FILES = [
  "host/config/schema.js",
  "host/config/language.js",
  "core/shared/prompt-surface-key.js",
];

/**
 * M0 的 zod 闭包版本：与 `magic-context/package.json` 的 pin 逐字一致
 * （`"zod": "4.6.5"`）。换版本等于换口径，需同步 spec IM1。
 *
 * 判据不看「窗口里的第一条 zod」（那有 19 个根，第一条由 import 顺序决定），
 * 而看 MC manifest 的解析结果——见 {@link resolveMcZod}。
 */
const M0_ZOD_VERSION = "4.6.5";

/** 包内解析落点的两形态（pnpm 符号链接可能给出 realpath 或 node_modules 路径）。 */
const MC_PACKAGE_MARKERS = ["/packages/magic-context/dist/", "/@zcode/magic-context/dist/"];

/** 宿主侧装配面（口径①的第二条）。 */
const FACTORY_DIR_MARKER = "bootstrap/dist/app/magic-context/";
const FACTORY_SHIM_MARKER = "bootstrap/dist/app/magic-context-turn-transform.js";
const FACTORY_ALLOWED_MARKERS = ["bootstrap/dist/app/magic-context/effective-enabled.js"];

/** 一条解析 URL 若是 MC 包内文件，返回 `dist/` 之后的相对路径；否则 null。 */
function mcPackageFile(url) {
  for (const marker of MC_PACKAGE_MARKERS) {
    const index = url.indexOf(marker);
    if (index >= 0) return url.slice(index + marker.length);
  }
  return null;
}

/** 一条解析 URL 是否是「宿主侧 MC 装配模块」（allow 之外）。 */
function isFactoryResolution(url) {
  if (FACTORY_ALLOWED_MARKERS.some((marker) => url.includes(marker))) return false;
  return url.includes(FACTORY_DIR_MARKER) || url.includes(FACTORY_SHIM_MARKER);
}

/** 从一条 zod 解析 URL 反推 zod 包根（`<root>/package.json` 的父目录，文件系统路径）。 */
function zodRootFromUrl(url) {
  let path;
  try {
    path = fileURLToPath(url).replaceAll("\\", "/");
  } catch {
    return undefined;
  }
  const marker = "/node_modules/zod/";
  const index = path.lastIndexOf(marker);
  if (index < 0) return undefined;
  return path.slice(0, index + marker.length);
}

/**
 * MC 自己实际用的 zod —— **唯一的正确判据**（ZL-2）。
 *
 * `createRequire(<mc>/package.json).resolve("zod/package.json")` 走的就是 MC 的
 * 模块上下文会走的那条 node 解析：从 `<mc>/` 起逐级找 `node_modules/zod`。
 * 只读 `package.json` 的 `dependencies.zod` 字符串不够（那是声明，不是解析结果：
 * pnpm 的 layout / 嵌套副本 / 覆盖都可能让实际解析落在别处）。
 *
 * 返回 realpath 归一后的 `packageRoot`（不带尾斜杠），与窗口扫描的 zod 根可直接比较。
 */
function resolveMcZod() {
  const requireFromMc = createRequire(MC_PACKAGE_JSON);
  const manifestPath = realpathSync(requireFromMc.resolve("zod/package.json"));
  const packageRoot = realpathSync(dirname(manifestPath));
  return {
    manifestPath,
    packageRoot,
    version: JSON.parse(readFileSync(manifestPath, "utf8")).version,
  };
}

/**
 * 窗口里出现过的 zod 根 → 解析条数（**辅助信息**，不是判据）。
 *
 * 它回答的是「窗口到底碰了几份 zod」，正好把旧写法依赖的「序」暴露成一个可读数字。
 */
function zodRootsInWindow(window) {
  const counts = new Map();
  for (const entry of window) {
    const root = zodRootFromUrl(String(entry.url));
    if (root === undefined) continue;
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return counts;
}

/** zod 包根的归一化 key：realpath + 正斜杠 + 去尾斜杠（窗口 URL 与 require 解析形态不同）。 */
function normalizeZodRoot(root) {
  const slashed = root.replaceAll("\\", "/").replace(/\/+$/, "");
  try {
    return realpathSync(root).replaceAll("\\", "/").replace(/\/+$/, "");
  } catch {
    return slashed;
  }
}

/**
 * 驱动源码。窗口（control 标记之前）= 协议入口 `zcode-protocol/server.js` +
 * `import create-app` + 真实 `createZCodeApp` + `close()`；control 之后 = 一次
 * barrel import 作判据量程证明。
 *
 * 两个根都在窗口里（ZL-1）：`server.js` 是两个 MC handler 的静态导入方，
 * 「handler 顶层把 barrel 加回来」只会出现在它的依赖图里。import 顺序取
 * 「协议入口 → 装配」——与 CLI 进程的加载顺序同向（协议入口是常驻面，app 是按会话建）。
 *
 * 子进程里只**观测**，不断言：断言全在父进程做，失败信息才带得上 node:test 的上下文。
 */
const DRIVER_SOURCE = `import { registerHooks } from "node:module";
import { appendFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const HOOK_LOG = process.env.ZCODE_TEST_HOOK_LOG;
const REPO_ROOT = ${JSON.stringify(REPO_ROOT)};
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map", "@zcode/provider"]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    appendFileSync(HOOK_LOG, JSON.stringify({ specifier, url: resolved.url }) + "\\n");
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

// 活性自检：哨兵是本进程注册 hook 之后的第一个真实文件解析。
await import(process.env.ZCODE_TEST_SENTINEL);

// ── 根 ①：生产协议入口（两个 MC handler 的静态导入方）────────────────────────
// 失败不中断驱动：错误进报告，父进程先断言它，仍能拿到窗口诊断。
let serverError;
try {
  await import(process.env.ZCODE_TEST_PROTOCOL_SERVER);
} catch (error) {
  serverError = error instanceof Error ? error.message : String(error);
}

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

const { createZCodeApp } = await import(process.env.ZCODE_TEST_CREATE_APP);
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
    version: "0.0.0-zero-load-test",
    sessionId: "ses_zero_load_disabled",
    workingDirectory: process.env.ZCODE_TEST_WORKSPACE,
    env: process.env,
    loggerFactory,
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

// resolve hook 的写日志跑在 hooks 线程：收尾前让出一轮。
await new Promise((resolve) => setTimeout(resolve, 50));
process.stdout.write(
  "DRIVER-REPORT " + JSON.stringify({ appError, closeError, serverError }) + "\\n",
);

// ── 控制段：判据量程证明（不属于装配窗口） ────────────────────────────────────
appendFileSync(HOOK_LOG, JSON.stringify({ control: "barrel" }) + "\\n");
await import(process.env.ZCODE_TEST_MC_ENTRY);
await new Promise((resolve) => setTimeout(resolve, 50));
`;

const SENTINEL_SOURCE = `export const SENTINEL = true;\n`;

/** 跑一次关闭态装配子进程；返回回传报告 + 分段后的 resolve 观测。 */
async function runDisabledDriver() {
  const tempRoot = mkdtempSync(join(tmpdir(), "omz-zero-load-"));
  const dbDir = join(tempRoot, "mc-db");
  const storageDir = join(tempRoot, "storage");
  const workspaceDir = join(tempRoot, "workspace");
  const homeDir = join(tempRoot, "home");
  const hookLog = join(tempRoot, "resolve-hook.log");
  const sentinel = join(tempRoot, "sentinel.mjs");
  for (const dir of [dbDir, storageDir, workspaceDir, homeDir]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(hookLog, "");
  writeFileSync(sentinel, SENTINEL_SOURCE);
  writeFileSync(join(tempRoot, "driver.mjs"), DRIVER_SOURCE);

  try {
    const child = spawn(NODE, [join(tempRoot, "driver.mjs")], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ZCODE_TEST_WORKSPACE: workspaceDir,
        ZCODE_TEST_HOOK_LOG: hookLog,
        ZCODE_TEST_SENTINEL: pathToFileURL(sentinel).href,
        ZCODE_TEST_CREATE_APP: pathToFileURL(CREATE_APP_DIST).href,
        ZCODE_TEST_PROTOCOL_SERVER: pathToFileURL(PROTOCOL_SERVER_DIST).href,
        ZCODE_TEST_MC_ENTRY: pathToFileURL(MC_DIST_INDEX).href,
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
      throw new Error(`驱动进程未回传报告（exit ${exit}）\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    const resolutions = readFileSync(hookLog, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    const controlIndex = resolutions.findIndex((entry) => entry.control === "barrel");
    return {
      control: controlIndex === -1 ? [] : resolutions.slice(controlIndex + 1),
      exit,
      report: JSON.parse(reportLine.slice(14)),
      stderr,
      window: controlIndex === -1 ? resolutions : resolutions.slice(0, controlIndex),
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

test("IM1: 关闭态 @zcode/magic-context 包内 M0 之外零解析 + 宿主装配面零解析", async () => {
  const { control, exit, report, stderr, window } = await runDisabledDriver();
  assert.equal(exit, 0, `驱动进程应正常退出；stderr:\n${stderr}`);
  // 两个根都必须真的加载成功（根坏了，窗口就少一整片生产入口）。
  assert.equal(
    report.serverError,
    undefined,
    `协议入口 zcode-protocol/server.js 不该加载失败：${report.serverError}`,
  );
  assert.equal(report.appError, undefined, `createZCodeApp 不该失败：${report.appError}`);
  assert.equal(report.closeError, undefined, `app.close 不该失败：${report.closeError}`);

  // ── 1. hook 活性：哨兵必须被观察到 ──────────────────────────────────────────
  assert.ok(
    window.some((entry) => String(entry.url).includes("sentinel.mjs")),
    "哨兵模块必须被 resolve hook 观察到（hook 活在链路上）",
  );
  // 根 ① 活性（ZL-1）：server.js 本身必须出现在窗口里。缺了它，「协议入口路径零加载」
  // 就退化成「根本没 import 过协议入口」——这正是修掉的那条假绿。
  const serverEntryUrl = pathToFileURL(PROTOCOL_SERVER_DIST).href;
  assert.ok(
    window.some((entry) => String(entry.url) === serverEntryUrl),
    "活性：窗口内必须出现协议入口 zcode-protocol/server.js 的解析记录（ZL-1 的根是死的）",
  );
  // 窗口非空：配置装载 + 装配的依赖图远不止几条。
  assert.ok(window.length > 100, `装配窗口应观察到大量解析，实际 ${window.length} 条`);
  // 诊断：窗口规模（两个根合计），失败时能把「少了哪个根」和「涨了多少」对上。
  console.log(
    `[IM1] 装配窗口 ${window.length} 条解析（create-app + zcode-protocol/server.js），` +
      `MC 包内 ${new Set(window.map((entry) => mcPackageFile(String(entry.url))).filter(Boolean)).size} 个文件`,
  );

  // ── 2. 口径① 第一条：包内 M0 之外零解析 ────────────────────────────────────
  const windowMcFiles = new Set();
  for (const entry of window) {
    const file = mcPackageFile(String(entry.url));
    if (file !== null) windowMcFiles.add(file);
  }
  const outsideM0 = [...windowMcFiles].filter((file) => !M0_PACKAGE_FILES.includes(file)).sort();
  assert.deepEqual(
    outsideM0,
    [],
    "关闭态不允许解析 `@zcode/magic-context` 包内 M0 白名单之外的文件（IM1 / 口径①）：" +
      `\n命中：${outsideM0.join("\n  ")}` +
      `\nM0 白名单：${M0_PACKAGE_FILES.join(", ")}`,
  );

  // ── 3. M0 上限 + 活性：白名单不是「空集凑数」 ───────────────────────────────
  assert.ok(
    windowMcFiles.size <= M0_PACKAGE_FILES.length,
    `M0 内解析数不得超过 ${M0_PACKAGE_FILES.length}，实际 ${windowMcFiles.size}`,
  );
  for (const required of M0_PACKAGE_FILES) {
    assert.ok(
      windowMcFiles.has(required),
      `活性：窗口内必须解析到 M0 成员 ${required}——它缺席说明配置装载没走 MC schema，` +
        "「M0 之外为零」将退化成假绿（另外两个 M0 成员由 schema 静态引入，同样会缺席）",
    );
  }

  // ── 4. zod：以 MC 自己 manifest 的解析结果为准（ZL-2）───────────────────────
  //
  // 旧写法取窗口里「第一条」zod 解析——窗口实测有 19 个 zod 根，第一条只由 import
  // 语句顺序决定，与「MC 用的是哪份 zod」无关。现在主判据是 MC 的模块解析结果。
  const mcZod = resolveMcZod();
  assert.equal(
    mcZod.version,
    M0_ZOD_VERSION,
    `MC 自己解析到的 zod 版本必须是 ${M0_ZOD_VERSION}（magic-context/package.json 的 pin）；` +
      `实际解析到 ${mcZod.manifestPath} = ${mcZod.version}。换版本等于换口径，需同步 spec IM1`,
  );

  // 辅助信息（**不是**判据）：窗口到底碰了几份 zod、各自几条解析。旧写法的「序」
  // 在这里就是一个一眼可见的偶然量。
  const windowZodRoots = zodRootsInWindow(window);
  console.log(
    `[IM1] 窗口 zod 根 ${windowZodRoots.size} 个：` +
      [...windowZodRoots].map(([root, count]) => `${root}×${count}`).join(" | ") +
      ` ｜ 判据来源 ${mcZod.manifestPath}`,
  );
  // 不依赖顺序的活性：MC 用的那一份 zod 必须真的在窗口里被解析过。否则版本断言
  // 描述的可能是一份没人加载的副本（pnpm layout / 嵌套副本下这并非不可能）。
  const mcZodRootKey = normalizeZodRoot(mcZod.packageRoot);
  assert.ok(
    [...windowZodRoots.keys()].some((root) => normalizeZodRoot(root) === mcZodRootKey),
    `活性：窗口里必须出现 MC 自己那份 zod（${mcZod.packageRoot}）的解析——` +
      "否则「M0 的 zod 是 4.6.5」描述的不是实际加载的那份",
  );

  // ── 5. 口径① 第二条：宿主侧装配面零解析（effective-enabled 白名单放行）─────
  const factoryResolutions = window.filter((entry) => isFactoryResolution(String(entry.url)));
  assert.deepEqual(
    factoryResolutions.map((entry) => entry.url),
    [],
    "关闭态不允许解析 bootstrap 的 MC 装配目录与旧门面（effective-enabled.js 已白名单放行）",
  );
  assert.ok(
    window.some((entry) => String(entry.url).includes(FACTORY_ALLOWED_MARKERS[0])),
    "活性：effective-enabled.js 必须被解析（create-app 静态 import 它算冷值；缺席说明白名单条目是死的）",
  );

  // ── 6. 判据量程：barrel 在控制段必须被大量标红 ─────────────────────────────
  const controlMcFiles = new Set();
  for (const entry of control) {
    const file = mcPackageFile(String(entry.url));
    if (file !== null) controlMcFiles.add(file);
  }
  const controlOutsideM0 = [...controlMcFiles].filter((file) => !M0_PACKAGE_FILES.includes(file));
  assert.ok(
    controlOutsideM0.length > 50,
    "阳性对照：同一判据在控制段（import barrel）必须把 M0 之外的大量包内文件标红——" +
      `实测 ${controlOutsideM0.length} 个。低于 50 说明判据或 hook 已经失效，` +
      "上面那条零加载断言也就不可信了",
  );
});
