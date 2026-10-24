/**
 * T-SS3（backlog-sweep 设备重连自动重申请）：设置页 Source 设置 attachment 的自动重试。
 *
 * 缺陷：SettingsPage 的 attachment effect 只依赖 [selectedSettingsSourceServerId,
 * sourceAttachmentRequest]，设备掉线再上线后不重跑，端口申请不回来。
 *
 * 本测试用「纯状态机断言 + 注册表行为断言 + 源码形状守卫」覆盖（本仓 UI 测试没有 jsdom）：
 * ①同一在线周期只申请一次；②掉线后重新上线会重申请；③已登记端口不被打扰；
 * ④失败退避按时间戳判定，失败会解除同周期幂等键，到期后自动重申请；
 * ⑤端口在同一在线周期内释放后至少等一个最小间隔才重申请，且抖动有次数上限；
 * ⑥申请回执 ≠ 端口已登记：未登记/服务集不完整都按失败重试，达到上限进入放弃态；
 * ⑦首次申请不被 online 判定拦住；⑧连续两次明确 offline 才允许释放端口；
 * ⑨旧条目失效（alive=false / invalidated）后 ensure 会替换；
 * ⑩显式 release（close 未触发）也能撤销条目并通知订阅者。
 *
 * 运行：npx tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/settingsSourceAttachmentRetry.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { IServiceAccessor } from "@zcode/services";

// SettingsPage 的模块图里有静态资源导入（WindowsTopLeftLogo 的 app-logo.svg）。本仓 UI 测试
// 没有打包器/jsdom，这里只把非 JS 资源解析成空模块，其余仍走真实的 TypeScript 源码——
// 决策逻辑必须针对生产实现断言，不能在测试里复制一份。
register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function load(url, context, nextLoad) {
        if (/\\.(?:svg|png|jpe?g|gif|webp|woff2?)$/i.test(url)) {
          return { format: "module", source: 'export default "";', shortCircuit: true };
        }
        return nextLoad(url, context);
      }`,
    ),
);

const {
  SOURCE_SETTINGS_ATTACHMENT_OFFLINE_CONFIRM_DELAY_MS,
  SOURCE_SETTINGS_ATTACHMENT_RELEASE_MIN_INTERVAL_MS,
  SOURCE_SETTINGS_ATTACHMENT_RETRY_BASE_DELAY_MS,
  SOURCE_SETTINGS_ATTACHMENT_RETRY_MAX_ATTEMPTS,
  SOURCE_SETTINGS_ATTACHMENT_RETRY_MAX_DELAY_MS,
  SOURCE_SETTINGS_ATTACHMENT_STABLE_PORT_MS,
  decideSourceSettingsAttachmentAttempt,
  decideSourceSettingsAttachmentOfflineRelease,
  recordSourceSettingsAttachmentFailure,
  resolveSourceSettingsAttachmentReceiptOutcome,
  resolveSourceSettingsAttachmentRetryDelayMs,
} = (await import("../src/SettingsPage.js")) as typeof import("../src/SettingsPage.js");
type SourceSettingsAttachmentRetryTracker =
  import("../src/SettingsPage.js").SourceSettingsAttachmentRetryTracker;

// SettingsPage 已经加载过同一模块，动态 import 拿到的是同一个注册表实例。
const {
  ensureSourceSettingsServices,
  getSourceSettingsServices,
  invalidateSourceSettingsServices,
  registerSourceSettingsServices,
  releaseSourceSettingsServices,
  subscribeSourceSettingsServices,
} =
  (await import("../src/store/sourceSettingsServiceStore.js")) as typeof import("../src/store/sourceSettingsServiceStore.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const read = (...segments: string[]) => readFileSync(path.join(repoRoot, ...segments), "utf8");

const SOURCE_ID = "source-a";

/** 与生产 effect 同形的一步：用上一步的 tracker 作为 previous。 */
function step(params: {
  previous?: SourceSettingsAttachmentRetryTracker;
  online: boolean | undefined;
  portRegistered?: boolean;
  now?: number;
  sourceServerId?: string;
}) {
  return decideSourceSettingsAttachmentAttempt({
    previous: params.previous,
    sourceServerId: params.sourceServerId ?? SOURCE_ID,
    online: params.online,
    portRegistered: params.portRegistered ?? false,
    now: params.now ?? 0,
  });
}

/** 与生产 effect 的「释放判定」同形的一步。 */
function releaseStep(params: {
  previous?: SourceSettingsAttachmentRetryTracker;
  online: boolean | undefined;
  portRegistered: boolean;
}) {
  return decideSourceSettingsAttachmentOfflineRelease({
    previous: params.previous,
    sourceServerId: SOURCE_ID,
    online: params.online,
    portRegistered: params.portRegistered,
  });
}

function createServices(name: string): IServiceAccessor {
  return { name } as unknown as IServiceAccessor;
}

/**
 * source-settings 服务集装配期必带的 8 个通道（见
 * packages/services/.../sourceSettingsServiceCollection.ts）。缺任一通道都不算已登记。
 */
function createCapabilityServices(): IServiceAccessor {
  return {
    hooksService: { name: "hooks" },
    pluginManagementService: { name: "plugin" },
    skillsService: { name: "skills" },
    subagentsService: { name: "subagents" },
    mcpSyncService: { name: "mcp" },
    commandsService: { name: "commands" },
    skillSyncService: { name: "skill-sync" },
    settingsSyncService: { name: "settings-sync" },
  } as unknown as IServiceAccessor;
}

test("T-SS3 同一在线周期只申请一次（快照多次更新不重复申请）", () => {
  const first = step({ online: true, now: 1_000 });
  assert.equal(first.request, true, "首次选中设备必须申请");
  assert.equal(first.reason, "initial");
  assert.equal(first.tracker.cycle, 0);

  // management 快照后续多次更新、设备保持在线：同一周期，不得重复申请。
  const second = step({ previous: first.tracker, online: true, now: 1_100 });
  assert.equal(second.request, false);
  assert.equal(second.reason, "same-cycle");
  assert.equal(second.tracker.cycle, 0, "在线状态未变化，周期不递增");

  const third = step({ previous: second.tracker, online: true, now: 1_900 });
  assert.equal(third.request, false);
  assert.equal(third.reason, "same-cycle");
});

test("T-SS3 首次申请不依赖 online 判定：选中即申请，失败走退避", () => {
  // management 快照可能短暂落后或尚未就绪；首次选中不能因为 online=false 就停在 unavailable。
  const offlineFirst = step({ online: false, now: 1_000 });
  assert.equal(offlineFirst.request, true, "首次选中即申请，不被 offline 投影拦截");
  assert.equal(offlineFirst.reason, "initial");

  // 失败后（同一在线周期）才按明确 offline 拦截，等重连再试。
  const failed = recordSourceSettingsAttachmentFailure({ tracker: offlineFirst.tracker });
  assert.equal(failed.exhausted, false);
  const offlineRetry = step({ previous: failed.tracker, online: false, now: 2_000 });
  assert.equal(offlineRetry.request, false);
  assert.equal(offlineRetry.reason, "offline");
});

test("T-SS3 掉线后重新上线会重申请（新在线周期）", () => {
  const first = step({ online: true, now: 1_000 });
  assert.equal(first.request, true);

  const offline = step({ previous: first.tracker, online: false, now: 2_000 });
  assert.equal(offline.request, false, "已知离线时不得申请");
  assert.equal(offline.reason, "offline");
  assert.equal(offline.tracker.online, false);

  const reconnected = step({ previous: offline.tracker, online: true, now: 3_000 });
  assert.equal(reconnected.request, true, "重新在线必须自动重申请，不能要求用户重选设备");
  assert.equal(reconnected.reason, "reconnect");
  assert.equal(reconnected.tracker.cycle, 1, "离线→在线进入新的在线周期");

  // 同一新周期内的后续快照：仍然只申请一次。
  const settle = step({ previous: reconnected.tracker, online: true, now: 3_100 });
  assert.equal(settle.request, false);
  assert.equal(settle.reason, "same-cycle");
});

test("T-SS3 连续两次明确 offline 才释放端口（单次只确认，复原即清零）", () => {
  const initial = step({ online: true, now: 1_000 });
  const registered = step({
    previous: initial.tracker,
    online: true,
    portRegistered: true,
    now: 2_000,
  });
  assert.equal(registered.request, false);
  assert.equal(registered.reason, "port-registered");

  // 第一次明确 offline：只记录观察，不释放（快照可能短暂落后）。
  const firstOffline = releaseStep({
    previous: registered.tracker,
    online: false,
    portRegistered: true,
  });
  assert.equal(firstOffline.action, "confirm", "单次 offline 必须先确认，不能直接释放");
  assert.equal(firstOffline.tracker.offlineObservations, 1);

  // 第二次仍明确 offline：允许释放（调用方随后还会用最新快照复核）。
  const secondOffline = releaseStep({
    previous: firstOffline.tracker,
    online: false,
    portRegistered: true,
  });
  assert.equal(secondOffline.action, "release");
  assert.equal(secondOffline.tracker.offlineObservations, 0);

  // 快照恢复 online：清零观察计数，绝不释放。
  const recovered = releaseStep({
    previous: registered.tracker,
    online: true,
    portRegistered: true,
  });
  assert.equal(recovered.action, "keep");
  assert.equal(recovered.tracker.offlineObservations, 0);

  // 端口已不在 / 快照未就绪：释放没有意义。
  assert.equal(
    releaseStep({ previous: registered.tracker, online: false, portRegistered: false }).action,
    "keep",
  );
  assert.equal(
    releaseStep({ previous: registered.tracker, online: undefined, portRegistered: true }).action,
    "keep",
  );
});

test("T-SS3 端口已登记时不打扰成功端口（也不累计失败退避）", () => {
  const failed = step({ online: true, now: 0 });
  failed.tracker.failedAttempts = 2;

  const withPort = step({
    previous: failed.tracker,
    online: true,
    portRegistered: true,
    now: 1_000,
  });
  assert.equal(withPort.request, false, "已登记的端口不能再申请一遍");
  assert.equal(withPort.reason, "port-registered");
  assert.equal(withPort.tracker.failedAttempts, 0, "端口存在即成功语义，失败计数清零");
  assert.equal(withPort.tracker.portRegistered, true, "端口登记事实必须进入追踪状态");
  assert.equal(withPort.tracker.portRegisteredAt, 1_000, "记录首次观察到的登记时间（稳定判定）");

  // 即使此刻设备掉线重连，端口仍在 → 不申请。
  const offline = step({
    previous: withPort.tracker,
    online: false,
    portRegistered: true,
    now: 2_000,
  });
  const reconnected = step({
    previous: offline.tracker,
    online: true,
    portRegistered: true,
    now: 3_000,
  });
  assert.equal(reconnected.request, false);
  assert.equal(reconnected.reason, "port-registered");
});

test("T-SS3 失败退避：快速重连不立刻重申请，退避到期后的状态变化再申请", () => {
  // 第一次申请失败：本周期已申请，失败计数 1。
  const first = step({ online: true, now: 10_000 });
  first.tracker.failedAttempts = 1;

  const offline = step({ previous: first.tracker, online: false, now: 10_100 });
  const tooSoon = step({ previous: offline.tracker, online: true, now: 10_200 });
  assert.equal(tooSoon.request, false, "失败退避内不得马上重申请");
  assert.equal(tooSoon.reason, "backoff");
  assert.equal(
    tooSoon.retryAfterMs,
    SOURCE_SETTINGS_ATTACHMENT_RETRY_BASE_DELAY_MS - (10_200 - 10_000),
    "退避只按状态变化时的时间戳计算，剩余时长由调用方的一次性定时器补齐",
  );

  // 退避到期后（定时器触发 effect 重跑）必须继续申请，不能占掉新在线周期。
  const afterBackoff = step({ previous: tooSoon.tracker, online: true, now: 12_100 });
  assert.equal(afterBackoff.request, true, "退避到期后的状态变化要继续尝试");
  assert.equal(afterBackoff.reason, "reconnect");
  assert.equal(afterBackoff.tracker.cycle, 1);
});

test("T-SS3 失败解除同周期幂等键：退避到点后自动重试（无需任何状态变化）", () => {
  // 首次申请后失败：生产失败回调同时清空 attemptedCycle 并累计 failedAttempts。
  const first = step({ online: true, now: 10_000 });
  assert.equal(first.request, true);
  first.tracker.failedAttempts = 1;
  first.tracker.attemptedCycle = null;

  // 定时器未到：仍是 backoff，并给出剩余时长（调用方据此安排下一次一次性触发）。
  const tooSoon = step({ previous: first.tracker, online: true, now: 10_500 });
  assert.equal(tooSoon.request, false);
  assert.equal(tooSoon.reason, "backoff");
  assert.equal(tooSoon.retryAfterMs, SOURCE_SETTINGS_ATTACHMENT_RETRY_BASE_DELAY_MS - 500);

  // 定时器到点（同一在线周期、快照没有变化）：必须真正重新申请，不能被 same-cycle 拦住。
  const due = step({ previous: tooSoon.tracker, online: true, now: 12_000 });
  assert.equal(due.request, true, "退避到点后必须自动重试");
  assert.equal(due.reason, "retry");
  assert.equal(due.tracker.cycle, 0, "没有掉线重连，仍是同一在线周期");
  assert.equal(due.tracker.attemptedCycle, 0, "重试占掉本周期的新一次申请");

  // 重试后同周期不再重复申请。
  const settle = step({ previous: due.tracker, online: true, now: 12_100 });
  assert.equal(settle.request, false);
  assert.equal(settle.reason, "same-cycle");
});

test("T-SS3 申请回执未登记端口：按失败退避重试，达到上限进入放弃态", () => {
  // 回执三态：未登记 / 服务集不完整 / 真正登记。
  assert.equal(
    resolveSourceSettingsAttachmentReceiptOutcome(undefined),
    "unregistered",
    "申请回执不等于端口已登记",
  );
  assert.equal(
    resolveSourceSettingsAttachmentReceiptOutcome(createServices("partial")),
    "incomplete",
    "缺少 source-settings 必需通道的条目不能当成已登记",
  );
  assert.equal(
    resolveSourceSettingsAttachmentReceiptOutcome(createCapabilityServices()),
    "registered",
  );

  // 回执成功但端口没登记：必须解除同周期幂等键并安排退避，而不是清掉定时器。
  const initial = step({ online: true, now: 1_000 });
  const firstFailure = recordSourceSettingsAttachmentFailure({ tracker: initial.tracker });
  assert.equal(firstFailure.exhausted, false);
  assert.equal(firstFailure.retryAfterMs, SOURCE_SETTINGS_ATTACHMENT_RETRY_BASE_DELAY_MS);
  assert.equal(firstFailure.tracker.attemptedCycle, null, "失败必须解除同周期幂等键");

  const due = step({
    previous: firstFailure.tracker,
    online: true,
    now: 1_000 + SOURCE_SETTINGS_ATTACHMENT_RETRY_BASE_DELAY_MS,
  });
  assert.equal(due.request, true, "退避到期后必须重新申请");

  // 连续失败达到上限：返回 exhausted 且不再给重试延时。
  let tracker = step({ online: true, now: 10_000 }).tracker;
  let outcome = recordSourceSettingsAttachmentFailure({ tracker });
  for (let attempt = 1; attempt < SOURCE_SETTINGS_ATTACHMENT_RETRY_MAX_ATTEMPTS; attempt += 1) {
    outcome = recordSourceSettingsAttachmentFailure({ tracker: outcome.tracker });
  }
  assert.equal(outcome.exhausted, true);
  assert.equal(outcome.retryAfterMs, 0);
  assert.equal(
    outcome.tracker.failedAttempts,
    SOURCE_SETTINGS_ATTACHMENT_RETRY_MAX_ATTEMPTS,
    "失败计数有明确上限",
  );
  const afterExhausted = step({ previous: outcome.tracker, online: true, now: 10_000_000 });
  assert.equal(afterExhausted.request, false, "放弃后不得自行重发 IPC");
  assert.equal(afterExhausted.reason, "exhausted");
  assert.equal(afterExhausted.tracker.exhausted, true);
});

test("T-SS3 放弃态会在设备状态变化 / 端口成功登记时重置", () => {
  let tracker = step({ online: true, now: 10_000 }).tracker;
  let outcome = recordSourceSettingsAttachmentFailure({ tracker });
  for (let attempt = 1; attempt < SOURCE_SETTINGS_ATTACHMENT_RETRY_MAX_ATTEMPTS; attempt += 1) {
    outcome = recordSourceSettingsAttachmentFailure({ tracker: outcome.tracker });
  }
  assert.equal(outcome.exhausted, true);

  // 离线 → 在线是新的外部事实：放弃态清零，允许再次自动申请。
  const offline = step({ previous: outcome.tracker, online: false, now: 20_000 });
  const reconnected = step({ previous: offline.tracker, online: true, now: 60_000 });
  assert.equal(reconnected.tracker.exhausted, false, "设备状态变化必须重置放弃态");
  assert.equal(reconnected.request, true, "重置后允许再试（退避已过）");

  // 快照从「未就绪」变成明确在线同样是新事实：启动阶段用尽重试后不能永久卡死。
  const unknownExhausted: SourceSettingsAttachmentRetryTracker = {
    ...outcome.tracker,
    online: null,
  };
  const firstOnline = step({ previous: unknownExhausted, online: true, now: 10_000_000 });
  assert.equal(firstOnline.tracker.exhausted, false, "快照就绪后首次在线也要重置放弃态");
  assert.equal(firstOnline.request, true);

  // 端口成功登记也代表申请成功：清零失败计数并退出放弃态。
  const exhaustedAgain = recordSourceSettingsAttachmentFailure({
    tracker: step({ online: true, now: 70_000 }).tracker,
  });
  const withPort = step({
    previous: exhaustedAgain.tracker,
    online: true,
    portRegistered: true,
    now: 80_000,
  });
  assert.equal(withPort.tracker.exhausted, false);
  assert.equal(withPort.tracker.failedAttempts, 0);
});

test("T-SS3 端口释放后至少等一个最小间隔，不退化成无延迟空转", () => {
  const initial = step({ online: true, now: 1_000 });
  const registered = step({
    previous: initial.tracker,
    online: true,
    portRegistered: true,
    now: 1_010,
  });

  // 申请回执后 20ms 端口就关闭：不能立刻重发（release→emit→effect→request 自激）。
  const released = step({
    previous: registered.tracker,
    online: true,
    portRegistered: false,
    now: 1_020,
  });
  assert.equal(released.request, false, "端口释放后必须至少等一个最小间隔");
  assert.equal(released.reason, "backoff");
  assert.equal(
    released.retryAfterMs,
    SOURCE_SETTINGS_ATTACHMENT_RELEASE_MIN_INTERVAL_MS - (1_020 - 1_000),
    "最小间隔从最近一次申请时间起算",
  );
  assert.equal(released.tracker.portReleaseAttempts, 1, "第一次释放计一次抖动");

  // 无关快照变化提前重跑 effect：retryNotBefore 仍要挡住，不能绕过最小间隔。
  const early = step({
    previous: released.tracker,
    online: true,
    portRegistered: false,
    now: 1_500,
  });
  assert.equal(early.request, false);
  assert.equal(early.reason, "backoff");
  assert.equal(
    early.retryAfterMs,
    1_020 + SOURCE_SETTINGS_ATTACHMENT_RELEASE_MIN_INTERVAL_MS - 1_500,
  );

  // 到点后（同一在线周期）按正常路径重申请。
  const due = step({
    previous: early.tracker,
    online: true,
    portRegistered: false,
    now: 1_020 + SOURCE_SETTINGS_ATTACHMENT_RELEASE_MIN_INTERVAL_MS,
  });
  assert.equal(due.request, true, "最小间隔到点后必须真正重新申请");
  assert.equal(due.tracker.portReleaseAttempts, 1);
  assert.equal(due.tracker.attemptedCycle, 0, "重新申请落在当前周期");
});

test("T-SS3 端口释放不清零失败计数：连续失败成为抖动兜底", () => {
  const initial = step({ online: true, now: 1_000 });
  const registered = step({
    previous: initial.tracker,
    online: true,
    portRegistered: true,
    now: 1_010,
  });
  // 端口曾成功建立，但此前已有连续失败：释放分支不得把它们洗掉。
  registered.tracker.failedAttempts = 3;

  const released = step({
    previous: registered.tracker,
    online: true,
    portRegistered: false,
    now: 1_020,
  });
  assert.equal(released.tracker.failedAttempts, 3, "释放分支不得清零失败计数");
  assert.equal(
    released.retryAfterMs,
    resolveSourceSettingsAttachmentRetryDelayMs(3) - (1_020 - 1_000),
    "释放退避取抖动次数与失败次数的较大者",
  );

  // 失败计数到达上限：释放分支也要直接进入放弃态。
  const exhausted = step({ online: true, now: 1_000 });
  const registered2 = step({
    previous: exhausted.tracker,
    online: true,
    portRegistered: true,
    now: 2_000,
  });
  registered2.tracker.failedAttempts = SOURCE_SETTINGS_ATTACHMENT_RETRY_MAX_ATTEMPTS;
  const releasedExhausted = step({
    previous: registered2.tracker,
    online: true,
    portRegistered: false,
    now: 3_000,
  });
  assert.equal(releasedExhausted.request, false);
  assert.equal(releasedExhausted.reason, "exhausted");
  assert.equal(releasedExhausted.tracker.exhausted, true);
});

test("T-SS3 端口先释放、快照后显示离线：重连进入新周期时照常申请", () => {
  const initial = step({ online: true, now: 1_000 });
  const registered = step({
    previous: initial.tracker,
    online: true,
    portRegistered: true,
    now: 2_000,
  });

  // 端口释放与离线在同一轮/相邻轮到达，两种顺序都允许；离线轮不得申请。
  const offline = step({
    previous: registered.tracker,
    online: false,
    portRegistered: false,
    now: 2_500,
  });
  assert.equal(offline.request, false);
  assert.equal(offline.reason, "offline");
  assert.equal(offline.tracker.attemptedCycle, null, "端口释放要解除同周期幂等键");

  const reconnected = step({
    previous: offline.tracker,
    online: true,
    portRegistered: false,
    now: 3_000,
  });
  assert.equal(reconnected.request, true);
  assert.equal(reconnected.reason, "reconnect");
  assert.equal(reconnected.tracker.cycle, 1);
});

test("T-SS3 端口登记后随即失效：连续释放按次退避，稳定登记后重新计数", () => {
  const initial = step({ online: true, now: 1_000 });

  const registered = step({
    previous: initial.tracker,
    online: true,
    portRegistered: true,
    now: 1_010,
  });
  const firstRelease = step({ previous: registered.tracker, online: true, now: 1_020 });
  assert.equal(firstRelease.request, false, "首次释放也要等最小间隔");
  assert.equal(firstRelease.reason, "backoff");
  assert.equal(firstRelease.tracker.portReleaseAttempts, 1);

  // 到点后重新申请（同周期），抖动次数不重复累计。
  const firstDue = step({ previous: firstRelease.tracker, online: true, now: 3_020 });
  assert.equal(firstDue.request, true);
  assert.equal(firstDue.tracker.portReleaseAttempts, 1);

  // 申请后端口刚登记又关闭：第二次释放退避翻倍。
  const registeredAgain = step({
    previous: firstDue.tracker,
    online: true,
    portRegistered: true,
    now: 3_030,
  });
  const secondRelease = step({ previous: registeredAgain.tracker, online: true, now: 3_040 });
  assert.equal(secondRelease.request, false);
  assert.equal(
    secondRelease.retryAfterMs,
    SOURCE_SETTINGS_ATTACHMENT_RETRY_BASE_DELAY_MS * 2 - (3_040 - 3_020),
  );

  // 端口稳定登记超过稳定阈值：视为新的一次正常释放，计数归零后重新按首次释放处理。
  const stableRegistered = step({
    previous: secondRelease.tracker,
    online: true,
    portRegistered: true,
    now: 4_000,
  });
  const stableRelease = step({
    previous: stableRegistered.tracker,
    online: true,
    now: 4_000 + SOURCE_SETTINGS_ATTACHMENT_STABLE_PORT_MS + 1_000,
  });
  assert.equal(stableRelease.request, true, "稳定登记的端口释放仍要立即重申请");
  assert.equal(stableRelease.tracker.portReleaseAttempts, 1);
});

test("T-SS3 稳定登记阈值必须大于端口桥的静默死亡观察窗口", () => {
  // 阈值若小于观察窗口，每次静默死亡都会因 registeredForMs 达标而清零 portReleaseAttempts，
  // 「连续 N 次抖动即放弃」永远触发不到（2026-10-25 复核：旧 60s 阈值按「15s 间隔 + 10s
  // 超时」取的，桥改成连续 3 次失败判死后窗口变成 70s）。这里从桥源码读真实节奏，
  // 桥改间隔/超时/失败阈值时本用例失败，提醒同步稳定阈值。
  const bridge = read(
    "packages",
    "desktop",
    "src",
    "renderer",
    "src",
    "sourceSettingsServicePortBridge.ts",
  );
  const readConstant = (name: string): number => {
    const value = new RegExp(`${name}\\s*=\\s*([\\d_]+)`).exec(bridge)?.[1];
    if (!value) assert.fail(`端口桥缺少常量 ${name}`);
    return Number(value.replace(/_/g, ""));
  };
  const interval = readConstant("SOURCE_SETTINGS_PORT_HEARTBEAT_INTERVAL_MS");
  const timeout = readConstant("SOURCE_SETTINGS_PORT_HEARTBEAT_TIMEOUT_MS");
  const maxFailures = readConstant("SOURCE_SETTINGS_PORT_HEARTBEAT_MAX_CONSECUTIVE_FAILURES");
  // 最坏情况：首个探测成功、随即静默死亡，再经历 maxFailures 个「间隔 + 超时」才判死。
  const observeWindow = interval * (maxFailures + 1) + timeout;
  assert.ok(
    SOURCE_SETTINGS_ATTACHMENT_STABLE_PORT_MS > observeWindow,
    `稳定阈值 ${SOURCE_SETTINGS_ATTACHMENT_STABLE_PORT_MS}ms 必须大于静默死亡观察窗口 ${observeWindow}ms`,
  );
});

test("T-SS3 端口抖动达到上限后停止自动重申请（自激循环有退出条件）", () => {
  let tracker = step({ online: true, now: 1_000 }).tracker;
  let now = 1_000;
  let release = step({ previous: tracker, online: true, now });

  for (let index = 0; index < SOURCE_SETTINGS_ATTACHMENT_RETRY_MAX_ATTEMPTS + 2; index += 1) {
    const registered = step({ previous: tracker, online: true, portRegistered: true, now });
    release = step({ previous: registered.tracker, online: true, now: now + 1 });
    tracker = release.tracker;
    now += 2;
  }
  assert.equal(release.request, false, "达到上限后不得再重申请");
  assert.equal(release.reason, "exhausted");
  assert.equal(release.tracker.exhausted, true);
  assert.equal(release.tracker.portReleaseAttempts, SOURCE_SETTINGS_ATTACHMENT_RETRY_MAX_ATTEMPTS);
});

test("T-SS3 连续失败按指数退避并封顶", () => {
  assert.equal(resolveSourceSettingsAttachmentRetryDelayMs(0), 0);
  assert.equal(
    resolveSourceSettingsAttachmentRetryDelayMs(1),
    SOURCE_SETTINGS_ATTACHMENT_RETRY_BASE_DELAY_MS,
  );
  assert.equal(
    resolveSourceSettingsAttachmentRetryDelayMs(2),
    SOURCE_SETTINGS_ATTACHMENT_RETRY_BASE_DELAY_MS * 2,
  );
  assert.equal(
    resolveSourceSettingsAttachmentRetryDelayMs(99),
    SOURCE_SETTINGS_ATTACHMENT_RETRY_MAX_DELAY_MS,
    "定时重试的延时有明确上限（30s），不会退化成高频轮询",
  );
});

test("T-SS3 management 快照未就绪时不拦截首次申请；切换设备重置周期与幂等键", () => {
  const unknownSnapshot = step({ online: undefined, now: 1_000 });
  assert.equal(unknownSnapshot.request, true, "快照未就绪保持旧行为（允许申请）");
  assert.equal(unknownSnapshot.reason, "initial");

  // 切到另一台再切回来：调用方拿到的是新设备的 tracker（previous 的 id 不匹配时视为首次）。
  const switched = step({
    previous: unknownSnapshot.tracker,
    sourceServerId: "source-b",
    online: true,
    now: 2_000,
  });
  assert.equal(switched.request, true, "切换设备必须为新设备申请");
  assert.equal(switched.tracker.sourceServerId, "source-b");
  assert.equal(switched.tracker.cycle, 0);
});

// ---------- 注册表：失效替换与显式释放 ----------

test("T-SS3 端口桥 close 语义（alive=false 且条目保留）之后 ensure 走替换分支", async () => {
  const sourceServerId = "source-close-retained";
  let alive = true;
  let disposed = 0;

  const closedServices = createServices("closed");
  registerSourceSettingsServices({
    sourceServerId,
    attachmentId: "attachment-close",
    services: closedServices,
    dispose: () => void (disposed += 1),
    isAlive: () => alive,
  });
  assert.equal(getSourceSettingsServices(sourceServerId), closedServices);

  // close / messageerror：alive=false，条目保留（不再同一 tick 删除）。
  alive = false;
  assert.equal(
    getSourceSettingsServices(sourceServerId),
    undefined,
    "失效条目不得让 portRegistered 恒真",
  );
  assert.equal(disposed, 0, "close 只标记失效，不立即 dispose");

  let requestCount = 0;
  await ensureSourceSettingsServices(sourceServerId, async () => {
    requestCount += 1;
    return { attachmentId: "attachment-replacement" };
  });
  assert.equal(requestCount, 1, "ensure 必须替换失效条目并重新申请");
  assert.equal(disposed, 1, "替换时必须 dispose 旧条目（关闭端口与心跳）");
  assert.equal(getSourceSettingsServices(sourceServerId), undefined, "申请回执不等于端口已登记");
});

test("T-SS3 旧端口条目失效后 ensure 会替换，而不是直接返回旧条目", async () => {
  const sourceServerId = "source-stale-entry";
  let alive = true;
  let staleDisposed = 0;
  const staleServices = createServices("stale");

  registerSourceSettingsServices({
    sourceServerId,
    attachmentId: "attachment-stale",
    services: staleServices,
    dispose: () => void (staleDisposed += 1),
    isAlive: () => alive,
  });
  assert.equal(getSourceSettingsServices(sourceServerId), staleServices);

  // 端口桥判定端口已失效（close 未到达也可能发生）：读取方不能再把它当可用端口。
  alive = false;
  assert.equal(
    getSourceSettingsServices(sourceServerId),
    undefined,
    "失效条目不得让 portRegistered 恒真",
  );

  let requestCount = 0;
  await ensureSourceSettingsServices(sourceServerId, async () => {
    requestCount += 1;
    return { attachmentId: "attachment-fresh" };
  });
  assert.equal(requestCount, 1, "ensure 必须重新申请，不能因旧条目存在而短路");
  assert.equal(staleDisposed, 1, "失效条目的 dispose 必须被调用");
  assert.equal(getSourceSettingsServices(sourceServerId), undefined, "申请回执不等于端口已登记");

  // 新端口登记后接替旧条目。
  const freshServices = createServices("fresh");
  const releaseFresh = registerSourceSettingsServices({
    sourceServerId,
    attachmentId: "attachment-fresh",
    services: freshServices,
    dispose: () => {},
  });
  assert.equal(getSourceSettingsServices(sourceServerId), freshServices);
  releaseFresh();
});

test("T-SS3 invalidate：心跳判定失效时条目留在注册表但读取为 undefined，ensure 负责替换", async () => {
  const sourceServerId = "source-invalidated";
  const events: string[] = [];
  const unsubscribe = subscribeSourceSettingsServices(() => events.push("changed"));
  let disposed = 0;
  const services = createServices("invalidated");
  registerSourceSettingsServices({
    sourceServerId,
    attachmentId: "attachment-live",
    services,
    dispose: () => void (disposed += 1),
    // 真实链路的 isAlive 由端口桥的 alive 变量驱动；这里恒 true，
    // 失效必须完全由 invalidate 标记驱动（模拟没有存活探测的调用方）。
    isAlive: () => true,
  });
  assert.equal(getSourceSettingsServices(sourceServerId), services);

  assert.equal(
    invalidateSourceSettingsServices(sourceServerId, "attachment-old"),
    false,
    "attachmentId 不匹配的迟到心跳失败不得误伤当前一代",
  );
  assert.equal(invalidateSourceSettingsServices(sourceServerId, "attachment-live"), true);
  assert.equal(
    getSourceSettingsServices(sourceServerId),
    undefined,
    "失效条目必须立即从读取面消失（portRegistered 不再恒真）",
  );
  assert.deepEqual(events, ["changed", "changed"], "失效必须通知订阅者重算");
  assert.equal(
    invalidateSourceSettingsServices(sourceServerId, "attachment-live"),
    false,
    "重复失效必须幂等",
  );

  let requestCount = 0;
  await ensureSourceSettingsServices(sourceServerId, async () => {
    requestCount += 1;
    return { attachmentId: "attachment-replacement" };
  });
  assert.equal(requestCount, 1, "ensure 必须走失效替换分支重新申请");
  assert.equal(disposed, 1, "失效条目的 dispose 必须被调用（含心跳停止）");
  assert.equal(getSourceSettingsServices(sourceServerId), undefined, "申请回执不等于端口已登记");
  unsubscribe();
});

test("T-SS3 显式 release：close 未触发时也能撤销条目并通知订阅者", () => {
  const sourceServerId = "source-explicit-release";
  const events: string[] = [];
  const unsubscribe = subscribeSourceSettingsServices(() => events.push("changed"));
  let disposed = 0;
  const services = createServices("released");

  registerSourceSettingsServices({
    sourceServerId,
    attachmentId: "attachment-current",
    services,
    dispose: () => void (disposed += 1),
  });
  assert.deepEqual(events, ["changed"]);

  // 迟到的旧 attachment 失败不得误删当前一代。
  assert.equal(
    releaseSourceSettingsServices(sourceServerId, "attachment-old"),
    false,
    "attachmentId 不匹配时必须忽略",
  );
  assert.equal(getSourceSettingsServices(sourceServerId), services);

  assert.equal(releaseSourceSettingsServices(sourceServerId), true);
  assert.equal(getSourceSettingsServices(sourceServerId), undefined);
  assert.equal(disposed, 1);
  assert.deepEqual(events, ["changed", "changed"], "显式释放必须通知设置页重算");
  assert.equal(releaseSourceSettingsServices(sourceServerId), false, "重复释放必须幂等");
  unsubscribe();
});

// ---------- 生产入口形状守卫 ----------

test("T-SS3 生产入口：effect 订阅 management 快照并真正走决策/申请链路", () => {
  const settingsPage = read("packages", "ui", "src", "SettingsPage.tsx");

  assert.match(
    settingsPage,
    /isSettingsSourceOnline[\s\S]{0,120}resolveSettingsSourceCapabilityServices[\s\S]{0,120}from "@\/settings\/settingsSourceWorkspace\.js"/,
    "在线判定与端口服务集校验必须复用设置面唯一口径",
  );
  assert.match(
    settingsPage,
    /import \{ getSourceSettingsServices \} from "@\/store\/sourceSettingsServiceStore\.js";/,
    "申请回执后必须回读注册表校验端口是否真的登记",
  );
  assert.match(
    settingsPage,
    /import \{ useSourceSettingsServices \} from "@\/store\/sourceSettingsServiceStore\.js";/,
    "必须订阅端口注册表（已成功登记的端口不重申请，释放要参与判定）",
  );
  assert.match(
    settingsPage,
    /import \{ useSourceSettingsServicesVersion \} from "@\/store\/sourceSettingsServiceStore\.js";/,
    "必须订阅注册表版本（登记后同批失效时 snapshot 会回到 undefined）",
  );
  assert.match(
    settingsPage,
    /import \{ releaseSourceSettingsServices \} from "@\/store\/sourceSettingsServiceStore\.js";/,
    "离线但 close 未到达时必须显式释放旧端口条目",
  );

  const attachmentEffect = settingsPage.match(
    /const sourceServerId = selectedSettingsSourceServerId;[\s\S]*?\n  \}, \[[\s\S]*?\]\);/,
  );
  assert.ok(
    attachmentEffect,
    "attachment effect 必须由 management 快照变化驱动，并以「决策 → 申请」收尾",
  );
  const effectSource = attachmentEffect![0];
  assert.match(
    effectSource,
    /sourceSettingsPortServicesVersion/,
    "effect 必须依赖注册表版本，否则失效条目等不到重算",
  );
  assert.match(
    effectSource,
    /isSettingsSourceOnline\(snapshot, sourceServerId\)/,
    "在线状态必须来自 management 快照（设备重连的事实源）",
  );
  // 释放判定：连续两次明确 offline + 最新快照复核，不能单次 offline 直接 release。
  assert.match(
    effectSource,
    /decideSourceSettingsAttachmentOfflineRelease\(/,
    "释放必须走两次观察判定",
  );
  assert.match(
    effectSource,
    /scheduleSourceAttachmentRetry\(SOURCE_SETTINGS_ATTACHMENT_OFFLINE_CONFIRM_DELAY_MS\)/,
    "第一次明确 offline 必须安排一次可取消的复核，而不是立即释放",
  );
  assert.match(effectSource, /deviceManagement\.getSnapshot\(\)/, "释放前必须用最新快照复核");
  assert.match(
    effectSource,
    /isSettingsSourceOnline\(latest, sourceServerId\)[\s\S]*?releaseSourceSettingsServices\(sourceServerId(?:,\s*[A-Za-z0-9_$]+)?\)/,
    "只有最新快照仍明确 offline 才释放仍存活的端口",
  );
  assert.match(
    effectSource,
    /releaseSourceSettingsServices\(sourceServerId(?:,\s*[A-Za-z0-9_$]+)?\)/,
    "离线确认后必须释放端口",
  );
  assert.match(
    effectSource,
    /ensureSourceSettingsServices\(\s*(?:selectedSettingsSourceServerId|sourceServerId),\s*sourceAttachmentRequest,?\s*\)/,
    "决策为 request 时必须真的调用申请（不能只加 prop / 留接口）",
  );
  // 回执 ≠ 已登记：必须回读注册表并校验服务集合，未登记按失败路径处理。
  assert.match(
    effectSource,
    /resolveSourceSettingsAttachmentReceiptOutcome\([\s\S]*?getSourceSettingsServices\(sourceServerId\)/,
    "申请回执后必须校验端口登记与服务集合",
  );
  assert.match(
    effectSource,
    /resolveSourceSettingsAttachmentReceiptOutcome\(sourceSettingsPortServices\)/,
    "决策里的 portRegistered 也必须校验服务集合，条目存在不等于设置面可用",
  );
  assert.match(
    effectSource,
    /releaseSourceSettingsServices\(sourceServerId(?:,\s*[A-Za-z0-9_$]+)?\);[\s\S]*?attemptedCycle = null/,
    "服务集不完整的存活条目必须先摘掉并解除幂等键，否则 ensure 会空转",
  );
  assert.match(
    effectSource,
    /receipt !== "registered"[\s\S]*?applyFailure\(receipt\)/,
    "回执未登记必须走失败路径（继续退避重试），不能直接清退避",
  );
  assert.match(
    effectSource,
    /recordSourceSettingsAttachmentFailure\(\{ tracker \}\)/,
    "失败必须累计退避次数并判定是否放弃",
  );
  // 失败必须解除同周期幂等键，否则退避到期后仍被 same-cycle 拦住。
  assert.match(effectSource, /attemptedCycle = null/, "失败后必须清空 attemptedCycle");
  // 退避与失败都必须安排下一次触发（一次性定时器），不能等下一个无关事件。
  assert.match(
    effectSource,
    /decision\.reason === "backoff"[\s\S]*?scheduleSourceAttachmentRetry\(decision\.retryAfterMs\)/,
    "退避未到时必须注册一次性定时器",
  );
  assert.match(
    effectSource,
    /scheduleSourceAttachmentRetry\(outcome\.retryAfterMs\)/,
    "申请失败本身也必须安排退避后的自动重试",
  );
  // 自动重试必须有次数上限且在 UI 上显式可见。
  assert.match(
    effectSource,
    /if \(outcome\.exhausted\)[\s\S]*?clearSourceAttachmentRetryTimer\(\);/,
    "达到上限后必须停止自动重试",
  );
  assert.match(effectSource, /syncSourceAttachmentExhausted\(/, "放弃态必须同步到 UI 状态");
  assert.match(
    settingsPage,
    /data-testid="settings-source-attachment-exhausted"/,
    "放弃态必须有可见 UI",
  );
  assert.match(settingsPage, /handleRetrySourceAttachment/, "放弃态必须有手动重试出口");
  assert.match(
    effectSource,
    /return clearSourceAttachmentRetryTimer;/,
    "effect 清理必须撤销定时器",
  );
  assert.match(
    settingsPage,
    /clearTimeout\(sourceAttachmentRetryTimerRef\.current\)/,
    "定时器必须可取消（clearTimeout 落到 ref）",
  );
  assert.match(
    settingsPage,
    /setSourceAttachmentRetryTick/,
    "定时器到期必须重新触发同一决策（effect 依赖 tick）",
  );
  assert.doesNotMatch(effectSource, /setInterval/, "不得引入轮询定时器");
});

test("T-SS3 生产入口：端口桥区分 messageerror 与真死亡，连续探测失败才判死", () => {
  const bridge = read(
    "packages",
    "desktop",
    "src",
    "renderer",
    "src",
    "sourceSettingsServicePortBridge.ts",
  );

  assert.match(bridge, /isAlive: \(\) => alive/, "端口存活事实必须交给注册表（ensure 据此替换）");
  assert.match(
    bridge,
    /addEventListener\("messageerror", probeLiveness\)/,
    "messageerror 只说明单条消息反序列化失败，必须补一次真实探测而不是直接判死",
  );
  assert.doesNotMatch(
    bridge,
    /addEventListener\("messageerror", markUnavailable/,
    "messageerror 不得直接标记失效：慢链路抖动/坏 payload 会把仍可用的端口送进释放链",
  );
  assert.match(bridge, /addEventListener\("close", markUnavailable/, "close 也必须标记失效");
  assert.match(
    bridge,
    /const markUnavailable[\s\S]*?alive = false;[\s\S]*?invalidateSourceSettingsServices\(sourceServerId, attachmentId\)/,
    "close/连续探测失败必须在同一条失效路径上保留条目（alive=false 生产可达）",
  );
  assert.match(
    bridge,
    /dispose: \(\) => \{[\s\S]*?alive = false;[\s\S]*?connection\.dispose\(\);[\s\S]*?port\.close\(\);/,
    "条目 dispose 必须让存活探测立即失效并关闭端口",
  );
  assert.match(
    bridge,
    /catch \{[\s\S]*?releaseSourceSettingsServices\(sourceServerId, attachmentId\);[\s\S]*?port\.close\(\);/,
    "建连失败也必须走真实释放入口并关闭端口，不登记死条目",
  );
  // 静默死端口（无 close/messageerror、快照仍 online）：必须有主动存活探测。
  assert.match(bridge, /systemService\.info\(\)/, "存活探测必须是真实 RPC 往返");
  assert.match(bridge, /setInterval\(/, "存活探测必须有周期触发");
  assert.match(bridge, /clearInterval\(/, "释放/失效/换代时必须停止存活探测");
  assert.match(
    bridge,
    /setTimeout\(fail, SOURCE_SETTINGS_PORT_HEARTBEAT_TIMEOUT_MS\)/,
    "探测必须有超时，不能对挂起的 Host 无限等待",
  );
  // 单次超时/单条 messageerror 不判死：必须累计连续失败，成功（含迟到的成功）清零。
  assert.match(
    bridge,
    /SOURCE_SETTINGS_PORT_HEARTBEAT_MAX_CONSECUTIVE_FAILURES = 3/,
    "必须有连续失败阈值，不能一次 RPC 抖动就判死",
  );
  assert.match(
    bridge,
    /consecutiveProbeFailures >= SOURCE_SETTINGS_PORT_HEARTBEAT_MAX_CONSECUTIVE_FAILURES[\s\S]*?markUnavailable\(\)/,
    "只有连续失败达到阈值才走失效路径",
  );
  assert.match(
    bridge,
    /consecutiveProbeFailures = 0/,
    "成功往返必须清零连续失败计数（慢链路的迟到成功也算存活证据）",
  );
  assert.match(
    bridge,
    /if \(settled \|\| !alive \|\| seq !== probeSeq\) return;/,
    "同一探测只计一次失败，超时后迟到的 rejection 不得重复累计",
  );
});

test("T-SS3 生产入口：过期注释已改写为当前真实链路", () => {
  const settingsPage = read("packages", "ui", "src", "SettingsPage.tsx");

  assert.doesNotMatch(
    settingsPage,
    /尚未随本批/,
    "旧注释声称 Desktop IPC 与端口桥未落位，已与 ab7dd19e 的事实冲突",
  );
  assert.match(
    settingsPage,
    /sourceSettingsServicePortBridge/,
    "注释必须指向 renderer 端口桥这一真实落点",
  );
  assert.match(
    settingsPage,
    /InternalChannels\.SourceSettingsServicePort/,
    "注释必须说明 main 经该频道投递 scoped MessagePort",
  );
});
