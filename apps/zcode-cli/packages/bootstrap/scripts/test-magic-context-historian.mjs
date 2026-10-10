#!/usr/bin/env node
/**
 * Step 24 装配单测（node:test，零新依赖）——D-6 historian 接线面。
 *
 * 覆盖本步交付的**接线判断**，而不是 historian 本身的行为（后者属 E2E，T-M6）：
 *
 *   1. `historian.model` 配了且此刻造得出 Model → 装 executor、`historianRunnable: true`、
 *      后台调度器在场，`/ctx-recomp` 的 runner 也注册上了。
 *   2. FORK（impl-historian-inherit）三态：字段缺失 / `"inherit"` → 无条件装
 *      executor（缺省继承会话模型，装配期还没有 turn 可绑），哨兵字面量**不过**
 *      包边界；live 绑定（`noteLiveModel`）之后模型入口切到绑定 key，窗口与
 *      输出上限惰性刷新；`""` → 不装（显式关闭）。
 *   3. 模型配了但宿主造不出来（provider/model 已下线）→ 不装、不抛、记诊断。
 *   4. sidecarModelCall 的映射：两段消息（system + user）、usage/finishReason 透传，
 *      以及那条**编译期字面量之外**的运行期事实——`preserveProviderStreamBoundaries`
 *      真的以 `true` 抵达 provider 适配层（旁路原语把它放进 model invocation context）。
 *   5. 模型缺席时 sidecar 抛 `model_config_missing`，于是 executor 把它分类成
 *      **终态** refusal 而不是可重试的传输失败。
 *
 * 真实 `createHistorianScheduler` 的合并/drain 语义在
 * `magic-context/scripts/test-historian.mjs`（16 项）里；这里只断言它在不在场。
 *
 * 与同目录的 `test-magic-context-turn-transform.mjs` 共用同一个 resolve 钩子：
 * `@zcode/shared` / `@zcode/model-option-map` 的包入口发布的是原始 TypeScript，裸
 * `node` 既无法把内部 `.js` 说明符改指到 `.ts`，也会在 strip-only 模式下拒绝参数
 * 属性。钩子把这两个包改指到它们同布局的编译产物——不引入实验性 loader 标志、
 * 不桩任何被测代码。
 *
 * 依赖已构建的 `dist/`：`pnpm --filter @zcode/contracts build`、
 * `pnpm --filter @zcode/magic-context build`、`pnpm --filter @zcode/core build`、
 * `pnpm --filter @zcode/bootstrap build`。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const { DEFAULT_MAGIC_CONTEXT_CONFIG, MagicContextConfigSchema } =
  await import("@zcode/magic-context");
const { createMagicContextHistorianHost, createZCodeSidecarModelCall } = await import(
  new URL("../dist/app/magic-context-historian.js", import.meta.url).href
);

const SESSION_ID = "ses_test_mc_historian";

const NOOP_LOGGER = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
};

/** 收集 warn，供「装配不炸但记了诊断」这类断言使用。 */
function loggerWithWarnings() {
  const warnings = [];
  return {
    warnings,
    logger: {
      ...NOOP_LOGGER,
      warn(message, context) {
        warnings.push({ message, context });
      },
    },
  };
}

/**
 * 一个**真的能发请求**的假 Model：streamText 吐出最小可接受的事件序列，
 * 于是旁路原语 `runSidecarModelRequest` 的整条消费路径都被跑到了。
 *
 * `observedInvocation` 记录请求抵达时的 model invocation context —— 那正是
 * `preserveProviderStreamBoundaries` 在原语里的落点，也是 provider 适配层据以
 * 决定要不要发 `compact_stream_boundary` 的那一位。
 */
function fakeModel(observed, options = {}) {
  const model = {
    providerId: "zcode",
    modelId: options.modelId ?? "fake-model",
    displayName: options.modelId ?? "fake-model",
    properties: { contextWindow: options.contextWindow ?? 200_000 },
    optionSpecs: { maxOutputTokens: { max: 8_000 }, reasoningLevel: { values: [] } },
    options: {},
    bind() {
      return model;
    },
    async generateText() {
      throw new Error("the sidecar path must stream, not call generateText");
    },
    async *streamText(request) {
      observed.messages.push(request.messages);
      observed.abortSignals.push(request.abortSignal);
      observed.invocations.push(observed.currentInvocation?.() ?? null);
      yield { type: "start" };
      yield { type: "text_start", id: "b0" };
      yield { type: "text_delta", id: "b0", text: options.reply ?? "SUMMARY" };
      yield { type: "text_end", id: "b0" };
      yield {
        type: "finish",
        finishReason: options.finishReason ?? "stop",
        usage: options.usage ?? { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
      };
    },
  };
  return model;
}

function hostDeps(overrides = {}) {
  return {
    logger: NOOP_LOGGER,
    db: {},
    sessionId: SESSION_ID,
    workingDirectory: "D:/tmp/project",
    ...overrides,
  };
}

/** 一条 executor `open` 会接受的 run identity（与 `test-historian.mjs` 同款）。 */
function makeRun(overrides = {}) {
  return {
    agent: "historian",
    kind: "historian",
    system: "historian system prompt",
    model: "zcode/fake-model",
    timeoutMs: 5_000,
    title: "test run",
    directory: "D:/tmp/project",
    ...overrides,
  };
}

test("shutdown 后在飞的 sidecar 请求真的被 abort，且调度器变惰性（MF-03）", async () => {
  // 一个**永不自己结束**的模型：唯一的出路是 abortSignal。executor 自己的超时预算
  // 给了 60s，所以这里观察到的 abort 只可能来自宿主的关闭信号。
  const observed = { abortSignals: [] };
  const hangingModel = fakeModel(observed, { reply: "never used" });
  hangingModel.optionSpecs = { maxOutputTokens: { max: 8_000 }, reasoningLevel: { values: [] } };
  const originalStream = hangingModel.streamText;
  hangingModel.streamText = async function* (request) {
    observed.abortSignals.push(request.abortSignal);
    yield* [{ type: "start" }];
    await new Promise((_resolve, reject) => {
      request.abortSignal.addEventListener("abort", () => reject(new Error("aborted by host")), {
        once: true,
      });
    });
    void originalStream;
  };

  const host = createMagicContextHistorianHost(
    MagicContextConfigSchema.parse({ historian: { model: "zcode/fake-model" } }),
    hostDeps({ createSidecarModel: () => hangingModel }),
  );
  assert.ok(host.hiddenCompletionExecutor, "executor 必须在场");

  const handle = await host.hiddenCompletionExecutor.open(makeRun({ timeoutMs: 60_000 }));
  await host.hiddenCompletionExecutor.attempt(handle, makePrompt("p"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(observed.abortSignals.length, 1, "前置条件：请求已在飞");
  assert.equal(observed.abortSignals[0].aborted, false);

  host.shutdown();
  await assert.rejects(host.hiddenCompletionExecutor.collect(handle, 1), /aborted by host/);
  assert.equal(observed.abortSignals[0].aborted, true, "shutdown 必须 abort 在飞请求");
  await host.hiddenCompletionExecutor.close(handle, {
    promptSettled: false,
    privacySensitive: false,
    context: "test",
    log: () => {},
  });

  // 调度器也随之变惰性：关闭后的触发被记成 no-fire `shutdown`，而不是悄悄再排一次。
  host.historianScheduler.notifyTurnSuccess({ sessionId: SESSION_ID });
  assert.equal(host.historianScheduler.getLastNoFireCause(SESSION_ID), "shutdown");
  assert.equal(host.historianScheduler.hasPendingWork(), false);
  // 幂等：重复关闭不抛。
  host.shutdown();
});

function makePrompt(text) {
  return { path: { id: "prompt-1" }, body: { parts: [{ type: "text", text, synthetic: true }] } };
}

test("historian.model 缺省（inherit）：无条件装 executor、哨兵不过包边界、未绑定期无模型 key", () => {
  // FORK（impl-historian-inherit）：缺省 = 继承会话模型。装配期会话模型还没绑
  // （turn 未开始），所以 executor 必须装；而 "inherit"/live key 都不能以字面量
  // 形式出现在包侧入口上——`historianModel` 缺席，`getHistorianModel()` 也还是
  // undefined（等 noteLiveModel）。
  const host = createMagicContextHistorianHost(
    DEFAULT_MAGIC_CONTEXT_CONFIG,
    hostDeps({ createSidecarModel: () => assert.fail("缺省时不得按配置值去造模型") }),
  );
  assert.equal(host.historianRunnable, true);
  assert.ok(host.hiddenCompletionExecutor, "executor 必须被装上（inherit 无条件装）");
  assert.equal(host.historianModelMode, "inherit");
  assert.equal(host.historianModel, undefined, "配置哨兵不得透到包侧");
  assert.equal(host.getHistorianModel(), undefined, "未绑定期没有具体 key");
  assert.ok(host.historianScheduler, "后台调度器必须在场");
  // 未绑定期：保守窗口回退（128k）与缺省输出上限。
  assert.equal(host.getHistorianChunkTokens(), 32_000);
  assert.equal(host.historianMaxOutputTokens, 8_192);
  host.shutdown();
});

test("inherit：live 绑定后 runPass 的模型入口切到绑定模型（窗口与输出上限惰性刷新）", async () => {
  const observed = { messages: [], abortSignals: [], invocations: [] };
  const liveModel = fakeModel(observed, { modelId: "glm-5", contextWindow: 128_000 });
  liveModel.optionSpecs = { maxOutputTokens: { max: 4_096 }, reasoningLevel: { values: [] } };
  const requested = [];
  const host = createMagicContextHistorianHost(
    MagicContextConfigSchema.parse({ historian: { model: "inherit" } }),
    hostDeps({
      createSidecarModel: (id) => {
        requested.push(id);
        return id === "zcode/glm-5" ? liveModel : undefined;
      },
    }),
  );
  assert.equal(host.historianModelMode, "inherit");

  // 绑定前：只有显式模式才会在装配期调 createSidecarModel。
  assert.deepEqual(requested, []);

  // e2e/R-2 落的那条链：turn 开始即 noteLiveModel（onTurnStart，pass 之前）。
  host.noteLiveModel({
    providerId: "zcode",
    modelId: "glm-5",
    properties: { contextWindow: 128_000 },
  });
  assert.equal(host.getHistorianModel(), "zcode/glm-5", "runPass 的模型入口必须是绑定 key");
  // 惰性解析：chunk 预算按绑定模型的窗口走，输出上限按它声明的 max 夹紧。
  assert.equal(host.getHistorianChunkTokens(), 32_000);
  assert.equal(host.historianMaxOutputTokens, 4_096, "输出上限要按 live 模型的上限夹紧");

  // 端到端一半：这个 key 真的能造出 Model 并跑完一次旁路请求。
  const model = host.getHistorianModel();
  const handle = await host.hiddenCompletionExecutor.open(makeRun({ model }));
  await host.hiddenCompletionExecutor.attempt(handle, makePrompt("p"));
  const result = await host.hiddenCompletionExecutor.collect(handle, 1);
  assert.equal(result.text, "SUMMARY");
  // 两次造模型：noteLiveModel 的惰性解析 + sidecar 调用面现读 run.model。
  // 两次必须是同一个 live key——任何一次漂回配置值都说明哨兵漏过了边界。
  assert.ok(requested.length >= 2, `expected live-key lookups, got ${JSON.stringify(requested)}`);
  assert.ok(
    requested.every((id) => id === "zcode/glm-5"),
    `every lookup must use the bound key: ${JSON.stringify(requested)}`,
  );
  host.shutdown();
});

test("inherit：绑不到 Model 时退回保守回退而不是把窗口清零", () => {
  const host = createMagicContextHistorianHost(
    MagicContextConfigSchema.parse({ historian: { model: "inherit" } }),
    hostDeps({ createSidecarModel: () => undefined }),
  );
  host.noteLiveModel({
    providerId: "zcode",
    modelId: "gone",
    properties: { contextWindow: 64_000 },
  });
  // key 仍然记着（runPass 会把它交给包侧，由 sidecar 调用面报 unavailable），
  // 但 chunk 预算退回 128k 回退、输出上限退回缺省值——窗口变 0 会让 chunk 预算
  // 归零，比「偏保守」危险得多。
  assert.equal(host.getHistorianModel(), "zcode/gone");
  assert.equal(host.getHistorianChunkTokens(), 32_000);
  assert.equal(host.historianMaxOutputTokens, 8_192);
  host.shutdown();
});

test('historian.model 显式清空（""）：不装 executor、historianRunnable 为 false、装配不抛', () => {
  const host = createMagicContextHistorianHost(
    MagicContextConfigSchema.parse({ historian: { model: "" } }),
    hostDeps({ createSidecarModel: () => assert.fail("off 时不得去造模型") }),
  );
  assert.equal(host.historianRunnable, false);
  assert.equal(host.hiddenCompletionExecutor, undefined);
  assert.equal(host.historianScheduler, undefined);
  assert.equal(host.historianModelMode, "off");
  assert.equal(host.historianModel, undefined);
  assert.equal(host.getHistorianModel(), undefined);
  // off 是显式关闭，不是异常：bindLiveModel 照常被调用也不该改变任何状态。
  host.noteLiveModel({ providerId: "zcode", modelId: "glm-5", properties: { contextWindow: 1 } });
  assert.equal(host.getHistorianModel(), undefined);
  host.shutdown();
});

test("historian.model 配了且造得出 Model：装 executor、historianRunnable 为 true", () => {
  const observed = { messages: [], abortSignals: [], invocations: [] };
  const model = fakeModel(observed);
  const host = createMagicContextHistorianHost(
    MagicContextConfigSchema.parse({ historian: { model: "zcode/fake-model" } }),
    hostDeps({ createSidecarModel: (id) => (id === "zcode/fake-model" ? model : undefined) }),
  );

  assert.equal(host.historianRunnable, true);
  assert.ok(host.hiddenCompletionExecutor, "executor 必须被装上");
  assert.equal(host.historianModelMode, "explicit");
  assert.equal(host.historianModel, "zcode/fake-model");
  assert.equal(host.getHistorianModel(), "zcode/fake-model");
  assert.ok(host.historianScheduler, "后台调度器必须在场");
  // chunk 预算按 historian 自己的窗口推导（200k × 25%），不是主模型的窗口。
  assert.equal(host.getHistorianChunkTokens(), 50_000);
  // 显式模式不读 live 绑定：noteLiveModel 只刷主模型窗口，模型入口原地不动。
  host.noteLiveModel({ providerId: "other", modelId: "x", properties: { contextWindow: 999 } });
  assert.equal(host.getHistorianModel(), "zcode/fake-model");
  host.shutdown();
});

test('inherit 缺省配置同样装 executor：与显式写 "inherit" 逐位等价', () => {
  // 同一条装配路径的两种写法：schema 里字段缺失与显式哨兵必须落到同一状态，
  // 否则「用户从没配过」和「用户显式选了继承」会分叉。
  const viaMissing = createMagicContextHistorianHost(
    DEFAULT_MAGIC_CONTEXT_CONFIG,
    hostDeps({ createSidecarModel: () => fakeModel({ messages: [], invocations: [] }) }),
  );
  const viaSentinel = createMagicContextHistorianHost(
    MagicContextConfigSchema.parse({ historian: { model: "inherit" } }),
    hostDeps({ createSidecarModel: () => fakeModel({ messages: [], invocations: [] }) }),
  );
  for (const host of [viaMissing, viaSentinel]) {
    assert.equal(host.historianRunnable, true);
    assert.equal(host.historianModelMode, "inherit");
    assert.equal(host.historianModel, undefined);
    assert.equal(host.getHistorianModel(), undefined);
    assert.equal(host.getHistorianChunkTokens(), 32_000);
    assert.equal(host.historianMaxOutputTokens, 8_192);
    host.shutdown();
  }
});

test("模型配了但宿主造不出来：不装、不抛、并记一条诊断", () => {
  const { warnings, logger } = loggerWithWarnings();
  const host = createMagicContextHistorianHost(
    MagicContextConfigSchema.parse({ historian: { model: "zcode/retired-model" } }),
    hostDeps({ logger, createSidecarModel: () => undefined }),
  );
  assert.equal(host.historianRunnable, false);
  assert.equal(host.hiddenCompletionExecutor, undefined);
  assert.ok(
    warnings.some((entry) => entry.context?.event === "magic_context.historian_model_unavailable"),
    `expected a diagnostic, got ${JSON.stringify(warnings)}`,
  );
  host.shutdown();
});

test("sidecarModelCall：两段消息（system + user）、usage 与 finishReason 透传", async () => {
  const observed = { messages: [], abortSignals: [], invocations: [] };
  const model = fakeModel(observed, {
    reply: "<compartments>…</compartments>",
    finishReason: "stop",
    usage: { inputTokens: 40, outputTokens: 9, totalTokens: 49 },
  });
  const call = createZCodeSidecarModelCall({
    logger: NOOP_LOGGER,
    createSidecarModel: () => model,
  });

  const controller = new AbortController();
  const result = await call(
    {
      run: makeRun(),
      prompt: "<new_messages>raw history</new_messages>",
      abortSignal: controller.signal,
    },
    { preserveProviderStreamBoundaries: true },
  );

  assert.equal(result.text, "<compartments>…</compartments>");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.lengthCapped, false);
  assert.equal(result.usage.totalTokens, 49);
  assert.equal(result.providerId, "zcode");
  assert.equal(result.modelId, "fake-model");

  assert.equal(observed.messages.length, 1);
  assert.deepEqual(
    observed.messages[0].map((message) => message.role),
    ["system", "user"],
  );
  assert.equal(observed.messages[0][0].content, "historian system prompt");
  assert.equal(observed.messages[0][1].content, "<new_messages>raw history</new_messages>");
  assert.equal(observed.abortSignals[0], controller.signal, "abortSignal 必须原样传到底层");
});

test("sidecarModelCall：以 true 把 preserveProviderStreamBoundaries 交到 provider 调用面", async () => {
  const { getCurrentModelInvocationContext } = await import("@zcode/contracts");
  const observed = {
    messages: [],
    abortSignals: [],
    invocations: [],
    currentInvocation: () => getCurrentModelInvocationContext(),
  };
  const model = fakeModel(observed);
  const call = createZCodeSidecarModelCall({
    logger: NOOP_LOGGER,
    createSidecarModel: () => model,
  });

  await call(
    { run: makeRun(), prompt: "p", abortSignal: new AbortController().signal },
    { preserveProviderStreamBoundaries: true },
  );

  const invocation = observed.invocations[0];
  assert.ok(invocation, "旁路原语必须在 model invocation context 里跑");
  // 这一位就是 provider 适配层决定发不发 `compact_stream_boundary` 的依据；
  // 缺席时 tool-call commit 判定会静默退化（S20 交接说明里的硬约束）。
  assert.equal(
    invocation.preserveProviderStreamBoundaries,
    true,
    "the stream-boundary flag must reach the model invocation context",
  );
  assert.equal(invocation.metadata?.event, "magic_context.historian_sidecar");
});

test("模型缺席：sidecar 抛 model_config_missing，被 executor 分类成终态 refusal", async () => {
  const call = createZCodeSidecarModelCall({
    logger: NOOP_LOGGER,
    createSidecarModel: () => undefined,
  });
  await assert.rejects(
    () =>
      call(
        { run: makeRun(), prompt: "p", abortSignal: new AbortController().signal },
        { preserveProviderStreamBoundaries: true },
      ),
    (error) => error?.code === "model_config_missing",
  );
});
