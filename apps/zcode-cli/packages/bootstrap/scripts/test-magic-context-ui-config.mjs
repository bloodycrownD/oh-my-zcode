#!/usr/bin/env node
/**
 * Step 29 / T-U1 �� ���÷��� �� config.json ���� �� **������**��Ч ��ȫ����֤��
 *
 * S23 �� `test-magic-context-config-rpc.mjs` �Ѿ���ס handler ����������ʽ˳����
 * T-M8 �ſأ�����**������ UI ����**��û�� `workspace/readMagicContextConfig`��
 * û�С����򸲸ǵĶ�-��-д����Ҳû�С�observer �յ�֪ͨ �� ��һ�� turn ������ֵ��
 * �����Ρ�������ﲹ������ UI ����֮���³��ֵ��ǲ���ʧЧ�棺
 *
 *   A. **��·��**��`workspace/readMagicContextConfig` �� ConfigPort ���� effective
 *      ��û�л session ʱ�˻ض��ļ� + schema parse������·���� UI ����״�㶨��
 *   B. **���򸲸ǵĶ�-��-д**��UI ���������ȶ���д������һ�α���ͻ�Ĩ���û���д��
 *      �����ֶΡ���һ��ֱ���� UI �� `buildMagicContextConfigFromForm` /
 *      `magicContextSettingsFormFromConfig`��packages/ui ����ʵ������Ǹ��̣���
 *      ������ per-model ���ǣ�`execute_threshold_tokens` / `cache_ttl` �Ķ�����̬��
 *      �� historian Ԫ����ԭ�����ء�
 *   C. **T-U1 ����**���� `execute_threshold_percentage` �� config.json ԭ�����̣����ļ�
 *      �������ݣ��� `ConfigPort.observe` �Ķ������յ�֪ͨ��generation bump���� ��һ
 *      turn ֱ�Ӷ�����ֵ��ȫ�̲��ؽ� App�����������̡�
 *
 * ���룺����д�붼ָ�� `mkdtemp` ��������ʱĿ¼��`configPath` ������ע��խ�죬
 * **���������û���ʵ�� `~/.omz/cli/config.json`**��
 *
 * �����ѹ����� dist��`@zcode/shared`��`@zcode/model-option-map`��`@zcode/magic-context`��
 * `contracts`��`adapters`��`bootstrap`���Լ�
 * `packages/ui/dist/settings/magicContextSettingsForm.js`���ɸ� `pnpm typecheck` ��
 * `tsc -b packages/ui` ��������
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
      throw new Error(`no compiled dist for "${specifier}" �� build ${packageName} first`);
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

// UI �ı���ӳ��ģ�飨��ʵ������Ǳ�������ĸ��̣���
const UI_FORM_DIST = `${REPO_ROOT}packages/ui/dist/settings/magicContextSettingsForm.js`;
if (!existsSync(UI_FORM_DIST)) {
  throw new Error(
    `missing ${UI_FORM_DIST} �� run the root \`pnpm typecheck\` (tsc -b packages/ui) first`,
  );
}
const { buildMagicContextConfigFromForm, magicContextSettingsFormFromConfig } = await import(
  pathToFileURL(UI_FORM_DIST).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS �� Step 29 T-U1 settings �� config.json �� hot reload"
      : `TEST FAIL �� Step 29 T-U1 settings chain (exit code ${code})`,
  );
});

const WORKSPACE = { workspacePath: "D:/tmp/project", workspaceKey: "ws_test" };
const READ_PARAMS = { workspace: WORKSPACE };
/** �� `MagicContextConfigSchema.parse({})` �� `.default()` һ�£���ʧ��ʱ�˻����� */
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

// ���� A: ��·�� ������������������������������������������������������������������������������������������������������������������������������

test("A1: read returns the ConfigPort's effective domain when a session is resident", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    // ��������һ��**��ͬ��**ֵ���������� ConfigPort Ϊ׼������������ʱ���õģ���
    // ������ÿ�ζ�ȥ���̡������򱣴�����̻ض����õ���һ�ֵ�ֵ��
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
    // ȱϯ�ֶα��뱻 schema �� .default() ���룬UI ������Ⱦһ������������
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
    // ȱ workspace����·���������� ref�����ŷ���Ķ���������뱻�ܡ�
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
    // ��·�������ܡ�˳���һ�¡���params ����� config �ֶξ���ԽȨ��дֻ�� update һ��·��
    await assert.rejects(
      () => readMagicContextConfig(contextWith(), { workspace: WORKSPACE, config: {} }, { configPath }),
      (error) => error.code === -32602,
    );
    // ���ܵ�����û�������κζ�����
    assert.equal(existsSync(configPath), false);
  });
});

// ���� B: UI ���������򸲸ǣ���-��-д�� ����������������������������������������������������������������������������������

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

  // �ĵ���һ���ֶ���Ч��
  assert.equal(next.execute_threshold_percentage, 42);
  // û�ĵ��ֶ�ԭ�����أ�RPC �������滻�������ؾ͵���ɾ����
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
  // д�غ��Ա����ܱ�ͬһ�� schema ������UI ���ܹ��������˱�Ȼ�ܾ����򣩡�
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
  // �մ����ǺϷ�ֵ��z.string().trim().min(1).optional() �ܾ��մ�����������ֵ�ֻ���
  // ����ա���ĬʧЧ����˱����ǡ��������ڡ���
  assert.equal("model" in next.historian, false);
  // ͬ historian ������Ԫ������Ȼ������
  assert.equal(next.historian.temperature, 0.3);
  assert.doesNotThrow(() => MagicContextConfigSchema.parse(next));
});

test("B4: clearing the token override drops only `default`, never the per-model table", () => {
  const base = MagicContextConfigSchema.parse({
    execute_threshold_tokens: { "zcode/big": 90_000 },
  });

  // `default` 在 schema 里可选，所以「只有 per-model 键」是合法形态；而表单首版
  // 没有按模型编辑入口，读侧只能把它坍缩成 null（展示为「未覆盖」）。
  const form = magicContextSettingsFormFromConfig(base, UI_FALLBACK_FORM);
  assert.equal(form.executeThresholdTokens, null);

  // 写侧不能因此删掉整张表：那些键在设置页上完全不可见（MF-09 数据损坏）。
  const cleared = buildMagicContextConfigFromForm(base, form);
  assert.deepEqual(cleared.execute_threshold_tokens, { "zcode/big": 90_000 });
  assert.doesNotThrow(() => MagicContextConfigSchema.parse(cleared));

  // per-model-only + 新填 default：两个分支共存，default 覆盖未单列的模型。
  const withDefault = buildMagicContextConfigFromForm(base, {
    ...form,
    executeThresholdTokens: 55_000,
  });
  assert.deepEqual(withDefault.execute_threshold_tokens, {
    default: 55_000,
    "zcode/big": 90_000,
  });

  // 只有 default 时清空 = 真删键（不能留下一张空对象）。
  const defaultOnly = buildMagicContextConfigFromForm(
    MagicContextConfigSchema.parse({ execute_threshold_tokens: { default: 40_000 } }),
    { ...form, executeThresholdTokens: null },
  );
  assert.equal("execute_threshold_tokens" in defaultOnly, false);
});

test("B5: a zero-edit save of a per-model-only domain is byte-identical", () => {
  const base = MagicContextConfigSchema.parse({
    execute_threshold_tokens: { "zcode/big": 90_000 },
  });
  const form = magicContextSettingsFormFromConfig(base, UI_FALLBACK_FORM);

  // MagicContextSettingsSection 的 dirty 判定就是这两个 stringify 的比较。
  // 写侧一旦丢掉 per-model 键（或改动键序），零改动也会被判成 dirty →
  // 保存按钮可点 → 点一下即销毁用户配置。修复前本断言失败。
  assert.equal(
    JSON.stringify(buildMagicContextConfigFromForm(base, form)),
    JSON.stringify(base),
  );
});

// ���� C: T-U1 ���壨UI �޸� �� ���� �� ��������Ч�� ����������������������������������������������������������

test("C (T-U1): a settings save lands on disk, notifies observers, and is read by the next turn", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ ui: { locale: "en-US" } }), "utf-8");

    const configPort = createConfigPort({});
    configPort.set(ConfigKey.MagicContext, DEFAULT_MAGIC_CONTEXT_CONFIG);

    // �� bootstrap װ���ͬһ�ݶ������壺ConfigPort.observe �Ķ�������ÿ��
    // fan-out ʱ�����ã�transform �����**��һ turn** ����ȡ���á����������ģ��һ��
    // ��ÿ turn ��һ�Ρ��Ķ��ߡ����������ľ�����Ч�е�ֵ��ȫ�̲��ؽ� App��
    let generation = 0;
    let turnValue = configPort.get(ConfigKey.MagicContext);
    const unsubscribe = configPort.observe().subscribe(ConfigKey.MagicContext, (value) => {
      generation += 1;
      turnValue = value;
    });

    try {
      // ���� �� �����÷��������� effective ����Ϊ������ֵ ����������������������������������������
      const initial = await readMagicContextConfig(
        contextWith(sessionRecord(configPort)),
        READ_PARAMS,
        { configPath },
      );
      const form = magicContextSettingsFormFromConfig(initial.config, UI_FALLBACK_FORM);
      assert.equal(form.executeThresholdPercentage, 65);

      // ���� �� �û��ļ����ֶΣ��㱣�� ������������������������������������������������������������������������������
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
      // update �ش����� effective ��UI ������������Ǳ��زݸ塣
      assert.equal(saved.config.execute_threshold_percentage, 48);

      // ���� �� ���̶��ԣ��������д�����ļ�����û�������������� ��������������������������
      const onDisk = JSON.parse(await readFile(configPath, "utf-8"));
      assert.deepEqual(onDisk.ui, { locale: "en-US" });
      assert.equal(onDisk.magicContext.execute_threshold_percentage, 48);
      assert.equal(onDisk.magicContext.protected_tokens, 16_000);
      assert.equal(onDisk.magicContext.historian.model, "zcode/glm-4.6");
      // û�в�����ʱ�ļ���atomicWriteJson ����ʱ�ļ������ѱ� rename ����
      assert.deepEqual(await readdir(dir), ["config.json"]);

      // ���� �� observer ֪ͨ��fan-out ���ٷ���һ�Σ��Ҷ���������ֵ ����������������������
      assert.equal(generation, 1, "һ�α�����봥��һ�� ConfigPort fan-out");
      assert.equal(turnValue.execute_threshold_percentage, 48);

      // ���� �� ��һ turn ֱ�Ӷ�����ֵ��ͬһ�� Port��ͬһ������ ������������������������������
      assert.equal(configPort.get(ConfigKey.MagicContext).execute_threshold_percentage, 48);
      assert.equal(configPort.get(ConfigKey.MagicContext).historian.model, "zcode/glm-4.6");

      // ���� �� �ݵ���д��changed:false�����ڴ���������fan-out �Է��� ������������������
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

      // ���� �� �ٴ�һ�����÷�����������ֵ���ڴ�һ�£�����ջ��� ������������������������
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

    // UI ��� min/max ֻ������㣻Խ��ֵ��Ȼ���뱻 CLI �� schema parse �ܾ���
    // ���ھܾ����ϴ������ڴ涼û��������
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
