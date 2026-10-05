#!/usr/bin/env node
/**
 * FORK（cr-fix-spec v0.1.0 MF-05 / MF-11）——magic-context 生命周期收口单测。
 *
 * MF-05 的裁定是：装配层补上 **drain → shutdown → bridge.dispose** 的调用方，而
 * 挂载点是 `session-facade.ts` 的 `close()` 链——必须在 `closeDynamicWorkflowRuns`
 * 之前、`closeSessionResources` 之前。这三条顺序里每一条都对应一个具体故障，所以本
 * 文件逐条钉死：
 *
 *   1. **收口先于资源关闭**：historian 的在飞请求要写库；store / execution port 先关
 *      就等于把写库落到已关闭的端口上。
 *   2. **收口抛错不吃掉后续关闭**：一个卡住的 historian 关闭绝不能让会话的其余资源
 *      永远不关。
 *   3. **收口先于 dwf 引擎停止**：同一条链上的兄弟，二者互不依赖，顺序只保证两边
 *      都在资源关闭之前完成。
 *   4. **缺席即不做**：没装 magic-context 的装配（flag 关 / 测试装配）行为逐行不变。
 *
 * MF-11 则是 `publishUsageSummary` 的读失败路径：注释承诺「推 null 让面板收起」，
 * 代码却只有一个空 catch。这里断言它真的推 null，且 sink 自己抛错不会外泄。
 *
 * 依赖已构建的 `dist/`：`pnpm --filter @zcode/contracts build`、
 * `pnpm --filter @zcode/core build`、`pnpm --filter @zcode/bootstrap build`。
 * 与同目录其它脚本共用同一个 resolve 钩子（`@zcode/shared` / `@zcode/model-option-map`
 * 的包入口发布的是原始 TypeScript，裸 node 加载不了）。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const TS_SOURCE_PACKAGES = new Set([
  "@zcode/shared",
  "@zcode/model-option-map",
  // session-facade 在运行时 import `normalizeModelSelection`（`@zcode/provider`），
  // 而该包同样把 `exports["."]` 指向 `src/index.ts`。同一个手法，同样只改解析。
  "@zcode/provider",
]);

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

const { createSessionFacade } = await import(
  new URL("../dist/app/session-facade.js", import.meta.url).href
);
const { pushMagicContextUsageSummary } = await import(
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

/**
 * 一个只够跑 `close()` 的 session facade 装配。
 *
 * `close()` 之外的方法一个都不实现——facade 的构造只算一个 locale 与一个 registry
 * 闭包，其余都是懒的，所以桩到这种程度刚好够用。
 */
function facadeDeps(overrides = {}) {
  const order = [];
  const warnings = [];
  const logger = {
    ...NOOP_LOGGER,
    warn(message, context) {
      warnings.push({ message, context });
    },
  };
  const deps = {
    configResult: { config: { ui: { locale: undefined } } },
    configuredMcpServers: {},
    executionPort: { close: () => order.push("closeExecution") },
    logger,
    loggerFactory: () => logger,
    ownsExecutionPort: true,
    ownsMcpPort: false,
    ownsSessionStore: false,
    prepareUserExecutionBoundary: async () => {},
    prepareResume: async () => {},
    projectID: "prj_test",
    providerRegistry: { getProvider: () => undefined },
    resolveUiLocale: (locale) => locale,
    runtime: {
      beginShutdown: () => order.push("beginShutdown"),
      drainMemoryExtractions: async () => {
        order.push("drainMemoryExtractions");
      },
      closeBrowserSession: async () => {
        order.push("closeBrowserSession");
      },
      getMode: () => "build",
      getSessionModelSelection: () => undefined,
    },
    sessionId: "ses_lifecycle",
    sessionStore: {},
    traceContext: { traceId: "tr_test" },
    untrustedProjectMcpServers: new Set(),
    workingDirectory: "D:/tmp/project",
    ...overrides,
  };
  return { deps, order, warnings, logger };
}

test("MF-05：magic-context 的收口先于 store/execution 等资源关闭", async () => {
  const { deps, order } = facadeDeps({
    closeMagicContext: async () => {
      order.push("closeMagicContext");
    },
  });
  await createSessionFacade(deps).close();
  // 第二条 `beginShutdown` 来自 `closeSessionResources` 自己的幂等 begin——不在本
  // 条断言的射程内，只记在期望里免得读起来像重复调用。
  assert.deepEqual(order, [
    "beginShutdown",
    "drainMemoryExtractions",
    "closeMagicContext",
    "beginShutdown",
    "closeBrowserSession",
    "closeExecution",
  ]);
});

test("MF-05：收口排在 dwf 引擎停止之前，且两者都先于资源关闭", async () => {
  const { deps, order } = facadeDeps({
    closeDynamicWorkflowRuns: async () => {
      order.push("closeDynamicWorkflowRuns");
    },
    closeMagicContext: async () => {
      order.push("closeMagicContext");
    },
  });
  await createSessionFacade(deps).close();
  assert.deepEqual(order, [
    "beginShutdown",
    "drainMemoryExtractions",
    "closeMagicContext",
    "closeDynamicWorkflowRuns",
    "beginShutdown",
    "closeBrowserSession",
    "closeExecution",
  ]);
});

test("MF-05：收口抛错不吃掉后续的资源关闭，只记一条 warn", async () => {
  const { deps, order, warnings } = facadeDeps({
    closeMagicContext: async () => {
      order.push("closeMagicContext");
      throw new Error("drain blew up");
    },
    closeDynamicWorkflowRuns: async () => {
      order.push("closeDynamicWorkflowRuns");
    },
  });
  await createSessionFacade(deps).close();
  assert.deepEqual(order, [
    "beginShutdown",
    "drainMemoryExtractions",
    "closeMagicContext",
    "closeDynamicWorkflowRuns",
    "beginShutdown",
    "closeBrowserSession",
    "closeExecution",
  ]);
  assert.equal(warnings.length, 1, "只应记一条收口失败的诊断");
  assert.equal(warnings[0].context?.event, "magic_context.historian_close_failed");
  assert.equal(warnings[0].context?.errorMessage, "drain blew up");
});

test("MF-05：没装 magic-context 的装配行为逐行不变", async () => {
  const { deps, order, warnings } = facadeDeps();
  await createSessionFacade(deps).close();
  assert.deepEqual(order, [
    "beginShutdown",
    "drainMemoryExtractions",
    "beginShutdown",
    "closeBrowserSession",
    "closeExecution",
  ]);
  assert.equal(warnings.length, 0);
});

test("MF-05：close() 幂等，收口钩子只跑一次", async () => {
  let closes = 0;
  const { deps } = facadeDeps({
    closeMagicContext: async () => {
      closes += 1;
    },
  });
  const facade = createSessionFacade(deps);
  await facade.close();
  await facade.close();
  assert.equal(closes, 1);
});

test("MF-11：读不出来推 null（面板据此收起），而不是留着上一帧的读数", async () => {
  const seen = [];
  pushMagicContextUsageSummary(
    async () => {
      throw new Error("sqlite busy");
    },
    (usage) => seen.push(usage),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [null], "读失败必须推 null，而不是什么都不推");
});

test("MF-11：读成功推真实读数，且不改变 sink 的同步异常语义", async () => {
  const seen = [];
  const usage = { contextWindow: 200_000, historyBudgetTokens: 30_000 };
  pushMagicContextUsageSummary(
    async () => usage,
    (value) => seen.push(value),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [usage]);
});

test("MF-11：sink 自己抛错不会变成 unhandled rejection", async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    pushMagicContextUsageSummary(
      async () => {
        throw new Error("sqlite busy");
      },
      () => {
        throw new Error("projection is gone");
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});
