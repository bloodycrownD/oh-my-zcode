/**
 * `openTiming.cliBootstrapMs` / `cliProcessState` 的判定规则（**观测层**，不启动进程、不改语义）。
 *
 * 为什么需要这一层：旧实现用 `processManager.getExistingClient(params)` 的返回是否非空来判
 * `cliProcessState`。侧栏任务列表为了渲染列表会**预建** client 对象（进程尚未 spawn），于是
 * 冷开（本次 subscribe 才把进程拉起来）也被记成 `reused`，spawn 成本落进 `hostPrepareMs`，
 * `cliBootstrapMs` 结构性缺席。判据因此只能是**进程事实**，不能是「client 对象存在」。
 *
 * 判定口径（已写进 spec phase-0-baseline 的冷开判据）：
 *   - `spawned` = 本次 subscribe **触发或等待**了一次进程启动（含等别的调用方在途的 spawn）；
 *     只有这一档才有 `cliBootstrapMs`（= 本次获取 client 的等待耗时）。
 *   - `reused`  = 调用前后是**同一个**已登记 runtime，本次调用没有付出 spawn 等待。
 * 「等待他人启动中的 spawn」也算 spawned：spawn 成本确实落在这次 subscribe 的延迟里，
 * 记成 reused 会让这段成本从分段里消失。
 */

/** 某 workspace 的进程事实快照；`getRuntimeSpawnSnapshot` 的返回值。 */
export interface ZCodeAgentRuntimeSpawnSnapshot {
  /** 已登记受管 runtime 的 spawn 时刻（epoch ms）。在途 spawn / 无 runtime 时缺席。 */
  startedAt?: number;
  /** 已登记受管 runtime 的代次（每次 spawn 递增）。在途 spawn / 无 runtime 时缺席。 */
  generation?: number;
  /** 已登记受管 runtime 的进程号。在途 spawn / 无 runtime 时缺席。 */
  pid?: number;
  /** 该 workspace 是否有 `getClient` 正在启动中（在途 spawn，尚无受管 entry）。 */
  startInFlight: boolean;
}

/** 与 `conversationOpenTimingSchema.cliProcessState` 同值域。 */
export type CliProcessState = "spawned" | "reused";

/** 判定依据，用于日志与采样报告解释（**不是**新的协议字段）。 */
export type CliBootstrapReason =
  | "no-runtime-before"
  | "waited-in-flight-spawn"
  | "runtime-replaced"
  | "same-runtime"
  | "runtime-vanished-after-acquire";

export interface CliBootstrapObservation {
  cliProcessState: CliProcessState;
  reason: CliBootstrapReason;
  /** 本次 acquire 是否覆盖了 spawn（= `cliBootstrapMs` 是否该有值）。 */
  spawnObserved: boolean;
}

/**
 * 按 acquire 前后的进程事实判定本次 subscribe 的 `cliProcessState`。
 *
 * 判决顺序（先命中先返回，避免「在途 spawn」与「仍登记的旧 runtime」同时出现时的歧义）：
 *   1. 调用前无任何 runtime 也无在途启动 → 这次调用把进程拉起来了；
 *   2. 调用前已有在途启动 → 这次调用在等那次 spawn；
 *   3. 调用后查不到 runtime（acquire 拿到 client 后进程立刻被回收）→ 本次没等 spawn；
 *   4. spawn 时刻/代次变了 → 调用期间换了新进程；
 *   5. 其余 → 同一个 runtime。
 */
export function resolveCliBootstrapObservation(
  before: ZCodeAgentRuntimeSpawnSnapshot | undefined,
  after: ZCodeAgentRuntimeSpawnSnapshot | undefined,
): CliBootstrapObservation {
  if (!before) {
    return { cliProcessState: "spawned", reason: "no-runtime-before", spawnObserved: true };
  }
  if (before.startInFlight) {
    return { cliProcessState: "spawned", reason: "waited-in-flight-spawn", spawnObserved: true };
  }
  if (!after) {
    // 无 after 只可能是 acquire 之后 runtime 被回收：这次 acquire 本身没有付 spawn 等待。
    return {
      cliProcessState: "reused",
      reason: "runtime-vanished-after-acquire",
      spawnObserved: false,
    };
  }
  const sameRuntime =
    before.startedAt === after.startedAt &&
    before.generation === after.generation &&
    before.pid === after.pid;
  return sameRuntime
    ? { cliProcessState: "reused", reason: "same-runtime", spawnObserved: false }
    : { cliProcessState: "spawned", reason: "runtime-replaced", spawnObserved: true };
}
