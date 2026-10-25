#!/usr/bin/env node
/* eslint-disable max-lines -- 采样脚本把「启动契约探测 + CDP 会话封装 + 页面内驱动表达式 + 分段取数与报告」集中在一处，便于单文件审阅；后续拆文件会割裂页面内表达式的完整性。 */

// 桌面端长会话性能采样脚本（SPEC Step 3，见 docs/iterations/desktop-long-session-perf/spec.md）
//
// 职责边界：只做「采样」，不负责构建。renderer dev server 必须由用户先起
// （.vscode/tasks.json 的 `zcode: prepare desktop debug`：tsup watch + vite dev）。
//
// dev 实例启动契约（SPEC「总体方案 A」）：
//   1) 探测 http://localhost:5174，不通则报错退出并提示先起 vite dev；
//   2) 探测 http://127.0.0.1:9229/json/version —— 可达则不新起实例（--skip-launch 或
//      仅转发深链给既有实例），不可达则自行 spawn electron ["." , "--open-workspace", ws]
//      且**不带 --inspect-brk**（无调试器会挂起首行）；spawn 后秒退按失败处理；
//   3) 轮询 9229 /json/list 直到出现 title === "ZCode" 的 page target。
//
// 采样序列：reset() → 驱动动作 → dump()（字符串取回）分段收集 → 写 JSON 报告。
// 探针由 SPEC Step 2 提供（window.__zcodePerfProbe），未挂载时明确报错并非零退出。
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

// 退出码
//   0 成功，且目标样本含验收指标（renderer.uiViewReadyMs）
//   2 用法错误   3 dev server 不可达   4 启动/复用失败
//   5 未出现 ZCode target   6 perfProbe 未挂载   7 CDP 交互失败
//   8 **已写出报告但缺验收指标**（uiViewReadyMs 缺席 / 观测面未挂载 / 无目标 ACK）
//
// 8 存在的理由：renderer.uiViewReadyMs 是冷开/热开的唯一验收量，缺它这份报告不能用来
// 判基线。它与「跑挂了」的 4/5/6/7 区分开——8 时报告已落盘，数字只是不满足验收条件。
// 3 已被「dev server 不可达」占用，故不复用（见 cr-func N2 的建议）。
const EXIT = {
  OK: 0,
  USAGE: 2,
  DEV_SERVER: 3,
  LAUNCH: 4,
  TARGET: 5,
  PROBE: 6,
  CDP: 7,
  MISSING_METRIC: 8,
};

const USAGE = [
  "用法: node scripts/dev/long-session-perf-sample.mjs [选项]",
  "",
  "选项:",
  "  --workspace <path>       要打开的 workspace 路径（默认：仓库根 " + REPO_ROOT + "）",
  "  --out <file>             报告输出路径（默认：仓库内",
  "                          docs/iterations/desktop-long-session-perf/baseline-<时间戳>.json）",
  "  --session <id>           目标会话 id；ACK 样本与 renderer 分段按它取",
  "                          （缺省取采样时间线所属 pane 的 data-session-id）",
  "  --skip-launch            不 spawn 任何进程，要求已有实例在跑（9229 可达）",
  "  --duration-ms <n>        单个采样窗口时长，默认 30000（两个窗口共 2×）",
  "  --scroll-selector <sel>  滚动容器选择器；缺省用 document.scrollingElement",
  "  --dev-server-url <url>   renderer dev server 地址，默认 http://localhost:5174",
  "  --cdp-port <n>           远程调试端口，默认 9229（采样期要求 dev 实例独占）",
  "  --ready-timeout-ms <n>   等待 ZCode target 就绪的超时，默认 90000",
  "  --electron <path>        electron 可执行文件覆盖（默认解析仓库内 electron）",
  "  --help                   打印本用法",
  "",
  "退出码:",
  "  0  成功，且目标样本含验收指标 renderer.uiViewReadyMs",
  "  2  用法错误",
  "  3  renderer dev server 不可达",
  "  4  启动/复用 dev 实例失败",
  "  5  未出现 ZCode page target",
  "  6  perfProbe 未挂载",
  "  7  CDP 交互失败",
  "  8  已写出报告但缺验收指标（uiViewReadyMs 缺席 / 观测面未挂载 / 无目标 ACK），",
  '     报告里 openProbe.acceptance.verdict = "missing"；与跑挂的 4/5/6/7 区分',
  "",
  "示例:",
  "  node scripts/dev/long-session-perf-sample.mjs --workspace D:\\dev\\my-workspace",
  "  node scripts/dev/long-session-perf-sample.mjs --skip-launch --duration-ms 60000 \\",
  "    --scroll-selector '[data-testid=\"conversation-timeline\"]'",
  "",
  "会话打开分段（session-open-latency）：",
  "",
  "  验收基准是 renderer 侧总量 `renderer.uiViewReadyMs`（connect 入口 → snapshot 应用完成），",
  "  要看首绘再叠加 `renderer.paintAfterApplyMs`。`openPhases.viewReadyMs` 只是 CLI 进程内",
  "  一段（不含 host 准备 / CLI spawn / RPC 往返 / 渲染），且各段嵌套不可相加。",
  "",
  "  验收阈值按场景分三档（spec phase-0-baseline）：冷开（CLI 未起）看",
  "  `uiViewReadyMs - openTiming.cliBootstrapMs ≤ 1s`（spawn 单列，总量 ≤2.5~3s 仅作观察）；",
  "  热开（CLI 已起、会话冷）看 `uiViewReadyMs ≤ 800ms`；切回（keep-warm）不发生 subscribe，",
  "  该指标没有生产者，不适用。",
  "",
  "  ACK 样本按**目标会话**取（`--session` 或时间线所属 pane），不取环形缓冲最后一条；",
  "  目标样本缺 `renderer.uiViewReadyMs` 时退出码 8，报告照写并标 verdict=missing。",
  "",
  "  本脚本同时采集 conversation subscribe ACK 的顶层键 `openPhases`",
  "  （viewReadyMs / mergeMs / rehydrateMs；manifestMs、materializeMs 要到 row manifest",
  "  与分页物化落地后才有值）与 `runtimeReady` query（runtimeReadyMs 不在 ACK 里：",
  "  view-only 的激活发生在 ACK 之后，口径为激活本体耗时）。两者来自页面窗口面",
  "  `window.__zcodeV4ConversationOpensE2E`。",
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
    try {
      if (process.platform === "win32") {
        // child.kill 杀不干净 electron 进程树（主进程退出后 renderer/utility 子进程
        // 仍占着 9229），必须用 taskkill /T 强杀整棵树。
        execFileSync("taskkill", ["/pid", String(activeChild.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } else {
        activeChild.kill();
      }
    } catch {
      // kill 失败只作提示，不覆盖原始错误
    }
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
      else if (token === "--scroll-selector") raw.scrollSelector = value;
      else if (token === "--dev-server-url") raw.devServerUrl = value;
      else if (token === "--electron") raw.electron = value;
      else {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0)
          fail(`参数 ${token} 需要正整数，收到 "${value}"`, EXIT.USAGE);
        if (token === "--duration-ms") raw.durationMs = n;
        else if (token === "--cdp-port") raw.cdpPort = n;
        else if (token === "--ready-timeout-ms") raw.readyTimeoutMs = n;
      }
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

async function waitForZCodeTarget(port, timeoutMs, child, devServerUrl) {
  const listUrl = `http://127.0.0.1:${port}/json/list`;
  const deadline = Date.now() + timeoutMs;
  let lastReason = "尚未读取到 target 列表";
  const launchedAt = Date.now();

  while (Date.now() < deadline) {
    const res = await fetchJson(listUrl);
    if (res.ok && Array.isArray(res.data)) {
      const page = res.data.find((t) => t.title === "ZCode" && t.webSocketDebuggerUrl);
      if (page) return page;
      lastReason = `列表内 ${res.data.length} 个 target，没有 title === "ZCode" 的页面`;
    } else {
      lastReason = res.reason;
    }

    // 自起实例秒退 = 单实例锁已有主进程占位（或启动失败），按失败处理。
    if (child && child.exitedAt != null) {
      const elapsed = child.exitedAt - launchedAt;
      const debugPortDisabled = process.env.ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT === "1";
      fail(
        [
          `electron 进程在 ${elapsed}ms 后退出（${child.exitInfo ?? "无退出码"}），但 ${port} 端口始终没有出现 ZCode target。`,
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
      `${Math.round(timeoutMs / 1000)}s 内未出现 title === "ZCode" 的 page target。`,
      `dev server(${devServerUrl}): ${(await probeHttpUrl(devServerUrl, 1_000)).ok ? "可达" : "不可达"}`,
      `现有 target: ${titles}`,
      "排查：确认 renderer dev server 已起、桌面窗口已打开、采样期 9229 未被 e2e（Chromedriver）占用。",
    ].join("\n"),
    EXIT.TARGET,
  );
  return null;
}

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
 * 验收指标是否采到（cr-func N2）。
 *
 * 只判「有没有采到」，不判三档阈值——场景（冷开/热开/切回）与阈值在 spec
 * phase-0-baseline 里，脚本没有足够信息替它下结论。但缺验收指标必须能被发现：
 * 否则 baseline 会在「没有验收数」的情况下静默成功落盘。
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
  // 冷开：`uiViewReadyMs - cliBootstrapMs` 才是视图侧（spawn 单列，见 spec 三档表）。
  // 复用进程时 cliBootstrapMs 缺席（缺席 ≠ 0）→ viewSideMs 也缺席，热开直接看 uiViewReadyMs。
  const cliBootstrapMs =
    typeof ack.openTiming?.cliBootstrapMs === "number" ? ack.openTiming.cliBootstrapMs : undefined;
  return {
    ...base,
    verdict: "present",
    reason: null,
    uiViewReadyMs,
    paintAfterApplyMs:
      typeof renderer?.paintAfterApplyMs === "number" ? renderer.paintAfterApplyMs : undefined,
    cliBootstrapMs,
    cliProcessState: ack.openTiming?.cliProcessState ?? null,
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
      }`
    : "uiViewReadyMs=unavailable";
  const spawn =
    `cliBootstrapMs=${ack.openTiming?.cliBootstrapMs ?? "absent"}` +
    `/cliProcessState=${ack.openTiming?.cliProcessState ?? "unknown"}` +
    `/viewSideMs=${acceptance?.viewSideMs ?? "n/a"}`;
  const runtime = sample.runtimeReady
    ? `runtimeReadyMs=${sample.runtimeReady.runtimeReadyMs ?? "null"} runtimeReady=${
        sample.runtimeReady.runtimeReady
      }`
    : `runtimeReady=unavailable${sample.runtimeReadyError ? `（${sample.runtimeReadyError}）` : ""}`;
  console.log(
    `${TAG} ${label}: topic=${ack.topic} ${rendererReady} ${spawn} openPhases=${phases} ${runtime}` +
      `（ACK 样本 ${sample.acks?.length ?? 0} 条，verdict=${acceptance?.verdict ?? "?"}）`,
  );
}

async function sampleSegment(cdp, name, { durationMs, drive }) {
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
  // 长会话双判据：DOM 常驻的 totalRowCount 与滚动余量 maxScrollTop，
  // 不用 [data-row-id] 计数（虚拟化下永远只有可视区几行）。
  const totalRowCount = rendererEnv.totalRowCount ?? 0;
  const windowRowCount = rendererEnv.windowRowCount ?? 0;
  const domRowCount = rendererEnv.rowCount ?? 0;
  const maxScrollTop = Math.max(
    rendererEnv.maxScrollTop ?? 0,
    driverInfo?.maxScrollTop ?? 0,
  );
  const longSessionOk =
    totalRowCount >= LONG_SESSION_MIN_TOTAL_ROWS ||
    maxScrollTop >= LONG_SESSION_MIN_MAX_SCROLL_TOP;
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
  const cdpBase = `http://127.0.0.1:${options.cdpPort}`;

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

  // 契约 2：9229 单实例探测 —— 可达则不新起实例。
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

  // 契约 3：就绪判定。
  const target = await waitForZCodeTarget(
    options.cdpPort,
    options.readyTimeoutMs,
    mode === "launch" ? child : null,
    options.devServerUrl,
  );
  console.log(`${TAG} target 就绪: title=${target.title} url=${target.url}`);

  const cdp = new CdpSession(target.webSocketDebuggerUrl);
  activeCdp = cdp;
  let segments;
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

    // 探针容错：探针由 Step 2 提供，可能尚未挂载。
    const probeInfo = safeParse(await cdp.evaluate(PROBE_CHECK_EXPR));
    if (probeInfo.mounted !== true) {
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
    console.log(`${TAG} perfProbe 已挂载，方法: ${(probeInfo.methods ?? []).join(", ")}`);

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
