// DF-G-1（cr-fix-v1.0.1）：随包基线回落路径的常驻回归网。
// 运行：node --import tsx --test test/zcodeBuiltinFallback.test.ts（或包脚本 test:zcode-builtin-fallback）。
// 用例 ①②③ 覆盖 NodeZCodeBuiltinProviderConfigSource 的 bundledFallback 语义；
// 用例 ④⑤⑥⑦（CLI 入口准备）在 apps/zcode-cli/packages/cli/test/provider-runtime-env.test.ts。
// 全部读写都落在 os.tmpdir() 临时目录，绝不触碰真实 ~/.zcode / ~/.omz。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { z } from "zod";
import { NodeZCodeBuiltinProviderConfigSource } from "../src/index.js";

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
  return mkdtempSync(join(tmpdir(), "omz-builtin-source-"));
}

function writeJson(filePath: string, value: unknown): string {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
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

describe("NodeZCodeBuiltinProviderConfigSource bundledFallback", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("① bundled 旧 schema 失效 + fallback 有效：read() 成功并输出回落告警", async () => {
    const root = createTempRoot();
    tempRoots.push(root);
    const staleBundled = writeJson(join(root, "bundled-stale.json"), STALE_RELEASE);
    const fallback = writeJson(join(root, "bundled", "zcode-builtin.json"), VALID_BASELINE_RELEASE);
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: staleBundled,
      bundledFallbackFilePath: fallback,
      activeFilePath: join(root, "active", "zcode-builtin.json"),
      watch: false,
    });
    const warnings = captureWarnings();
    try {
      const snapshot = await source.read();
      assert.ok(
        snapshot.revision.startsWith("zcode-builtin:7:"),
        `应读取 fallback 的 revision=7，实际 ${snapshot.revision}`,
      );
      assert.ok(
        warnings.messages.some(
          (message) =>
            message.includes("[zcode-builtin]") &&
            message.includes("Bundled 基线不可用") &&
            message.includes(fallback),
        ),
        `缺少回落告警，实际输出：\n${warnings.messages.join("\n")}`,
      );
    } finally {
      warnings.restore();
      source.dispose();
    }
  });

  it("② bundled 失效 + fallback 缺失：抛原始 AggregateError，不二次包装", async () => {
    const root = createTempRoot();
    tempRoots.push(root);
    const staleBundled = writeJson(join(root, "bundled-stale.json"), STALE_RELEASE);
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: staleBundled,
      bundledFallbackFilePath: join(root, "missing", "zcode-builtin.json"),
      activeFilePath: join(root, "active", "zcode-builtin.json"),
      watch: false,
    });
    const warnings = captureWarnings();
    try {
      await assert.rejects(source.read(), (error: unknown) => {
        assert.ok(error instanceof AggregateError, `应为 AggregateError，实际 ${String(error)}`);
        assert.equal(error.message, "Bundled 与 Active ZCode Built-in Release 均不可用");
        assert.equal(error.errors.length, 1);
        assert.ok(
          error.errors[0] instanceof z.ZodError,
          `errors[0] 应为原始 ZodError，实际 ${String(error.errors[0])}`,
        );
        return true;
      });
    } finally {
      warnings.restore();
      source.dispose();
    }
  });

  it("③ active 有效：不触碰 fallback", async () => {
    const root = createTempRoot();
    tempRoots.push(root);
    const staleBundled = writeJson(join(root, "bundled-stale.json"), STALE_RELEASE);
    const active = writeJson(join(root, "active", "zcode-builtin.json"), {
      ...VALID_BASELINE_RELEASE,
      revision: 3,
    });
    // fallback 指向不存在的目录：若被读取会以 ENOENT 失败并吞掉 active 结果。
    const untouchedFallbackDir = join(root, "untouched", "nested");
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: staleBundled,
      bundledFallbackFilePath: join(untouchedFallbackDir, "zcode-builtin.json"),
      activeFilePath: active,
      watch: false,
    });
    const warnings = captureWarnings();
    try {
      const snapshot = await source.read();
      assert.ok(snapshot.revision.startsWith("zcode-builtin:3:"));
      assert.equal(
        warnings.messages.filter((message) => message.includes("Bundled 基线不可用")).length,
        0,
        "active 有效时不应触发 fallback 回落",
      );
      assert.equal(existsSync(untouchedFallbackDir), false);
    } finally {
      warnings.restore();
      source.dispose();
    }
  });
});
