#!/usr/bin/env node
/**
 * PL-G-1（prompt-language-option）：`workspace/read|updatePromptLanguage` 常驻回归网。
 *
 * 四组断言：
 *
 *   A. **三段式顺序与落盘**。update 先校验 → 写盘 → `configPort.set` +
 *      `runtime.updateConfig`；三态（auto / zh-CN / en-US）都写盘，且读改写保留
 *      其余顶层键（ui.locale / plugins 等）；每个 resident session 的
 *      `configPort.set` 与 `runtime.updateConfig` 各恰一次，updateConfig 收到的是
 *      解析后的 effective language。
 *
 *   B. **非法值**（"fr" / 数字 / null）→ `-32602` 结构化错误，且磁盘与内存
 *      （ConfigPort、runtime）都未被触碰；协议层 envelope 保持 strict。
 *
 *   C. **read 的读取顺序**：有 resident session 走 ConfigPort；无 session 读文件；
 *      文件缺省/损坏回落 "auto"（设置页永远拿到可渲染值）。
 *      result schema round-trip 由 zod schema.parse 在各断言处覆盖。
 *
 *   D. **PL-B-1 auto 探测与冷/热同源**：auto + LANG=zh_CN.UTF-8 → zh-CN；
 *      auto + env 空 + Intl zh-CN → zh-CN；auto + env 空 + Intl en-US → en-US；
 *      显式值透传不受探测影响；同一 (env, intlLocale) 输入下热路径
 *      （updatePromptLanguage）与冷启动装配（resolveEffectiveLocale）输出一致。
 *
 * 依赖已构建的 dist：`pnpm --filter @zcode/adapters build`、
 * `pnpm --filter @zcode/bootstrap build`（以及 @zcode/shared 的 dist 兜底，见
 * 下方 resolve 钩子——与 test-magic-context-config-rpc.mjs 同一范式）。
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
const {
  zcodeWorkspaceReadPromptLanguageParamsSchema,
  zcodeWorkspaceReadPromptLanguageResultSchema,
  zcodeWorkspaceUpdatePromptLanguageParamsSchema,
  zcodeWorkspaceUpdatePromptLanguageResultSchema,
} = await import("@zcode/shared");
const { resolveEffectiveLocale, resolveIntlLocale, resolvePromptLanguage } = await import(
  new URL("../dist/app/app-config-options.js", import.meta.url).href
);
const { readPromptLanguage, updatePromptLanguage } = await import(
  new URL("../dist/zcode-protocol/prompt-language.js", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — workspace/read|updatePromptLanguage handlers + PL-B-1 auto detection"
      : `TEST FAIL — workspace/read|updatePromptLanguage handlers (exit code ${code})`,
  );
});

const WORKSPACE = { workspacePath: "D:/tmp/project", workspaceKey: "ws_test" };

function readParams() {
  return { workspace: WORKSPACE };
}

function updateParams(promptLanguage) {
  return { workspace: WORKSPACE, promptLanguage };
}

/**
 * 一个最小 resident session record：ConfigPort（set 计数）+ runtime.updateConfig
 * （调用参数记录）。handler 只消费这两个面。
 */
function sessionRecord() {
  const configPort = createConfigPort({});
  const setCalls = [];
  const originalSet = configPort.set.bind(configPort);
  configPort.set = (key, value) => {
    setCalls.push({ key, value });
    originalSet(key, value);
  };
  const updateConfigCalls = [];
  return {
    configPort,
    setCalls,
    updateConfigCalls,
    record: {
      app: {
        getConfigPort: () => configPort,
        runtime: {
          updateConfig(patch) {
            updateConfigCalls.push(patch);
          },
        },
      },
    },
  };
}

function contextWith(...records) {
  return { sessions: new Map(records.map((record, index) => [`ses_${index}`, record])) };
}

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "zcode-pl-rpc-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeConfig(configPath, value) {
  await writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function readConfig(configPath) {
  return JSON.parse(await readFile(configPath, "utf-8"));
}

// ── A: envelope ──────────────────────────────────────────────────────────────

test("A1: params envelope is strict and only accepts the three-state enum", () => {
  assert.equal(
    zcodeWorkspaceUpdatePromptLanguageParamsSchema.safeParse(updateParams("auto")).success,
    true,
  );
  assert.equal(zcodeWorkspaceReadPromptLanguageParamsSchema.safeParse(readParams()).success, true);

  for (const bad of [
    { workspace: WORKSPACE },
    { ...updateParams("zh-CN"), extra: 1 },
    { ...updateParams("zh-CN"), workspace: { workspaceKey: "k" } },
    updateParams("fr"),
    updateParams("zh_CN"),
    updateParams(42),
    updateParams(null),
    { workspace: WORKSPACE, promptLanguage: "zh-CN", extra: true },
  ]) {
    assert.equal(
      zcodeWorkspaceUpdatePromptLanguageParamsSchema.safeParse(bad).success,
      false,
      `expected envelope to be rejected: ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(
    zcodeWorkspaceReadPromptLanguageParamsSchema.safeParse({ workspace: WORKSPACE, x: 1 }).success,
    false,
  );
});

// ── A2: 非法值 → -32602，磁盘/内存均未触碰 ───────────────────────────────────

test("A2: invalid values → -32602, and neither disk nor memory is touched", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    const before = { ui: { locale: "zh-CN" }, plugins: { enabledPlugins: { demo: true } } };
    await writeConfig(configPath, before);
    const session = sessionRecord();

    for (const invalid of ["fr", 42, null, "zh_CN", undefined]) {
      await assert.rejects(
        () =>
          updatePromptLanguage(
            contextWith(session.record),
            { workspace: WORKSPACE, promptLanguage: invalid },
            { configPath, env: {}, intlLocale: "en-US" },
          ),
        (error) => {
          assert.equal(error.name, "ProtocolRequestError");
          assert.equal(error.code, -32602);
          return true;
        },
      );
    }

    assert.equal(session.setCalls.length, 0, "校验失败时绝不能已经广播到内存");
    assert.equal(session.updateConfigCalls.length, 0);
    assert.deepEqual(await readConfig(configPath), before);
  });
});

// ── A3: 三态写盘 + 保留其它顶层键 + 每 session 恰一次推送 ─────────────────────

test("A3: all three states write the file, preserve other top-level keys, and fan out once per session", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    const first = sessionRecord();
    const second = sessionRecord();
    const context = contextWith(first.record, second.record);

    const cases = [
      { value: "auto", env: { LANG: "zh_CN.UTF-8" }, expected: "zh-CN" },
      { value: "zh-CN", env: {}, expected: "zh-CN" },
      { value: "en-US", env: { LANG: "zh_CN.UTF-8" }, expected: "en-US" },
    ];

    for (const { value, env } of cases) {
      await writeConfig(configPath, {
        ui: { locale: "zh-CN", theme: "dark" },
        plugins: { enabledPlugins: { demo: true } },
        ...(value === "auto" ? {} : { promptLanguage: "auto" }),
      });

      const result = await updatePromptLanguage(context, updateParams(value), {
        configPath,
        env,
        intlLocale: "en-US",
      });

      // result schema round-trip。
      assert.deepEqual(zcodeWorkspaceUpdatePromptLanguageResultSchema.parse(result), result);
      assert.equal(result.path, configPath);
      assert.equal(result.promptLanguage, value);
      assert.equal(result.updatedSessionCount, 2);

      // ① 写盘：目标标量 + 其余顶层键保留。
      const onDisk = await readConfig(configPath);
      assert.equal(onDisk.promptLanguage, value);
      assert.deepEqual(onDisk.ui, { locale: "zh-CN", theme: "dark" });
      assert.deepEqual(onDisk.plugins, { enabledPlugins: { demo: true } });
    }

    // ② 内存：每个 session 的 ConfigPort.set / runtime.updateConfig 各恰一次，
    //    且 updateConfig 收到的是「解析后的 effective」而不是原始偏好值。
    const expectedEffective = cases.map((entry) => entry.expected);
    for (const session of [first, second]) {
      assert.deepEqual(
        session.setCalls.map((call) => [call.key, call.value]),
        cases.map((entry) => [ConfigKey.PromptLanguage, entry.value]),
        "configPort.set 必须逐次、原样收到偏好值",
      );
      assert.deepEqual(
        session.updateConfigCalls.map((patch) => patch.language),
        expectedEffective,
        "runtime.updateConfig 必须逐次收到解析后的 effective 值",
      );
    }
  });
});

test("A3: effective language pushed to runtime is the auto-resolved value (PL-B-1)", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    const session = sessionRecord();
    const context = contextWith(session.record);

    // auto + POSIX 中文环境：热更新推送的必须是 zh-CN，而不是 "auto" 或 en-US。
    await updatePromptLanguage(context, updateParams("auto"), {
      configPath,
      env: { LANG: "zh_CN.UTF-8" },
      intlLocale: "en-US",
    });
    assert.deepEqual(session.setCalls, [{ key: ConfigKey.PromptLanguage, value: "auto" }]);
    assert.deepEqual(session.updateConfigCalls, [{ language: "zh-CN" }]);
    assert.equal((await readConfig(configPath)).promptLanguage, "auto");
  });
});

test("A3: with no active session the write still lands on disk with updatedSessionCount 0", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    await writeConfig(configPath, { ui: { locale: "en-US" } });

    const result = await updatePromptLanguage(contextWith(), updateParams("zh-CN"), {
      configPath,
      env: {},
      intlLocale: "en-US",
    });

    assert.equal(result.updatedSessionCount, 0);
    const onDisk = await readConfig(configPath);
    assert.equal(onDisk.promptLanguage, "zh-CN");
    assert.deepEqual(onDisk.ui, { locale: "en-US" });
  });
});

// ── C: read 的读取顺序 ───────────────────────────────────────────────────────

test("C1: read prefers the ConfigPort of a resident session over the file", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    await writeConfig(configPath, { promptLanguage: "en-US" });
    const session = sessionRecord();
    session.configPort.set(ConfigKey.PromptLanguage, "zh-CN");

    const result = await readPromptLanguage(contextWith(session.record), readParams(), {
      configPath,
    });

    assert.deepEqual(zcodeWorkspaceReadPromptLanguageResultSchema.parse(result), result);
    assert.equal(result.promptLanguage, "zh-CN");
    assert.equal(result.path, configPath);
    assert.equal(result.supported, true);
    assert.deepEqual(result.workspace, WORKSPACE);
  });
});

test("C2: without a session read goes to the file; missing/corrupt values fall back to auto", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");

    await writeConfig(configPath, { promptLanguage: "en-US" });
    assert.equal(
      (await readPromptLanguage(contextWith(), readParams(), { configPath })).promptLanguage,
      "en-US",
    );

    // 文件里没有该键（缺省态）：回落 auto。
    await writeConfig(configPath, { ui: { locale: "zh-CN" } });
    const absent = await readPromptLanguage(contextWith(), readParams(), { configPath });
    assert.equal(absent.promptLanguage, "auto");
    assert.equal(absent.supported, true);
    assert.equal(absent.path, configPath);

    // 文件损坏：设置页永远拿到可渲染值。
    await writeFile(configPath, '{"promptLanguage":', "utf-8");
    assert.equal(
      (await readPromptLanguage(contextWith(), readParams(), { configPath })).promptLanguage,
      "auto",
    );

    // 文件不存在同样回落 auto。
    await rm(configPath, { force: true });
    assert.equal(
      (await readPromptLanguage(contextWith(), readParams(), { configPath })).promptLanguage,
      "auto",
    );
  });
});

// ── D: PL-B-1 auto 探测与冷/热同源 ───────────────────────────────────────────

test("D1: shared resolver applies explicit passthrough and env → Intl detection order", () => {
  // 显式值透传，不受探测影响。
  assert.equal(resolvePromptLanguage("zh-CN", { env: { LANG: "en_US.UTF-8" } }), "zh-CN");
  assert.equal(resolvePromptLanguage("en-US", { env: { LANG: "zh_CN.UTF-8" } }), "en-US");
  assert.equal(resolvePromptLanguage(undefined, { env: { LANG: "zh_CN.UTF-8" } }), "zh-CN");

  // auto：env 优先于注入的 Intl。
  assert.equal(
    resolvePromptLanguage("auto", { env: { LANG: "zh_CN.UTF-8" }, intlLocale: "en-US" }),
    "zh-CN",
  );
  // auto + env 空：注入的 Intl 生效。
  assert.equal(resolvePromptLanguage("auto", { env: {}, intlLocale: "zh-CN" }), "zh-CN");
  assert.equal(resolvePromptLanguage("auto", { env: {}, intlLocale: "en-US" }), "en-US");
  // POSIX 风格标签（含编码修饰）同样归一。
  assert.equal(
    resolvePromptLanguage("auto", { env: { LC_ALL: "zh_CN.UTF-8", LANG: "C" } }),
    "zh-CN",
  );
  // 非语言 locale（C/POSIX）被 i18n 归一器拒绝。
  assert.equal(resolvePromptLanguage("auto", { env: { LANG: "C" }, intlLocale: "en-US" }), "en-US");
});

test("D2: update handler resolves auto with env then Intl, matching the cold-start path", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    const session = sessionRecord();
    const context = contextWith(session.record);
    const effective = () => session.updateConfigCalls.at(-1)?.language;

    // auto + LANG=zh_CN.UTF-8（Intl 注入为 en-US 也不该赢）→ zh-CN。
    await updatePromptLanguage(context, updateParams("auto"), {
      configPath,
      env: { LANG: "zh_CN.UTF-8" },
      intlLocale: "en-US",
    });
    assert.equal(effective(), "zh-CN");

    // auto + env 空 + Intl zh-CN → zh-CN。
    await updatePromptLanguage(context, updateParams("auto"), {
      configPath,
      env: {},
      intlLocale: "zh-CN",
    });
    assert.equal(effective(), "zh-CN");

    // auto + env 空 + Intl en-US → en-US。
    await updatePromptLanguage(context, updateParams("auto"), {
      configPath,
      env: {},
      intlLocale: "en-US",
    });
    assert.equal(effective(), "en-US");

    // 显式值透传。
    await updatePromptLanguage(context, updateParams("zh-CN"), {
      configPath,
      env: {},
      intlLocale: "en-US",
    });
    assert.equal(effective(), "zh-CN");
    await updatePromptLanguage(context, updateParams("en-US"), {
      configPath,
      env: { LANG: "zh_CN.UTF-8" },
      intlLocale: "zh-CN",
    });
    assert.equal(effective(), "en-US");
  });
});

test("D3: cold assembly and hot handler agree for the same (env, intl) input", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "config.json");
    const session = sessionRecord();
    const context = contextWith(session.record);
    const effective = () => session.updateConfigCalls.at(-1)?.language;

    // ① env 有值时：冷（resolveEffectiveLocale）与热（update handler）都取 env。
    for (const env of [
      { LANG: "zh_CN.UTF-8" },
      { LANG: "en_US.UTF-8" },
      { LC_ALL: "zh_CN.UTF-8" },
    ]) {
      const cold = resolveEffectiveLocale("auto", { env });
      await updatePromptLanguage(context, updateParams("auto"), { configPath, env });
      assert.equal(effective(), cold, `hot/cold mismatch for ${JSON.stringify(env)}`);
    }

    // ② env 空：两边都回落到同一进程 Intl 探测（热路径不注入 intlLocale）。
    const realIntl = resolveIntlLocale();
    const cold = resolveEffectiveLocale("auto", { env: {} });
    await updatePromptLanguage(context, updateParams("auto"), { configPath, env: {} });
    assert.equal(effective(), cold, `hot/cold mismatch for real Intl ${String(realIntl)}`);

    // ③ 注入的 Intl 与冷启动宿主 uiDetectedLocale 是同一探测语义。
    const coldFromHost = resolveEffectiveLocale("auto", {
      env: {},
      uiDetectedLocale: "en-US",
    });
    await updatePromptLanguage(context, updateParams("auto"), {
      configPath,
      env: {},
      intlLocale: "en-US",
    });
    assert.equal(effective(), coldFromHost);
    assert.equal(coldFromHost, "en-US");
  });
});
