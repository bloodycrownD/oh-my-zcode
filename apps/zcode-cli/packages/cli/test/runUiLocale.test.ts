// T-L4（agent-lang-trace-usage-batch / Step 4，A7 接线）：app-server 冷启动把
// 子进程 env `ZCODE_UI_LOCALE` 转发为 `RunZCodeProtocolAgentOptions.uiDetectedLocale`。
// 运行：node --import tsx --test test/runUiLocale.test.ts（或包脚本 test:run-ui-locale）。
//
// 为什么必须独立断言：T-L1 只锁定消费端（runtime-config）的优先级，无法证明
// run.ts 的读取/转发接线存在。这里注入 deps.runZCodeProtocolAgent 捕获实际 options。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Logger } from "@zcode/contracts";
import { ZCODE_UI_LOCALE_ENV_KEY } from "@zcode/shared/runtime-env";
import type { RunContext } from "@zcode/shared-types";
import type { RunDependencies } from "../src/run.js";
import { run } from "../src/run.js";

/** 静默 Logger：run() 在未注入 logger 时会自建 JSONL 工厂，测试不需要它的输出。 */
const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omz-cli-ui-locale-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createContext(): RunContext {
  return {
    argv: ["app-server"],
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

/**
 * 走真实 `run()` 的 app-server 分发路径，捕获转发给 bootstrap 的 options。
 * `deps.env` 只给最小集合：绝不让宿主机真实 env（可能带 LANG/LOCALE）参与断言。
 */
async function captureProtocolOptions(
  env: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const captured: Array<Record<string, unknown>> = [];
  const deps: RunDependencies = {
    cwd: () => createTempDir(),
    env,
    logger: silentLogger,
    // 协议子进程的 .env 读取与断言无关；注入空结果避免触碰真实文件系统。
    loadDotenv: () => ({ keys: [], loaded: false }),
    runZCodeProtocolAgent: async (options) => {
      captured.push((options ?? {}) as Record<string, unknown>);
    },
  };

  const exitCode = await run(createContext(), deps);
  assert.equal(exitCode, 0, "app-server 分发路径应正常返回 0");
  assert.equal(captured.length, 1, "run() 必须恰好调用一次 runZCodeProtocolAgent");
  return captured[0]!;
}

describe("run() 转发宿主 UI 语言（A7）", () => {
  it("env 携带 ZCODE_UI_LOCALE 时以 uiDetectedLocale 原样转发", async () => {
    const options = await captureProtocolOptions({ [ZCODE_UI_LOCALE_ENV_KEY]: "zh-CN" });

    assert.equal(options.uiDetectedLocale, "zh-CN");
    // 载荷键本身仍随 env 交给 bootstrap（消费端只读 options，不要求删键）。
    assert.equal(
      (options.env as Record<string, string | undefined>)[ZCODE_UI_LOCALE_ENV_KEY],
      "zh-CN",
    );
  });

  it("env 缺失该键时 options 不含 uiDetectedLocale（不得传 null/undefined 覆盖）", async () => {
    const options = await captureProtocolOptions({ LANG: "en_US.UTF-8" });

    // 关键契约：runtime-config 用 `uiDetectedLocale !== undefined` 判定「宿主已探明」，
    // 键存在但为 undefined 与「无该键」在语义上都要保持「未探明」，因此断言键不存在。
    assert.equal("uiDetectedLocale" in options, false);
    assert.equal(options.uiDetectedLocale, undefined);
  });

  it("env 值为空白串时同样不传该键（非空才转发）", async () => {
    const options = await captureProtocolOptions({ [ZCODE_UI_LOCALE_ENV_KEY]: "   " });

    assert.equal("uiDetectedLocale" in options, false);
  });
});
