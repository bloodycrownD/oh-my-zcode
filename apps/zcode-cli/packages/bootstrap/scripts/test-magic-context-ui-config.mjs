#!/usr/bin/env node
/**
 * Step 29 / T-U1 — 设置分区 → config.json 落盘 → **不重启**生效 的全链验证。
 *
 * S23 的 `test-magic-context-config-rpc.mjs` 已经钉住 handler 自身的三段式顺序与
 * T-M8 门控，但它**不经过 UI 表单**：没有 `workspace/readMagicContextConfig`、
 * 没有「整域覆盖的读-改-写」、也没有「observer 收到通知 → 下一个 turn 读到新值」
 * 这三段。因此这里补的正是 UI 接上之后新出现的那部分失效面：
 *
 *   A. **读路径**：`workspace/readMagicContextConfig` 从 ConfigPort 读回 effective
 *      域；没有活动 session 时退回读文件 + schema parse，两条路径给 UI 的形状恒定。
 *   B. **整域覆盖的读-改-写**：UI 表单必须先读再写，否则一次保存就会抹掉用户手写的
 *      其它字段。这一段直接跑 UI 的 `buildMagicContextConfigFromForm` /
 *      `magicContextSettingsFormFromConfig`（packages/ui 的真实产物，不是复刻），
 *      并断言 per-model 覆盖（`execute_threshold_tokens` / `cache_ttl` 的对象形态）
 *      与 historian 元数据原样带回。
 *   C. **T-U1 本体**：改 `execute_threshold_percentage` → config.json 原子落盘（读文件
 *      断言内容）→ `ConfigPort.observe` 的订阅者收到通知（generation bump）→ 下一
 *      turn 直接读到新值，全程不重建 App、不重启进程。
 *
 * 隔离：所有写入都指向 `mkdtemp` 出来的临时目录，`configPath` 走依赖注入窄缝，
 * **绝不触碰用户真实的 `~/.zcode/cli/config.json`**。
 *
 * 依赖已构建的 dist：`@zcode/shared`、`@zcode/model-option-map`、`@zcode/magic-context`、
 * `contracts`、`adapters`、`bootstrap`，以及
 * `packages/ui/dist/settings/magicContextSettingsForm.js`（由根 `pnpm typecheck` 的
 * `tsc -b packages/ui` 产出）。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
const { readMagicContextConfig, updateMagicContextConfig } = await import(
  new URL("../dist/zcode-protocol/magic-context-config.js", import.meta.url).href
);

// UI 的表单映射模块（真实产物，不是本测试里的复刻）。
const UI_FORM_DIST = `${REPO_ROOT}packages/ui/dist/settings/magicContextSettingsForm.js`;
if (!existsSync(UI_FORM_DIST)) {
  throw new Error(
    `missing ${UI_FORM_DIST} — run the root \`pnpm typecheck\` (tsc -b packages/ui) first`,
  );
}
const { buildMagicContextConfigFromForm, magicContextSettingsFormFromConfig } = await import(
  pathToFileURL(UI_FORM_DIST).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — Step 29 T-U1 settings → config.json → hot reload"
      : `TEST FAIL — Step 29 T-U1 settings chain (exit code ${code})`,
  );
});

const WORKSPACE = { workspacePath: "D:/tmp/project", workspaceKey: "ws_test" };
const READ_PARAMS = { workspace: WORKSPACE };
/** 与 `MagicContextConfigSchema.parse({})` 的 `.default()` 一致，读失败时退回它。 */
const UI_FALLBACK_FORM = {
  enabled: true,
  executeThresholdPercentage: 65,
  executeThresholdTokens: null,
  protectedTokens: null,
  historyBudgetPercentage: 0.15,
  cacheTtl: "5m",
  historianModel: "",
  smartDrops: false,
  failClosedBlocking: true,
};

function sessionRecord(configPort) {
  return configPort === undefined ? {} : { app: { getConfigPort: () => configPort } };
}

function contextWith(...records) {
  return { sessions: new Map(records.map((record, index) => [`ses_${index}`, record])) };
}

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "zcode-mc-ui-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── A: 读路径 ───────────────────────────────────────────────────────────────

test("A1: read returns the ConfigPort's effective domain when a session is resident", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    // 磁盘上是一份**不同的**值：读必须以 ConfigPort 为准（它才是运行时在用的），
    // 而不是每次都去读盘——否则保存后立刻回读会拿到上一轮的值。
    await writeFile(configPath, JSON.stringify({ magicContext: { protected_tokens: 4000 } }));
    const configPort = createConfigPort({});
    const live = MagicContextConfigSchema.parse({ protected_tokens: 32000 });
    configPort.set(ConfigKey.MagicContext, live);

    const result = await readMagicContextConfig(
      contextWith(sessionRecord(configPort)),
      READ_PARAMS,
      { configPath },
    );

    assert.deepEqual(result.workspace, WORKSPACE);
    assert.equal(result.path, configPath);
    assert.deepEqual(result.config, live);
  });
});

test("A2: read falls back to the file when no session is resident", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({ magicContext: { historian: { model: "zcode/glm-4.6" } } }),
    );

    const result = await readMagicContextConfig(contextWith(), READ_PARAMS, { configPath });

    assert.equal(result.config.historian.model, "zcode/glm-4.6");
    // 缺席字段必须被 schema 的 .default() 补齐，UI 才能渲染一份完整表单。
    assert.equal(result.config.execute_threshold_percentage, 65);
    assert.equal(result.config.cache_ttl, "5m");
  });
});

test("A3: a missing or broken config file still yields a complete editable domain", async () => {
  await withTempDir(async (dir) => {
    const missing = await readMagicContextConfig(contextWith(), READ_PARAMS, {
      configPath: join(dir, "absent.json"),
    });
    assert.deepEqual(missing.config, DEFAULT_MAGIC_CONTEXT_CONFIG);

    const brokenPath = join(dir, "broken.json");
    await writeFile(brokenPath, "{not json");
    const broken = await readMagicContextConfig(contextWith(), READ_PARAMS, {
      configPath: brokenPath,
    });
    assert.deepEqual(broken.config, DEFAULT_MAGIC_CONTEXT_CONFIG);
  });
});

test("A4: the read envelope is strict and carries no domain field at all", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    // 缺 workspace（读路径不接受裸 ref）与信封外的额外键都必须被拒。
    for (const bad of [{ workspaceKey: "k" }, { workspace: WORKSPACE, extra: 1 }]) {
      await assert.rejects(
        () => readMagicContextConfig(contextWith(), bad, { configPath }),
        (error) => {
          assert.equal(error.name, "ProtocolRequestError");
          assert.equal(error.code, -32602);
          return true;
        },
      );
    }
    // 读路径不接受「顺便改一下」：params 里出现 config 字段就是越权，写只有 update 一条路。
    await assert.rejects(
      () => readMagicContextConfig(contextWith(), { workspace: WORKSPACE, config: {} }, { configPath }),
      (error) => error.code === -32602,
    );
    // 被拒的请求没有落盘任何东西。
    assert.equal(existsSync(configPath), false);
  });
});

// ── B: UI 表单的整域覆盖（读-改-写） ─────────────────────────────────────────

test("B1: editing one field through the UI form preserves every other key", () => {
  const base = MagicContextConfigSchema.parse({
    enabled: true,
    protected_tokens: 12000,
    historian: {
      model: "zcode/glm-4.6",
      temperature: 0.3,
      prompt: "keep me",
      fallback_models: ["zcode/glm-4.5"],
      two_pass: true,
    },
    language: "tr",
  });

  const form = magicContextSettingsFormFromConfig(base, UI_FALLBACK_FORM);
  assert.equal(form.protectedTokens, 12000);
  assert.equal(form.historianModel, "zcode/glm-4.6");
  assert.equal(form.cacheTtl, "5m");

  const next = buildMagicContextConfigFromForm(base, {
    ...form,
    executeThresholdPercentage: 42,
  });

  // 改的那一个字段生效。
  assert.equal(next.execute_threshold_percentage, 42);
  // 没改的字段原样带回：RPC 是整域替换，带不回就等于删除。
  assert.equal(next.protected_tokens, 12000);
  assert.equal(next.language, "tr");
  assert.deepEqual(next.historian, base.historian);
  assert.deepEqual(MagicContextConfigSchema.parse(next), {
    ...MagicContextConfigSchema.parse(base),
    execute_threshold_percentage: 42,
  });
});

test("B2: per-model overrides survive a UI save (only the default branch is edited)", () => {
  const base = MagicContextConfigSchema.parse({
    execute_threshold_tokens: { default: 40_000, "zcode/big": 90_000 },
    cache_ttl: { default: "10m", "zcode/big": "1h" },
  });

  const form = magicContextSettingsFormFromConfig(base, UI_FALLBACK_FORM);
  assert.equal(form.executeThresholdTokens, 40_000);
  assert.equal(form.cacheTtl, "10m");

  const next = buildMagicContextConfigFromForm(base, {
    ...form,
    executeThresholdTokens: 55_000,
    cacheTtl: "30m",
  });

  assert.deepEqual(next.execute_threshold_tokens, { default: 55_000, "zcode/big": 90_000 });
  assert.deepEqual(next.cache_ttl, { default: "30m", "zcode/big": "1h" });
  // 写回后仍必须能被同一个 schema 解析（UI 不能构造出服务端必然拒绝的域）。
  assert.deepEqual(MagicContextConfigSchema.parse(next).cache_ttl, {
    default: "30m",
    "zcode/big": "1h",
  });
});

test("B3: clearing optional fields deletes the key instead of writing null or stale values", () => {
  const base = MagicContextConfigSchema.parse({
    protected_tokens: 12000,
    historian: { model: "zcode/glm-4.6", temperature: 0.3 },
  });
  const form = magicContextSettingsFormFromConfig(base, UI_FALLBACK_FORM);

  const next = buildMagicContextConfigFromForm(base, {
    ...form,
    protectedTokens: null,
    historianModel: "",
  });

  assert.equal("protected_tokens" in next, false);
  // 空串不是合法值（z.string().trim().min(1).optional() 拒绝空串），保留旧值又会让
  // 「清空」静默失效，因此必须是「键不存在」。
  assert.equal("model" in next.historian, false);
  // 同 historian 的其它元数据仍然保留。
  assert.equal(next.historian.temperature, 0.3);
  assert.doesNotThrow(() => MagicContextConfigSchema.parse(next));
});

// ── C: T-U1 本体（UI 修改 → 落盘 → 不重启生效） ─────────────────────────────

test("C (T-U1): a settings save lands on disk, notifies observers, and is read by the next turn", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ ui: { locale: "en-US" } }), "utf-8");

    const configPort = createConfigPort({});
    configPort.set(ConfigKey.MagicContext, DEFAULT_MAGIC_CONTEXT_CONFIG);

    // 与 bootstrap 装配层同一份订阅语义：ConfigPort.observe 的订阅者在每次
    // fan-out 时被调用，transform 借此在**下一 turn** 重新取配置。这里把它建模成一个
    // 「每 turn 读一次」的读者——它读到的就是生效中的值，全程不重建 App。
    let generation = 0;
    let turnValue = configPort.get(ConfigKey.MagicContext);
    const unsubscribe = configPort.observe().subscribe(ConfigKey.MagicContext, (value) => {
      generation += 1;
      turnValue = value;
    });

    try {
      // ── ① 打开设置分区：读回 effective 域作为表单初值 ────────────────────
      const initial = await readMagicContextConfig(
        contextWith(sessionRecord(configPort)),
        READ_PARAMS,
        { configPath },
      );
      const form = magicContextSettingsFormFromConfig(initial.config, UI_FALLBACK_FORM);
      assert.equal(form.executeThresholdPercentage, 65);

      // ── ② 用户改几个字段，点保存 ───────────────────────────────────────
      const next = buildMagicContextConfigFromForm(initial.config, {
        ...form,
        executeThresholdPercentage: 48,
        protectedTokens: 16_000,
        historianModel: "zcode/glm-4.6",
      });
      const saved = await updateMagicContextConfig(
        contextWith(sessionRecord(configPort)),
        { workspace: WORKSPACE, config: next },
        { configPath },
      );
      assert.equal(saved.applied, true);
      assert.equal(saved.changed, true);
      // update 回传的是 effective 域，UI 用它回填而不是本地草稿。
      assert.equal(saved.config.execute_threshold_percentage, 48);

      // ── ③ 落盘断言：内容真的写进了文件，且没有碰其它顶层域 ─────────────
      const onDisk = JSON.parse(await readFile(configPath, "utf-8"));
      assert.deepEqual(onDisk.ui, { locale: "en-US" });
      assert.equal(onDisk.magicContext.execute_threshold_percentage, 48);
      assert.equal(onDisk.magicContext.protected_tokens, 16_000);
      assert.equal(onDisk.magicContext.historian.model, "zcode/glm-4.6");
      // 没有残留临时文件：atomicWriteJson 的临时文件必须已被 rename 掉。
      assert.deepEqual(await readdir(dir), ["config.json"]);

      // ── ④ observer 通知：fan-out 至少发生一次，且读到的是新值 ───────────
      assert.equal(generation, 1, "一次保存必须触发一次 ConfigPort fan-out");
      assert.equal(turnValue.execute_threshold_percentage, 48);

      // ── ⑤ 下一 turn 直接读到新值：同一个 Port、同一个进程 ───────────────
      assert.equal(configPort.get(ConfigKey.MagicContext).execute_threshold_percentage, 48);
      assert.equal(configPort.get(ConfigKey.MagicContext).historian.model, "zcode/glm-4.6");

      // ── ⑥ 幂等重写：changed:false，但内存仍收敛、fan-out 仍发生 ─────────
      const again = await updateMagicContextConfig(
        contextWith(sessionRecord(configPort)),
        { workspace: WORKSPACE, config: next },
        { configPath },
      );
      assert.equal(again.changed, false);
      assert.equal(generation, 2);
      assert.deepEqual(
        configPort.get(ConfigKey.MagicContext),
        MagicContextConfigSchema.parse(JSON.parse(await readFile(configPath, "utf-8")).magicContext),
      );

      // ── ⑦ 再打开一次设置分区：表单初值与内存一致（回填闭环） ────────────
      const reread = await readMagicContextConfig(
        contextWith(sessionRecord(configPort)),
        READ_PARAMS,
        { configPath },
      );
      const rereadForm = magicContextSettingsFormFromConfig(reread.config, UI_FALLBACK_FORM);
      assert.equal(rereadForm.executeThresholdPercentage, 48);
      assert.equal(rereadForm.protectedTokens, 16_000);
      assert.equal(rereadForm.historianModel, "zcode/glm-4.6");
    } finally {
      unsubscribe();
    }
  });
});

test("C: an out-of-range UI value is rejected by the schema and never reaches disk", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ magicContext: { protected_tokens: 9000 } }), "utf-8");
    const configPort = createConfigPort({});

    // UI 侧的 min/max 只是体验层；越界值仍然必须被 CLI 的 schema parse 拒绝，
    // 且在拒绝点上磁盘与内存都没被碰过。
    await assert.rejects(
      () =>
        updateMagicContextConfig(
          contextWith(sessionRecord(configPort)),
          { workspace: WORKSPACE, config: { execute_threshold_percentage: 95 } },
          { configPath },
        ),
      (error) => error.code === -32602,
    );
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf-8")).magicContext, {
      protected_tokens: 9000,
    });
    assert.deepEqual(configPort.get(ConfigKey.MagicContext), DEFAULT_MAGIC_CONTEXT_CONFIG);
  });
});
