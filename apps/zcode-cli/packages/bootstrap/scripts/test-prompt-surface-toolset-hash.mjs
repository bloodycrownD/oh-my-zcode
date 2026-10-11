#!/usr/bin/env node
/**
 * MF-PS-1（bugfix-batch-20261011，CR fix 节点）——`getToolSetHash` 闭包活读直证。
 *
 * 失效形态：`buildTransformDeps` 的指纹闭包捕获**装配期**的 `config.prompt_surface`；
 * 而 `applyConfigToDeps` 每次配置刷新都换 `deps.promptSurface` 的引用
 * （config-bridge 每次 refresh 产新对象）。长驻进程（桌面 / app-server / TUI）在
 * 设置页把 preset 从 full 翻到 light 后，指纹恒为旧值——
 * `transform_decisions.m0_tool_set_hash_prev/new` 恒等、`session_meta
 * .cached_m0_tool_set_hash` 的 baseline 永远追不上审计操作数。CLI 一进程一轮
 * 无此问题，长驻才有。
 *
 * 本测试钉死的是修复后的行为：真工厂（createMagicContextTurnTransform + 真
 * ConfigPort 订阅 + 真临时库）+ 两个 pass——
 *   ① pass 1（preset=full）materialize 后 `session_meta.cached_m0_tool_set_hash`
 *      落 full 身份（`promptSurfaceConfigIdentity` 同值）；
 *   ② 经 ConfigPort.set 翻到 light（等价设置页保存）→ bridge onChange →
 *      applyConfigToDeps 原地换 deps.promptSurface；
 *   ③ pass 2 再 materialize（先清 cached_m0_bytes 触发 first_render）后审计列
 *      必须是 light 身份且 != full 身份。修复前这里恒为 full。
 *
 * **验收口径勘误（登记于 cache/fix-node-map.md）**：fix-spec 原文写「断言
 * transform_decisions.m0_tool_set_hash_new 为新身份」，但 fork 的
 * `transform-decision-log.ts` FORK-NOTE 明示 durable writer 被裁掉（表由
 * migrations 建、无任何写入方，恒空），transform_decisions 断言在 fork 现实里
 * 不可执行；pending decision 又只在 bustedThisPass 时记录且无读出口。因此落到
 * fork 实际存在的同一审计列 `session_meta.cached_m0_tool_set_hash`——它由
 * materialize 的 markers 写入（inject-compartments.ts `markers.toolSetHash =
 * hard.toolSetHash`，hard signals 即 `deps.getToolSetHash()` 的每 pass 现读值），
 * 与 transform_decisions 的 m0_tool_set_hash_new 语义同源。
 *
 * 隔离：`MAGIC_CONTEXT_DB_DIR` / `MAGIC_CONTEXT_LOG_PATH` 指 `os.tmpdir()` 一次性
 * 目录，绝不写真实 ~/.omz / ~/.zcode。真开一个 SQLite 句柄，Windows 上退出前
 * 不释放，目录删除尽力而为（同 test-settle-background.mjs 的既定处理）。
 *
 * 前置：`@zcode/magic-context` / `@zcode/core` / `@zcode/bootstrap` 的 dist 必须
 * 存在（`@zcode/shared` 与 `@zcode/model-option-map` 的包入口发布原始 TS，
 * 下方 resolve 钩子改指同布局 dist，同 test-magic-context-turn-transform.mjs）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── 隔离：必须先于任何被测模块的 import ────────────────────────────────────────
const TEST_HOME = mkdtempSync(join(tmpdir(), "zcode-ps1-toolset-"));
process.env.MAGIC_CONTEXT_DB_DIR = TEST_HOME;
process.env.MAGIC_CONTEXT_LOG_PATH = join(TEST_HOME, "magic-context.log");
process.on("exit", () => {
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* Windows 上 sqlite 句柄未释放时的既定行为；残留由 OS 临时目录策略回收 */
  }
});

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map"]);

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

const { ConfigKey } = await import("@zcode/contracts");
const {
  DEFAULT_MAGIC_CONTEXT_CONFIG,
  getMagicContextDatabasePath,
  initializeMagicContextHost,
  openDatabase,
  promptSurfaceConfigIdentity,
} = await import("@zcode/magic-context");
const { createMagicContextTurnTransform } = await import(
  new URL("../dist/app/magic-context-turn-transform.js", import.meta.url).href
);

initializeMagicContextHost();
// openDatabase 按路径缓存句柄：与工厂内部拿到同一个 handle，测试进程内共享。
const sharedDb = openDatabase(getMagicContextDatabasePath());
assert.ok(sharedDb, "openDatabase() must succeed against the temp store");

const SESSION_ID = "ses_ps1_toolset_hash";

const NOOP_LOGGER = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
};

/** 内存 ConfigPort：只承载 magicContext 一个域（bootstrap bridge 只读这一个）。 */
function createMemoryConfigPort(initialDomain) {
  let domain = initialDomain;
  const listeners = new Set();
  return {
    setMagicContext(value) {
      const prev = domain;
      domain = value;
      for (const listener of [...listeners]) listener(value, prev);
    },
    get(key) {
      if (key === ConfigKey.MagicContext) return domain;
      throw new Error(`test ConfigPort only serves ${ConfigKey.MagicContext}, got ${key}`);
    },
    getAll() {
      return {};
    },
    has(key) {
      return key === ConfigKey.MagicContext;
    },
    set(key, value) {
      if (key !== ConfigKey.MagicContext) throw new Error(`unsupported key ${key}`);
      this.setMagicContext(value);
    },
    observe() {
      return {
        subscribe(key, handler) {
          if (key !== ConfigKey.MagicContext) {
            throw new Error(`unsupported key ${key}`);
          }
          listeners.add(handler);
          return () => listeners.delete(handler);
        },
        subscribeAll() {
          return () => {};
        },
      };
    },
    getSources() {
      return [];
    },
    merge() {},
  };
}

/** 长文本 entries：把估算 token 推过 execute 阈值，让 pass 必然 materialize。 */
function fatEntries() {
  const paragraph = "讨论提示词面与工具集指纹的审计保真。".repeat(120);
  return [
    { kind: "message", message: { role: "system", content: `you are zcode\n${paragraph}` } },
    {
      kind: "message",
      message: { role: "user", content: `first question\n${paragraph}` },
      metadata: { source: "real_user" },
    },
    {
      kind: "message",
      message: { role: "assistant", content: `let me read it\n${paragraph}` },
    },
    {
      kind: "message",
      message: { role: "user", content: `second question\n${paragraph}` },
      metadata: { source: "real_user" },
    },
  ];
}

/** 极小 contextWindow + 长 entries → usage 占比爆表 → scheduler execute + first_render。 */
const FAT_MODEL = {
  providerId: "zcode",
  modelId: "glm-4.6",
  displayName: "glm-4.6",
  properties: { contextWindow: 200 },
  optionSpecs: { maxOutputTokens: { max: 8_192 }, reasoningLevel: { values: [] } },
  options: {},
  bind() {
    return this;
  },
};

async function runPass(port) {
  return await port({
    entries: fatEntries(),
    model: FAT_MODEL,
    sessionId: SESSION_ID,
    workingDirectory: TEST_HOME,
  });
}

function readToolSetHashAudit() {
  const row = sharedDb
    .prepare("SELECT cached_m0_tool_set_hash AS hash, cached_m0_bytes AS bytes FROM session_meta WHERE session_id = ?")
    .get(SESSION_ID);
  return row ?? null;
}

test("MF-PS-1：preset 翻转后 getToolSetHash 读活值——审计列从 full 身份翻到 light 身份", async () => {
  const fullDomain = {
    ...DEFAULT_MAGIC_CONTEXT_CONFIG,
    prompt_surface: { default: "full" },
  };
  const configPort = createMemoryConfigPort(fullDomain);

  const port = await createMagicContextTurnTransform({
    enabled: true,
    configPort,
    sessionId: SESSION_ID,
    workingDirectory: TEST_HOME,
    logger: NOOP_LOGGER,
    // inherit 模式装配需要造得出 Model 的 sidecar（真工厂装配路径）。
    createSidecarModel: () => FAT_MODEL,
    registerClose: () => {},
    // 短驻/长驻与本断言无关，用缺省（保守）。
  });
  assert.ok(port, "flag on 且库开得出来时必须拿到端口");

  // fixture 有效性前提：full 与 light 的配置身份必须可区分，否则整条断言无区分力。
  const fullIdentity = promptSurfaceConfigIdentity({ default: "full" });
  const lightIdentity = promptSurfaceConfigIdentity({ default: "light" });
  assert.notEqual(
    fullIdentity,
    lightIdentity,
    "full 与 light 的 promptSurfaceConfigIdentity 必须不同（fixture 前提）",
  );

  // pass 1（preset=full）：materialize 把本 pass 的 tool-set 身份落进审计列。
  const first = await runPass(port);
  assert.ok(
    first.outcome === "applied" || first.outcome === "unchanged",
    `unexpected outcome ${first.outcome}`,
  );
  const afterFirst = readToolSetHashAudit();
  assert.ok(afterFirst, "pass 1 必须留下 session_meta 行");
  assert.equal(
    afterFirst.hash,
    fullIdentity,
    "pass 1 的审计列必须落 full 身份（markers.toolSetHash = 本 pass 的 getToolSetHash）",
  );

  // 用户在设置页把 preset 翻到 light：ConfigPort.set → bridge onChange →
  // applyConfigToDeps 原地换 deps.promptSurface（同一活对象，不重建 deps）。
  configPort.setMagicContext({
    ...DEFAULT_MAGIC_CONTEXT_CONFIG,
    prompt_surface: { default: "light" },
  });

  // 清 baseline 强制 pass 2 再 materialize（first_render）——否则 no-op 的 pass
  // 不会刷新 markers，也就观察不到指纹变化。
  sharedDb.prepare("UPDATE session_meta SET cached_m0_bytes = NULL WHERE session_id = ?").run(SESSION_ID);
  const second = await runPass(port);
  assert.ok(
    second.outcome === "applied" || second.outcome === "unchanged",
    `unexpected outcome ${second.outcome}`,
  );

  const afterSecond = readToolSetHashAudit();
  assert.ok(afterSecond, "pass 2 必须留下 session_meta 行");
  assert.equal(
    afterSecond.hash,
    lightIdentity,
    "pass 2 的审计列必须是 light 身份——修复前这里恒为 full（闭包捕获装配期 config）",
  );
  assert.notEqual(afterSecond.hash, afterFirst.hash, "两次 pass 的审计操作数必须可区分");
});
