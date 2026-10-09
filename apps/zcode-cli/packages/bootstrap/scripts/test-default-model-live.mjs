#!/usr/bin/env node
/**
 * Step 10 / T-E3 —— ① agent 默认模型「同进程实时」的自动化验证。
 *
 * ============================================================================
 * 这一步要锁死的失效形态
 * ============================================================================
 *
 * `startProcessProviderRegistryRuntime` 原本在启动时 `await read()` 一次，把
 * defaultModelSelection 冻成静态快照交给所有消费面（协议层的 app options、装配期
 * 的初始选择解析、`setModel("main")` 的兜底）。桌面是**长驻进程**：用户在设置里
 * 改掉默认模型后，同进程内新建的会话仍解析到 startup 时的旧默认——「agent 默认
 * 模型切换不实时」。
 *
 * 修复闭环（spec ① 变更点 1f）：
 *   - process-provider-registry-runtime 订阅
 *     `NodeModelSelectionConfigRepository.onDidChange`，维护**同步缓存**
 *     （repository 只有 async read()，首读 await 后缓存、变更后台刷新），
 *     dispose 时退订；
 *   - 消费面全部转活读：runtime-config 的初始选择解析、create-app 的
 *     `resolveFallbackSelection` 与 session facade 注入、protocol entrypoint 的
 *     app options、session-facade `setModel("main")` 的兜底源。
 *
 * 产品语义（有意设计，不得「顺手修」）：**运行中会话粘住自己选过的模型**
 * （`turn.ts:97-100`）。因此本文件断言的是「新会话跟随新默认」+「已绑定会话的
 * 选择不被追溯改写」，而不是「运行中会话被切换模型」。
 *
 * 四组断言：
 *   A runtime 层：onDidChange 驱动同步缓存跟随（外部改文件的 poll-changed 路径 +
 *     同进程 saveConfiguredDefault 的 updated 路径）。
 *   B 装配层：`resolveAppRuntimeConfig` 的初始选择解析活读——同进程改默认后
 *     新解析拿到新值，此前已解析出的会话选择对象不被改写；只传静态字段的
 *     旧装配（CLI 每 prompt 一进程）保持原语义。
 *   C facade 层：`setModel("main")` 的兜底源活读默认模型。
 *   D 生命周期：dispose 退订后同步缓存不再被外部变更刷新。
 *
 * 隔离：全部读写落在 `os.tmpdir()` 临时目录，Personal/Built-in 配置文件路径经
 * env 显式注入，**绝不触碰用户真实 ~/.omz / ~/.zcode**。
 *
 * 运行方式：`npx tsx --test scripts/test-default-model-live.mjs`（与
 * test-edit-retry-model 同源：tsx 直接吃 src，免去先 build bootstrap 的前置；
 * `@zcode/provider-node` / `@zcode/provider` / `@zcode/shared` 的 exports 指向
 * 原始 TypeScript，裸 node 加载不了）。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { startProcessProviderRegistryRuntime } = await import(
  new URL("../src/app/process-provider-registry-runtime.ts", import.meta.url).href
);
const { resolveAppRuntimeConfig } = await import(
  new URL("../src/app/runtime-config.ts", import.meta.url).href
);
const { createSessionFacade } = await import(
  new URL("../src/app/session-facade.ts", import.meta.url).href
);
const { createConfig } = await import("@zcode/adapters/config");

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — Step 10 agent default model live (T-E3)"
      : `TEST FAIL — Step 10 agent default model live (exit code ${code})`,
  );
});

// ── 夹具：临时目录里的 Personal/Built-in Provider 配置 ───────────────────────

const PROVIDER_ID = "te3-personal";
const MODEL_INITIAL = "model-initial";
const MODEL_UPDATED = "model-updated";
const REASONING_LEVEL = "high";
const SESSION_ID = "ses_te3";

/** 当前解码器接受的最小 Built-in Release（空规则集合合法）。 */
const MINIMAL_BUILTIN_RELEASE = Object.freeze({
  schemaVersion: 1,
  revision: 1,
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
});

/** Registry 要求 Model 配置「完整」才算可执行；这里给一份最小完整形状。 */
function createModelConfig() {
  return Object.freeze({
    enabled: true,
    properties: Object.freeze({
      requiresMfjsToolSchema: false,
      contextWindow: 8192,
      inputFormat: Object.freeze({
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      }),
      outputFormat: Object.freeze({ supportsText: true }),
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    }),
    optionSpecs: Object.freeze({
      // restricted-CEL 表达式：标识符即档位名，求值结果必须是 JSON 对象。
      reasoningLevel: Object.freeze({
        values: Object.freeze(["low", "high"]),
        map: '{"reasoning":{"effort":reasoningLevel}}',
      }),
      maxOutputTokens: Object.freeze({
        max: 4096,
        map: '{"maxTokens":maxOutputTokens}',
      }),
    }),
  });
}

/** Personal Provider 规则：Registry 还要求 access/api/group 完整，否则整条 provider 不可见。 */
function createProviderRule() {
  return Object.freeze({
    providerId: PROVIDER_ID,
    providerName: "T-E3 Personal Provider",
    enabled: true,
    config: Object.freeze({
      group: "standard-personal",
      access: Object.freeze({ type: "api-key", apiKey: "te3-only-key" }),
      api: Object.freeze({ type: "anthropic-messages", baseUrl: "https://te3.invalid/v1" }),
      personalModelIds: Object.freeze([MODEL_INITIAL, MODEL_UPDATED]),
      visibility: "visible",
    }),
  });
}

function createPersonalConfigFile(defaultModelSelection) {
  return Object.freeze({
    schemaVersion: 1,
    config: Object.freeze({
      providerConfigRules: Object.freeze({ providerRules: Object.freeze([createProviderRule()]) }),
      modelConfigRules: Object.freeze({
        providerModelRules: Object.freeze([
          Object.freeze({
            providerId: PROVIDER_ID,
            modelId: MODEL_INITIAL,
            config: createModelConfig(),
          }),
          Object.freeze({
            providerId: PROVIDER_ID,
            modelId: MODEL_UPDATED,
            config: createModelConfig(),
          }),
        ]),
        manualProviderModelRules: Object.freeze([]),
      }),
      ...(defaultModelSelection ? { defaultModelSelection } : {}),
    }),
  });
}

function selectionOf(modelId) {
  return Object.freeze({
    providerId: PROVIDER_ID,
    modelId,
    options: Object.freeze({ reasoningLevel: REASONING_LEVEL }),
  });
}

const INITIAL_SELECTION = selectionOf(MODEL_INITIAL);
const UPDATED_SELECTION = selectionOf(MODEL_UPDATED);

/** 原子写：personal repository 的轮询在锁外观察文件，绝不能看到写一半的 JSON。 */
function writeJsonAtomically(filePath, value) {
  const staging = `${filePath}.staging`;
  writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(staging, filePath);
}

/** 模拟「另一个写方」（设置页/另一进程）改默认模型：只改文件、不经本进程 repository。 */
function writePersonalConfigExternally(defaultModelSelection) {
  const current = JSON.parse(readFileSync(personalFilePath, "utf8"));
  writeJsonAtomically(personalFilePath, {
    ...current,
    config: { ...current.config, defaultModelSelection },
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ── 进程级夹具 ───────────────────────────────────────────────────────────────

const tempRoot = mkdtempSync(join(tmpdir(), "omz-default-model-live-"));
const providerDir = join(tempRoot, "provider");
const builtinFilePath = join(providerDir, "zcode-builtin.json");
const personalFilePath = join(providerDir, "provider_config.json");
const workspaceDir = join(tempRoot, "workspace");
const cliStorageRoot = join(tempRoot, "storage");
const env = {
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinFilePath,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalFilePath,
};

mkdirSync(providerDir, { recursive: true });
mkdirSync(workspaceDir, { recursive: true });
mkdirSync(cliStorageRoot, { recursive: true });
writeFileSync(builtinFilePath, `${JSON.stringify(MINIMAL_BUILTIN_RELEASE, null, 2)}\n`, "utf8");
// 首次写入的形状无所谓：repository 首次 read 会把它规范化成同一种编码形态。
writeFileSync(
  personalFilePath,
  `${JSON.stringify(createPersonalConfigFile(INITIAL_SELECTION), null, 2)}\n`,
  "utf8",
);

let sharedRuntime;

test.before(async () => {
  sharedRuntime = await startProcessProviderRegistryRuntime(env);
});

test.after(() => {
  sharedRuntime?.dispose();
  rmSync(tempRoot, { recursive: true, force: true });
});

// ── A: runtime 层——同步缓存跟随 onDidChange ─────────────────────────────────

test("A1: 启动后静态快照与同步缓存一致，且 Registry 可见夹具 provider", () => {
  const runtime = sharedRuntime;
  assert.ok(
    runtime.runtime.registryService
      .getView()
      .providers.some((provider) => provider.providerId === PROVIDER_ID),
    "夹具 provider 必须进入 Registry 视图（否则后续断言没有意义）",
  );
  assert.deepEqual(runtime.configuredDefaultModelSelection, INITIAL_SELECTION);
  assert.deepEqual(runtime.getConfiguredDefaultModelSelection(), INITIAL_SELECTION);
});

test("A2: 外部改 Personal 配置 → onDidChange → 同步缓存跟随新默认", async () => {
  const runtime = sharedRuntime;
  writePersonalConfigExternally(UPDATED_SELECTION);
  // repository 通过轮询（默认 1s）发现文件版本变化并发布 poll-changed；
  // 我们的订阅收到通知后**异步**刷新同步缓存，这里等缓存落地。
  await waitFor(
    () => runtime.getConfiguredDefaultModelSelection()?.modelId === MODEL_UPDATED,
    15_000,
    "poll-changed 之后同步缓存应更新为新默认",
  );
  assert.deepEqual(runtime.getConfiguredDefaultModelSelection(), UPDATED_SELECTION);
});

test("A3: 同进程 saveConfiguredDefault → onDidChange(updated) → 同步缓存跟随", async () => {
  const runtime = sharedRuntime;
  await runtime.modelSelectionConfigRepository.saveConfiguredDefault(INITIAL_SELECTION);
  await waitFor(
    () => runtime.getConfiguredDefaultModelSelection()?.modelId === MODEL_INITIAL,
    5_000,
    "updated 通知之后同步缓存应回到旧默认",
  );
  assert.deepEqual(runtime.getConfiguredDefaultModelSelection(), INITIAL_SELECTION);
});

// ── B: 装配层——新会话初始选择活读 ───────────────────────────────────────────

/** config 装配只做只读合并；传无副作用 logger 避免任何诊断日志落到真实 ~/.omz。 */
const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return silentLogger;
  },
};
const configResult = createConfig({
  skipUserConfig: true,
  env,
  workingDirectory: workspaceDir,
  loggerFactory: {
    createLogger: () => silentLogger,
    withContext: () => silentLogger,
    setLevel() {},
  },
});

function resolveInitialModelSelection(options) {
  const { runtimeConfig } = resolveAppRuntimeConfig({
    cliStorageRoot,
    configResult,
    options: { ...options, env },
    subagentOutputRootDir: join(cliStorageRoot, "subagents"),
    workingDirectory: workspaceDir,
  });
  return runtimeConfig.modelSelection;
}

test("B1: 活读取入下，初始选择解析到当前默认模型", () => {
  const runtime = sharedRuntime;
  const selection = resolveInitialModelSelection({
    providerRegistry: runtime.runtime.registryService,
    resolveConfiguredDefaultModelSelection: () => runtime.getConfiguredDefaultModelSelection(),
  });
  assert.ok(selection, "夹具默认模型必须可解析（Registry 里要看得见）");
  assert.equal(`${selection.providerId}/${selection.modelId}`, `${PROVIDER_ID}/${MODEL_INITIAL}`);
});

test("B2: 同进程改默认后，新解析拿到新默认；已解析出的会话选择不被追溯改写", async () => {
  const runtime = sharedRuntime;
  const liveOptions = {
    providerRegistry: runtime.runtime.registryService,
    resolveConfiguredDefaultModelSelection: () => runtime.getConfiguredDefaultModelSelection(),
  };
  // 「运行中会话」：它绑定的选择是装配期解析出来的冻结值。
  const runningSessionSelection = resolveInitialModelSelection(liveOptions);
  assert.equal(runningSessionSelection?.modelId, MODEL_INITIAL);

  writePersonalConfigExternally(UPDATED_SELECTION);
  await waitFor(
    () => runtime.getConfiguredDefaultModelSelection()?.modelId === MODEL_UPDATED,
    15_000,
    "同步缓存应跟随新默认",
  );

  const newSessionSelection = resolveInitialModelSelection(liveOptions);
  assert.equal(newSessionSelection?.modelId, MODEL_UPDATED, "新会话初始选择必须跟随新默认");
  // 运行中会话粘住自己的选择（有意设计）：此前解析出的值不被追溯改写。
  assert.equal(runningSessionSelection?.modelId, MODEL_INITIAL);
});

test("B3: 只传静态字段的旧装配（CLI 每 prompt 一进程）保持原语义", () => {
  const runtime = sharedRuntime;
  const frozenDefault = runtime.getConfiguredDefaultModelSelection();
  assert.equal(frozenDefault?.modelId, MODEL_UPDATED, "前置条件：当前默认已是新模型");
  const selection = resolveInitialModelSelection({
    providerRegistry: runtime.runtime.registryService,
    // 没有 accessor：值就是这一次读到的静态快照。
    configuredDefaultModelSelection: INITIAL_SELECTION,
  });
  assert.equal(
    selection?.modelId,
    MODEL_INITIAL,
    "无 accessor 时必须回落静态字段（CLI 旧路径语义不变）",
  );
});

// ── C: facade 层——setModel("main") 兜底源活读 ──────────────────────────────

function createFacadeHarness() {
  const state = { selection: undefined };
  const logger = { ...silentLogger };
  const deps = {
    configResult,
    configuredMcpServers: {},
    executionPort: { close: () => {} },
    logger,
    loggerFactory: () => logger,
    ownsExecutionPort: false,
    ownsMcpPort: false,
    ownsSessionStore: false,
    prepareUserExecutionBoundary: async () => {},
    prepareResume: async () => {},
    projectID: "prj_te3",
    providerRegistry: sharedRuntime.runtime.registryService,
    resolveConfiguredDefaultModelSelection: () =>
      sharedRuntime.getConfiguredDefaultModelSelection(),
    resolveUiLocale: (locale) => locale,
    runtime: {
      getMode: () => "build",
      getSessionModelSelection: () => state.selection,
      setSessionModelSelection: (selection) => {
        state.selection = selection;
      },
    },
    sessionId: SESSION_ID,
    sessionStore: { saveSessionEntry: async () => {} },
    traceContext: { traceId: "trace-te3", sessionId: SESSION_ID },
    workingDirectory: workspaceDir,
  };
  return { deps, state };
}

test('C1: setModel("main") 的兜底源跟随默认模型变更', async () => {
  const runtime = sharedRuntime;
  const { deps } = createFacadeHarness();
  const facade = createSessionFacade(deps);

  writePersonalConfigExternally(INITIAL_SELECTION);
  await waitFor(
    () => runtime.getConfiguredDefaultModelSelection()?.modelId === MODEL_INITIAL,
    15_000,
    "同步缓存应回到旧默认",
  );
  const first = await facade.setModel("main", { transient: true });
  assert.equal(first.model, `${PROVIDER_ID}/${MODEL_INITIAL}`);

  writePersonalConfigExternally(UPDATED_SELECTION);
  await waitFor(
    () => runtime.getConfiguredDefaultModelSelection()?.modelId === MODEL_UPDATED,
    15_000,
    "同步缓存应跟随新默认",
  );
  const second = await facade.setModel("main", { transient: true });
  assert.equal(second.model, `${PROVIDER_ID}/${MODEL_UPDATED}`, "兜底解析必须活读默认模型");
  // 第一次解析出的会话选择不受第二次解析影响（粘住语义）。
  assert.equal(first.model, `${PROVIDER_ID}/${MODEL_INITIAL}`);
});

// ── D: 生命周期——dispose 退订 ──────────────────────────────────────────────

test("D1: dispose 退订后同步缓存不再被外部变更刷新", async () => {
  const own = await startProcessProviderRegistryRuntime(env);
  try {
    const before = own.getConfiguredDefaultModelSelection();
    assert.deepEqual(before, UPDATED_SELECTION, "前置条件：磁盘默认已是新模型");

    own.dispose();
    // dispose 之后：退订 + repository dispose（轮询停止、监听清空）。
    writePersonalConfigExternally(INITIAL_SELECTION);
    // 给足一个轮询周期，确认没有任何后台刷新把新值写进缓存。
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.deepEqual(own.getConfiguredDefaultModelSelection(), before);
    // 已 dispose 的 repository 不能再被读（同步缓存是唯一幸存读者）。
    await assert.rejects(() => own.modelSelectionConfigRepository.read());
  } finally {
    // 断言失败也不能把第二个 runtime 的 fs watcher 留在进程里（测试进程会挂住）。
    own.dispose();
  }
});
