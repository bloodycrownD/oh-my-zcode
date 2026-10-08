// DF-G-1（cr-fix-v1.0.1）：CLI 随包基线解析与显式覆盖/成对探针的常驻回归网。
// 运行：node --import tsx --test test/provider-runtime-env.test.ts（或包脚本 test:provider-runtime-env）。
// 用例 ①②③ 在 packages/provider-node/test/zcodeBuiltinFallback.test.ts。
// 全部读写都落在 os.tmpdir() 临时目录（含 dataBaseDir），绝不触碰真实 ~/.zcode / ~/.omz。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import { prepareCliProviderRuntimeEnv } from "../src/provider-runtime-env.js";

/** 当前解码器接受的最小 Release；空规则集合合法（规则 schema 无最小条数约束）。 */
const VALID_BASELINE_RELEASE = {
  schemaVersion: 1,
  revision: 7,
  config: {
    providerConfigRules: { templateRules: [], providerRules: [] },
    modelConfigRules: {
      modelRules: [],
      modelApiRules: [],
      providerSiteRules: [],
      templateModelRules: [],
      builtinProviderModelRules: [],
    },
  },
};

/** 旧安装留下的 Release 形态：缺 schemaVersion/config 结构 → decodeZCodeBuiltinRelease 抛 ZodError。 */
const STALE_RELEASE = { version: 1, revision: 7, providers: {} };

function createTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "omz-cli-provider-env-"));
}

function writeText(filePath: string, content: string): string {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

function writeJson(filePath: string, value: unknown): string {
  return writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** 捕获 console.warn（写 stderr）用于断言回落告警；测试结束必须 restore。 */
function captureWarnings(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    messages.push(args.map((arg) => String(arg)).join(" "));
  };
  return {
    messages,
    restore: () => {
      console.warn = original;
    },
  };
}

describe("prepareCliProviderRuntimeEnv 随包基线解析", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("④ 主路径：显式值失效 + 基线可解析 → BUNDLED 指向真实基线", async () => {
    const root = createTempRoot();
    tempRoots.push(root);
    // CLI 打包布局：入口同级的 provider/zcode-builtin.json。
    const cliDist = join(root, "cli-dist");
    const entrypoint = writeText(join(cliDist, "zcode.cjs"), "");
    const baseline = writeJson(
      join(cliDist, "provider", "zcode-builtin.json"),
      VALID_BASELINE_RELEASE,
    );
    const staleExplicit = writeJson(join(root, "legacy", "zcode-builtin.json"), STALE_RELEASE);
    const dataBaseDir = join(root, "data");
    const warnings = captureWarnings();
    try {
      const env = await prepareCliProviderRuntimeEnv({
        argv: ["app-server", "--stdio"],
        env: { [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: staleExplicit },
        entrypoint,
        dataBaseDir,
        platform: "windows-x86_64",
        appVersion: "1.0.2-test",
      });
      assert.equal(env[ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV], baseline);
      assert.ok(
        env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.startsWith(join(dataBaseDir, ".omz", "v2")),
        `读取入口应落到 dataBaseDir 下的 Active 缓存，实际 ${env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]}`,
      );
      assert.ok(
        warnings.messages.some(
          (message) =>
            message.includes("[zcode-builtin]") && message.includes("Bundled 基线不可用"),
        ),
        `缺少回落告警，实际输出：\n${warnings.messages.join("\n")}`,
      );
    } finally {
      warnings.restore();
    }
  });

  it("⑤ 成对显式路径：可读原样透传；不可读落主路径且探针不创建目录", async () => {
    const root = createTempRoot();
    tempRoots.push(root);
    const readableExplicit = writeJson(join(root, "explicit-valid.json"), VALID_BASELINE_RELEASE);
    const personal = join(root, "personal-provider-config.json");
    const passthrough = await prepareCliProviderRuntimeEnv({
      argv: ["app-server"],
      env: {
        [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: readableExplicit,
        [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personal,
      },
      // 成对早退不解析入口；给一个不存在的路径以证明这一点。
      entrypoint: join(root, "unused-entry", "zcode.cjs"),
      dataBaseDir: join(root, "data-passthrough"),
    });
    assert.deepEqual(passthrough, {
      [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: readableExplicit,
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personal,
    });

    // 不可读（父目录不存在）：DF-C-1 的纯读取探针不得创建目录；随后落主路径。
    const cliDist = join(root, "cli-dist");
    const entrypoint = writeText(join(cliDist, "zcode.cjs"), "");
    const baseline = writeJson(
      join(cliDist, "provider", "zcode-builtin.json"),
      VALID_BASELINE_RELEASE,
    );
    const missingParentDir = join(root, "missing-dir");
    const missingExplicit = join(missingParentDir, "zcode-builtin.json");
    const dataBaseDir = join(root, "data-fallback");
    const warnings = captureWarnings();
    try {
      const fallback = await prepareCliProviderRuntimeEnv({
        argv: ["app-server"],
        env: {
          [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: missingExplicit,
          [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personal,
        },
        entrypoint,
        dataBaseDir,
        platform: "windows-x86_64",
        appVersion: "1.0.2-test",
      });
      assert.equal(existsSync(missingParentDir), false, "纯读取探针不得创建任何目录");
      assert.equal(fallback[ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV], baseline);
      assert.equal(fallback[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV], personal);
      assert.ok(
        fallback[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.startsWith(
          join(dataBaseDir, ".omz", "v2"),
        ),
      );
    } finally {
      warnings.restore();
    }
  });

  it("⑥ 基线不可解析 + 显式值有效：不新增失败，BUNDLED 保持显式值", async () => {
    const root = createTempRoot();
    tempRoots.push(root);
    const explicitValid = writeJson(join(root, "explicit-valid.json"), VALID_BASELINE_RELEASE);
    // 与任何随包布局都无关的入口目录。
    const isolatedEntrypoint = writeText(join(root, "isolated", "nested", "zcode.cjs"), "");
    const dataBaseDir = join(root, "data");
    const env = await prepareCliProviderRuntimeEnv({
      argv: ["app-server", "--stdio"],
      env: { [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: explicitValid },
      entrypoint: isolatedEntrypoint,
      dataBaseDir,
      platform: "windows-x86_64",
      appVersion: "1.0.2-test",
    });
    assert.equal(env[ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV], explicitValid);
    assert.equal(
      env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV],
      join(dataBaseDir, ".omz", "v2", PERSONAL_PROVIDER_CONFIG_FILE_NAME),
    );
  });

  it("⑦ 打包桌面布局（resources/glm → resources/config/provider）：stale 显式值不再整段退出", async () => {
    const root = createTempRoot();
    tempRoots.push(root);
    const resourcesDir = join(root, "resources");
    const entrypoint = writeText(join(resourcesDir, "glm", "zcode.cjs"), "");
    const baseline = writeJson(
      join(resourcesDir, "config", "provider", "zcode-builtin.json"),
      VALID_BASELINE_RELEASE,
    );
    const staleExplicit = writeJson(join(root, "legacy", "zcode-builtin.json"), STALE_RELEASE);
    const dataBaseDir = join(root, "data");
    const warnings = captureWarnings();
    try {
      const env = await prepareCliProviderRuntimeEnv({
        argv: ["app-server", "--stdio"],
        env: { [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: staleExplicit },
        entrypoint,
        dataBaseDir,
        platform: "darwin-arm64",
        appVersion: "1.0.2-test",
      });
      assert.equal(env[ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV], baseline);
      assert.ok(
        env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.startsWith(join(dataBaseDir, ".omz", "v2")),
      );
      assert.ok(
        warnings.messages.some(
          (message) =>
            message.includes("[zcode-builtin]") &&
            message.includes("Bundled 基线不可用") &&
            message.includes(baseline),
        ),
        `缺少回落告警，实际输出：\n${warnings.messages.join("\n")}`,
      );
    } finally {
      warnings.restore();
    }
  });
});
