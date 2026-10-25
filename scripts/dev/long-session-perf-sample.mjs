#!/usr/bin/env node
/* eslint-disable max-lines -- 采样脚本把「启动契约探测 + CDP 会话封装 + 页面内驱动表达式 + 分段取数与报告」集中在一处，便于单文件审阅；后续拆文件会割裂页面内表达式的完整性。 */

// 桌面端长会话性能采样脚本（SPEC Step 3，见 docs/iterations/desktop-long-session-perf/spec.md
// 与 docs/iterations/session-open-latency/spec.md 的 phase-0-baseline）
//
// 职责边界：只做「采样 + 驱动」，不负责构建。renderer dev server 必须由用户先起
// （.vscode/tasks.json 的 `zcode: prepare desktop debug`：tsup watch + vite dev）。
//
// 两种模式：
//   1) 默认（压力窗口）：`reset() → 驱动动作 → dump()` 分段收集，采流式/滚动负载。
//   2) `--path cold|warm|reopen|switchback`（会话打开）：**自己驱动**「打开 / 关闭后重开 /
//      切走再切回」，每次采前清 ACK 环，一条命令跑完一条路径 ×N 次。不再需要外部临时 CDP
//      脚本点侧栏——baseline 的驱动脚本没入库，导致数字不可复核（phase-0 findings）。
//
// dev 实例启动契约（SPEC「总体方案 A」）：
//   1) 探测 http://localhost:5174，不通则报错退出并提示先起 vite dev；
//   2) 探测 http://127.0.0.1:9229/json/version —— 可达则不新起实例（--skip-launch 或
//      仅转发深链给既有实例），不可达则自行 spawn electron ["." , "--open-workspace", ws]
//      且**不带 --inspect-brk**（无调试器会挂起首行）；spawn 后秒退按失败处理；
//   3) 轮询 9229 /json/list 直到出现** renderer 页面 **target（判定见
//      `isRendererPageTarget`：type==="page" 且 URL 指向 dev server 或 file:// 的
//      index.html。**不按产品名匹配**——本树 title / productName 都是 "omz"，旧实现的
//      `title === "ZCode"` 会让脚本以退出码 5 失败）。
//
// 采样序列：ensureVisible → openProbe.reset() → 驱动动作 → 取 ACK 样本 → 写 JSON 报告。
// 探针由 SPEC Step 2 提供（window.__zcodePerfProbe），未挂载时明确报错并非零退出
// （仅压力窗口模式需要；路径模式只依赖 window.__zcodeV4ConversationOpensE2E）。
//
// 零依赖：只用 Node 内置 fetch / WebSocket / child_process。
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";

const TAG = "[long-session-perf]";
const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const DESKTOP_ROOT = resolve(REPO_ROOT, "packages/desktop");
const DEFAULT_DEV_SERVER_URL = "http://localhost:5174";
const DEFAULT_CDP_PORT = 9229;
const DEFAULT_DURATION_MS = 30_000;
const DEFAULT_READY_TIMEOUT_MS = 90_000;
const EVALUATE_TIMEOUT_MS = 60_000;
const SCROLL_INTERVAL_MS = 120;
// 长会话判据阈值。虚拟化时间线在 DOM 里永远只有可视区几十行，
// [data-row-id] 计数不能用来判断「有没有打开长会话」；改用两个 DOM 常驻量：
//   - totalRowCount：v4-timeline 的 data-total-row-count（组件持有的总行数）
//   - maxScrollTop：滚动容器的可滚动余量（px）
// 两者任一达标即认为长会话已就位。
const LONG_SESSION_MIN_TOTAL_ROWS = 200;
const LONG_SESSION_MIN_MAX_SCROLL_TOP = 1_000;
const TIMELINE_SELECTOR = '[data-testid="v4-timeline"]';
// 复用既有实例时，转发深链的第二个进程应当很快自行退出（second-instance 通道）。
const FORWARDER_EXIT_TIMEOUT_MS = 20_000;
// 自行 spawn 后留给主进程的时间：超过即视为「秒退 = 单实例锁让位」，按失败处理。
const LAUNCH_EXIT_GRACE_MS = 8_000;
// 路径模式（会话打开）默认值。
const DEFAULT_ITERATIONS = 3;
const DEFAULT_ACK_TIMEOUT_MS = 20_000;
const DEFAULT_PAINT_GRACE_MS = 1_500;
// 必须大于 SessionDataLayer 的 SESSION_DATA_LAYER_KEEP_WARM_MS（30s，
// packages/ui/src/v4/sessionDataLayer.ts:28）：keep-warm 未过期时再点开会直接复用 store、
// 不产生 ACK，reopen/warm 就采不到样本。多留 1s 余量。
const DEFAULT_KEEP_WARM_WAIT_MS = 31_000;
const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
// 侧栏任务行的 testId 前缀（packages/shared/src/test-ids.ts 的 TID_TASK_ITEM +
// packages/ui/src/TaskListItem.tsx:485 的 testId(TID_TASK_ITEM, task.taskId)）。
const TASK_ITEM_TEST_ID_PREFIX = "task-item-";
const SWITCHBACK_POLL_INTERVAL_MS = 25;

// 退出码
//   0 成功，且目标样本含验收指标（renderer.uiViewReadyMs）
//   2 用法错误   3 dev server 不可达   4 启动/复用失败
//   5 未出现 renderer page target   6 perfProbe 未挂载   7 CDP 交互失败
//   8 **已写出报告但缺验收指标**（uiViewReadyMs 缺席 / 观测面未挂载 / 无目标 ACK）
//   9 驱动动作失败（路径模式下点击/切换/等 ACK 超时，或冷开前置条件不成立）
//
// 8 存在的理由：renderer.uiViewReadyMs 是冷开/热开的唯一验收量，缺它这份报告不能用来
// 判基线。它与「跑挂了」的 4/5/6/7 区分开——8 时报告已落盘，数字只是不满足验收条件。
// 3 已被「dev server 不可达」占用，故不复用（见 cr-func N2 的建议）。
// 9 单列的理由：路径模式自己驱动 UI，点击不到/等不到 ACK 与「采到了但缺指标」是两种事故，
// 混进 8 会让「脚本跑不动」看起来像「性能结论缺一项」。
const EXIT = {
  OK: 0,
  USAGE: 2,
  DEV_SERVER: 3,
  LAUNCH: 4,
  TARGET: 5,
  PROBE: 6,
  CDP: 7,
  MISSING_METRIC: 8,
  ACTION: 9,
};

/** 路径模式支持的会话打开路径（spec phase-0 的四路径）。 */
const OPEN_PATHS = ["cold", "warm", "reopen", "switchback"];

const USAGE = [
  "用法: node scripts/dev/long-session-perf-sample.mjs [选项]",
  "",
  "选项:",
  "  --workspace <path>       要打开的 workspace 路径（默认：仓库根 " + REPO_ROOT + "）",
  "  --out <file>             报告输出路径（默认：仓库内",
  "                          docs/iterations/desktop-long-session-perf/baseline-<时间戳>.json）",
  "  --session <id>           目标会话 id；ACK 样本与 renderer 分段按它取",
  "                          （路径模式必填；压力窗口模式缺省取时间线所属 pane 的 data-session-id）",
  "  --path <p>               会话打开路径，p ∈ cold|warm|reopen|switchback。给出后脚本",
  "                          自己驱动「打开 / 关闭后重开 / 切走再切回」，不采流式/滚动窗口",
  "  --iterations <n>         路径模式重复次数，默认 3",
  "  --park-session <id>      切换用的另一个会话（warm/reopen 的「切走」、switchback 的 B）；",
  "                          缺省在侧栏里取第一条与 --session 不同的 task-item（报告记录来源）",
  "  --startup-workspace <p>  冷开时传给 --open-workspace 的 workspace（默认同 --workspace）。",
  "                          冷开要求目标 workspace 不在启动预热名单内，常用另一个项目路径",
  "  --ack-timeout-ms <n>     路径模式等待目标 ACK 的上限，默认 20000",
  "  --paint-grace-ms <n>     路径模式等 paintAfterApplyMs / paint_missing 的宽限，默认 1500",
  "  --keep-warm-wait-ms <n>  warm/reopen 切走后等 renderer keep-warm 过期的时长，默认 31000",
  "                          （SessionDataLayer 的 30s keep-warm 不过期就不会有新 ACK）",
  "  --action-timeout-ms <n>  等侧栏任务行出现/消失的上限，默认 15000",
  "  --skip-launch            不 spawn 任何进程，要求已有实例在跑（9229 可达）；cold 路径不接受",
  "  --duration-ms <n>        单个采样窗口时长，默认 30000（两个窗口共 2×）",
  "  --scroll-selector <sel>  滚动容器选择器；缺省用 document.scrollingElement",
  "  --dev-server-url <url>   renderer dev server 地址，默认 http://localhost:5174",
  "  --cdp-port <n>           远程调试端口，默认 9229（采样期要求 dev 实例独占）",
  "  --ready-timeout-ms <n>   等待 renderer page target 就绪的超时，默认 90000",
  "  --electron <path>        electron 可执行文件覆盖（默认解析仓库内 electron）",
  "  --help                   打印本用法",
  "",
  "退出码:",
  "  0  成功，且目标样本含验收指标 renderer.uiViewReadyMs",
  "  2  用法错误",
  "  3  renderer dev server 不可达",
  "  4  启动/复用 dev 实例失败",
  "  5  未出现 renderer page target",
  "  6  观测面未挂载（压力窗口模式要 perfProbe；路径模式要 __zcodeV4ConversationOpensE2E）",
  "  7  CDP 交互失败",
  "  8  已写出报告但缺验收指标（uiViewReadyMs 缺席 / 观测面未挂载 / 无目标 ACK），",
  '     报告里 openProbe.acceptance.verdict = "missing"；与跑挂的 4/5/6/7 区分',
  "  9  驱动动作失败（点不到任务行 / 等 ACK 超时 / 切回产生了新 ACK / 冷开前置不成立）",
  "",
  "示例:",
  "  node scripts/dev/long-session-perf-sample.mjs --workspace D:\\dev\\my-workspace",
  "  node scripts/dev/long-session-perf-sample.mjs --skip-launch --duration-ms 60000 \\",
  "    --scroll-selector '[data-testid=\"conversation-timeline\"]'",
  "  node scripts/dev/long-session-perf-sample.mjs --path warm --session sess_xxx \\",
  "    --iterations 3 --out docs/iterations/session-open-latency/warm.json",
  "",
  "会话打开分段（session-open-latency）：",
  "",
  "  验收基准是 renderer 侧总量 `renderer.uiViewReadyMs`（connect 入口 → snapshot 应用完成），",
  "  要看首绘再叠加 `renderer.paintAfterApplyMs`。`openPhases.viewReadyMs` 只是 CLI 进程内",
  "  一段（不含 host 准备 / CLI spawn / RPC 往返 / 渲染），且各段嵌套不可相加。",
  "",
  "  冷开判据（phase-0-baseline）：**主判 `uiViewReadyMs - openTiming.hostPrepareMs ≤ 1s`**，",
  "  `uiViewReadyMs - openTiming.cliBootstrapMs` 作为并列分解项。主判用 hostPrepareMs 的理由是",
  "  它在实测里稳定覆盖 spawn（冷开 1578~1776ms / 热开 live 2~3ms），而 cliBootstrapMs 在旧树",
  "  结构性缺席（client 被任务列表预建 → 恒 reused）。本脚本只判「有没有采到」，阈值判定仍在 spec。",
  "  热开看 `uiViewReadyMs ≤ 800ms`；切回（keep-warm）不发生 subscribe，该指标没有生产者，",
  "  脚本改为断言「没有新 ACK」并采 click→pane 绑定耗时。",
  "",
  "  ACK 样本按**目标会话**取（`--session` 或时间线所属 pane），不取环形缓冲最后一条；",
  "  目标样本缺 `renderer.uiViewReadyMs` 时退出码 8，报告照写并标 verdict=missing。",
  "",
  "  首绘采样被丢弃时（会话关闭 / 换代），报告里 `paintMissing.reason` 明确写",
  "  `closed` / `generation_changed`——缺席有原因，不再静默。",
  "",
  "  可见性：Chromium 把被遮挡的窗口判 hidden，rAF 降频 / timer 夹到 1s（实测同一次打开的",
  "  paintAfterApplyMs 93827ms vs 429~461ms）。脚本每次采样前用 CDP",
  "  `Emulation.setFocusEmulationEnabled` + `Page.bringToFront` + `Page.setWebLifecycleState(active)`",
  "  解除遮挡，并在样本里记 `visibility`（hidden 样本会被标 `contaminated: true`，可剔除）。",
  "",
  "  ACK 顶层 `openPhases`（viewReadyMs / mergeMs / rehydrateMs）与 `runtimeReady` query",
  "  来自页面窗口面 `window.__zcodeV4ConversationOpensE2E`。",
  "",
  "  例：node scripts/dev/long-session-perf-sample.mjs --skip-launch \\",
  "        --out docs/iterations/session-open-latency/baseline.json",
  "",
].join("\n");

/** 带退出码的错误：抛出后在顶层统一回收子进程 / CDP 连接再退出。 */
class PerfError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function fail(message, code) {
  throw new PerfError(message, code);
}

// 自起的进程在失败路径上必须回收，避免留下占着 9229 的野实例。
let activeChild = null;

function killStrayChild() {
  if (activeChild && activeChild.exitedAt == null) {
    console.error(`${TAG} 回收本次启动的进程 pid=${activeChild.pid}`);
    killChildTree(activeChild);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const FLAGS = new Set(["--skip-launch", "--help"]);
const VALUED = new Set([
  "--workspace",
  "--out",
  "--session",
  "--path",
  "--iterations",
  "--park-session",
  "--startup-workspace",
  "--ack-timeout-ms",
  "--paint-grace-ms",
  "--keep-warm-wait-ms",
  "--action-timeout-ms",
  "--duration-ms",
  "--scroll-selector",
  "--dev-server-url",
  "--cdp-port",
  "--ready-timeout-ms",
  "--electron",
]);

function parseArgs(argv) {
  const raw = {
    workspace: process.env.ZCODE_PERF_WORKSPACE?.trim() || REPO_ROOT,
    out: "",
    session: "",
    skipLaunch: false,
    durationMs: DEFAULT_DURATION_MS,
    scrollSelector: "",
    devServerUrl: DEFAULT_DEV_SERVER_URL,
    cdpPort: DEFAULT_CDP_PORT,
    readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
    electron: "",
    // 路径模式（会话打开四路径）
    path: "",
    iterations: DEFAULT_ITERATIONS,
    parkSession: "",
    startupWorkspace: "",
    ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
    paintGraceMs: DEFAULT_PAINT_GRACE_MS,
    keepWarmWaitMs: DEFAULT_KEEP_WARM_WAIT_MS,
    actionTimeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    let token = argv[i];
    let inlineValue;
    const eq = token.indexOf("=");
    if (token.startsWith("--") && eq > 2) {
      inlineValue = token.slice(eq + 1);
      token = token.slice(0, eq);
    }
    const take = () => {
      if (inlineValue != null) return inlineValue;
      i += 1;
      const v = argv[i];
      if (v == null) fail(`参数 ${token} 缺少取值`, EXIT.USAGE);
      return v;
    };

    if (token === "--help" || token === "-h") {
      raw.help = true;
    } else if (FLAGS.has(token)) {
      raw.skipLaunch = true;
    } else if (VALUED.has(token)) {
      const value = take();
      if (token === "--workspace") raw.workspace = value;
      else if (token === "--out") raw.out = value;
      else if (token === "--session") raw.session = value;
      else if (token === "--park-session") raw.parkSession = value;
      else if (token === "--startup-workspace") raw.startupWorkspace = value;
      else if (token === "--scroll-selector") raw.scrollSelector = value;
      else if (token === "--dev-server-url") raw.devServerUrl = value;
      else if (token === "--electron") raw.electron = value;
      else if (token === "--path") {
        if (!OPEN_PATHS.includes(value)) {
          fail(`--path 只接受 ${OPEN_PATHS.join("|")}，收到 "${value}"`, EXIT.USAGE);
        }
        raw.path = value;
      } else {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0)
          fail(`参数 ${token} 需要正整数，收到 "${value}"`, EXIT.USAGE);
        if (token === "--duration-ms") raw.durationMs = n;
        else if (token === "--cdp-port") raw.cdpPort = n;
        else if (token === "--ready-timeout-ms") raw.readyTimeoutMs = n;
        else if (token === "--iterations") raw.iterations = Math.floor(n);
        else if (token === "--ack-timeout-ms") raw.ackTimeoutMs = n;
        else if (token === "--paint-grace-ms") raw.paintGraceMs = n;
        else if (token === "--keep-warm-wait-ms") raw.keepWarmWaitMs = n;
        else if (token === "--action-timeout-ms") raw.actionTimeoutMs = n;
      }
    } else if (token === "--path") {
      fail(`--path 需要取值（${OPEN_PATHS.join("|")}）`, EXIT.USAGE);
    } else {
      fail(`未知参数 "${token}"\n\n${USAGE}`, EXIT.USAGE);
    }
  }

  return raw;
}

/**
 * 只判断「有没有服务在应答」的 HTTP 探测，不解析响应体。
 * vite dev server 根路径返回 HTML，交给 JSON 解析会误报为不可达。
 */
async function probeHttpUrl(url, timeoutMs = 1_500) {
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel();
    return { ok: res.ok || res.status < 500, reason: `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 带超时的 JSON 探测，永不抛错（仅用于 CDP 自身的 JSON 端点）。 */
async function fetchJson(url, timeoutMs = 1_500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

class CdpSession {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error(`CDP WebSocket 连接失败: ${this.url}`));
    });
    this.ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      const entry = message.id != null ? this.pending.get(message.id) : undefined;
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(
          new Error(`${entry.method} 失败: ${message.error.message} (${message.error.code})`),
        );
      } else {
        entry.resolve(message.result);
      }
    };
  }

  send(method, params = {}) {
    return new Promise((res, rej) => {
      const mid = ++this.id;
      this.pending.set(mid, { resolve: res, reject: rej, method });
      this.ws.send(JSON.stringify({ id: mid, method, params }));
    });
  }

  /** evaluate 并把返回值按字符串/值取回；页面内抛错则抛出带描述的异常。 */
  async evaluate(expression, timeoutMs = EVALUATE_TIMEOUT_MS) {
    const work = this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const timer = new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`Runtime.evaluate 超时（${timeoutMs}ms）`)), timeoutMs),
    );
    const result = await Promise.race([work, timer]);
    if (result?.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(
        `Runtime.evaluate 页面内异常: ${detail.exception?.description ?? detail.text ?? "未知异常"}`,
      );
    }
    return result?.result?.value;
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // 关闭失败不影响采样结论
    }
  }
}

// 当前 CDP 连接，顶层退出前需要先 close —— 直接 process.exit 会撞上
// Node 在 Windows 上对「正在 CLOSING 的 uv handle」的断言。
let activeCdp = null;

// ---- 页面内表达式 ------------------------------------------------------------

const PROBE_CHECK_EXPR = `(() => {
  const probe = window.__zcodePerfProbe;
  if (!probe) return JSON.stringify({ mounted: false });
  return JSON.stringify({
    mounted: true,
    methods: Object.keys(probe).filter((k) => typeof probe[k] === "function"),
  });
})()`;

const PROBE_RESET_EXPR = `(() => {
  const probe = window.__zcodePerfProbe;
  if (!probe || typeof probe.reset !== "function") throw new Error("perfProbe.reset 不可用");
  probe.reset();
  return "reset-ok";
})()`;

const PROBE_DUMP_EXPR = `(() => {
  const probe = window.__zcodePerfProbe;
  if (!probe || typeof probe.dump !== "function") throw new Error("perfProbe.dump 不可用");
  const dumped = probe.dump();
  return typeof dumped === "string" ? dumped : JSON.stringify(dumped);
})()`;

// ---- 会话打开分段（ACK 顶层键 openPhases + runtimeReady query）----------------
//
// 数据源是 UI 侧窗口面 `__zcodeV4ConversationOpensE2E`
// （packages/ui/src/v4/conversationOpenObservability.ts）。为什么不能在别处取：
//   - `openPhases` / `openTiming` 只在 conversation subscribe **ACK 帧**里，不进
//     snapshot / delta，页面外拿不到；
//   - `runtimeReadyMs` 不在 ACK 里（view-only 的激活发生在 ACK 之后），只能事后走
//     `v4/conversation/runtimeReady` query。
// 该面未挂载 / 目标会话没有 ACK / 缺 uiViewReadyMs 时退出码 8（报告照写）。
//
// 口径（cr-func 两轮矫正）：**验收基准是 renderer 侧总量 `uiViewReadyMs`**
// （= connect 入口 → snapshot 应用完成；要覆盖首绘再叠加 `paintAfterApplyMs`）。
// `openPhases.viewReadyMs` 只是 **CLI 进程内**的视图就绪段，不含 host 准备 / CLI spawn /
// RPC 往返 / 首帧传输 / renderer apply+paint，冷开下系统性偏短；各段还嵌套不可相加
// （viewReadyMs ⊇ initialFrameEncodeMs，viewReadyMs ⊃ mergeMs + rehydrateMs，
// hostPrepareMs ⊇ cliBootstrapMs + providerRegistrySyncMs + taskMetaReadMs）。
//
// 两个读法陷阱（必须写进 baseline 解读）：①`uiViewReadyMs` 起点是 `SessionDataLayer.acquire`，
// acquire 在 useEffect 里跑，**比用户点击晚一个 React commit**；②runtime recycle 的有界重试
// 重入 connect 时不传起始时间戳，起点被重置——带 recycle 的冷开会显得很快。
const OPEN_PROBE_CHECK_EXPR = `(() => {
  const probe = window.__zcodeV4ConversationOpensE2E;
  if (!probe) return JSON.stringify({ mounted: false });
  return JSON.stringify({
    mounted: true,
    ackCount: Array.isArray(probe.acks) ? probe.acks.length : 0,
    methods: Object.keys(probe).filter((k) => typeof probe[k] === "function"),
  });
})()`;

// 目标会话解析：采样的是「时间线所属 pane」，不是「环形缓冲最后一条 ACK 的 topic」。
// 预览/侧 pane、子代理 pane 也会 subscribe，取最后一条会拿到别人的样本。
const OPEN_PROBE_TARGET_EXPR = `(() => {
  const readId = (el) => (el && typeof el.getAttribute === "function" ? el.getAttribute("data-session-id") : null);
  const timeline = document.querySelector(${JSON.stringify(TIMELINE_SELECTOR)});
  const ownerSessionId = timeline ? readId(timeline.closest("[data-session-id]")) : null;
  const paneSessionIds = Array.from(document.querySelectorAll("[data-session-id]"))
    .map((el) => readId(el))
    .filter((id) => typeof id === "string" && id.length > 0);
  return JSON.stringify({ ownerSessionId, paneSessionIds });
})()`;

// targetSessionId 为 null 时不取样本（由调用方判 missing），**绝不**退化成 ring 最后一条。
const OPEN_PROBE_SAMPLE_EXPR = (targetSessionId) => `(async () => {
  const probe = window.__zcodeV4ConversationOpensE2E;
  if (!probe) return JSON.stringify({ mounted: false });
  const targetSessionId = ${JSON.stringify(targetSessionId ?? null)};
  // topic 与 conversationTopic() 同构：conversation/<sessionId>。
  const targetTopic = targetSessionId ? "conversation/" + targetSessionId : null;
  const acks = Array.isArray(probe.acks) ? probe.acks : [];
  let targetAck = null;
  if (targetTopic) {
    for (let i = acks.length - 1; i >= 0; i -= 1) {
      const ack = acks[i];
      if (ack && ack.topic === targetTopic) {
        targetAck = ack;
        break;
      }
    }
  }
  let runtimeReady = null;
  let runtimeReadyError = null;
  if (typeof probe.runtimeReady === "function") {
    try {
      runtimeReady = await probe.runtimeReady(targetSessionId || undefined);
    } catch (error) {
      runtimeReadyError = error && error.message ? String(error.message) : String(error);
    }
  }
  return JSON.stringify({
    mounted: true,
    capturedAt: new Date().toISOString(),
    targetSessionId,
    targetTopic,
    acks,
    targetAck,
    // 只作诊断：环形缓冲最后一条属于哪个 topic（可能不是目标会话）。
    ringLastAck: acks.length > 0 ? acks[acks.length - 1] : null,
    // 首绘采样被丢弃时的原因（closed / generation_changed）；有值即「缺席 ≠ 还没到」。
    paintMissing:
      probe.paintMissing && targetTopic && probe.paintMissing[targetTopic]
        ? probe.paintMissing[targetTopic]
        : null,
    runtimeReady,
    runtimeReadyError,
  });
})()`;

const RENDERER_ENV_EXPR = `(() => {
  const timeline = document.querySelector(${JSON.stringify(TIMELINE_SELECTOR)});
  const num = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return JSON.stringify({
    url: location.href,
    userAgent: navigator.userAgent,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    // 仅作参考：虚拟化下它等于可视区窗口行数，不能当长会话判据。
    rowCount: document.querySelectorAll("[data-row-id]").length,
    timelinePresent: Boolean(timeline),
    totalRowCount: timeline ? num(timeline.getAttribute("data-total-row-count")) : null,
    windowRowCount: timeline ? num(timeline.getAttribute("data-window-row-count")) : null,
    maxScrollTop: timeline ? Math.max(0, timeline.scrollHeight - timeline.clientHeight) : null,
    now: new Date().toISOString(),
  });
})()`;

// ---- 窗口可见性（rAF 被降频的唯一开关）----------------------------------------
//
// Chromium 把被其他窗口遮住的页面判成 hidden：rAF 被降频/夹到 1s，timer 也受影响。
// phase-0 实测同一次打开的 paintAfterApplyMs 从 429~461ms（visible）变成 93827ms（hidden）。
// 因此**每次采样前**必须走三步（Page.setWebLifecycleState / Emulation.setFocusEmulationEnabled /
// Page.bringToFront），并把采样时的可见性写进样本，让 hidden 样本可被剔除而不是污染中位数。
const VISIBILITY_EXPR = `(() => JSON.stringify({
  visibilityState: document.visibilityState,
  hidden: document.hidden === true,
  hasFocus: typeof document.hasFocus === "function" ? document.hasFocus() : null,
  at: Date.now(),
}))()`;

// ---- 路径模式（会话打开）的页面驱动 -------------------------------------------
//
// 三动作全部由脚本完成，不依赖外部临时 CDP 脚本（phase-0 的驱动脚本没入库 → 不可复核）：
//   open    = 点击侧栏 [data-testid="task-item-<sessionId>"]（TaskListItem.tsx:485）
//   close   = 切到另一个会话（renderer 视角即「关掉当前会话」，旧 store 进 keep-warm）
//   switch  = 再点回目标会话
// 每次测量前都调 __zcodeV4ConversationOpensE2E.reset()（同时清 ACK 环与 paintMissing）。
const OPEN_PROBE_RESET_EXPR = `(() => {
  const probe = window.__zcodeV4ConversationOpensE2E;
  if (!probe || typeof probe.reset !== "function") {
    throw new Error("__zcodeV4ConversationOpensE2E.reset 不可用（观测面未挂载）");
  }
  probe.reset();
  return "open-probe-reset-ok";
})()`;

/** 按 topic 读 ACK 状态（这个缓冲区每个 topic 只留一条）。 */
const OPEN_PROBE_ACK_STATE_EXPR = (topic) => `(() => {
  const probe = window.__zcodeV4ConversationOpensE2E;
  if (!probe) return JSON.stringify({ mounted: false });
  const topic = ${JSON.stringify(topic)};
  const acks = Array.isArray(probe.acks) ? probe.acks : [];
  const ack = acks.find((sample) => sample && sample.topic === topic) || null;
  const renderer = ack && ack.renderer ? ack.renderer : null;
  const paintMissing = probe.paintMissing && probe.paintMissing[topic] ? probe.paintMissing[topic] : null;
  return JSON.stringify({
    mounted: true,
    ackCount: acks.length,
    ackAt: ack ? ack.at : null,
    ackMode: ack ? ack.mode : null,
    uiViewReadyMs: renderer ? (renderer.uiViewReadyMs ?? null) : null,
    paintAfterApplyMs: renderer ? (renderer.paintAfterApplyMs ?? null) : null,
    paintMissing: paintMissing ? paintMissing.reason : null,
  });
})()`;

/** 侧栏里现存的 task-item sessionId 列表（用于给 warm/reopen 自动挑「切走」目标）。 */
const LIST_TASK_ITEMS_EXPR = `(() => JSON.stringify({
  ids: Array.from(document.querySelectorAll('[data-testid^="' + ${JSON.stringify(TASK_ITEM_TEST_ID_PREFIX)} + '"]'))
    .map((el) => el.getAttribute("data-testid"))
    .map((id) => (typeof id === "string" ? id.slice(${JSON.stringify(TASK_ITEM_TEST_ID_PREFIX)}.length) : ""))
    .filter((id) => id.length > 0),
}))()`;

const ELEMENT_PRESENT_EXPR = (testId) => `(() => JSON.stringify({
  present: Boolean(document.querySelector('[data-testid="' + ${JSON.stringify(testId)} + '"]')),
}))()`;

/**
 * 派发完整指针序列再 click。
 *
 * 只 `el.click()` 在部分行上不会触发 React 的 pointer 处理（任务行用 onClick，但拖拽/焦点
 * 捕获层会先吃 pointerdown）；基线用的是同一套 pointerdown/mousedown/pointerup/mouseup/click。
 */
const CLICK_TEST_ID_EXPR = (testId) => `(() => {
  const testId = ${JSON.stringify(testId)};
  const el = document.querySelector('[data-testid="' + testId + '"]');
  if (!el) return JSON.stringify({ ok: false, reason: "not-found", testId });
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
  const rect = typeof el.getBoundingClientRect === "function"
    ? el.getBoundingClientRect()
    : { left: 0, top: 0, width: 0, height: 0 };
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  const pointerCtor = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
  for (const [type, ctor] of [["pointerdown", pointerCtor], ["mousedown", MouseEvent], ["pointerup", pointerCtor], ["mouseup", MouseEvent]]) {
    el.dispatchEvent(new ctor(type, init));
  }
  el.click();
  return JSON.stringify({
    ok: true,
    testId,
    tag: el.tagName,
    text: (el.textContent || "").trim().slice(0, 80),
    dispatchedAt: Date.now(),
  });
})()`;

/** 时间线归属（pane 上的 data-session-id）+ 行数；切回动作的判定量。 */
const TIMELINE_STATE_EXPR = `(() => {
  const timeline = document.querySelector(${JSON.stringify(TIMELINE_SELECTOR)});
  const owner = timeline ? timeline.closest("[data-session-id]") : null;
  const rows = timeline ? Number(timeline.getAttribute("data-total-row-count")) : NaN;
  return JSON.stringify({
    at: Date.now(),
    ownerSessionId: owner ? owner.getAttribute("data-session-id") : null,
    totalRowCount: Number.isFinite(rows) ? rows : 0,
    paneSessionIds: Array.from(document.querySelectorAll("[data-session-id]"))
      .map((el) => el.getAttribute("data-session-id"))
      .filter((id) => typeof id === "string" && id.length > 0),
  });
})()`;

/**
 * 切回的耗时打点（页面内 performance.now，与 renderer 的其它分段同一时钟）。
 *
 * 口径沿用 phase-0 的 keep-warm 实测：起点 = 点击派发前，终点 = 时间线 pane 的
 * data-session-id 切到目标会话且 total-row-count > 0 的那次 25ms 轮询。含同步 React commit
 * 与首屏行渲染，不含点击前的浏览器输入排队。
 */
const SWITCHBACK_PROBE_START_EXPR = (sessionId) => `(() => {
  const target = ${JSON.stringify(sessionId)};
  const previous = window.__zcodeSwitchbackProbe;
  if (previous && previous.timer) clearInterval(previous.timer);
  const probe = {
    target,
    startedAt: performance.now(),
    boundAt: null,
    timelineRows: 0,
    timer: null,
    polls: 0,
  };
  const read = () => {
    probe.polls += 1;
    const timeline = document.querySelector(${JSON.stringify(TIMELINE_SELECTOR)});
    const owner = timeline ? timeline.closest("[data-session-id]") : null;
    const ownerId = owner ? owner.getAttribute("data-session-id") : null;
    const rows = timeline ? Number(timeline.getAttribute("data-total-row-count")) : NaN;
    if (probe.boundAt == null && ownerId === target && Number.isFinite(rows) && rows > 0) {
      probe.boundAt = performance.now();
      probe.timelineRows = rows;
    }
    if (probe.boundAt != null && probe.timer) {
      clearInterval(probe.timer);
      probe.timer = null;
    }
  };
  probe.timer = setInterval(read, ${SWITCHBACK_POLL_INTERVAL_MS});
  read();
  window.__zcodeSwitchbackProbe = probe;
  return JSON.stringify({ ok: true, target, startedAt: probe.startedAt });
})()`;

const SWITCHBACK_PROBE_READ_EXPR = `(() => {
  const probe = window.__zcodeSwitchbackProbe;
  if (!probe) return JSON.stringify({ ok: false, reason: "probe-not-set" });
  return JSON.stringify({
    ok: true,
    target: probe.target,
    boundAt: probe.boundAt,
    switchMs: probe.boundAt == null ? null : Math.max(0, Math.round(probe.boundAt - probe.startedAt)),
    timelineRows: probe.timelineRows,
    polls: probe.polls,
    running: probe.timer != null,
  });
})()`;

const SWITCHBACK_PROBE_CLEAR_EXPR = `(() => {
  const probe = window.__zcodeSwitchbackProbe;
  if (probe && probe.timer) clearInterval(probe.timer);
  delete window.__zcodeSwitchbackProbe;
  return "switchback-probe-cleared";
})()`;

// ---- 窗口可见性固化 ----------------------------------------------------------

const SCROLL_DRIVER_EXPR = (selectorJson, intervalMs) => `(() => {
  const selector = ${selectorJson};
  const el = selector ? document.querySelector(selector) : (document.scrollingElement || document.documentElement);
  if (!el) return JSON.stringify({ ok: false, reason: "scroll-container-not-found" });
  const previous = window.__zcodePerfScrollDriver;
  if (previous && previous.timer) clearInterval(previous.timer);
  const driver = {
    el,
    intervalMs: ${intervalMs},
    maxScrollTop: Math.max(0, el.scrollHeight - el.clientHeight),
    dir: 1,
    steps: 0,
    timer: null,
  };
  const step = () => {
    const delta = Math.max(60, Math.round((driver.el.clientHeight || 400) * 0.9));
    let next = driver.el.scrollTop + driver.dir * delta;
    if (next >= driver.maxScrollTop) { next = driver.maxScrollTop; driver.dir = -1; }
    else if (next <= 0) { next = 0; driver.dir = 1; }
    driver.el.scrollTop = next;
    driver.steps += 1;
    driver.el.dispatchEvent(new WheelEvent("wheel", {
      deltaY: driver.dir * delta, deltaMode: 0, bubbles: true, cancelable: true,
    }));
  };
  step();
  driver.timer = setInterval(step, driver.intervalMs);
  window.__zcodePerfScrollDriver = driver;
  return JSON.stringify({
    ok: true,
    tag: el.tagName,
    className: String(el.className || "").slice(0, 120),
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    maxScrollTop: driver.maxScrollTop,
  });
})()`;

const SCROLL_STOP_EXPR = `(() => {
  const driver = window.__zcodePerfScrollDriver;
  if (!driver) return JSON.stringify({ ok: false, reason: "driver-not-running" });
  if (driver.timer) clearInterval(driver.timer);
  const summary = JSON.stringify({ ok: true, steps: driver.steps, finalScrollTop: driver.el.scrollTop });
  delete window.__zcodePerfScrollDriver;
  return summary;
})()`;

// ---- 启动与就绪 --------------------------------------------------------------

function resolveElectronExecutable(override) {
  if (override) {
    const abs = isAbsolute(override) ? override : resolve(process.cwd(), override);
    if (!existsSync(abs)) fail(`--electron 指定的文件不存在: ${abs}`, EXIT.LAUNCH);
    return abs;
  }
  const require_ = createRequire(import.meta.url);
  const tail =
    process.platform === "darwin"
      ? ["dist", "Electron.app", "Contents", "MacOS", "Electron"]
      : ["dist", process.platform === "win32" ? "electron.exe" : "electron"];
  for (const base of [DESKTOP_ROOT, REPO_ROOT]) {
    try {
      const pkg = require_.resolve("electron/package.json", { paths: [base] });
      const abs = resolve(pkg, "..", ...tail);
      if (existsSync(abs)) return abs;
    } catch {
      // 该 base 下没有安装 electron，继续试下一个候选路径
    }
  }
  fail(
    "未找到 electron 可执行文件；请先在仓库安装依赖（pnpm install），或用 --electron 指定路径",
    EXIT.LAUNCH,
  );
  return "";
}

function spawnElectron(executable, workspacePath, devServerUrl) {
  const child = spawn(executable, [".", "--open-workspace", workspacePath], {
    cwd: DESKTOP_ROOT,
    stdio: "inherit",
    // 刻意不带 --inspect-brk：无调试器会挂起首行；remote-debugging-port=9229 由 dev 主进程自己开。
    env: { ...process.env, ELECTRON_RENDERER_URL: devServerUrl },
    windowsHide: true,
  });
  child.exitedAt = null;
  child.on("error", (error) => {
    child.exitedAt = child.exitedAt ?? Date.now();
    console.error(`${TAG} electron spawn 失败: ${error.message}`);
  });
  child.on("close", (code, signal) => {
    child.exitedAt = child.exitedAt ?? Date.now();
    child.exitInfo = `code=${code} signal=${signal}`;
  });
  activeChild = child;
  return child;
}

/** 等一个 child（转发进程）自行退出，带超时。 */
async function waitChildExit(child, timeoutMs) {
  if (child.exitedAt != null) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitedAt != null) return true;
    await sleep(200);
  }
  return false;
}

/**
 * 是否 renderer 页面 target。
 *
 * **不许按产品名匹配**（phase-0 findings.samplerTargetTitle）：旧实现用
 * `title === "ZCode"`，而本树 renderer/index.html 的 title 与 packages/desktop 的
 * productName 都是 "omz"，脚本原样跑必然退出码 5，基线只能靠临时改 document.title 绕过
 * ——那不是解决办法。判据改为「type=page 且 URL 指向 renderer」：
 *   - http(s)：与 dev server 同端口、且两边都是 loopback（localhost / 127.0.0.1 / [::1]）；
 *     dev server 报 localhost 而页面从 127.0.0.1 加载时仍应命中。
 *   - file：路径以 /index.html 结尾（打包后的 out/renderer/index.html）。
 */
function isRendererPageTarget(target, devServerUrl) {
  if (!target || target.type !== "page" || !target.webSocketDebuggerUrl) return false;
  const url = typeof target.url === "string" ? target.url : "";
  if (!url) return false;
  let pageUrl;
  let devUrl;
  try {
    pageUrl = new URL(url);
    devUrl = new URL(devServerUrl);
  } catch {
    return false;
  }
  if (pageUrl.protocol === "http:" || pageUrl.protocol === "https:") {
    const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
    return (
      pageUrl.port === devUrl.port &&
      loopback.has(pageUrl.hostname) &&
      loopback.has(devUrl.hostname)
    );
  }
  if (pageUrl.protocol === "file:") {
    return /\/index\.html?$/i.test(pageUrl.pathname);
  }
  return false;
}

async function waitForRendererTarget(port, timeoutMs, child, devServerUrl) {
  const listUrl = `http://127.0.0.1:${port}/json/list`;
  const deadline = Date.now() + timeoutMs;
  let lastReason = "尚未读取到 target 列表";
  const launchedAt = Date.now();

  while (Date.now() < deadline) {
    const res = await fetchJson(listUrl);
    if (res.ok && Array.isArray(res.data)) {
      const page = res.data.find((t) => isRendererPageTarget(t, devServerUrl));
      if (page) return page;
      lastReason = `列表内 ${res.data.length} 个 target，没有 URL 指向 renderer（${devServerUrl}）的 page`;
    } else {
      lastReason = res.reason;
    }

    // 自起实例秒退 = 单实例锁已有主进程占位（或启动失败），按失败处理。
    if (child && child.exitedAt != null) {
      const elapsed = child.exitedAt - launchedAt;
      const debugPortDisabled = process.env.ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT === "1";
      fail(
        [
          `electron 进程在 ${elapsed}ms 后退出（${child.exitInfo ?? "无退出码"}），但 ${port} 端口始终没有出现 renderer page target。`,
          "常见原因：已有 ZCode 实例占着 single-instance 锁（请先关掉旧实例，或加 --skip-launch 复用它）；",
          "或 desktop 主进程尚未构建出 out/main/index.js（先跑 .vscode 任务 `zcode: prepare desktop debug`）。",
          debugPortDisabled
            ? "注意：环境变量 ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT=1 会让 dev 实例不开 9229，请 unset。"
            : `最后探测结果：${lastReason}`,
        ].join("\n"),
        EXIT.LAUNCH,
      );
    }
    if (child && Date.now() - launchedAt < LAUNCH_EXIT_GRACE_MS) {
      console.error(`${TAG} 等待 electron 就绪（${lastReason}）...`);
    }
    await sleep(500);
  }

  const listed = await fetchJson(listUrl, 2_000);
  const titles =
    listed.ok && Array.isArray(listed.data)
      ? listed.data.map((t) => `${t.type}:${JSON.stringify(t.title)}@${t.url}`).join(", ")
      : `读取失败（${listed.reason}）`;
  fail(
    [
      `${Math.round(timeoutMs / 1000)}s 内未出现 URL 指向 renderer（${devServerUrl}）的 page target。`,
      `dev server(${devServerUrl}): ${(await probeHttpUrl(devServerUrl, 1_000)).ok ? "可达" : "不可达"}`,
      `现有 target: ${titles}`,
      "排查：确认 renderer dev server 已起、桌面窗口已打开、采样期 9229 未被 e2e（Chromedriver）占用。",
      "判定口径：type=page 且 URL 与 --dev-server-url 同端口（loopback）或 file://…/index.html；不按产品名匹配。",
    ].join("\n"),
    EXIT.TARGET,
  );
  return null;
}

// ---- 页面驱动原语（可见性 / 等待 / 点击）-------------------------------------

async function readVisibility(cdp) {
  try {
    return safeParse(await cdp.evaluate(VISIBILITY_EXPR));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 把页面切回 visible（rAF 降频的唯一开关），并回报三步 CDP 是否真的生效。
 *
 * 三步缺一不可：`Page.setWebLifecycleState("active")` 解除 frozen/occluded 生命周期，
 * `Emulation.setFocusEmulationEnabled` 让页面相信自己有焦点，`Page.bringToFront` 把窗口
 * 提到最前。任一步失败都在样本里留痕（`applied` 字段），不静默降级。
 */
async function ensurePageVisible(cdp) {
  const applied = {};
  for (const [method, params] of [
    ["Page.enable", {}],
    ["Emulation.setFocusEmulationEnabled", { enabled: true }],
    ["Page.bringToFront", {}],
    ["Page.setWebLifecycleState", { state: "active" }],
  ]) {
    try {
      await cdp.send(method, params);
      applied[method] = "ok";
    } catch (error) {
      applied[method] = error instanceof Error ? error.message : String(error);
    }
  }
  const visibility = await readVisibility(cdp);
  const visible = visibility.visibilityState === "visible" && visibility.hidden === false;
  if (!visible) {
    console.error(
      `${TAG} 警告: 页面仍不是 visible（visibilityState=${visibility.visibilityState ?? "?"}` +
        `，hidden=${visibility.hidden ?? "?"}）。rAF 会被降频、paintAfterApplyMs 不可信；` +
        "该样本会被标 visibility.contaminated=true，判读中位数时应剔除。",
    );
  }
  return { applied, visible, atSampling: visibility };
}

/** 轮询直到 predicate 返回 done=true；超时返回最后一次结果 + done=false。 */
async function waitFor(predicate, { timeoutMs, intervalMs = 100, label }) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last && last.done) return last;
    await sleep(intervalMs);
  }
  return { ...last, done: false, timeoutMs, label };
}

/** 等侧栏里的 testId 元素出现（列表懒渲染/切换 workspace 时会晚到），再派发点击。 */
async function clickTestId(cdp, testId, actionTimeoutMs) {
  const appeared = await waitFor(
    async () => {
      const present = safeParse(await cdp.evaluate(ELEMENT_PRESENT_EXPR(testId)));
      return { done: present.present === true };
    },
    { timeoutMs: actionTimeoutMs, label: `element:${testId}` },
  );
  if (!appeared.done) {
    return { ok: false, reason: "not-found", testId, waitedMs: actionTimeoutMs };
  }
  return safeParse(await cdp.evaluate(CLICK_TEST_ID_EXPR(testId)));
}

async function readTimelineState(cdp) {
  return safeParse(await cdp.evaluate(TIMELINE_STATE_EXPR));
}

/** 「切走」目标：`--park-session` 优先，否则取侧栏里第一条不同的 task-item（记录来源）。 */
async function resolveParkSession(cdp, targetSessionId, explicit) {
  if (explicit) return { id: explicit, source: "flag" };
  const listed = safeParse(await cdp.evaluate(LIST_TASK_ITEMS_EXPR));
  const ids = Array.isArray(listed.ids) ? listed.ids : [];
  const other = ids.find((id) => id !== targetSessionId);
  return other ? { id: other, source: "auto-from-sidebar" } : null;
}

const topicOf = (sessionId) => `conversation/${sessionId}`;

// ---- 采样 --------------------------------------------------------------------

async function readRendererEnv(cdp) {
  try {
    return JSON.parse(await cdp.evaluate(RENDERER_ENV_EXPR));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function safeParse(raw) {
  if (typeof raw !== "string") return { unexpectedDump: raw };
  try {
    return JSON.parse(raw);
  } catch (error) {
    return { parseError: error instanceof Error ? error.message : String(error), raw };
  }
}

/** 取当前页面上的会话打开分段（按目标会话取 ACK + runtimeReady query）；窗口面缺席时由调用方判 missing。 */
async function readOpenProbe(cdp, targetSessionId) {
  try {
    return safeParse(await cdp.evaluate(OPEN_PROBE_SAMPLE_EXPR(targetSessionId)));
  } catch (error) {
    return { mounted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 解析目标会话：`--session` 优先；否则取采样时间线所属 pane 的 `data-session-id`。
 *
 * draft pane（`data-session-id="draft"`）没有 subscribe，不能当目标；解析不出就交给
 * {@link evaluateOpenAcceptance} 判 missing，**绝不**退化成「环形缓冲最后一条」。
 */
async function resolveOpenProbeTarget(cdp, explicitSessionId) {
  const info = safeParse(await cdp.evaluate(OPEN_PROBE_TARGET_EXPR));
  const ownerSessionId =
    typeof info.ownerSessionId === "string" && info.ownerSessionId.length > 0
      ? info.ownerSessionId
      : null;
  const paneSessionIds = Array.isArray(info.paneSessionIds) ? info.paneSessionIds : [];
  const fromPane = ownerSessionId && ownerSessionId !== "draft" ? ownerSessionId : null;
  const sessionId = explicitSessionId || fromPane;
  return {
    sessionId: sessionId || null,
    // 与 `conversationTopic()` 同构，仅用于日志与判读。
    topic: sessionId ? `conversation/${sessionId}` : null,
    source: explicitSessionId ? "flag" : fromPane ? "pane" : "unresolved",
    ownerSessionId,
    paneSessionIds,
  };
}

/**
 * 验收指标是否采到（cr-func N2 + phase-0 C3）。
 *
 * 只判「有没有采到」，不判三档阈值——场景（冷开/热开/切回）与阈值在 spec
 * phase-0-baseline 里，脚本没有足够信息替它下结论。但缺验收指标必须能被发现：
 * 否则 baseline 会在「没有验收数」的情况下静默成功落盘。
 *
 * 判据（spec phase-0-baseline，2026-10-25 C3 改）：
 *   - **主判** `uiViewReadyMs - hostPrepareMs ≤ 1s`（`hostSideViewMs`）。`hostPrepareMs`
 *     是 subscribe 入口 → cliRequest 发起，实测冷开 1578~1776ms / 热开 live 2~3ms，
 *     区分度足够，且它**必然覆盖** spawn。
 *   - 并列分解项 `uiViewReadyMs - cliBootstrapMs`（`viewSideMs`）。这一项依赖
 *     `cliBootstrapMs` 的诚实度：旧树用 `getExistingClient()` 非空判 reused，spawn 被埋进
 *     hostPrepareMs、cliBootstrapMs 恒缺席；本树已改为按进程事实判定
 *     （packages/services/src/zcode-agent/cliBootstrapObservation.ts）。
 */
function evaluateOpenAcceptance(sample, target) {
  const base = {
    targetSessionId: target.sessionId,
    targetTopic: target.topic,
    targetSource: target.source,
  };
  if (!target.sessionId) {
    return { ...base, verdict: "missing", reason: "target-session-unresolved" };
  }
  if (!sample || sample.mounted !== true) {
    return {
      ...base,
      verdict: "missing",
      reason: "probe-unmounted",
      ...(sample?.error ? { error: sample.error } : {}),
    };
  }
  const ack = sample.targetAck ?? null;
  if (!ack) {
    return { ...base, verdict: "missing", reason: "no-ack-for-target" };
  }
  const renderer = ack.renderer ?? null;
  const uiViewReadyMs =
    typeof renderer?.uiViewReadyMs === "number" ? renderer.uiViewReadyMs : undefined;
  if (uiViewReadyMs === undefined) {
    return { ...base, verdict: "missing", reason: "renderer-ui-view-ready-missing" };
  }
  const cliBootstrapMs =
    typeof ack.openTiming?.cliBootstrapMs === "number" ? ack.openTiming.cliBootstrapMs : undefined;
  const hostPrepareMs =
    typeof ack.openTiming?.hostPrepareMs === "number" ? ack.openTiming.hostPrepareMs : undefined;
  // 首绘缺席原因（closed / generation_changed）：由 renderer 侧丢弃时写进观测面，
  // 缺席有原因才谈得上「凑不齐」而不是「还没到」。
  const paintMissing = sample.paintMissing?.reason ?? null;
  return {
    ...base,
    verdict: "present",
    reason: null,
    uiViewReadyMs,
    paintAfterApplyMs:
      typeof renderer?.paintAfterApplyMs === "number" ? renderer.paintAfterApplyMs : undefined,
    paintMissingReason: paintMissing,
    // 到首绘的体感总量只在 paint 采到时存在（缺席 ≠ 0）。
    uiViewReadyToPaintMs:
      typeof renderer?.paintAfterApplyMs === "number"
        ? uiViewReadyMs + renderer.paintAfterApplyMs
        : undefined,
    cliBootstrapMs,
    cliProcessState: ack.openTiming?.cliProcessState ?? null,
    hostPrepareMs,
    // 清单账目修正（Step 7）：true = 本次冷开就地改过 row_count（live 与 cold 的行数分布
    // 还在分叉）；false = 清单可用且无偏差；**null = 没走清单**（降级 / 宿主无读端口）。
    // 三态不是为了好看：把它折成布尔会把「没读清单」说成「清单没偏差」。
    manifestAdjusted:
      typeof ack.openPhases?.manifestAdjusted === "boolean"
        ? ack.openPhases.manifestAdjusted
        : null,
    primaryCriterion: "uiViewReadyMs - hostPrepareMs",
    hostSideViewMs:
      hostPrepareMs === undefined ? undefined : Math.max(0, uiViewReadyMs - hostPrepareMs),
    secondaryCriterion: "uiViewReadyMs - cliBootstrapMs",
    viewSideMs:
      cliBootstrapMs === undefined ? undefined : Math.max(0, uiViewReadyMs - cliBootstrapMs),
    ackAt: ack.at ?? null,
  };
}

function logOpenProbe(label, sample, acceptance) {
  if (!sample || sample.mounted !== true) {
    console.error(
      `${TAG} ${label}: 会话打开观测面未挂载（旧 renderer 或非 dev 构建）` +
        `${sample?.error ? `（${sample.error}）` : ""}，无法采验收指标`,
    );
    return;
  }
  const ack = sample.targetAck;
  if (!ack) {
    console.error(
      `${TAG} ${label}: 目标会话 ${sample.targetTopic ?? "（未解析）"} 没有 subscribe ACK 样本` +
        `（缓冲内 ${sample.acks?.length ?? 0} 条；先打开该会话再采样，或用 --session 指定）`,
    );
    return;
  }
  const phases = ack.openPhases ? JSON.stringify(ack.openPhases) : "{}";
  // 验收基准是 renderer 侧总量 uiViewReadyMs；openPhases.viewReadyMs 只是 CLI 进程内一段
  // （不含 host 准备 / CLI spawn / RPC 往返 / 渲染），两者不可互换、也不可相减。
  const rendererReady = ack.renderer
    ? `uiViewReadyMs=${ack.renderer.uiViewReadyMs ?? "null"} paintAfterApplyMs=${
        ack.renderer.paintAfterApplyMs ?? "null"
      }${acceptance?.paintMissingReason ? `(paint_missing=${acceptance.paintMissingReason})` : ""}`
    : "uiViewReadyMs=unavailable";
  const spawn =
    `cliBootstrapMs=${ack.openTiming?.cliBootstrapMs ?? "absent"}` +
    `/cliProcessState=${ack.openTiming?.cliProcessState ?? "unknown"}` +
    `/hostPrepareMs=${ack.openTiming?.hostPrepareMs ?? "absent"}` +
    `/主判=${acceptance?.hostSideViewMs ?? "n/a"}(uiViewReady-hostPrepare)` +
    `/并列=${acceptance?.viewSideMs ?? "n/a"}(uiViewReady-cliBootstrap)`;
  const runtime = sample.runtimeReady
    ? `runtimeReadyMs=${sample.runtimeReady.runtimeReadyMs ?? "null"} runtimeReady=${
        sample.runtimeReady.runtimeReady
      }`
    : `runtimeReady=unavailable${sample.runtimeReadyError ? `（${sample.runtimeReadyError}）` : ""}`;
  console.log(
    `${TAG} ${label}: topic=${ack.topic} ${rendererReady} ${spawn}` +
      `/manifestAdjusted=${acceptance?.manifestAdjusted ?? "absent"} openPhases=${phases} ${runtime}` +
      `（ACK 样本 ${sample.acks?.length ?? 0} 条，verdict=${acceptance?.verdict ?? "?"}）`,
  );
}

async function sampleSegment(cdp, name, { durationMs, drive }) {
  // 每个窗口前都重新强制 visible：采样期窗口可能被别的窗口盖住（rAF 会被夹到 1s）。
  const visibility = await ensurePageVisible(cdp);
  await cdp.evaluate(PROBE_RESET_EXPR);
  let driverInfo = null;
  let driverStarted = false;
  if (drive) {
    const raw = await cdp.evaluate(drive.start);
    driverInfo = safeParse(raw);
    driverStarted = driverInfo.ok !== false;
    if (!driverStarted) {
      console.error(
        `${TAG} ${name} 驱动未启动: ${driverInfo.reason ?? JSON.stringify(driverInfo)}`,
      );
    } else if (driverInfo.maxScrollTop === 0) {
      console.error(
        `${TAG} 警告: ${name} 窗口的滚动容器不可滚动（maxScrollTop=0）。`,
        "基线会失真——请先在窗口里打开长会话；若会话列表有独立滚动容器，用 --scroll-selector 指定。",
      );
    }
  }
  const driveNote = !drive
    ? "（流式窗口：脚本不驱动，请在窗口期手动触发长输出）"
    : driverStarted
      ? "（滚动驱动已启动）"
      : "（滚动驱动启动失败，本窗口没有滚动负载）";
  console.log(`${TAG} ${name} 窗口开始，时长 ${durationMs}ms${driveNote}`);
  const startedAt = new Date().toISOString();
  await sleep(durationMs);
  if (drive) {
    driverInfo = { ...driverInfo, ...safeParse(await cdp.evaluate(SCROLL_STOP_EXPR)) };
  }
  const dumped = safeParse(await cdp.evaluate(PROBE_DUMP_EXPR));
  const rendererEnv = await readRendererEnv(cdp);
  const visibilityAfter = await readVisibility(cdp);
  // 长会话双判据：DOM 常驻的 totalRowCount 与滚动余量 maxScrollTop，
  // 不用 [data-row-id] 计数（虚拟化下永远只有可视区几行）。
  const totalRowCount = rendererEnv.totalRowCount ?? 0;
  const windowRowCount = rendererEnv.windowRowCount ?? 0;
  const domRowCount = rendererEnv.rowCount ?? 0;
  const maxScrollTop = Math.max(rendererEnv.maxScrollTop ?? 0, driverInfo?.maxScrollTop ?? 0);
  const longSessionOk =
    totalRowCount >= LONG_SESSION_MIN_TOTAL_ROWS || maxScrollTop >= LONG_SESSION_MIN_MAX_SCROLL_TOP;
  if (!longSessionOk) {
    console.error(
      `${TAG} 警告: ${name} 窗口未检出长会话` +
        `（data-total-row-count=${totalRowCount} < ${LONG_SESSION_MIN_TOTAL_ROWS}，` +
        `maxScrollTop=${maxScrollTop} < ${LONG_SESSION_MIN_MAX_SCROLL_TOP}）。`,
      "采样不代表真实负载——请先在窗口里打开长会话再重跑；虚拟化下 [data-row-id] 计数不参与该判据。",
    );
  }
  console.log(`${TAG} ${name} 窗口结束，已取回 dump`);
  return {
    name,
    startedAt,
    durationMs,
    driverInfo,
    rendererEnv,
    visibility: {
      contaminated: visibility.visible !== true || visibilityAfter.hidden === true,
      before: visibility,
      after: visibilityAfter,
    },
    longSession: {
      ok: longSessionOk,
      totalRowCount,
      windowRowCount,
      domRowCount,
      maxScrollTop,
      thresholds: {
        minTotalRowCount: LONG_SESSION_MIN_TOTAL_ROWS,
        minMaxScrollTop: LONG_SESSION_MIN_MAX_SCROLL_TOP,
      },
    },
    probe: dumped,
  };
}

/**
 * 契约 2 + 3：拿到 renderer page target（复用或自起）。
 *
 * 复用判定：9229 可达 → 复用（--skip-launch 直接复用；否则转发 --open-workspace 深链），
 * 不可达 → 自行 spawn。路径模式冷开时由调用方先确认 9229 不可达再进这里（每次迭代
 * kill 自己 spawn 的进程树后重进），所以本函数不承担「冷」的语义。
 */
async function acquirePageTarget(options, workspacePath) {
  const cdpBase = `http://127.0.0.1:${options.cdpPort}`;
  const running = await fetchJson(`${cdpBase}/json/version`);
  let child = null;
  let mode;
  // resolveElectronExecutable 的结果缓存：报告构造阶段直接复用，不再二次调用解析
  // （采样成功但报告写不出的问题——解析在报告期失败会导致整个报告丢失）。
  let resolvedExecutable = null;
  if (running.ok) {
    if (options.skipLaunch) {
      mode = "reuse-skip-launch";
      console.log(`${TAG} 检测到已运行实例（${cdpBase}），按 --skip-launch 复用`);
    } else {
      mode = "reuse-forward-deep-link";
      const executable = resolveElectronExecutable(options.electron);
      resolvedExecutable = executable;
      console.log(`${TAG} 检测到已运行实例，转发 --open-workspace 深链: ${workspacePath}`);
      child = spawnElectron(executable, workspacePath, options.devServerUrl);
      const exited = await waitChildExit(child, FORWARDER_EXIT_TIMEOUT_MS);
      if (exited) {
        console.log(
          `${TAG} 深链转发进程已退出（${child.exitInfo ?? "code=0"}），等待既有实例加载 workspace`,
        );
      } else {
        // 不直接判失败：既有实例是否真收到深链只能从 target 侧观察；
        // 残留的转发进程会在后续任一失败路径上被 killStrayChild 回收。
        console.error(
          `${TAG} 警告: 深链转发进程 ${FORWARDER_EXIT_TIMEOUT_MS}ms 内未退出（pid=${child.pid}）。`,
          "若既有实例没收到 workspace 深链，它可能是一个野的第二实例；采样失败时会自动回收。",
        );
      }
    }
  } else if (options.skipLaunch) {
    fail(
      `--skip-launch 指定了复用模式，但 ${cdpBase}/json/version 不可达（${running.reason}），没有可复用的实例。`,
      EXIT.LAUNCH,
    );
  } else {
    mode = "launch";
    const executable = resolveElectronExecutable(options.electron);
    resolvedExecutable = executable;
    console.log(`${TAG} 启动 dev 实例: ${executable} . --open-workspace ${workspacePath}`);
    child = spawnElectron(executable, workspacePath, options.devServerUrl);
  }

  const target = await waitForRendererTarget(
    options.cdpPort,
    options.readyTimeoutMs,
    mode === "launch" ? child : null,
    options.devServerUrl,
  );
  console.log(`${TAG} target 就绪: type=${target.type} url=${target.url} title=${target.title}`);
  return { target, child, mode, resolvedExecutable };
}

// ---- 会话打开路径（--path）---------------------------------------------------
//
// 四路径的定义沿用 phase-0 baseline：
//   cold        app 与 CLI 都不在：kill 整棵 electron 树 → 冷启 → 点开目标会话。
//               每一轮都要重新冷启（CLI agent 是 app 的子进程，随树一起消失）。
//   warm        CLI 进程已在、目标会话在 renderer 侧没有 store：已打开则切走 + 等
//               keep-warm 过期 → 点开。
//   reopen      同会话打开过 → 切走 → 等 keep-warm 过期 → 再点开（有 ACK）。
//   switchback  目标 A 已打开 → 切到 B → 短时间内切回 A（命中 keep-warm，**不应有新 ACK**）。
//
// 「关闭会话」在 UI 上就是点另一个会话：旧 pane 卸载、旧 store 进 keep-warm。不新造关闭入口，
// 也不改 keep-warm 时长——那属于产品语义，本轮只做观测层与采样脚本。

/** 回收一棵 electron 进程树（win32 必须 /T /F，否则 renderer/utility 残留占着 9229）。 */
function killChildTree(child) {
  if (!child || child.exitedAt != null) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill();
    }
  } catch {
    // kill 失败只作提示，不覆盖原始错误
  }
}

async function waitForCdpPortClosed(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = await fetchJson(`http://127.0.0.1:${port}/json/version`, 800);
    if (!running.ok) return true;
    await sleep(300);
  }
  return false;
}

/** 冷开的每一轮之间必须先把上一轮实例收干净，否则下一轮会复用它的 CLI 进程。 */
async function teardownInstance(child, options) {
  if (!child) return { killed: false };
  const pid = child.pid;
  killChildTree(child);
  const portClosed = await waitForCdpPortClosed(options.cdpPort, 20_000);
  return { killed: true, pid, cdpPortClosed: portClosed };
}

/**
 * 等会话打开观测面挂载。
 *
 * 必须**轮询**而不是连上 CDP 就断言：冷开时 page target 出现在 renderer bundle 求值之前
 * （实测连上时 title 还是空的、window 面尚未挂载），立即断言会把「还没加载完」误报成
 * 「观测面不存在」（退出码 6）。
 */
async function assertOpenProbeMounted(cdp, timeoutMs) {
  const waited = await waitFor(
    async () => {
      const info = safeParse(await cdp.evaluate(OPEN_PROBE_CHECK_EXPR));
      return { done: info.mounted === true, info };
    },
    { timeoutMs, intervalMs: 200, label: "open-probe-mount" },
  );
  if (waited.done !== true) {
    fail(
      [
        "会话打开观测面 window.__zcodeV4ConversationOpensE2E 未挂载，路径模式无法采样本。",
        `（已等待 ${timeoutMs}ms）`,
        "该面由 packages/ui/src/v4/conversationOpenObservability.ts 提供，只在 vite dev 构建挂载；",
        "若是复用既有实例，需重启该实例让新 renderer 生效。",
      ].join("\n"),
      EXIT.PROBE,
    );
  }
  return waited.info ?? { mounted: true, methods: [] };
}

/**
 * 目标 workspace 的会话行必须先在侧栏渲染出来。
 *
 * 顺序很重要：**先等**（冷启时 app 刚起，侧栏是异步渲染的，立刻断言会误判「不在」），
 * 等不到才点一次 workspace tab（复用既有 testId）把它带出来。激活 workspace tab 本身可能
 * 触发该 workspace 的 workspace-init / CLI 预热——那会让「冷开」样本失去语义，所以这一步
 * 要**记进报告**（`activatedWorkspaceTab`），而不是悄悄做掉。
 */
async function ensureTargetRowVisible(cdp, options, workspacePath) {
  const testId = `${TASK_ITEM_TEST_ID_PREFIX}${options.session.trim()}`;
  const appeared = await waitFor(
    async () => {
      const present = safeParse(await cdp.evaluate(ELEMENT_PRESENT_EXPR(testId)));
      return { done: present.present === true };
    },
    { timeoutMs: options.actionTimeoutMs, intervalMs: 250, label: `target-row:${testId}` },
  );
  if (appeared.done === true) return { activatedWorkspaceTab: false, waitedMs: null };
  const workspaceTestId = `workspace-item-${workspacePath}`;
  const clicked = await clickTestId(cdp, workspaceTestId, options.actionTimeoutMs);
  console.log(
    `${TAG} 目标行等了 ${options.actionTimeoutMs}ms 仍未出现在侧栏，激活 workspace tab ` +
      `${workspaceTestId}：${clicked.ok === true ? "ok" : clicked.reason}`,
  );
  const afterActivation = await waitFor(
    async () => {
      const present = safeParse(await cdp.evaluate(ELEMENT_PRESENT_EXPR(testId)));
      return { done: present.present === true };
    },
    {
      timeoutMs: options.actionTimeoutMs,
      intervalMs: 250,
      label: `target-row-after-activate:${testId}`,
    },
  );
  return {
    activatedWorkspaceTab: clicked.ok === true,
    waitedMs: options.actionTimeoutMs,
    detail: clicked,
    rowPresentAfterActivation: afterActivation.done === true,
  };
}

function summarizeOpenSample(sample) {
  if (!sample || sample.mounted !== true) return sample ?? null;
  return {
    mounted: true,
    capturedAt: sample.capturedAt ?? null,
    targetTopic: sample.targetTopic ?? null,
    ackCount: Array.isArray(sample.acks) ? sample.acks.length : 0,
    targetAck: sample.targetAck ?? null,
    paintMissing: sample.paintMissing ?? null,
    runtimeReady: sample.runtimeReady ?? null,
    runtimeReadyError: sample.runtimeReadyError ?? null,
  };
}

/** 等目标 pane 真的挂上（时间线归属切到目标且已有行）；用于 prime 与切回判定之外的开会话。 */
async function waitForPaneBound(cdp, sessionId, timeoutMs, label) {
  return await waitFor(
    async () => {
      const state = await readTimelineState(cdp);
      return {
        done: state.ownerSessionId === sessionId && state.totalRowCount > 0,
        state,
      };
    },
    { timeoutMs, intervalMs: 100, label },
  );
}

/** 打开目标会话（prime）：只要求 pane 挂上，不要求 ACK（keep-warm 命中时本来就没有 ACK）。 */
async function primeTarget(cdp, sessionId, options, run, actionName) {
  const state = await readTimelineState(cdp);
  if (state.ownerSessionId === sessionId && state.totalRowCount > 0) {
    run.actions.push({ name: actionName, skipped: "already-open", sessionId });
    return {};
  }
  const click = await clickTestId(
    cdp,
    `${TASK_ITEM_TEST_ID_PREFIX}${sessionId}`,
    options.actionTimeoutMs,
  );
  run.actions.push({ name: actionName, sessionId, click });
  if (click.ok !== true) {
    return { failure: { kind: "click-session", sessionId, detail: click } };
  }
  const bound = await waitForPaneBound(cdp, sessionId, options.ackTimeoutMs, `prime:${sessionId}`);
  if (!bound.done) {
    return { failure: { kind: "pane-not-bound", sessionId, timeoutMs: options.ackTimeoutMs } };
  }
  return {};
}

/**
 * 若目标会话当前已打开则切走，并等 renderer keep-warm 过期。
 *
 * 为什么必须等：`SessionDataLayer` 的 30s keep-warm 未过期时，再点开会**直接复用 store**，
 * 不发起 subscribe、不产生 ACK（sessionDataLayer.ts:28,70-89）。不等就只能采到「没有样本」。
 */
async function dismissTargetIfOpen(cdp, targetSessionId, options, park, run) {
  const state = await readTimelineState(cdp);
  const isOpen =
    state.ownerSessionId === targetSessionId ||
    (Array.isArray(state.paneSessionIds) && state.paneSessionIds.includes(targetSessionId));
  if (!isOpen) {
    run.actions.push({ name: "close", skipped: "not-open" });
    return {};
  }
  if (!park) {
    return {
      failure: {
        kind: "no-park-session",
        message:
          "目标会话当前已打开，但没有可切换的其它会话：请用 --park-session 指定，" +
          "或让侧栏里存在第二条 task-item（脚本会按 DOM 顺序自动挑一条）。",
      },
    };
  }
  const click = await clickTestId(
    cdp,
    `${TASK_ITEM_TEST_ID_PREFIX}${park.id}`,
    options.actionTimeoutMs,
  );
  run.actions.push({ name: "close", via: park.id, click });
  if (click.ok !== true) {
    return { failure: { kind: "click-park-session", park, detail: click } };
  }
  const unmounted = await waitFor(
    async () => {
      const next = await readTimelineState(cdp);
      return {
        done: !(
          Array.isArray(next.paneSessionIds) && next.paneSessionIds.includes(targetSessionId)
        ),
        state: next,
      };
    },
    { timeoutMs: options.actionTimeoutMs, label: `unmount:${targetSessionId}` },
  );
  if (!unmounted.done) {
    return { failure: { kind: "session-not-unmounted", targetSessionId, detail: unmounted.state } };
  }
  if (options.keepWarmWaitMs > 0) {
    console.log(
      `${TAG} 等 renderer keep-warm 过期 ${options.keepWarmWaitMs}ms（否则再点开不产生 ACK）`,
    );
    await sleep(options.keepWarmWaitMs);
    run.actions.push({ name: "wait-keep-warm", ms: options.keepWarmWaitMs });
  }
  return {};
}

/**
 * 测一次打开：清 ACK 环 → 点目标行 → 等 ACK → 等首绘落地/明确缺席 → 取样本。
 *
 * 每次采前都 reset：不清会读到上一次打开的同 topic 样本（基线就是靠外部脚本手工 reset 的）。
 */
async function measureOpen(cdp, options, run) {
  const targetSessionId = options.session.trim();
  const topic = topicOf(targetSessionId);
  // 采前现场：pane 里已挂载哪些会话。冷开若发现目标 workspace 的会话已在挂载，说明启动恢复
  // 的并发 subscribe 已经把 CLI 拉起来了——这正是 cliProcessState 记 reused 的可复核证据。
  run.preOpenPane = await readTimelineState(cdp);
  await cdp.evaluate(OPEN_PROBE_RESET_EXPR);
  run.actions.push({ name: "reset-open-probe" });

  const click = await clickTestId(
    cdp,
    `${TASK_ITEM_TEST_ID_PREFIX}${targetSessionId}`,
    options.actionTimeoutMs,
  );
  run.actions.push({ name: "open", click });
  if (click.ok !== true) {
    return { ...run, ok: false, failure: { kind: "click-target", detail: click } };
  }

  const ackWait = await waitFor(
    async () => {
      const state = safeParse(await cdp.evaluate(OPEN_PROBE_ACK_STATE_EXPR(topic)));
      return { done: state.mounted === true && state.ackAt != null, state };
    },
    { timeoutMs: options.ackTimeoutMs, intervalMs: 100, label: "ack" },
  );
  run.ackWait = ackWait.state ?? null;
  // click 与 ACK 的 at 都是**页面内 Date.now**，同一时钟可直接相减；只作驱动耗时参考，
  // 不是验收量（验收量是 renderer 单调时钟的 uiViewReadyMs）。
  run.clickToAckMs =
    typeof ackWait.state?.ackAt === "number" && typeof click.dispatchedAt === "number"
      ? Math.max(0, ackWait.state.ackAt - click.dispatchedAt)
      : null;
  if (!ackWait.done) {
    return {
      ...run,
      ok: false,
      failure: {
        kind: "ack-timeout",
        timeoutMs: options.ackTimeoutMs,
        lastState: ackWait.state ?? null,
      },
    };
  }

  // 首绘比 ACK 晚两帧：不等就立刻读，会把存在的 paintAfterApplyMs 读成缺席（旧脚本的坑）。
  const paintWait = await waitFor(
    async () => {
      const state = safeParse(await cdp.evaluate(OPEN_PROBE_ACK_STATE_EXPR(topic)));
      return { done: state.paintAfterApplyMs != null || state.paintMissing != null, state };
    },
    { timeoutMs: options.paintGraceMs, intervalMs: 50, label: "paint" },
  );
  run.paintWait = paintWait.state ?? null;

  const sample = await readOpenProbe(cdp, targetSessionId);
  const visibilityAfter = await readVisibility(cdp);
  run.visibility.afterAck = visibilityAfter;
  if (visibilityAfter.visibilityState !== "visible" || visibilityAfter.hidden === true) {
    run.visibility.contaminated = true;
  }
  const acceptance = evaluateOpenAcceptance(sample, {
    sessionId: targetSessionId,
    topic,
    source: "flag",
  });
  run.sample = summarizeOpenSample(sample);
  run.acceptance = acceptance;
  run.timeline = await readTimelineState(cdp);
  run.warnings = [];
  if (options.path === "cold" && acceptance.cliProcessState !== "spawned") {
    // 冷开的前置条件「CLI 未起」不成立时，数字本身没错，但它不是冷开样本。**不能**标
    // present：那会让一个 warm 样本混进冷开中位数。置 precondition-violated（退出码 8），
    // 数值仍留在样本里供诊断。
    run.warnings.push(
      `冷开的 cliProcessState=${acceptance.cliProcessState ?? "unknown"}（应为 spawned）：` +
        "这次不是冷开，样本作废（目标 workspace 的 CLI 在本轮打开前已被拉起）",
    );
    run.acceptance = { ...acceptance, verdict: "precondition-violated" };
  }
  if (options.path === "warm" && acceptance.cliProcessState === "spawned") {
    run.warnings.push(
      `热开样本里 cliProcessState=spawned（cliBootstrapMs=${acceptance.cliBootstrapMs ?? "absent"}）：` +
        "这次打开含 CLI spawn，按 spec 的 warm 定义不算热开，判读时要归到含 spawn 的 regime",
    );
  }
  if (acceptance.paintAfterApplyMs === undefined) {
    run.warnings.push(
      `paintAfterApplyMs 缺席（paint_missing=${acceptance.paintMissingReason ?? "未记录/仍在两帧窗口内"}）`,
    );
  }
  return { ...run, ok: true };
}

/** 切回：清环 → 页面内打点 → 点回目标 → 等 pane 绑定 → 断言无新 ACK。 */
async function measureSwitchback(cdp, options, run) {
  const targetSessionId = options.session.trim();
  const topic = topicOf(targetSessionId);
  if (!run.park) {
    return {
      ...run,
      ok: false,
      failure: {
        kind: "no-park-session",
        message: "switchback 需要第二个会话（--park-session，或侧栏里另一条 task-item）。",
      },
    };
  }
  const primedTarget = await primeTarget(cdp, targetSessionId, options, run, "prime-target");
  if (primedTarget.failure) return { ...run, ok: false, failure: primedTarget.failure };
  const primedPark = await primeTarget(cdp, run.park.id, options, run, "prime-park");
  if (primedPark.failure) return { ...run, ok: false, failure: primedPark.failure };

  // 环在切回前清空：此后出现的任何该 topic ACK 都必然是「切回」产生的。
  await cdp.evaluate(OPEN_PROBE_RESET_EXPR);
  run.actions.push({ name: "reset-open-probe" });
  const ackBefore = safeParse(await cdp.evaluate(OPEN_PROBE_ACK_STATE_EXPR(topic)));
  await cdp.evaluate(SWITCHBACK_PROBE_START_EXPR(targetSessionId));
  const click = await clickTestId(
    cdp,
    `${TASK_ITEM_TEST_ID_PREFIX}${targetSessionId}`,
    options.actionTimeoutMs,
  );
  run.actions.push({ name: "switch-back", click });
  if (click.ok !== true) {
    await cdp.evaluate(SWITCHBACK_PROBE_CLEAR_EXPR);
    return { ...run, ok: false, failure: { kind: "click-target", detail: click } };
  }
  const boundWait = await waitFor(
    async () => {
      const probe = safeParse(await cdp.evaluate(SWITCHBACK_PROBE_READ_EXPR));
      return { done: probe.boundAt != null, probe };
    },
    { timeoutMs: options.ackTimeoutMs, intervalMs: 50, label: "switch-back" },
  );
  await cdp.evaluate(SWITCHBACK_PROBE_CLEAR_EXPR);
  const ackAfter = safeParse(await cdp.evaluate(OPEN_PROBE_ACK_STATE_EXPR(topic)));
  const visibilityAfter = await readVisibility(cdp);
  run.visibility.afterAck = visibilityAfter;
  if (visibilityAfter.visibilityState !== "visible" || visibilityAfter.hidden === true) {
    run.visibility.contaminated = true;
  }
  const switchback = {
    switchMs: boundWait.probe?.switchMs ?? null,
    timelineRows: boundWait.probe?.timelineRows ?? null,
    polls: boundWait.probe?.polls ?? null,
    ackCountAfterReset: ackBefore.ackCount ?? null,
    newAckAfterSwitch:
      ackAfter.ackAt != null
        ? { at: ackAfter.ackAt, mode: ackAfter.ackMode, uiViewReadyMs: ackAfter.uiViewReadyMs }
        : null,
    noNewAck: ackAfter.ackAt == null,
    measurement:
      "页面内 performance.now 打点（点击派发前）→ 25ms 轮询到 pane 的 data-session-id === 目标且 v4-timeline total-row-count > 0；含同步 React commit 与首屏行渲染，不含点击前的浏览器输入排队",
  };
  run.switchback = switchback;
  run.timeline = await readTimelineState(cdp);
  run.warnings = [];
  run.acceptance = {
    verdict: switchback.noNewAck && boundWait.done ? "not-applicable" : "keep-warm-broken",
    reason: "keep-warm 命中时不发生 subscribe，uiViewReadyMs 没有生产者（spec 三档表的豁免项）",
    switchMs: switchback.switchMs,
    noNewAck: switchback.noNewAck,
  };
  if (!boundWait.done) {
    return {
      ...run,
      ok: false,
      failure: { kind: "switchback-pane-not-bound", timeoutMs: options.ackTimeoutMs },
    };
  }
  if (!switchback.noNewAck) {
    return {
      ...run,
      ok: false,
      failure: {
        kind: "switchback-produced-ack",
        detail: switchback.newAckAfterSwitch,
        message:
          "切回产生了新 ACK：keep-warm 已过期，这次不是 keep-warm 切回（样本不可用于该判据）",
      },
    };
  }
  return { ...run, ok: true };
}

async function sampleOpenPathOnce(cdp, options, { park, runIndex }) {
  const targetSessionId = options.session.trim();
  const run = {
    runIndex,
    path: options.path,
    startedAt: new Date().toISOString(),
    targetSessionId,
    park: park ? { id: park.id, source: park.source } : null,
    actions: [],
  };
  const visibilityBefore = await readVisibility(cdp);
  const visibilityStep = await ensurePageVisible(cdp);
  run.visibility = {
    contaminated: visibilityStep.visible !== true,
    applied: visibilityStep.applied,
    beforeActions: visibilityBefore,
    afterEnsureVisible: visibilityStep.atSampling,
  };
  if (options.path === "switchback") {
    const result = await measureSwitchback(cdp, options, run);
    result.finishedAt = new Date().toISOString();
    return result;
  }
  if (options.path !== "cold") {
    // reopen 的顺序是「先打开过 → 再切走 → 等 keep-warm 过期」；warm 只要求当前没打开。
    if (options.path === "reopen") {
      const primed = await primeTarget(cdp, targetSessionId, options, run, "prime-target");
      if (primed.failure) {
        return { ...run, ok: false, failure: primed.failure, finishedAt: new Date().toISOString() };
      }
    }
    const dismissed = await dismissTargetIfOpen(cdp, targetSessionId, options, park, run);
    if (dismissed.failure) {
      return {
        ...run,
        ok: false,
        failure: dismissed.failure,
        finishedAt: new Date().toISOString(),
      };
    }
  }
  const result = await measureOpen(cdp, options, run);
  result.finishedAt = new Date().toISOString();
  return result;
}

function logOpenPathRun(run) {
  const a = run.acceptance ?? {};
  const parts = [
    `run#${run.runIndex} path=${run.path}`,
    `verdict=${a.verdict ?? "?"}`,
    `uiViewReadyMs=${a.uiViewReadyMs ?? "absent"}`,
    `hostPrepareMs=${a.hostPrepareMs ?? "absent"}`,
    `cliBootstrapMs=${a.cliBootstrapMs ?? "absent"}/${a.cliProcessState ?? "?"}`,
    `主判(uiViewReady-hostPrepare)=${a.hostSideViewMs ?? "n/a"}`,
    `并列(uiViewReady-cliBootstrap)=${a.viewSideMs ?? "n/a"}`,
    `paint=${a.paintAfterApplyMs ?? "absent"}${a.paintMissingReason ? `(paint_missing=${a.paintMissingReason})` : ""}`,
    `clickToAck=${run.clickToAckMs ?? "n/a"}`,
    `visibility=${run.visibility?.contaminated ? "contaminated" : "ok"}`,
  ];
  if (run.switchback) {
    parts.push(
      `switchMs=${run.switchback.switchMs ?? "n/a"}`,
      `newAck=${run.switchback.newAckAfterSwitch ? "yes" : "no"}`,
    );
  }
  console.log(`${TAG} ${parts.join(" ")}`);
  for (const warning of run.warnings ?? []) console.warn(`${TAG}   警告: ${warning}`);
  if (run.failure) console.error(`${TAG}   动作失败: ${JSON.stringify(run.failure)}`);
}

function summarizeOpenPath(runs) {
  const present = runs.filter((run) => run.acceptance?.verdict === "present");
  const numbers = (pick) => present.map(pick).filter((value) => typeof value === "number");
  return {
    runs: runs.length,
    present: present.length,
    verdicts: runs.map((run) => run.acceptance?.verdict ?? null),
    uiViewReadyMs: numbers((run) => run.acceptance?.uiViewReadyMs),
    hostPrepareMs: numbers((run) => run.acceptance?.hostPrepareMs),
    cliBootstrapMs: numbers((run) => run.acceptance?.cliBootstrapMs),
    hostSideViewMs: numbers((run) => run.acceptance?.hostSideViewMs),
    viewSideMs: numbers((run) => run.acceptance?.viewSideMs),
    paintAfterApplyMs: numbers((run) => run.acceptance?.paintAfterApplyMs),
    uiViewReadyToPaintMs: numbers((run) => run.acceptance?.uiViewReadyToPaintMs),
    clickToAckMs: runs.map((run) => run.clickToAckMs).filter((value) => typeof value === "number"),
    cliProcessState: runs.map((run) => run.acceptance?.cliProcessState ?? null),
    paintMissing: runs.map((run) => run.acceptance?.paintMissingReason ?? null),
    contaminatedRuns: runs.filter((run) => run.visibility?.contaminated).length,
    switchback: runs.map((run) => run.switchback).filter(Boolean),
  };
}

function resolveOutPath(options, defaultDir, defaultPrefix) {
  if (options.out) {
    return isAbsolute(options.out) ? options.out : resolve(process.cwd(), options.out);
  }
  return resolve(
    REPO_ROOT,
    defaultDir,
    `${defaultPrefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
}

async function runOpenPath(options, workspacePath) {
  const path = options.path;
  const startedAt = new Date().toISOString();
  if (path === "cold" && options.skipLaunch) {
    fail("--path cold 不接受 --skip-launch：冷开要求 9229 上没有运行中的实例。", EXIT.USAGE);
  }
  const runs = [];
  let instance = null;
  let cdp = null;
  let park = null;
  let targetInfo = null;
  const harnessActions = [];
  try {
    for (let index = 1; index <= options.iterations; index += 1) {
      const needsColdLaunch = path === "cold";
      if (needsColdLaunch && instance) {
        if (cdp) {
          cdp.close();
          cdp = null;
          activeCdp = null;
        }
        const teardown = await teardownInstance(instance.child, options);
        console.log(`${TAG} 冷开第 ${index} 轮：回收上一轮实例 ${JSON.stringify(teardown)}`);
        instance = null;
        if (teardown.cdpPortClosed !== true) {
          fail(
            [
              `冷开第 ${index} 轮前置失败：回收上一轮实例后 ${options.cdpPort} 仍可达。`,
              "端口没关就没有「CLI 未起」的冷开语义；先手动确认没有残留 electron 进程后重跑。",
            ].join("\n"),
            EXIT.LAUNCH,
          );
        }
      }
      if (!instance) {
        if (needsColdLaunch) {
          // 冷开前置：这一轮启动前 9229 必须是空的（否则复用别人的实例，样本不是冷开）。
          const running = await fetchJson(`http://127.0.0.1:${options.cdpPort}/json/version`);
          if (running.ok) {
            fail(
              [
                `--path cold 要求 9229 上没有运行中的实例，但 ${options.cdpPort} 可达。`,
                "请先关闭 dev 实例（脚本不会杀不是自己启动的进程），或改用 --path warm/reopen。",
              ].join("\n"),
              EXIT.LAUNCH,
            );
          }
        }
        const startupWorkspace =
          needsColdLaunch && options.startupWorkspace
            ? isAbsolute(options.startupWorkspace)
              ? options.startupWorkspace
              : resolve(process.cwd(), options.startupWorkspace)
            : workspacePath;
        instance = await acquirePageTarget(options, startupWorkspace);
        // 冷开会逐轮回收实例（finally 里 instance 置 null），报告用的 target 必须先抄下来。
        targetInfo = {
          id: instance.target.id ?? null,
          title: instance.target.title ?? null,
          url: instance.target.url ?? null,
          type: instance.target.type ?? null,
          appMode: instance.mode,
          pid: instance.child?.pid ?? null,
        };
        cdp = new CdpSession(instance.target.webSocketDebuggerUrl);
        activeCdp = cdp;
        await cdp.connect();
        const openProbeInfo = await assertOpenProbeMounted(cdp, options.actionTimeoutMs);
        console.log(
          `${TAG} 会话打开观测面已挂载，方法: ${(openProbeInfo.methods ?? []).join(", ")}`,
        );
        park = await resolveParkSession(cdp, options.session.trim(), options.parkSession.trim());
        console.log(
          `${TAG} 切走目标: ${park ? `${park.id}（${park.source}）` : "无（warm/reopen/switchback 需要）"}`,
        );
        const row = await ensureTargetRowVisible(cdp, options, workspacePath);
        harnessActions.push({ name: "ensure-target-row", at: new Date().toISOString(), ...row });
        if (row.rowPresentAfterActivation === false) {
          console.error(`${TAG} 目标行激活 workspace tab 后仍不在侧栏；点击动作还会再等一次`);
        }
      }
      const run = await sampleOpenPathOnce(cdp, options, { park, runIndex: index });
      runs.push(run);
      logOpenPathRun(run);
      if (run.ok !== true) break;
    }
  } finally {
    if (path === "cold" && instance?.child) {
      if (cdp) {
        cdp.close();
        cdp = null;
        activeCdp = null;
      }
      const teardown = await teardownInstance(instance.child, options);
      console.log(`${TAG} 冷开路径结束：回收最后一次实例 ${JSON.stringify(teardown)}`);
      instance = null;
    }
  }

  const summary = summarizeOpenPath(runs);
  const lastRun = runs[runs.length - 1] ?? null;
  const report = {
    schema: "zcode-desktop-long-session-perf-sample/v1",
    mode: "open-path",
    startedAt,
    finishedAt: new Date().toISOString(),
    repo: readGitInfo(),
    params: {
      path,
      iterations: options.iterations,
      workspacePath,
      startupWorkspace: options.startupWorkspace || null,
      session: options.session.trim(),
      parkSession: options.parkSession.trim() || null,
      resolvedPark: park,
      durationMs: null,
      scrollSelector: null,
      devServerUrl: options.devServerUrl,
      cdpPort: options.cdpPort,
      skipLaunch: options.skipLaunch,
      ackTimeoutMs: options.ackTimeoutMs,
      paintGraceMs: options.paintGraceMs,
      keepWarmWaitMs: options.keepWarmWaitMs,
      actionTimeoutMs: options.actionTimeoutMs,
    },
    environment: {
      build: "dev（__zcodeV4ConversationOpensE2E 只在 vite dev 挂载）",
      visibilityPolicy:
        "每次采样前 Emulation.setFocusEmulationEnabled(true) + Page.bringToFront + Page.setWebLifecycleState(active)；" +
        "样本里 visibility.contaminated=true 表示采样期页面仍非 visible，rAF 被降频，paintAfterApplyMs 不可信，判读中位数时应剔除",
      keepWarmWaitMs: options.keepWarmWaitMs,
      keepWarmSource:
        "packages/ui/src/v4/sessionDataLayer.ts:28 SESSION_DATA_LAYER_KEEP_WARM_MS=30s；未过期时再点开不发起 subscribe、不产生 ACK",
      coldLifecycle:
        "cold 每轮之间 kill 自己启动的 electron 进程树并等 9229 关闭后重开；路径结束也会回收（避免下一轮误判为复用）",
      driving:
        '脚本自行驱动：点击侧栏 [data-testid="task-item-<sessionId>"]（完整 pointer/mouse 序列 + click）；' +
        "「关闭会话」= 点另一个会话（旧 pane 卸载、store 进 keep-warm）",
      criteria: {
        primary: "uiViewReadyMs - openTiming.hostPrepareMs（spec phase-0-baseline 冷开主判据）",
        secondary:
          "uiViewReadyMs - openTiming.cliBootstrapMs（并列分解项；cliBootstrapMs 由进程事实判定）",
      },
    },
    target: targetInfo,
    segments: [],
    openPath: {
      path,
      runs,
      summary,
      harnessActions,
    },
    // 兼容既有报告读取路径：openProbe 取最后一次 run 的样本与裁决。
    openProbe: {
      target: {
        sessionId: options.session.trim(),
        topic: topicOf(options.session.trim()),
        source: "flag",
      },
      acceptance: lastRun?.acceptance ?? {
        verdict: "missing",
        reason: "no-run-completed",
      },
      beforeSampling: lastRun?.sample ?? null,
      afterSampling: lastRun?.sample ?? null,
    },
  };

  const outPath = resolveOutPath(options, "docs/iterations/session-open-latency", `open-${path}`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8" });
  console.log(`${TAG} 报告已写入: ${outPath}`);
  console.log(`${TAG} 汇总: ${JSON.stringify(summary)}`);

  const failedRun = runs.find((run) => run.ok !== true);
  if (failedRun) {
    console.error(
      [
        `${TAG} 错误: 第 ${failedRun.runIndex} 轮驱动动作失败（${failedRun.failure?.kind ?? "unknown"}）——退出码 9。`,
        failedRun.failure?.message ?? JSON.stringify(failedRun.failure ?? null),
        "报告已写出（含已完成轮次）。",
      ].join("\n"),
    );
    return EXIT.ACTION;
  }
  if (path !== "switchback" && runs.some((run) => run.acceptance?.verdict !== "present")) {
    console.error(
      [
        `${TAG} 错误: 有轮次缺验收指标（verdict≠present）——退出码 8。`,
        `目标会话: ${topicOf(options.session.trim())}；renderer.uiViewReadyMs 是冷开/热开的唯一验收量。`,
        "处理：确认该会话已打开并产生 subscribe ACK、跑的是 dev 构建、keep-warm 已过期。",
      ].join("\n"),
    );
    return EXIT.MISSING_METRIC;
  }
  return EXIT.OK;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return EXIT.OK;
  }

  const startedAt = new Date().toISOString();
  const workspacePath = isAbsolute(options.workspace)
    ? options.workspace
    : resolve(process.cwd(), options.workspace);
  if (!existsSync(workspacePath)) {
    fail(`--workspace 路径不存在: ${workspacePath}`, EXIT.USAGE);
  }
  // 路径模式的参数语义先判：用法错误不该等到起完实例才报。
  if (options.path) {
    if (!options.session.trim()) {
      fail(`--path ${options.path} 需要 --session <id> 指定目标会话`, EXIT.USAGE);
    }
    if ((options.path === "warm" || options.path === "reopen") && options.iterations > 1) {
      console.log(
        `${TAG} 提示: ${options.path} 每轮之间要等 keep-warm 过期 ${options.keepWarmWaitMs}ms` +
          `（${options.iterations} 轮约 ${Math.round((options.iterations * options.keepWarmWaitMs) / 1000)}s）`,
      );
    }
  }

  // 契约 1：renderer dev server 必须已就绪（脚本不起构建）。
  const devServer = await probeHttpUrl(options.devServerUrl);
  if (!devServer.ok) {
    fail(
      [
        `renderer dev server 不可达（${options.devServerUrl}：${devServer.reason}）。`,
        "本脚本不负责起构建，请先启动 vite dev：VS Code 任务 `zcode: prepare desktop debug`（tsup watch + vite dev），",
        "或在 packages/desktop 下执行 `pnpm dev:local-cli`。",
      ].join("\n"),
      EXIT.DEV_SERVER,
    );
  }
  console.log(`${TAG} dev server 就绪: ${options.devServerUrl}`);

  // 路径模式：一条命令自己驱动「打开 / 关闭后重开 / 切走再切回」×N 次。
  if (options.path) {
    return await runOpenPath(options, workspacePath);
  }

  // 契约 2 + 3：复用或自起实例，并等 renderer page target（判据不按产品名）。
  const { target, child, mode, resolvedExecutable } = await acquirePageTarget(
    options,
    workspacePath,
  );

  const cdp = new CdpSession(target.webSocketDebuggerUrl);
  activeCdp = cdp;
  let segments;
  let visibilityState = null;
  let openProbeTarget = {
    sessionId: null,
    topic: null,
    source: "unresolved",
    ownerSessionId: null,
    paneSessionIds: [],
  };
  let openProbeBeforeSampling;
  let openProbeAfterSampling;
  try {
    await cdp.connect();

    // 可见性：被遮挡的窗口会被 Chromium 判 hidden，rAF 降频（phase-0 实测 paint 93827ms vs
    // 429~461ms）。压力窗口模式同样先强制 visible，并把结果写进报告。
    const visible = await ensurePageVisible(cdp);
    visibilityState = { ...visible, atStart: await readVisibility(cdp) };

    // 探针容错：探针由 Step 2 提供，可能尚未挂载。冷启时 target 先于 bundle 求值出现，
    // 所以要轮询而不是连上就断言。
    const probeWait = await waitFor(
      async () => {
        const info = safeParse(await cdp.evaluate(PROBE_CHECK_EXPR));
        return { done: info.mounted === true, info };
      },
      { timeoutMs: options.actionTimeoutMs, intervalMs: 200, label: "perf-probe-mount" },
    );
    if (probeWait.done !== true) {
      fail(
        [
          "perfProbe 未挂载（需 dev 构建包含 Step 2 改动）。",
          "window.__zcodePerfProbe 不存在——确认 packages/ui/src/lib/perfProbe.ts 已落地、",
          "App.tsx 已接入 startPerfProbe，且当前跑的是 dev 构建（import.meta.env.DEV 门控）。",
          "若是复用既有实例，需重启该实例让新 renderer 生效。",
        ].join("\n"),
        EXIT.PROBE,
      );
    }
    console.log(`${TAG} perfProbe 已挂载，方法: ${(probeWait.info?.methods ?? []).join(", ")}`);

    // 目标会话：ACK/renderer 样本按它取，不取环形缓冲最后一条（可能是侧 pane / 子代理）。
    openProbeTarget = await resolveOpenProbeTarget(cdp, options.session.trim());
    console.log(
      `${TAG} 目标会话: ${openProbeTarget.topic ?? "（未解析）"}（来源: ${openProbeTarget.source}` +
        `；pane: ${openProbeTarget.paneSessionIds.join(", ") || "无"}）`,
    );

    // 会话打开分段：先取一次（窗口加载/打开会话发生在采样之前），采样结束后再取一次
    // （期间可能发生重订阅/热切换）。缺验收指标只影响退出码（8），报告照写。
    const openProbeInfo = safeParse(await cdp.evaluate(OPEN_PROBE_CHECK_EXPR));
    if (openProbeInfo.mounted !== true) {
      console.error(
        [
          `${TAG} 警告: 会话打开观测面 window.__zcodeV4ConversationOpensE2E 未挂载。`,
          "openPhases / runtimeReady / uiViewReadyMs 都将缺失——报告仍会写出，但退出码为 8。",
          "该面由 packages/ui/src/v4/conversationOpenObservability.ts 提供，" +
            "需 dev renderer 重启后生效。",
        ].join("\n"),
      );
    } else {
      const mountedMethods = (openProbeInfo.methods ?? []).join(", ");
      console.log(`${TAG} 会话打开观测面已挂载，方法: ${mountedMethods}`);
    }
    openProbeBeforeSampling = await readOpenProbe(cdp, openProbeTarget.sessionId);
    logOpenProbe(
      "采样前 openPhases",
      openProbeBeforeSampling,
      evaluateOpenAcceptance(openProbeBeforeSampling, openProbeTarget),
    );

    const scrollStart = SCROLL_DRIVER_EXPR(
      options.scrollSelector ? JSON.stringify(options.scrollSelector) : "null",
      SCROLL_INTERVAL_MS,
    );
    segments = [
      // 流式窗口：脚本不驱动，用户在窗口期手动触发长输出/流式回复。
      await sampleSegment(cdp, "stream", { durationMs: options.durationMs, drive: null }),
      // 滚动窗口：脚本驱动容器来回滚动。
      await sampleSegment(cdp, "scroll", {
        durationMs: options.durationMs,
        drive: { start: scrollStart },
      }),
    ];
    openProbeAfterSampling = await readOpenProbe(cdp, openProbeTarget.sessionId);
    logOpenProbe(
      "采样后 openPhases",
      openProbeAfterSampling,
      evaluateOpenAcceptance(openProbeAfterSampling, openProbeTarget),
    );
  } finally {
    cdp.close();
  }

  // 验收裁决取「最后一次读」：采样期间的重订阅/热切换以最新样本为准。
  const openProbeAcceptanceProbe = openProbeAfterSampling ?? openProbeBeforeSampling ?? null;
  const openProbeAcceptance = evaluateOpenAcceptance(openProbeAcceptanceProbe, openProbeTarget);

  const report = {
    schema: "zcode-desktop-long-session-perf-sample/v1",
    startedAt,
    finishedAt: new Date().toISOString(),
    repo: readGitInfo(),
    params: {
      workspacePath,
      session: options.session || null,
      durationMs: options.durationMs,
      scrollSelector: options.scrollSelector || null,
      devServerUrl: options.devServerUrl,
      cdpPort: options.cdpPort,
      skipLaunch: options.skipLaunch,
      mode,
      spawnedPid: child?.pid ?? null,
      childExitInfo: child?.exitInfo ?? null,
      childStillRunning: child != null && child.exitedAt == null,
      electronExecutable: resolvedExecutable,
    },
    target: {
      id: target.id ?? null,
      title: target.title,
      url: target.url,
      type: target.type ?? null,
    },
    segments,
    // 采样期页面可见性（rAF 是否被降频的唯一开关）。hidden/contaminated 的样本不能进中位数。
    visibility: visibilityState,
    // 会话打开分段（session-open-latency）：
    //   - `renderer.uiViewReadyMs` / `renderer.paintAfterApplyMs` = **验收基准**（总量口径）；
    //   - `openPhases`（ACK 顶层）= 分解项，其中 viewReadyMs 只是 CLI 进程内一段；
    //   - `runtimeReady` query（ACK 里没有该值，口径为激活本体耗时）。
    // 采样前后各取一次：打开会话发生在采样之前，采样期间也可能发生重订阅/热切换。
    // `acceptance.verdict === "missing"` 时退出码为 8（报告照写）：
    // 没有 renderer.uiViewReadyMs 的 baseline 不能用来判验收。
    openProbe: {
      target: openProbeTarget,
      acceptance: openProbeAcceptance,
      beforeSampling: openProbeBeforeSampling ?? null,
      afterSampling: openProbeAfterSampling ?? null,
    },
  };

  const outPath = options.out
    ? isAbsolute(options.out)
      ? options.out
      : resolve(process.cwd(), options.out)
    : resolve(
        REPO_ROOT,
        "docs/iterations/desktop-long-session-perf",
        `baseline-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8" });
  console.log(`${TAG} 报告已写入: ${outPath}`);
  if (child) {
    console.log(`${TAG} dev 实例（pid=${child.pid}）保持运行，脚本退出不会关闭它。`);
  }
  if (openProbeAcceptance.verdict !== "present") {
    console.error(
      [
        `${TAG} 错误: 报告已写出，但**缺验收指标**（${openProbeAcceptance.reason}）——退出码 8。`,
        `目标会话: ${openProbeTarget.topic ?? "（未解析）"}；renderer.uiViewReadyMs 是冷开/热开的唯一验收量。`,
        "处理：用 --session 指定目标会话、确认该会话已打开并产生 subscribe ACK、确认跑的是 dev 构建。",
        "注意：退出码 8 ≠ 跑挂（4/5/6/7）——报告有效，只是不足以判基线。",
      ].join("\n"),
    );
    return EXIT.MISSING_METRIC;
  }
  return EXIT.OK;
}

function readGitInfo() {
  const git = (...args) => {
    try {
      return execFileSync("git", args, {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };
  return {
    root: REPO_ROOT,
    head: git("rev-parse", "HEAD"),
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
  };
}

let exitCode = EXIT.OK;
try {
  exitCode = await main();
} catch (error) {
  if (error instanceof PerfError) {
    killStrayChild();
    console.error(`${TAG} 错误: ${error.message}`);
    exitCode = error.code;
  } else {
    killStrayChild();
    console.error(`${TAG} 未预期错误: ${error instanceof Error ? error.stack : String(error)}`);
    exitCode = EXIT.CDP;
  }
} finally {
  activeCdp?.close();
  // 给 WebSocket 的 close 事件留出落地时间，避免 process.exit 撞上 uv 断言。
  await sleep(200);
}

process.exit(exitCode);
