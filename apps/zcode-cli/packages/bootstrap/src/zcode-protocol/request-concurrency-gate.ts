import type { CommandConcurrency } from "./command-concurrency.js";

interface GateWaiter {
  concurrency: CommandConcurrency;
  /** 放行：此刻起该请求持有自己的槽位（只读共享 / 变更独占）。 */
  grant: () => void;
}

/**
 * **命令级读写锁**（fix-c20）：把「所有请求一把串行队列」换成「只读共享、变更独占」。
 *
 * ## 语义（三条，缺一条就是次序事故）
 *
 * 1. **只读之间并发**：在队首的连续只读一次性全部放行。只读与只读没有次序语义
 *    （见 `command-concurrency.ts` 的三条判据），排队只会互相白等。
 * 2. **变更独占**：变更必须等**所有在飞的只读排空**才进（`activeReaders === 0`），
 *    且在它出队之前**任何新只读都不得进入**。后一条是「变更与它之后到达的只读之间的
 *    次序语义不能变」的全部内容——只读不许插队到已排队的变更前面。
 * 3. **严格 FIFO**：队列按到达顺序排，变更与变更之间的顺序因此等于到达顺序。
 *
 * 这三条合起来就是「写优先的公平读写锁」：`[R1, R2, W1, R3]` 的实际执行是
 * `R1‖R2 → W1 → R3`，而不是 `R1‖R2‖R3 → W1`（后者让 R3 越过 W1，正是次序错乱）。
 *
 * ## 失败不毒化
 *
 * 槽位释放一律在 `finally` 语义里（`run` 的 resolve / reject 两个分支都调 `release`，
 * 任务同步抛错也调）。一次只读抛错只让它自己失败，`activeReaders` 照样回落，
 * 排队的变更照常进——否则一次上游报错就会把整条命令通道永久钉死。
 *
 * ## 与旁路的关系
 *
 * 停止 / 取消**不过这把锁**（`transport.ts` 的旁路名单先命中）：它们要能越过一条正在飞的
 * 长变更。锁只覆盖「普通命令」这一档，语义与改造前的 `processing` 链一致。
 */
export class RequestConcurrencyGate {
  private readonly queue: GateWaiter[] = [];
  private activeReaders = 0;
  private activeWriter = false;
  /** 已入队 + 已放行、尚未结束的请求数（`isIdle` / `waitForIdle` 的唯一判据）。 */
  private pending = 0;
  private existingIdleWaiters: Array<() => void> = [];
  private pumping = false;

  /**
   * 排队并执行。`onStart` 在**拿到槽位的那一刻**同步调用（旁路的
   * `lastQueuedMessageStarted` 靠它保持原有语义：等的是「前面的请求真的开始跑了」，
   * 不是「前面的请求跑完了」）。
   */
  run<T>(
    concurrency: CommandConcurrency,
    task: () => Promise<T> | T,
    onStart?: () => void,
  ): Promise<T> {
    this.pending += 1;
    return new Promise<T>((resolve, reject) => {
      const waiter: GateWaiter = {
        concurrency,
        grant: () => {
          let started: Promise<T> | T;
          try {
            onStart?.();
            started = task();
          } catch (error) {
            this.release(concurrency);
            reject(error);
            return;
          }
          // `then` 的两个分支都释放槽位：抛错不毒化锁（见文件头）。
          Promise.resolve(started).then(
            (value) => {
              this.release(concurrency);
              resolve(value);
            },
            (error: unknown) => {
              this.release(concurrency);
              reject(error);
            },
          );
        },
      };
      this.queue.push(waiter);
      this.pump();
    });
  }

  /** 当前是否有请求在飞或排队（EOF 半关闭时的「等队列排空」用它）。 */
  isIdle(): boolean {
    return this.pending === 0;
  }

  waitForIdle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.existingIdleWaiters.push(resolve);
    });
  }

  /** 诊断/测试读数：谁在飞、谁在排。 */
  inspect(): { queued: number; waitingWriters: number; activeReaders: number; writer: boolean } {
    return {
      queued: this.queue.length,
      waitingWriters: this.queue.filter((entry) => entry.concurrency === "mutating").length,
      activeReaders: this.activeReaders,
      writer: this.activeWriter,
    };
  }

  private pump(): void {
    // 重入保护：`grant` 会同步启动任务，任务体内若再次 run() 就会回到这里；
    // 外层循环会继续把该放行的都放行，内层直接返回即可。
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        // 变更在飞：一个人都不放（独占）。
        if (this.activeWriter) return;
        const head = this.queue[0]!;
        if (head.concurrency === "mutating") {
          // 变更必须等所有在飞的只读排空；排不空就停在这里，后面的只读也不许过。
          if (this.activeReaders > 0) return;
          this.queue.shift();
          this.activeWriter = true;
          head.grant();
          // 变更独占：它没结束之前，后面的任何请求（含只读）都不得开始。
          return;
        }
        this.queue.shift();
        this.activeReaders += 1;
        head.grant();
        // 继续循环：队首还是只读就一起放行；是变更则因 activeReaders > 0 停下。
      }
    } finally {
      this.pumping = false;
      this.notifyIdle();
    }
  }

  private release(concurrency: CommandConcurrency): void {
    if (concurrency === "mutating") this.activeWriter = false;
    else this.activeReaders = Math.max(0, this.activeReaders - 1);
    this.pending = Math.max(0, this.pending - 1);
    // 释放即重排：这一步同时负责「排空的变更放行」与「它之后排队的只读放行」。
    this.pump();
  }

  private notifyIdle(): void {
    if (this.pending !== 0 || this.existingIdleWaiters.length === 0) return;
    const waiters = this.existingIdleWaiters;
    this.existingIdleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
