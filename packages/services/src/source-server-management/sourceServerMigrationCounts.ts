// 照搬上游 v3.16.2 source-server-management/sourceServerMigrationCounts.ts（backlog-sweep
// Step 7，P9-1）。职责：把「每台设备的失败/已放弃迁移路径数」做成带状态的缓存投影。
//
// 上游语义（沿用 SourceServerManagementSnapshot.migrationCounts 四态）：
// - available：已从在线 Source 读到真实计数；
// - requires-connection：设备当前没有在线连接，计数不可读（不是错误）；
// - loading：后台读取进行中；
// - unavailable：读取抛错，保留上一轮可用值以外的空投影。
//
// 关键约束：统计完成本身会写 directory 事件面，若每次事件都重读远端就会形成反馈轮询。
// 因此只有显式 `refresh: true`（进入/刷新设置页）才发起新读取；事件驱动的 getSnapshot
// 只回放缓存。后台读取完成时通过 onDidChange 通知一次，由调用方决定是否重读快照。
import type { SourceServerManagementSnapshot } from "@zcode/shared";

export type SourceServerMigrationCountState =
  SourceServerManagementSnapshot["migrationCounts"][number];

export type SourceServerMigrationCountsReadResult =
  | { status: "available"; failedPathCount: number; abandonedPathCount: number }
  | { status: "requires-connection" };

export interface SourceServerMigrationCountsOptions {
  readCounts(sourceServerId: string): Promise<SourceServerMigrationCountsReadResult>;
  /** 后台读取完成（状态确有变化）时通知；调用方据此发布 directory 事件。 */
  onDidChange?(): void;
  logWarn?(message: string, error: Error): void;
}

interface MigrationCountEntry {
  state: SourceServerMigrationCountState;
  /** 每次发起读取自增；迟到的旧读取结果按 epoch 丢弃。 */
  epoch: number;
  inFlight: boolean;
}

export class SourceServerMigrationCounts {
  private readonly entries = new Map<string, MigrationCountEntry>();
  private disposed = false;

  public constructor(private readonly options: SourceServerMigrationCountsOptions) {}

  /** 只读投影；顺序与传入的 serverIds 一致。 */
  public read(
    serverIds: readonly string[],
    options: { refresh?: boolean } = {},
  ): SourceServerMigrationCountState[] {
    const wanted = new Set(serverIds);
    for (const serverId of this.entries.keys()) {
      if (!wanted.has(serverId)) this.entries.delete(serverId);
    }
    return serverIds.map((sourceServerId) => {
      const entry = this.entries.get(sourceServerId);
      if (!entry) return this.begin(sourceServerId);
      // refresh 表示「显式刷新」：已有可用值时先回放旧值（stale-while-revalidate），
      // 没有可用值才暴露 loading，避免设置页每轮刷新都闪成加载态。
      if (options.refresh === true && !entry.inFlight) {
        this.begin(sourceServerId);
      }
      return entry.state;
    });
  }

  public dispose(): void {
    this.disposed = true;
    this.entries.clear();
  }

  private begin(sourceServerId: string): SourceServerMigrationCountState {
    const previous = this.entries.get(sourceServerId);
    const epoch = (previous?.epoch ?? 0) + 1;
    const entry: MigrationCountEntry = {
      // 有可用旧值时保留它直到新结果落地（stale-while-revalidate）；没有才暴露 loading。
      state: previous?.state ?? { sourceServerId, status: "loading" },
      epoch,
      inFlight: true,
    };
    this.entries.set(sourceServerId, entry);
    void this.load(sourceServerId, epoch);
    return entry.state;
  }

  private async load(sourceServerId: string, epoch: number): Promise<void> {
    let next: SourceServerMigrationCountState;
    try {
      const result = await this.options.readCounts(sourceServerId);
      next =
        result.status === "available"
          ? {
              sourceServerId,
              status: "available",
              failedPathCount: result.failedPathCount,
              abandonedPathCount: result.abandonedPathCount,
            }
          : { sourceServerId, status: "requires-connection" };
    } catch (error) {
      this.options.logWarn?.(
        `failed to read migration counts for source server ${sourceServerId}`,
        error instanceof Error ? error : new Error(String(error)),
      );
      next = { sourceServerId, status: "unavailable" };
    }
    const current = this.entries.get(sourceServerId);
    // 设备已删除或期间又发起了更新的读取：旧结果直接丢弃。
    if (this.disposed || !current || current.epoch !== epoch) return;
    const changed = JSON.stringify(current.state) !== JSON.stringify(next);
    this.entries.set(sourceServerId, { state: next, epoch, inFlight: false });
    if (changed) this.options.onDidChange?.();
  }
}

export function sumMigrationCounts(counts: readonly SourceServerMigrationCountState[]): {
  failedPathCount: number;
  abandonedPathCount: number;
} {
  let failedPathCount = 0;
  let abandonedPathCount = 0;
  for (const count of counts) {
    if (count.status !== "available") continue;
    failedPathCount += count.failedPathCount;
    abandonedPathCount += count.abandonedPathCount;
  }
  return { failedPathCount, abandonedPathCount };
}
