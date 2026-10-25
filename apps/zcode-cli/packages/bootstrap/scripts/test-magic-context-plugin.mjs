#!/usr/bin/env node
/**
 * Step 3（phase-facade）门面两层的**导出面对拍**：`magic-context/index.ts`（未来唯一入口）
 * 与 `magic-context-turn-transform.ts`（历史兼容面）。
 *
 * ============================================================================
 * 这一步要钉死什么
 * ============================================================================
 *
 * 拆分（d1f2283a）把 2240 行拆成门面 + 8 个职责文件，同时把 10 个跨文件引用的符号
 * 提升为 `export`。这 10 个符号**不属于**旧门面的导出面：
 *
 *   projection 2  projectMagicContextEntries / createZCodeScheduler
 *   settle     3  HISTORIAN_SETTLE_TIMEOUT_MS / settleInFlightHistorian /
 *                 settleInFlightHistorianInBackground
 *   storage    5  StoredRow / toStoredRows / pageFromRows / withOrdinal /
 *                 BOOT_OPEN_BUSY_TIMEOUT_MS
 *
 * 旧门面一旦用 `export *`，这 10 个就从 `dist/app/magic-context-turn-transform.js`
 * 外溢——11 个脚本 hardcode 该路径，外溢即悄悄扩公共面。所以本脚本四组断言：
 *
 *   A 源码层：旧门面**不含 `export *`**；`index.ts` 声明 `createMagicContextPlugin`。
 *   B dist 运行时面：`index.js` 只有 `createMagicContextPlugin` 一个值导出；
 *     旧门面的值导出恰好 10 个。
 *   C dist 类型面：`index.d.ts` 3 个名字（1 值 + 2 类型）；旧门面 `.d.ts` 恰好 15 个
 *     （10 值 + 5 类型），且 10 个内部符号**不在**其中。
 *   D 行为：`createMagicContextPlugin({enabled:false, …})` 返回的插件形状（turnTransform
 *     为 undefined、recorder 归插件、close 可调用），且 disabled 事件仍由工厂发一次
 *     ——插件没有抢走开关判定（否则 mc/A-1 那条生产可达事件就没了）。
 *
 * 依赖已构建的 dist：`pnpm --filter @zcode/bootstrap build`。与
 * test-magic-context-absent-event.mjs 同一手法（dist 加载 + registerHooks 把发布原始
 * TypeScript 的 @zcode/shared / @zcode/model-option-map / @zcode/provider 改指编译产物）。
 *
 * Exits 0 on success, 1 on any failed assertion（node:test 自行置退出码）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
/** 临时库目录的固定根（与 magic-context 的测试同一条隔离规矩）。 */
const CACHE_ROOT = join(REPO_ROOT, "node_modules/.cache");

// 与 test-magic-context-absent-event.mjs 同一理由/同一名单：这三个包发布的是原始
// TypeScript，裸 node 无法把内部 `.js` 说明符改指 `.ts`。
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

const SRC_INDEX = join(PACKAGE_ROOT, "src/app/magic-context/index.ts");
const SRC_FACADE = join(PACKAGE_ROOT, "src/app/magic-context-turn-transform.ts");
const DIST_INDEX = join(PACKAGE_ROOT, "dist/app/magic-context/index.js");
const DIST_INDEX_DTS = join(PACKAGE_ROOT, "dist/app/magic-context/index.d.ts");
const DIST_FACADE = join(PACKAGE_ROOT, "dist/app/magic-context-turn-transform.js");
const DIST_FACADE_DTS = join(PACKAGE_ROOT, "dist/app/magic-context-turn-transform.d.ts");

for (const file of [
  SRC_INDEX,
  SRC_FACADE,
  DIST_INDEX,
  DIST_INDEX_DTS,
  DIST_FACADE,
  DIST_FACADE_DTS,
]) {
  if (!existsSync(file)) {
    throw new Error(`missing ${file} — run \`pnpm --filter @zcode/bootstrap build\` first`);
  }
}

/**
 * 旧门面的完整导出面：10 个值 + 5 个类型 = 15（拆分前后逐字一致）。
 * 顺序无意义，比较前一律排序。
 */
const FACADE_VALUE_EXPORTS = [
  "MAGIC_CONTEXT_CONSERVATIVE_CONTEXT_WINDOW",
  "MAGIC_CONTEXT_DEFAULT_CONTEXT_WINDOW_ENV",
  "createMagicContextPromptSectionResolver",
  "createMagicContextToolDescriptionResolver",
  "createMagicContextTurnTransform",
  "createMagicContextUsageRecorder",
  "createZCodeMagicContextTurnTransformPort",
  "describeStorageUnavailability",
  "openMagicContextStorageWithBusyRetry",
  "pushMagicContextUsageSummary",
];
const FACADE_TYPE_EXPORTS = [
  "MagicContextRecorderModel",
  "MagicContextTurnTransformOptions",
  "MagicContextUsageMapEntry",
  "MagicContextUsageRecorder",
  "ZCodeMagicContextTransform",
];
const FACADE_ALL_EXPORTS = [...FACADE_VALUE_EXPORTS, ...FACADE_TYPE_EXPORTS].sort();

/** 拆分提升为 export、但**不得**从旧门面外溢的 10 个内部符号（来源见文件头）。 */
const INTERNAL_PROMOTED_EXPORTS = [
  // projection 2
  "projectMagicContextEntries",
  "createZCodeScheduler",
  // settle 3
  "HISTORIAN_SETTLE_TIMEOUT_MS",
  "settleInFlightHistorian",
  "settleInFlightHistorianInBackground",
  // storage 5
  "StoredRow",
  "toStoredRows",
  "pageFromRows",
  "withOrdinal",
  "BOOT_OPEN_BUSY_TIMEOUT_MS",
];

/**
 * 剥注释：tsc 会把源文件头的大段中文注释逐字带进 `.d.ts`，而源码层的形状守卫也
 * 必须先剥——旧门面的头注里就写着「不用 `export *`」这句话，不剥注释会让守卫
 * 自己把自己判红（与 test-magic-context-gate.mjs 的「剥注释 + 逐行正则」同口径）。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * 从 `.d.ts` 抽出导出名。只认两种字面形态（与全仓源码形状守卫同口径，不做 AST）：
 *   `export { a, b as c }` / `export type { T }` 与 `export [declare] interface|type|const|function X`。
 */
function declaredExportNames(source) {
  const withoutComments = stripComments(source);
  const names = new Set();
  for (const match of withoutComments.matchAll(/export\s+(?:type\s+)?\{([\s\S]*?)\}/g)) {
    for (const raw of match[1].split(",")) {
      const entry = raw.trim().replace(/^type\s+/, "");
      if (entry === "") continue;
      const renamed = entry.split(/\s+as\s+/);
      names.add(renamed[renamed.length - 1].trim());
    }
  }
  for (const match of withoutComments.matchAll(
    /export\s+(?:declare\s+)?(?:interface|type|const|function|class|enum)\s+([A-Za-z0-9_$]+)/g,
  )) {
    names.add(match[1]);
  }
  return [...names].sort();
}

/** 解析器自身的正例：写法变了要报红，而不是静默返回空集合。 */
test("A0: 导出名解析器对第二种写法有反应（避免守卫空转）", () => {
  const names = declaredExportNames(
    [
      "export { a, b as c };",
      "export type { T };",
      "export declare function f(): void;",
      "export interface I {}",
    ].join("\n"),
  );
  assert.deepEqual(names, ["I", "T", "a", "c", "f"]);
});

test("A1: 旧门面源码不含 `export *`（内部符号不外溢）", () => {
  const source = stripComments(readFileSync(SRC_FACADE, "utf8"));
  assert.ok(
    !/export\s+\*/.test(source),
    "magic-context-turn-transform.ts 出现 `export *`：拆分的 10 个内部符号会从旧 dist 路径外溢",
  );
});

test("A2: index.ts 是唯一出口——导出 createMagicContextPlugin（且同样不用 export *）", () => {
  const source = stripComments(readFileSync(SRC_INDEX, "utf8"));
  assert.match(source, /export\s+async\s+function\s+createMagicContextPlugin\s*\(/);
  assert.ok(!/export\s+\*/.test(source), "index.ts 不许 `export *`：那会把实现文件整面外溢");
});

const indexModule = await import(pathToFileURL(DIST_INDEX).href);
const facadeModule = await import(pathToFileURL(DIST_FACADE).href);

test("B1: dist 的 index.js 值导出恰好是 createMagicContextPlugin", () => {
  assert.deepEqual(Object.keys(indexModule).sort(), ["createMagicContextPlugin"]);
  assert.equal(typeof indexModule.createMagicContextPlugin, "function");
});

test("B2: dist 的旧门面值导出恰好 10 个（15 个符号里的值那一半）", () => {
  assert.deepEqual(Object.keys(facadeModule).sort(), [...FACADE_VALUE_EXPORTS].sort());
});

test("C1: index.d.ts 的导出面 = createMagicContextPlugin + MagicContextPlugin + MagicContextPluginOptions", () => {
  assert.deepEqual(declaredExportNames(readFileSync(DIST_INDEX_DTS, "utf8")), [
    "MagicContextPlugin",
    "MagicContextPluginOptions",
    "createMagicContextPlugin",
  ]);
});

test("C2: 旧门面 .d.ts 的导出面逐字是那 15 个（10 值 + 5 类型）", () => {
  assert.deepEqual(declaredExportNames(readFileSync(DIST_FACADE_DTS, "utf8")), FACADE_ALL_EXPORTS);
});

test("C3: 10 个被提升的内部符号不在旧门面的导出面里（值面 + 类型面各查一遍）", () => {
  const runtimeKeys = new Set(Object.keys(facadeModule));
  const declared = new Set(declaredExportNames(readFileSync(DIST_FACADE_DTS, "utf8")));
  for (const name of INTERNAL_PROMOTED_EXPORTS) {
    assert.ok(!runtimeKeys.has(name), `内部符号 ${name} 从旧门面的值导出面外溢了`);
    assert.ok(!declared.has(name), `内部符号 ${name} 从旧门面的类型导出面外溢了`);
  }
});

test("D1: createMagicContextPlugin(enabled:false) 的插件形状与开关归属", async () => {
  const events = [];
  const logger = {
    info() {},
    debug() {},
    warn(message, context) {
      events.push({ level: "warn", message, context });
    },
    error() {},
    child() {
      return logger;
    },
  };
  const plugin = await indexModule.createMagicContextPlugin({
    enabled: false,
    sessionId: "plugin-surface-probe",
    workingDirectory: process.cwd(),
    logger,
    // 窗口兜底层必须进契约：缺席会让 usage recorder 的三源第二层静默消失。
    resolveFallbackContextWindow: () => 200_000,
  });

  // turnTransform 在 disabled 时是 undefined（core 按端口在场决定是否插桩）。
  assert.equal(plugin.turnTransform, undefined);
  // 两个 prompt-surface 注入口 + recorder 恒在场（它们不碰 DB）。
  assert.equal(typeof plugin.promptSection, "function");
  assert.equal(typeof plugin.toolDescription, "function");
  assert.equal(typeof plugin.usageRecorder.record, "function");
  assert.equal(typeof plugin.usageRecorder.prime, "function");
  assert.equal(typeof plugin.usageRecorder.readUsage, "function");
  assert.equal(
    plugin.usageRecorder.readUsage(),
    null,
    "未 prime / 未 record 时读数是 null（不知道≠0）",
  );
  // close 可调用且不抛（工厂没注册关闭钩子时是 noop）。
  assert.equal(typeof plugin.close, "function");
  await plugin.close();

  // 开关判定的唯一所有者仍是工厂：disabled 事件必须恰好一次，且带 reason。
  assert.equal(events.length, 1, `disabled 装配必须恰好发一条事件，实际 ${events.length} 条`);
  assert.equal(events[0].context?.event, "magic_context.transform_absent");
  assert.equal(events[0].context?.reason, "disabled");
});

/**
 * D2：**启用态端到端**——插件自己开库、自己装 transform、`close` 与
 * `registerClose` 是同一个函数对象。
 *
 * 隔离（硬规矩，与 magic-context/scripts/test-boot-busy-retry.mjs 同一条）：所有库
 * 写入只落在本仓 `node_modules/.cache` 下的 mkdtemp 目录，显式 `MAGIC_CONTEXT_DB_DIR`
 * + `MAGIC_CONTEXT_LOG_PATH`，**绝不碰用户真实的 `~/.omz`**。
 *
 * 收尾不能在 `finally` 里硬删：`closeDatabase()` 生产零调用方（包内 handle 活到进程
 * 退出），Windows 上句柄还在 → EBUSY。与 test-boot-busy-retry 同款 `bestEffortRmSync`
 * 放 `test.after`，失败只打印不判红。
 */
const pluginTempDirs = [];

/**
 * 上一轮遗留的临时库目录（上一进程退出后句柄已放）：开跑前先清一次，免得
 * `node_modules/.cache` 里越攒越多。
 */
function sweepStalePluginDirs() {
  if (!existsSync(CACHE_ROOT)) return;
  for (const name of readdirSync(CACHE_ROOT)) {
    if (name.startsWith("omz-mc-plugin-")) bestEffortRmSync(join(CACHE_ROOT, name));
  }
}

function bestEffortRmSync(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EBUSY" || error.code === "ENOTEMPTY")) {
      console.log(`  note  cleanup deferred (${error.code}): ${path}`);
    } else {
      throw error;
    }
  }
}

sweepStalePluginDirs();

test.after(() => {
  for (const dir of pluginTempDirs) bestEffortRmSync(dir);
});

test("D2: createMagicContextPlugin(enabled:true) 端到端——transform 在场、close 与 registerClose 同一对象", async () => {
  mkdirSync(CACHE_ROOT, { recursive: true });
  const dir = mkdtempSync(join(CACHE_ROOT, "omz-mc-plugin-"));
  assert.ok(dir.startsWith(CACHE_ROOT), `isolation violation: ${dir} is not under ${CACHE_ROOT}`);
  pluginTempDirs.push(dir);
  const previousDbDir = process.env.MAGIC_CONTEXT_DB_DIR;
  const previousLogPath = process.env.MAGIC_CONTEXT_LOG_PATH;
  process.env.MAGIC_CONTEXT_DB_DIR = dir;
  process.env.MAGIC_CONTEXT_LOG_PATH = join(dir, "magic-context.log");

  const events = [];
  const logger = {
    info() {},
    debug() {},
    warn(message, context) {
      events.push({ level: "warn", message, context });
    },
    error() {},
    child() {
      return logger;
    },
  };
  let registeredClose;
  try {
    const plugin = await indexModule.createMagicContextPlugin({
      enabled: true,
      sessionId: "ses_plugin_e2e",
      workingDirectory: dir,
      logger,
      // 调用方的关闭钩子必须照旧被转发（Step 4 之前 create-app 就是靠它收口的）。
      registerClose: (close) => {
        registeredClose = close;
      },
      resolveFallbackContextWindow: () => 200_000,
    });

    assert.ok(plugin.turnTransform, "开库成功后 turnTransform 必须在场（不是 undefined）");
    assert.equal(typeof plugin.turnTransform.isEnabled, "function");
    assert.equal(
      plugin.close,
      registeredClose,
      "插件返回的 close 必须与 registerClose 回填的是同一个函数对象（不得另造包装）",
    );
    // recorder 归插件所有：它已经 prime 过（DB 开出来了），内存表仍是 Map。
    assert.ok(plugin.usageRecorder.contextUsageMap instanceof Map);
    // 启用态不允许出现缺席事件。
    assert.deepEqual(
      events.filter((entry) => entry.context?.event === "magic_context.transform_absent"),
      [],
      "启用态装配不允许发 transform_absent",
    );
    // 端口上的活值开关（MF-01）：默认配置下读 bridge 快照应为 true。
    assert.equal(plugin.turnTransform.isEnabled?.(), true, "端口活值开关在默认配置下应为 true");
    // drain → shutdown → dispose 全链：close 必须能正常返回。
    await plugin.close();
  } finally {
    if (previousDbDir === undefined) delete process.env.MAGIC_CONTEXT_DB_DIR;
    else process.env.MAGIC_CONTEXT_DB_DIR = previousDbDir;
    if (previousLogPath === undefined) delete process.env.MAGIC_CONTEXT_LOG_PATH;
    else process.env.MAGIC_CONTEXT_LOG_PATH = previousLogPath;
  }
});
