/**
 * historian 的两态 settle：短驻前台有界等待 / 长驻后台记账。
 *
 * 从 `../magic-context-turn-transform.ts` 拆出（Step 3 / phase-facade，零行为）。
 * 为什么单独成文件：这是**时序**不变量（spec 第 3 条）的落点——判据
 * `processExitsAfterTurn` 只在端口入口求值一次（`settlesInForeground`），本文件只提供
 * 两个动作、不持判据，谁都不会在这里重复判断进程形态。
 */

import { getActiveCompartmentRun } from "@zcode/magic-context";
import type { MagicContextTurnTransformOptions } from "./types.js";

/**
 * FORK（S24-fix2 + bugfix-batch-20261011 / Step 2）：让本 pass 起的 historian 跑完
 * 再交还控制权——**只用于短驻形态**（`processExitsAfterTurn !== false`，即 CLI `-p`
 * 一次性进程与所有未声明形态）。长驻形态（app-server / TUI）由
 * {@link settleInFlightHistorianInBackground} 记账后放行，不阻塞前台。
 *
 * 上游（OpenCode）是长驻进程：compartment agent 是 fire-and-forget 的，但**进程
 * 不会退出**，所以它跑完的 publish 与 drain 预留一定落地。
 *
 * ZCode 的短驻形态是「一进程 = 一轮 prompt」：transform 一返回，这一轮就结束了，
 * historian 还在飞的那几秒会随进程一起消失——drain 预留泄漏（下一轮报
 * `historian skip: internal drain budget spent`）、compartment 不落库。
 *
 * 所以短驻形态这里有界地等这一轮 historian 落定（失败/拒绝都被吞掉——它本来就不该
 * 影响这一轮请求）。代价是这一轮的请求会晚发出几秒；这是「进程会退出」这件事在本
 * fork 里必须付的钱。长驻形态不付这笔钱（进程不会退出），支付方式见后台变体。
 *
 * provider 的注册范围问题见下面 `ensureProviderRegistered` 的注释。
 */
export const HISTORIAN_SETTLE_TIMEOUT_MS = 60_000;

export async function settleInFlightHistorian(sessionId: string): Promise<void> {
  const active = getActiveCompartmentRun(sessionId);
  if (!active) return;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, HISTORIAN_SETTLE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([
      active.promise.then(
        () => undefined,
        () => undefined,
      ),
      expired,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * FORK（bugfix-batch-20261011 / Step 2）：{@link settleInFlightHistorian} 的后台变体
 * ——长驻形态专用。
 *
 * 这一路**绝不 await**（调用点就用 `void` 丢出去）：app-server / TUI 的进程不会随
 * 一轮退出，让首 token 或排队消息的 idle-only 提升等一次最长 60s 的 historian 是
 * 错的（spec bugfix-batch-20261011 缺陷①）。收起工作交给两件既有的事：
 *   ① 调度器契约自陈 fire-and-forget 自行 publish（historian-scheduler.ts 文件头）；
 *   ② 优雅关闭（app.close() / disposeAllAndWait 的 graceful 段）由 `registerClose`
 *      的 drain 收口兜底（MF-05）。
 * 强杀（force-kill）下与 CLI 一进程一轮同损——既有风险，非本批新增。
 *
 * 保留 `settleInFlightHistorian` 内部的 60s 上界与 `timer.unref()`：后台 promise
 * 因此既不会无限期挂在进程里，也不会拖住进程退出（unref 计时器不保持事件循环）。
 * 本函数只做**记账**：有一条在飞的 run 时，落定后记一条 debug，异常路径记一条 warn
 * ——`settleInFlightHistorian` 自己吞掉了 run 的拒绝，这里的 warn 只可能来自它自身
 * 的编程错误，属于「可恢复异常」而不是崩溃。
 */
export function settleInFlightHistorianInBackground(
  sessionId: string,
  logger: MagicContextTurnTransformOptions["logger"],
): void {
  // 本来就没有在飞的 run 时连日志都不多一条：settle 是每个 model step 前的常规路径，
  // 而「没有 historian 在飞」才是常态。
  if (getActiveCompartmentRun(sessionId) === undefined) return;
  void settleInFlightHistorian(sessionId).then(
    () => {
      logger.debug("Magic context historian settled in the background", {
        module: "bootstrap",
        event: "magic_context.settle_background_settled",
        sessionId,
      });
    },
    (error: unknown) => {
      logger.warn("Magic context historian background settle failed", {
        module: "bootstrap",
        event: "magic_context.settle_background_failed",
        sessionId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    },
  );
}
