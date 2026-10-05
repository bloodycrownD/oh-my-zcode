#!/usr/bin/env node
/**
 * Step 23 — `workspace/updateMagicContextConfig` handler 与装配层门控（D-12）。
 *
 * 两组断言：
 *
 *   A. **handler 三段式顺序**。D-12 点名 `workspace/updateInteractionPreferences`
 *      「只改内存不写盘不推送，不可作整体范式」，所以这里真正要钉住的是本 handler
 *      与它的差异：
 *        - 字段级校验失败 → `-32602` 结构化错误，且**磁盘与内存都没被碰过**
 *          （顺序错了就会出现「内存已广播、磁盘写失败」的不可恢复分叉）；
 *        - 成功 → 先落盘，再 `configPort.set`，推给进程内每个 resident session；
 *        - 幂等重写 → `changed:false`，但仍然广播（内存与磁盘必须同时收敛）。
 *
 *   B. **T-M8 门控**（spec Step 19a/23）：`features.magicContext` 关闭时，装配层
 *      **不创建任何实例**——无论 `magicContext` 参数域配了什么。这里用一个一旦被
 *      触碰就抛错的配置口与一次性 DB 目录来证明「连读都没读」。
 *
 * 依赖已构建的 dist：`pnpm --filter @zcode/magic-context build`、`contracts`、
 * `adapters`、`bootstrap`。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

const { ConfigKey } = await import("@zcode/contracts");
const { createConfigPort } = await import("@zcode/adapters/config");
const { DEFAULT_MAGIC_CONTEXT_CONFIG, MagicContextConfigSchema } = await import(
  "@zcode/magic-context"
);
const { zcodeWorkspaceUpdateMagicContextConfigParamsSchema } = await import("@zcode/shared");
const { updateMagicContextConfig } = await import(
  new URL("../dist/zcode-protocol/magic-context-config.js", import.meta.url).href
);
const { createMagicContextTurnTransform } = await import(
  new URL("../dist/app/magic-context-turn-transform.js", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — workspace/updateMagicContextConfig handler + T-M8 gate"
      : `TEST FAIL — workspace/updateMagicContextConfig handler (exit code ${code})`,
  );
});

const WORKSPACE = { workspacePath: "D:/tmp/project", workspaceKey: "ws_test" };

function params(config) {
  return { workspace: WORKSPACE, config };
}

/** 一个只暴露 getConfigPort 的最小 session record。 */
function sessionRecord(configPort) {
  return configPort === undefined ? {} : { app: { getConfigPort: () => configPort } };
}

function contextWith(...records) {
  return { sessions: new Map(records.map((record, index) => [`ses_${index}`, record])) };
}

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "zcode-mc-rpc-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── A1: envelope ─────────────────────────────────────────────────────────────

test("A1: params envelope is strict about its own shape but opaque about the domain", () => {
  assert.equal(
    zcodeWorkspaceUpdateMagicContextConfigParamsSchema.safeParse(params({ enabled: false })).success,
    true,
  );
  for (const bad of [
    { config: { enabled: false } },
    { ...params({ enabled: false }), extra: 1 },
    { ...params({ enabled: false }), workspace: { workspaceKey: "k" } },
  ]) {
    assert.equal(
      zcodeWorkspaceUpdateMagicContextConfigParamsSchema.safeParse(bad).success,
      false,
      `expected envelope to be rejected: ${JSON.stringify(bad)}`,
    );
  }
  // 域内部是 unknown：字段级判断被推给 CLI handler，而不是在协议层复制一份字段表。
  assert.equal(
    zcodeWorkspaceUpdateMagicContextConfigParamsSchema.safeParse(
      params({ execute_threshold_percentage: 999 }),
    ).success,
    true,
  );
});

// ── A2: validation failure short-circuits before any side effect ─────────────

test("A2: invalid domain → -32602, and neither disk nor memory is touched", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ ui: { locale: "zh-CN" } }), "utf-8");
    const configPort = createConfigPort({});
    let setCalls = 0;
    const originalSet = configPort.set.bind(configPort);
    configPort.set = (key, value) => {
      setCalls += 1;
      originalSet(key, value);
    };

    await assert.rejects(
      () =>
        updateMagicContextConfig(
          contextWith(sessionRecord(configPort)),
          params({ execute_threshold_percentage: 95 }),
          { configPath },
        ),
      (error) => {
        assert.equal(error.name, "ProtocolRequestError");
        assert.equal(error.code, -32602);
        assert.match(error.message, /magicContext: execute_threshold_percentage/);
        return true;
      },
    );

    assert.equal(setCalls, 0, "校验失败时绝不能已经广播到内存");
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf-8")), {
      ui: { locale: "zh-CN" },
    });
  });
});

test("A2: empty/absent config falls back to the full default domain", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    const configPort = createConfigPort({});
    const result = await updateMagicContextConfig(
      contextWith(sessionRecord(configPort)),
      params({}),
      { configPath },
    );
    assert.equal(result.applied, true);
    assert.equal(result.changed, true);
    assert.deepEqual(configPort.get(ConfigKey.MagicContext), DEFAULT_MAGIC_CONTEXT_CONFIG);
  });
});

// ── A2-MF07: 「空值」不是「空对象」，两者语义相反 ────────────────────────────
//
// 整域替换语义下，`config` 缺席或为空值都等于「把整份配置重置成默认值」，且会被
// 写盘 + fan-out + 回 `applied:true`——静默数据损坏。反过来 `config: {}` 是合法
// 的「我就要存全默认域」，必须放行。三条路径各自钉住：

test("A2 (MF-07): absent config key is rejected by the envelope, nothing is written", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ ui: { locale: "zh-CN" } }), "utf-8");
    const configPort = createConfigPort({});
    let setCalls = 0;
    const originalSet = configPort.set.bind(configPort);
    configPort.set = (key, value) => {
      setCalls += 1;
      originalSet(key, value);
    };

    // zod 4 的 `z.unknown()` 是 nonoptional 的：键缺席在 object 层就判 invalid_type。
    const parsed = zcodeWorkspaceUpdateMagicContextConfigParamsSchema.safeParse({
      workspace: WORKSPACE,
    });
    assert.equal(parsed.success, false);
    assert.equal(parsed.error.issues[0].code, "invalid_type");

    await assert.rejects(
      () =>
        updateMagicContextConfig(
          contextWith(sessionRecord(configPort)),
          { workspace: WORKSPACE },
          { configPath },
        ),
      (error) => {
        assert.equal(error.name, "ProtocolRequestError");
        assert.equal(error.code, -32602);
        return true;
      },
    );

    assert.equal(setCalls, 0);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf-8")), {
      ui: { locale: "zh-CN" },
    });
  });
});

test("A2 (MF-07): null config is rejected by the envelope refine, disk and ConfigPort untouched", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ ui: { locale: "en-US" } }), "utf-8");
    const configPort = createConfigPort({});
    const before = configPort.get(ConfigKey.MagicContext);
    let setCalls = 0;
    const originalSet = configPort.set.bind(configPort);
    configPort.set = (key, value) => {
      setCalls += 1;
      originalSet(key, value);
    };

    // 键存在、值为空：JSON-RPC 线上合法，会一路穿过 `.strict()`，由 refine 兜住。
    for (const empty of [null, undefined]) {
      const parsed = zcodeWorkspaceUpdateMagicContextConfigParamsSchema.safeParse({
        workspace: WORKSPACE,
        config: empty,
      });
      assert.equal(parsed.success, false, `expected envelope to reject config=${String(empty)}`);
      assert.equal(parsed.error.issues[0].path[0], "config");

      await assert.rejects(
        () =>
          updateMagicContextConfig(
            contextWith(sessionRecord(configPort)),
            { workspace: WORKSPACE, config: empty },
            { configPath },
          ),
        (error) => {
          assert.equal(error.name, "ProtocolRequestError");
          assert.equal(error.code, -32602);
          assert.match(error.message, /config is required and must not be null/);
          return true;
        },
      );
    }

    assert.equal(setCalls, 0, "空值调用绝不能广播到内存");
    assert.deepEqual(configPort.get(ConfigKey.MagicContext), before);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf-8")), {
      ui: { locale: "en-US" },
    });
  });
});

// ── A3: success = 写盘 + 内存双写 ─────────────────────────────────────────────

test("A3: success writes the file and pushes the parsed domain into every session", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ ui: { locale: "en-US" } }), "utf-8");

    const first = createConfigPort({});
    const second = createConfigPort({});
    const context = contextWith(sessionRecord(first), sessionRecord(second), sessionRecord());
    const next = MagicContextConfigSchema.parse({
      protected_tokens: 12000,
      historian: { model: "zcode/glm-4.6" },
    });

    const result = await updateMagicContextConfig(context, params(next), { configPath });

    assert.equal(result.applied, true);
    assert.equal(result.changed, true);
    assert.equal(result.path, configPath);
    assert.deepEqual(result.workspace, WORKSPACE);

    // ① 写盘：顶层域 + 其余键保留。
    const onDisk = JSON.parse(await readFile(configPath, "utf-8"));
    assert.deepEqual(onDisk.magicContext, next);
    assert.deepEqual(onDisk.ui, { locale: "en-US" });

    // ② 内存：每个实现了 getConfigPort 的 resident session 都收到了同一个对象。
    assert.deepEqual(first.get(ConfigKey.MagicContext), next);
    assert.deepEqual(second.get(ConfigKey.MagicContext), next);
  });
});

test("A3: the pushed value is the schema-normalised domain, not the raw payload", async () => {
  await withTempDir(async (dir) => {
    const configPort = createConfigPort({});
    await updateMagicContextConfig(
      contextWith(sessionRecord(configPort)),
      // 参考插件遗留的 `compaction` 必须在这里被剥掉，而不是原样进内存。
      params({ enabled: true, compaction: { enabled: true } }),
      { configPath: join(dir, "config.json") },
    );
    const stored = configPort.get(ConfigKey.MagicContext);
    assert.equal("compaction" in stored, false);
    assert.equal(stored.cache_ttl, "5m", "缺席字段应被 .default() 补齐");
  });
});

test("A3: a repeated identical write reports changed:false but still converges memory", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    const configPort = createConfigPort({});
    const next = MagicContextConfigSchema.parse({ protected_tokens: 9000 });

    const first = await updateMagicContextConfig(
      contextWith(sessionRecord(configPort)),
      params(next),
      { configPath },
    );
    const second = await updateMagicContextConfig(
      contextWith(sessionRecord(configPort)),
      params(next),
      { configPath },
    );

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.deepEqual(configPort.get(ConfigKey.MagicContext), next);
  });
});

test("A3: with no active session the write still lands on disk", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    const result = await updateMagicContextConfig(
      contextWith(),
      params({ protected_tokens: 9000 }),
      { configPath },
    );
    assert.equal(result.applied, true);
    assert.equal(
      JSON.parse(await readFile(configPath, "utf-8")).magicContext.protected_tokens,
      9000,
    );
  });
});

// ── B: T-M8 gating at the assembly point ─────────────────────────────────────

test("B (T-M8): features.magicContext=false never touches the config port, whatever the domain says", async () => {
  const trap = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "get" || property === "observe" || property === "set") {
          throw new Error(`config port must not be touched while the feature is off (${String(property)})`);
        }
        return undefined;
      },
    },
  );

  const result = await createMagicContextTurnTransform({
    enabled: false,
    // 参数域写得再足也不能让门控失效：真正的 kill switch 是 features.magicContext。
    configPort: trap,
    configDomain: { enabled: true, protected_tokens: 9000, historian: { model: "x/y" } },
    sessionId: "ses_gate_off",
    workingDirectory: "D:/tmp/project",
    logger: { info() {}, warn() {}, error() {}, debug() {}, child: () => ({}) },
  });

  assert.equal(result, undefined);
});