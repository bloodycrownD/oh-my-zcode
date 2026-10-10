#!/usr/bin/env node
/**
 * bugfix-batch-20261011 / Step 3 — 长驻形态 settle 后台化（node:test，零新依赖）。
 *
 * 这一步钉死什么
 * ───────────────
 * spec `docs/iterations/bugfix-batch-20261011/spec.md` 缺陷①的**端口层**判据：
 * `processExitsAfterTurn === false`（app-server / TUI 长驻）时，两处 settle 都不阻塞
 * model step——
 *
 *   ① `settleInFlightHistorian`：一条**不会自己结束**的 compartment run 在场时，
 *      端口仍然立刻返回（顺序数组 + 计时双证据），而那条 run 此刻仍在飞——这正是
 *      「drain / active execution 不被 settle 拖住」的直接观察点（core 的
 *      `hasActiveOrQueuedTurnWork()` / idle-only promotion lease 语义因此当轮即可
 *      获得，但那是 core 侧的事，本文件不拉进来）。
 *   ② 端口钩子 `settleScheduledPass`：压根不被调用。`test-magic-context-turn-
 *      transform.mjs` 里按形态分化过的那组断言是桩驱动的一半，这里补上「真
 *      compartment run」这一半，并用**短驻对照组**证明「不等」有区分力。
 *   ③ 收口契约（MF-05）：长驻形态不再前台等 settle 之后，「折叠 pass 落库」靠 close
 *      钩子的 drain 兜底。这里用**真调度器**复刻装配处形态（`magic-context-turn-
 *      transform.ts` 的 `registerClose`：drain → shutdown → dispose），钉死 drain 会
 *      把在飞的那次 pass 等完再停机；再用真工厂 assert `registerClose` 钩子在长驻
 *      形态仍在场、且调用它能跑通整条链。
 *
 * 隔离声明
 * ────────
 * 绝不写真实 `~/.omz` / `~/.zcode`。本文件在 import 任何被测模块**之前**把
 * `MAGIC_CONTEXT_DB_DIR` / `MAGIC_CONTEXT_LOG_PATH` 指到 `os.tmpdir()` 下的一次性
 * 临时目录（`core/shared/data-path.ts` 的两个 getter 现读这两个 env，调用前设好即
 * 生效）。刻意不设 `NODE_ENV=test`：那条 backstop 是包内的兜底歧路，显式 env 更有
 * 区分力，也避免命中它的 memoized throwaway 目录。
 *
 * 真工厂那条用例会开一个 SQLite 句柄，而生产的 `closeMagicContext` 收口只做
 * drain → shutdown → dispose（**不**关库——关库是会话层的活，与 CLI 一进程一轮的
 * 既有语义一致）。Windows 上句柄在进程退出前不释放，退出时的目录删除因此是**尽力
 * 而为**：成功最好，失败也只留一个 tmpdir 下的小 sqlite 文件由 OS 回收，绝不把
 * 「用例全过」变成进程非零退出。
 *
 * dist 前置构建
 * ─────────────
 * `pnpm --filter @zcode/magic-context build`、`pnpm --filter @zcode/core build`、
 * `pnpm --filter @zcode/bootstrap build`。`@zcode/shared` 与 `@zcode/model-option-map`
 * 也必须有 dist：它们的包入口发布的是原始 TypeScript，裸 `node` 既无法把内部 `.js`
 * 说明符改指到 `.ts`，也会在 strip-only 模式下拒绝参数属性——下面的 resolve 钩子把
 * 这两个包改指到同布局的编译产物（与 `test-magic-context-turn-transform.mjs` 的
 * FORK（S23）说明同一手法，不引入实验性 loader 标志、不桩任何被测代码）。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── 隔离：必须先于任何被测模块的 import ────────────────────────────────────────
const TEST_HOME = mkdtempSync(join(tmpdir(), "zcode-settle-bg-"));
process.env.MAGIC_CONTEXT_DB_DIR = TEST_HOME;
process.env.MAGIC_CONTEXT_LOG_PATH = join(TEST_HOME, "magic-context.log");
process.on("exit", () => {
  // 尽力而为：真工厂那条用例会开一个 SQLite 句柄，而 `closeMagicContext` 的收口只做
  // drain → shutdown → dispose（**不**关库——关库是会话层的活）。Windows 上句柄在
  // 进程退出前不会释放，于是这里的删除可能 EPERM。清理失败绝不能把「用例全过」变成
  // 进程非零退出；残留目录由 OS 的临时目录策略回收，且它本来就在 tmpdir 下。
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* 见上：句柄未释放时的 Windows 既定行为 */
  }
});

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

const {
  DEFAULT_MAGIC_CONTEXT_CONFIG,
  createHistorianScheduler,
  drainHistorianSchedulerWithTimeout,
  getActiveCompartmentRun,
  registerActiveCompartmentRun,
} = await import("@zcode/magic-context");
const { createMagicContextTurnTransform, createZCodeMagicContextTurnTransformPort } = await import(
  new URL("../dist/app/magic-context-turn-transform.js", import.meta.url).href
);

const NOOP_LOGGER = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
};

/** 收集结构化日志，供「后台 settle 落定后有记账」这类断言使用。 */
function capturingLogger() {
  const entries = [];
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
      return logger;
    },
  };
  const note = (level) => (message, context) => {
    entries.push({ level, message, context });
  };
  logger.info = note("info");
  logger.debug = note("debug");
  logger.warn = note("warn");
  return { logger, entries };
}

/** 一条真实的 ZCode request entries：system → user → assistant(toolCall) → tool → user。 */
function sampleEntries() {
  return [
    { kind: "message", message: { role: "system", content: "you are zcode" } },
    {
      kind: "message",
      message: { role: "user", content: "first question" },
      metadata: { source: "real_user" },
    },
    {
      kind: "message",
      message: {
        role: "assistant",
        content: "let me read it",
        toolCalls: [{ id: "call_1", name: "read", input: { path: "a.ts" } }],
      },
    },
    {
      kind: "message",
      message: { role: "tool", content: "file body", toolCallId: "call_1", toolName: "read" },
    },
    {
      kind: "message",
      message: { role: "user", content: "second question" },
      metadata: { source: "real_user" },
    },
  ];
}

async function runPort(port, entries, sessionId) {
  return await port({
    entries,
    model: { providerId: "zcode", modelId: "glm-4.6", properties: { contextWindow: 128_000 } },
    sessionId,
    workingDirectory: TEST_HOME,
  });
}

/** 把微任务队列排干：`notifyTurnSuccess` 的 pass 是在微任务上起跑的。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ── ① + ②：长驻形态 model step 不等两处 settle ────────────────────────────────

test("长驻形态：model step 不等两处 settle，端口返回时在飞的 historian 仍在跑（T-S1）", async () => {
  const sessionId = "ses_settle_bg_turn";
  const order = [];
  let releaseRun = () => {};
  // 一条**不会自己结束**的 compartment run：短驻形态的 settleInFlightHistorian 在它
  // 身上最多等 60s。长驻形态必须不等它。
  registerActiveCompartmentRun(
    sessionId,
    new Promise((resolve) => {
      releaseRun = resolve;
    }),
    "incremental",
  );

  const { logger, entries } = capturingLogger();
  let settleFinished = false;
  const port = createZCodeMagicContextTurnTransformPort(
    async () => {
      order.push("transform");
    },
    {
      getConfig: () => DEFAULT_MAGIC_CONTEXT_CONFIG,
      options: { sessionId, logger, processExitsAfterTurn: false },
      onPassSucceeded: () => order.push("notify"),
      // 装配层仍会递这个钩子过来（「要不要等」是端口的决定）；长驻形态下它必须
      // 连调用都收不到。
      settleScheduledPass: async () => {
        order.push("settle:start");
        await new Promise((resolve) => setTimeout(resolve, 200));
        settleFinished = true;
        order.push("settle:end");
      },
    },
  );

  const startedAt = Date.now();
  const result = await runPort(port, sampleEntries(), sessionId);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.outcome, "unchanged");
  assert.deepEqual(order, ["transform", "notify"], "turn 内不得出现任何 settle 标记");
  assert.equal(settleFinished, false, "settleScheduledPass 钩子不得被调用，更谈不上等它");
  assert.ok(elapsedMs < 100, `turn 不得被 200ms 的 settle 拖住，实测 ${elapsedMs}ms`);

  // ②：端口返回的那一刻，historian 还在飞。core 的
  // `hasActiveOrQueuedTurnWork()` / idle-only promotion lease 之所以当轮即可获得，
  // 就是因为这一段不再被 settle 拉长——这里直接观察那个「还在飞」。
  assert.ok(
    getActiveCompartmentRun(sessionId) !== undefined,
    "端口返回时在飞的 compartment run 必须还在（drain/execution 不被拖住的直接证据）",
  );

  // 后台 promise 仍附着在那条 run 上：放行后它自己落定、注销并留下一条记账日志。
  releaseRun();
  await flush();
  await flush();
  assert.equal(
    getActiveCompartmentRun(sessionId),
    undefined,
    "后台 settle 必须等 run 落定，run 表随之清空",
  );
  assert.ok(
    entries.some((entry) => entry.context?.event === "magic_context.settle_background_settled"),
    `expected a background settle log, got ${JSON.stringify(entries)}`,
  );
});

test("短驻形态（对照组）：model step 确实等在飞的 compartment run 与 settle（T-S1 区分力）", async () => {
  const sessionId = "ses_settle_bg_control";
  const order = [];
  let releaseRun = () => {};
  registerActiveCompartmentRun(
    sessionId,
    new Promise((resolve) => {
      releaseRun = resolve;
    }),
    "incremental",
  );

  const port = createZCodeMagicContextTurnTransformPort(
    async () => {
      order.push("transform");
    },
    {
      getConfig: () => DEFAULT_MAGIC_CONTEXT_CONFIG,
      options: { sessionId, logger: NOOP_LOGGER, processExitsAfterTurn: true },
      onPassSucceeded: () => order.push("notify"),
      settleScheduledPass: async () => {
        order.push("settle:start");
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("settle:end");
      },
    },
  );

  // run 晚于端口调用之后落定——短驻形态必须一直在等它。
  setTimeout(() => releaseRun(), 30);
  const startedAt = Date.now();
  const result = await runPort(port, sampleEntries(), sessionId);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.outcome, "unchanged");
  assert.deepEqual(order, ["transform", "notify", "settle:start", "settle:end"]);
  assert.ok(elapsedMs >= 30, `短驻形态必须等在飞的 run，实测 ${elapsedMs}ms`);
  assert.equal(
    getActiveCompartmentRun(sessionId),
    undefined,
    "短驻 settle 等 run 落定之后才交还控制权",
  );
});

// ── ③：close()/registerClose 的 drain 收口仍把折叠 pass 落库 ───────────────────

test("MF-05 drain 收口：close 钩子把在飞的折叠 pass 等完再停机（T-S2 契约）", async () => {
  const sessionId = "ses_settle_bg_close";
  const events = [];
  let finishPass = () => {};
  // 真调度器：`runSession` 不自己结束，于是「在飞」是一个可观测的状态。
  const scheduler = createHistorianScheduler({
    runSession: async (sid) => {
      events.push(`pass:started:${sid}`);
      await new Promise((resolve) => {
        finishPass = resolve;
      });
      events.push(`pass:finished:${sid}`);
      return "success";
    },
    drainTimeoutMs: 5_000,
  });

  // 复刻装配处形态（`magic-context-turn-transform.ts` 的 `registerClose` 钩子）：
  // drain（有界）→ shutdown → dispose。长驻形态下 turn 不再 drain，于是「等它落定」
  // 只发生在这一处——这一步被删掉，后台化就等于把折叠丢在半路。
  const closeMagicContext = async () => {
    await drainHistorianSchedulerWithTimeout(scheduler, 60_000);
    scheduler.shutdown();
  };

  // turn 成功 → notifyTurnSuccess（fire-and-forget，宿主侧见 onPassSucceeded）。
  scheduler.notifyTurnSuccess({ sessionId });
  await flush();
  assert.deepEqual(events, [`pass:started:${sessionId}`], "notify 之后 pass 在后台起跑");
  assert.equal(scheduler.hasPendingWork(), true, "此刻 pass 在飞——长驻形态不等它");

  // close：drain 必须等它落定，然后 shutdown 让调度器惰性。
  const closing = closeMagicContext();
  assert.deepEqual(events, [`pass:started:${sessionId}`], "close 的 drain 只等待，不新起动作");
  finishPass();
  await closing;

  assert.deepEqual(
    events,
    [`pass:started:${sessionId}`, `pass:finished:${sessionId}`],
    "drain 收口把折叠 pass 跑完",
  );
  assert.equal(scheduler.hasPendingWork(), false);
  assert.equal(scheduler.getLastStatus(sessionId), "success", "折叠结果已落账");
  // 停机之后的触发被记成 no-fire shutdown，而不是悄悄再排一次。
  scheduler.notifyTurnSuccess({ sessionId });
  assert.equal(scheduler.getLastNoFireCause(sessionId), "shutdown");
});

test("长驻形态下 registerClose 钩子仍在场，且 close() 能跑通 drain→shutdown→dispose（MF-05）", async () => {
  const sessionId = "ses_settle_bg_register";
  const closeHooks = [];
  // 真工厂 + 真临时库：inherit 模式 + 一个造得出 Model 的 sidecar，于是 historian
  // executor、后台调度器与 registerClose 钩子都按生产形态装配。
  const port = await createMagicContextTurnTransform({
    enabled: true,
    // 无 configPort → 静态源（S19b 的降级路径），用缺省域值。
    configDomain: {},
    sessionId,
    workingDirectory: TEST_HOME,
    logger: NOOP_LOGGER,
    createSidecarModel: () => ({
      providerId: "zcode",
      modelId: "glm-4.6",
      displayName: "glm-4.6",
      properties: { contextWindow: 128_000 },
      optionSpecs: { maxOutputTokens: { max: 8_192 }, reasoningLevel: { values: [] } },
      options: {},
      bind() {
        return this;
      },
    }),
    registerClose: (close) => {
      closeHooks.push(close);
    },
    // 本批改动的形态位：长驻。
    processExitsAfterTurn: false,
  });
  assert.ok(port, "flag on 且库开得出来时必须拿到端口");

  // 驱动一次真 turn：投影 → transform → 反投影整圈跑通，且两处 settle 都不阻塞。
  const result = await runPort(port, sampleEntries(), sessionId);
  assert.ok(result.outcome === "applied" || result.outcome === "unchanged", result.outcome);

  assert.equal(closeHooks.length, 1, "长驻形态不得丢掉 MF-05 的关闭钩子");
  // 优雅关闭路径：drain（有界）→ shutdown → dispose bridge。
  await closeHooks[0]();
  assert.equal(
    closeHooks.length,
    1,
    "钩子只注册一次；再次调用它不应改变这一事实（幂等由 drain/shutdown 自己保证）",
  );
});
