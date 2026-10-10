#!/usr/bin/env node
/**
 * bugfix-batch-20261011 / Step 6（缺陷③，T-MU1/T-MU2 的 auto 部分）——
 * 子智能体模型 override「同会话内实时生效」（per-spawn 活读）。
 *
 * ============================================================================
 * 这一步钉死什么
 * ============================================================================
 *
 * 修复前的失效链：设置页（Local Host 进程）把内置子智能体模型 override 写进
 * `agents-state.json`，但 CLI 侧只在 **App 创建时**读一次
 * （`loadZCodeAgentProfiles` → `runtimeConfig.subagents` → core
 * `createDefaultSubagentPort` 的启动快照 → `createExploreSubagentPort` 构造期
 * `normalizeAgentProfiles` 冻结 profiles）——同会话改「继承→具体模型」要重启
 * 应用才生效。
 *
 * 修复后的链（B1 方案：per-spawn 活读，不扩协议）：
 *   每次 spawn（port.launch/run/start、含 sendMessage 的 resume 路径）前，
 *   core 经 provider 回调现读 agents-state.json →
 *   `effectiveModel = override[agentName] ?? profile 默认`。bootstrap 侧
 *   provider 带**内容缓存**（文件字符串未变则零解析）与 fail-open 语义：
 *   文件缺失/损坏/字段缺失 → 返回 undefined → core 回退启动冻结快照；
 *   override 指向 Registry 不存在的模型 → 丢弃该条目 + warn（回退 profile 默认）；
 *   warn 按签名去重，不随每次 spawn 刷屏；读失败绝不阻塞 spawn。
 *
 * 四组断言（对应验收 ①-④）：
 *   ① 同一 port 实例（= 同一 App/runtime，core 每 runtime 只建一个 subagent
 *      port）内：spawn → 改文件 override → 再 spawn → 第二次用新模型；
 *   ② 无 override 时回到 profile 默认（内置无显式选择 / 自定义 profile 保留
 *      自身 modelSelection），静态快照形态（旧装配）语义不变——不回归；
 *   ③ agents-state.json 缺失 / JSON 损坏 / 缺字段 → fail-open 回退冻结快照，
 *      spawn 不炸，warn 不刷屏；
 *   ④ override 指向不存在的模型 id → 丢弃并 warn（一次），同文件里其他可用
 *      override 不受影响。
 *
 * 隔离声明
 * ========
 * 绝不写真实 `~/.omz` / `~/.zcode`：
 *   - `ZCODE_STORAGE_DIR` 在 import 任何被测模块**之前**指到 `os.tmpdir()` 下
 *     的一次性临时目录（兜底：任何 import 期解析 storage root 的模块都落临时目录）；
 *   - provider 的 storageRoot 与 agents-state.json 路径全部显式指向该临时目录
 *     下的 per-test 子目录（测试之间互不污染缓存）；
 *   - agent 元数据/输出文件写 `TEST_HOME` 内的独立 output 目录。
 *
 * dist 前置构建
 * ============
 * `pnpm --filter @zcode/shared build`（dist 已随仓提供则跳过）、
 * `pnpm --filter @zcode/core build`、`pnpm --filter @zcode/bootstrap build`。
 * `@zcode/shared` 与 `@zcode/model-option-map` 的包入口发布的是原始 TypeScript，
 * 裸 node 加载不了——与 `test-settle-background.mjs` 同款 registerHooks 手法把
 * 这两个包改指到同布局的编译产物（不引入实验性 loader 标志、不桩任何被测代码）。
 * 本文件直读 core 的 `dist/subagent/runner.js`（被测的 per-spawn 解析）与
 * bootstrap 的 `dist/subagents.js`（被测的活读 provider）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── 隔离：必须先于任何被测模块的 import ────────────────────────────────────────
const TEST_HOME = mkdtempSync(join(tmpdir(), "zcode-subagent-live-model-"));
process.env.ZCODE_STORAGE_DIR = TEST_HOME;
process.on("exit", () => {
  // 尽力而为：Windows 上若仍有句柄未释放会 EPERM；清理失败不改变用例结果，
  // 残留目录由 OS 临时目录策略回收，且它本来就在 tmpdir 下。
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* 见上 */
  }
});

// ── dist 前置：@zcode/shared / @zcode/model-option-map 改指编译产物 ────────────
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

const { createAgentStateOverrideProvider } = await import(
  new URL("../dist/subagents.js", import.meta.url).href
);
const { createExploreSubagentPort } = await import(
  new URL("../../core/dist/subagent/runner.js", import.meta.url).href
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

/** 收集 warn 的结构化 logger：断言「记一次、不刷屏」。 */
function capturingLogger() {
  const warns = [];
  const logger = {
    info() {},
    warn(message, context) {
      warns.push({ message, context });
    },
    error() {},
    debug() {},
    child() {
      return logger;
    },
  };
  return { logger, warns };
}

// ── 夹具 ─────────────────────────────────────────────────────────────────────

const PROVIDER_ID = "live-provider";
const MODEL_DEFAULT = "model-default";
const MODEL_KNOWN = "model-known";
const MODEL_GHOST = "model-ghost";
const FROZEN_SELECTION = Object.freeze({ providerId: PROVIDER_ID, modelId: "model-frozen" });
/** 启动冻结快照的形状与 runtimeConfig.subagents.builtInModelSelectionOverrides 一致（按 agentName 建键）。 */
const FROZEN_SNAPSHOT = Object.freeze({ "general-purpose": FROZEN_SELECTION });

/** per-test 隔离的 storageRoot；状态文件 = `<root>/v2/agents-state.json`。 */
function createStorageRoot(name) {
  const root = join(TEST_HOME, name);
  mkdirSync(root, { recursive: true });
  return root;
}

function agentsStatePathOf(storageRoot) {
  return join(storageRoot, "v2", "agents-state.json");
}

function writeAgentState(storageRoot, value) {
  mkdirSync(join(storageRoot, "v2"), { recursive: true });
  writeFileSync(agentsStatePathOf(storageRoot), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeRawAgentState(storageRoot, raw) {
  mkdirSync(join(storageRoot, "v2"), { recursive: true });
  writeFileSync(agentsStatePathOf(storageRoot), raw, "utf8");
}

function removeAgentState(storageRoot) {
  rmSync(agentsStatePathOf(storageRoot), { force: true });
}

/**
 * 真 core subagent port：唯一替身是 `runExploreAgent`（不拉真 AgentRuntime），
 * 它捕获本次 spawn 实际拿到的 profile——`profile.modelSelection` 就是
 * `override[agentName] ?? profile 默认` 的落点（core `runExploreAgent` 里
 * `resolveSubagentSelection({ profileSelection: request.profile.modelSelection })`
 * 消费它）。
 */
function createPortHarness(options) {
  const spawns = [];
  const parentEvents = [];
  const port = createExploreSubagentPort({
    ...(options.profiles ? { profiles: options.profiles } : {}),
    builtInModelSelectionOverrides: options.builtInModelSelectionOverrides,
    outputRootDir: join(TEST_HOME, "agent-output"),
    logger: options.logger ?? NOOP_LOGGER,
    runExploreAgent: async (request) => {
      spawns.push(request.profile);
      return { response: "done", traceId: request.traceContext.traceId, events: [] };
    },
    emitParentEvent: async (event) => {
      parentEvents.push(event);
    },
  });
  return { parentEvents, port, spawns };
}

/** 一次 spawn：`agentType` 决定落到哪个 profile（内置 general-purpose/Explore 或自定义）。 */
async function spawnAgent(port, agentType) {
  return await port.run({
    sessionId: "ses_subagent_live_model",
    parentToolCallId: "call_subagent_live_model",
    agentType,
    description: `spawn ${agentType}`,
    prompt: "noop",
    workingDirectory: TEST_HOME,
    workspaceRoot: TEST_HOME,
    trace: { traceId: "tr_subagent_live_model" },
  });
}

function spawnedModelLabels(parentEvents) {
  return parentEvents
    .filter((event) => event.type === "subagent_spawned")
    .map((event) => event.payload?.model);
}

// ── ①：per-spawn 生效（同一 port 实例 = 同一 App/runtime） ────────────────────

test("① 同进程 spawn → 改 agents-state.json override → 再 spawn：第二次用新模型", async () => {
  const storageRoot = createStorageRoot("live");
  const provider = createAgentStateOverrideProvider({ storageRoot, logger: NOOP_LOGGER });
  const { parentEvents, port, spawns } = createPortHarness({
    builtInModelSelectionOverrides: provider,
  });

  // 初始：没有 override 文件（等价于用户从未设置过）。
  removeAgentState(storageRoot);
  await spawnAgent(port, "general-purpose");
  assert.equal(spawns[0].modelSelection, undefined, "无 override 时内置 profile 无显式模型选择");

  // 用户（host 进程）把「继承」改成具体模型：只改文件，不重启、不重建 port。
  writeAgentState(storageRoot, {
    builtInModelSelectionOverrides: {
      "general-purpose": { providerId: PROVIDER_ID, modelId: MODEL_KNOWN },
    },
  });
  await spawnAgent(port, "general-purpose");
  assert.deepEqual(
    spawns[1].modelSelection,
    { providerId: PROVIDER_ID, modelId: MODEL_KNOWN },
    "第二次 spawn 必须用 override 的新模型（per-spawn 活读）",
  );
  assert.ok(
    spawnedModelLabels(parentEvents).includes(`${PROVIDER_ID}/${MODEL_KNOWN}`),
    "SubagentSpawned 事件的 model 标记同样跟随活读值",
  );

  // Explore 没有 override：不受影响（override 按 agentName 精确命中）。
  await spawnAgent(port, "Explore");
  assert.equal(spawns[2].modelSelection, undefined);

  // 再改一次（override 被替换成另一个模型）：第三次 spawn 跟上，无需重启。
  writeAgentState(storageRoot, {
    builtInModelSelectionOverrides: {
      "general-purpose": { providerId: PROVIDER_ID, modelId: MODEL_DEFAULT },
    },
  });
  await spawnAgent(port, "general-purpose");
  assert.equal(
    spawns[3].modelSelection?.modelId,
    MODEL_DEFAULT,
    "override 更换后 spawn 继续跟随活值",
  );

  // 用户把 override 改回「继承」（写侧写空表）：活读如实清除，回退默认。
  writeAgentState(storageRoot, { builtInModelSelectionOverrides: {} });
  await spawnAgent(port, "general-purpose");
  assert.equal(spawns[4].modelSelection, undefined, "空 override 表 = 当场恢复继承");
});

// ── ②：无 override 时用 profile 默认（不回归） ────────────────────────────────

test("② 无 override 时用 profile 默认；静态快照形态（旧装配）语义不变", async () => {
  const storageRoot = createStorageRoot("defaults");
  const provider = createAgentStateOverrideProvider({ storageRoot, logger: NOOP_LOGGER });
  const customProfile = {
    name: "custom-agent",
    description: "custom agent",
    source: "user",
    systemPrompt: "you are custom",
    modelSelection: { providerId: PROVIDER_ID, modelId: MODEL_DEFAULT },
  };
  const { port, spawns } = createPortHarness({
    profiles: [customProfile],
    builtInModelSelectionOverrides: provider,
  });

  removeAgentState(storageRoot);
  await spawnAgent(port, "custom-agent");
  await spawnAgent(port, "general-purpose");
  assert.deepEqual(
    spawns[0].modelSelection,
    { providerId: PROVIDER_ID, modelId: MODEL_DEFAULT },
    "自定义 profile 的自身默认不被 override 污染",
  );
  assert.equal(spawns[1].modelSelection, undefined, "内置 profile 无 override 时保持无显式选择");

  // 静态值形态（未注入 provider 的旧装配，如 workflow child runtime）：
  // 与构造期快照逐行等价——这里显式钉住它不因活读改动而回归。
  const staticHarness = createPortHarness({
    builtInModelSelectionOverrides: { Explore: FROZEN_SELECTION },
  });
  removeAgentState(storageRoot);
  await spawnAgent(staticHarness.port, "Explore");
  assert.deepEqual(staticHarness.spawns[0].modelSelection, FROZEN_SELECTION);
  await spawnAgent(staticHarness.port, "general-purpose");
  assert.equal(
    staticHarness.spawns[1].modelSelection,
    undefined,
    "未覆盖的内置 agent 仍无显式选择",
  );
});

// ── ③：损坏/缺字段 → fail-open 回退冻结快照，不炸、不刷屏 ────────────────────

test("③ agents-state.json 缺失/损坏/缺字段 → 回退冻结快照且 spawn 不炸，warn 去重", async () => {
  const storageRoot = createStorageRoot("failopen");
  const { logger, warns } = capturingLogger();
  const provider = createAgentStateOverrideProvider({ storageRoot, logger });
  // 复刻 core `createDefaultSubagentPort` 的合并语义：活读 provider ?? 启动冻结快照。
  const { port, spawns } = createPortHarness({
    builtInModelSelectionOverrides: () => provider() ?? FROZEN_SNAPSHOT,
    logger,
  });

  // ③-a 文件缺失：fail-open 回退启动快照。
  removeAgentState(storageRoot);
  await spawnAgent(port, "general-purpose");
  assert.deepEqual(spawns[0].modelSelection, FROZEN_SELECTION, "文件缺失 → 回退启动冻结快照");
  assert.equal(warns.length, 1, "文件缺失 warn 一次");
  assert.ok(warns[0].message.includes("不可读"));

  // ③-b JSON 损坏：同样 fail-open，且不写失败缓存（写侧修好即恢复）。
  writeRawAgentState(storageRoot, "{ this is not json");
  await spawnAgent(port, "general-purpose");
  assert.deepEqual(spawns[1].modelSelection, FROZEN_SELECTION, "JSON 损坏 → 回退启动冻结快照");
  const warnCountAfterCorrupt = warns.length;
  assert.equal(warnCountAfterCorrupt, 2, "损坏 warn 一次（累计 2 条）");

  // 同一损坏内容再次 spawn：warn 签名去重，不刷屏。
  await spawnAgent(port, "general-purpose");
  assert.equal(warns.length, warnCountAfterCorrupt, "同一失效形态 warn 去重，不随 spawn 刷屏");
  assert.deepEqual(spawns[2].modelSelection, FROZEN_SELECTION);

  // ③-c 合法 JSON 但缺 builtInModelSelectionOverrides 字段（外部/旧格式写入）：
  // 无法确定活值 → 信任启动快照；这是合法状态（用户从未设置过），不记 warn。
  const warnCountBefore = warns.length;
  writeAgentState(storageRoot, { disabledAgentIds: [] });
  await spawnAgent(port, "general-purpose");
  assert.deepEqual(spawns[3].modelSelection, FROZEN_SELECTION, "缺字段 → 回退启动冻结快照");
  assert.equal(warns.length, warnCountBefore, "缺字段是合法状态，不应 warn");

  // ③-d 写侧恢复成有效 override：下一次 spawn 立即跟上（失败未被缓存）。
  writeAgentState(storageRoot, {
    builtInModelSelectionOverrides: {
      "general-purpose": { providerId: PROVIDER_ID, modelId: MODEL_KNOWN },
    },
  });
  await spawnAgent(port, "general-purpose");
  assert.deepEqual(
    spawns[4].modelSelection,
    { providerId: PROVIDER_ID, modelId: MODEL_KNOWN },
    "文件恢复有效后无需重启，spawn 立即跟随活值",
  );
});

// ── ④：override 指向不存在的模型 id → 丢弃 + warn（一次） ────────────────────

test("④ override 指向不存在的模型 id → 丢弃该 override 回退 profile 默认并 warn", async () => {
  const storageRoot = createStorageRoot("ghost");
  const { logger, warns } = capturingLogger();
  const provider = createAgentStateOverrideProvider({
    storageRoot,
    logger,
    isModelSelectionAvailable: (selection) =>
      selection.providerId === PROVIDER_ID && selection.modelId === MODEL_KNOWN,
  });
  const { port, spawns } = createPortHarness({
    builtInModelSelectionOverrides: provider,
    logger,
  });

  writeAgentState(storageRoot, {
    builtInModelSelectionOverrides: {
      "general-purpose": { providerId: PROVIDER_ID, modelId: MODEL_GHOST },
      Explore: { providerId: PROVIDER_ID, modelId: MODEL_KNOWN },
    },
  });

  // 活读面：ghost 被丢弃，可用的 Explore override 保留。
  assert.deepEqual(provider(), {
    Explore: { providerId: PROVIDER_ID, modelId: MODEL_KNOWN },
  });

  await spawnAgent(port, "general-purpose");
  assert.equal(
    spawns[0].modelSelection,
    undefined,
    "不可用模型的 override 被丢弃 → 回退 profile 默认（继承父模型）",
  );
  await spawnAgent(port, "Explore");
  assert.deepEqual(
    spawns[1].modelSelection,
    { providerId: PROVIDER_ID, modelId: MODEL_KNOWN },
    "同一文件里可用的 override 不受影响",
  );

  // warn 只记一次；重复 spawn 不刷屏。
  assert.equal(warns.length, 1, "不可用模型 warn 一次");
  assert.ok(warns[0].message.includes("不可用模型"));
  assert.equal(warns[0].context?.modelId, MODEL_GHOST);
  await spawnAgent(port, "general-purpose");
  assert.equal(warns.length, 1, "同一失效形态 warn 去重");
});
