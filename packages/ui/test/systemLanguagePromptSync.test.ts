// FORK（system-language-unification）：界面语言 → 模型语言（agent 提示词语言）联动同步判据。
//
// 背景：v1.0.4 的「模型语言」设置行被推翻合并进「系统语言」（用户拍板：两者统一才方便
// 理解），config.json 的 promptLanguage 降级为内部实现细节。本测试盯住合并后仍然必须
// 成立的行为（spec：docs/iterations/oh-my-zcode-fork/features/system-language-unification/spec.md）：
//
//   - 无 workspace：协议读写定位不到本机控制面，静默跳过（不写、不抛）；
//   - 旧 CLI（services 层把 -32601 降级成 supported:false）：静默跳过；
//   - 值已是界面语言解析值：不写（幂等，避免每次语言操作都触发一次写盘+热更新）；
//   - 值为 auto / 旧手选值：写成具体 locale（否则「英文系统 + 中文界面」会让提示词落回英文）；
//   - 读或写失败：只经日志出口报出，绝不抛给调用方（界面语言保存是主路径，模型语言是从属细节）。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locale, ZCodePromptLanguage } from "@zcode/shared";
import {
  syncPromptLanguageWithInterfaceLocale,
  type PromptLanguageSyncLog,
  type PromptLanguageSyncPort,
} from "../src/lib/promptLanguageSync.js";

interface FakeAgentService extends PromptLanguageSyncPort {
  readCalls: number;
  updateCalls: number;
  writtenPromptLanguages: ZCodePromptLanguage[];
}

function createFakeAgentService(options: {
  current: ZCodePromptLanguage;
  supported?: boolean;
  readError?: Error;
  updateError?: Error;
}): FakeAgentService {
  const service: FakeAgentService = {
    readCalls: 0,
    updateCalls: 0,
    writtenPromptLanguages: [],
    async readPromptLanguage() {
      service.readCalls += 1;
      if (options.readError) throw options.readError;
      return {
        promptLanguage: options.current,
        supported: options.supported ?? true,
      };
    },
    async updatePromptLanguage(params) {
      service.updateCalls += 1;
      if (options.updateError) throw options.updateError;
      service.writtenPromptLanguages.push(params.promptLanguage);
      return {};
    },
  };
  return service;
}

function createLogCollector() {
  const entries: { level: "debug" | "warn"; message: string }[] = [];
  const log: PromptLanguageSyncLog = {
    debug: (message) => entries.push({ level: "debug", message }),
    warn: (message) => entries.push({ level: "warn", message }),
  };
  return { entries, log };
}

async function run(
  agentService: FakeAgentService,
  interfaceLocale: Locale,
  workspacePath: string | null | undefined,
  log: PromptLanguageSyncLog,
) {
  return await syncPromptLanguageWithInterfaceLocale({
    interfaceLocale,
    workspacePath,
    agentService,
    log,
  });
}

test("无 workspace：静默跳过，不读不写", async () => {
  const agentService = createFakeAgentService({ current: "auto" });
  const { entries, log } = createLogCollector();

  for (const workspacePath of [undefined, null, "", "   "]) {
    const outcome = await run(agentService, "zh-CN", workspacePath, log);
    assert.equal(outcome, "skipped-no-workspace");
  }

  assert.equal(agentService.readCalls, 0);
  assert.equal(agentService.updateCalls, 0);
  assert.ok(entries.some((entry) => entry.level === "debug"));
});

test("旧 CLI 降级（supported:false）：静默跳过，不写", async () => {
  const agentService = createFakeAgentService({ current: "auto", supported: false });
  const { entries, log } = createLogCollector();

  const outcome = await run(agentService, "zh-CN", "/repo", log);

  assert.equal(outcome, "skipped-unsupported");
  assert.equal(agentService.readCalls, 1);
  assert.equal(agentService.updateCalls, 0);
  assert.ok(entries.some((entry) => entry.level === "debug"));
});

test("值已是界面语言解析值：不写（幂等）", async () => {
  const agentService = createFakeAgentService({ current: "en-US" });
  const { log } = createLogCollector();

  const outcome = await run(agentService, "en-US", "/repo", log);

  assert.equal(outcome, "skipped-unchanged");
  assert.equal(agentService.readCalls, 1);
  assert.equal(agentService.updateCalls, 0);
});

test("值不一致（auto / 旧手选值）：写成界面语言的具体 locale", async () => {
  for (const current of ["auto", "en-US"] as const) {
    const agentService = createFakeAgentService({ current });
    const { log } = createLogCollector();

    const outcome = await run(agentService, "zh-CN", "/repo", log);

    assert.equal(outcome, "updated");
    assert.equal(agentService.updateCalls, 1);
    assert.deepEqual(agentService.writtenPromptLanguages, ["zh-CN"]);
  }
});

test("读取失败：只记日志不抛，且不写", async () => {
  const agentService = createFakeAgentService({
    current: "auto",
    readError: new Error("rpc down"),
  });
  const { entries, log } = createLogCollector();

  const outcome = await run(agentService, "zh-CN", "/repo", log);

  assert.equal(outcome, "failed");
  assert.equal(agentService.updateCalls, 0);
  assert.ok(entries.some((entry) => entry.level === "warn"));
});

test("写入失败：只记日志不抛（界面语言不因模型语言同步失败而回滚）", async () => {
  const agentService = createFakeAgentService({
    current: "auto",
    updateError: new Error("write failed"),
  });
  const { entries, log } = createLogCollector();

  const outcome = await run(agentService, "en-US", "/repo", log);

  assert.equal(outcome, "failed");
  assert.equal(agentService.updateCalls, 1);
  assert.ok(
    entries.some((entry) => entry.level === "warn" && entry.message.includes("写入模型语言失败")),
  );
});
