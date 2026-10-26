import type { SessionId, SessionMessageIndexEntry, SessionStorePort } from "@zcode/contracts";

/**
 * 全序消息索引（`listSessionMessageIndex`）的**会话级读取缓存**。
 *
 * 为什么需要缓存：索引读是 O(messages)——实测 5000 消息 6.8ms（`test-session-message-index`
 * 的 A 组；对比 `messages()` 全量 131.7ms）。冷开后的翻页 / 目录 / 裁断会**多次**要同一份
 * id 序（Step 5 的 `readActiveBranchTail`、Step 7 的按需物化、`session.revert` 裁断），
 * 每次重读就是把 6.8ms 乘上页数。缓存粒度是「会话 × 一次数据快照」，不是「一次查询」。
 *
 * 缓存什么：`SessionMessageIndexEntry[]`（id + sequence + timeCreated + storageRowId），
 * **不含**正文与 role——它就是窄读形状，缓存它不会把 `data` 留在内存里。
 *
 * 失效点（三个，全部写死在这里，调用方不得各自猜）：
 *   1. **新消息落库 / 任何 live ingest**：gateway 对每个进入某会话的事件调 `invalidate`
 *      （粗粒度但不会漏；冷会话没有 ingest，缓存因此能跨页存活）；
 *   2. **rewind（消息被截断）**：同上，`RewindTriggered` 也是 ingest 事件；
 *   3. **hydration 重建投影**：投影重放不改变 message 表，缓存**不需要**失效；但进程重启
 *      后是新缓存实例，天然从空开始。真正的失效仍然由 1/2 覆盖。
 *
 * 缺席语义（Step 3 已定）：端口不存在 = 读方必须降级为全量 `messages()`，**不得**当成
 * 空会话。本模块把「端口缺席」返回成 `null`，与「读到空数组」严格区分。
 */
export interface SessionMessageIndexCache {
  /**
   * 读一个会话的全序消息索引；同一会话在失效前只真正读一次。
   * 返回 `null` = 宿主没实现 `listSessionMessageIndex`（调用方降级，不得当空会话）。
   */
  read(
    store: SessionStorePort | undefined,
    sessionID: SessionId,
  ): Promise<readonly SessionMessageIndexEntry[] | null>;
  /** 失效一个会话（live ingest / rewind）。幂等。 */
  invalidate(sessionID: SessionId): void;
  /** 全部失效（会话关闭 / dispose）。 */
  clear(): void;
  /** 测试探针：当前缓存条数。 */
  size(): number;
}

interface CachedIndexEntry {
  value: Promise<readonly SessionMessageIndexEntry[] | null>;
}

/**
 * 建缓存。`maxSessions` 是**内存上界**而不是性能参数：一份 5k 消息的索引约 5k 条记录，
 * 会话多了会一直涨；按最近使用淘汰（Map 的插入序）足够，因为缓存的价值在「一次冷开的
 * 多页读」，不在跨会话复用。
 */
export function createSessionMessageIndexCache(
  input: { maxSessions?: number } = {},
): SessionMessageIndexCache {
  const maxSessions = Math.max(1, input.maxSessions ?? 16);
  const entries = new Map<SessionId, CachedIndexEntry>();

  return {
    read(store, sessionID) {
      const listSessionMessageIndex = store?.listSessionMessageIndex;
      if (!store || typeof listSessionMessageIndex !== "function") return Promise.resolve(null);
      const cached = entries.get(sessionID);
      if (cached) {
        // 命中即刷新「最近使用」位置；Map 的迭代序就是淘汰序。
        entries.delete(sessionID);
        entries.set(sessionID, cached);
        return cached.value;
      }
      const value = Promise.resolve(
        listSessionMessageIndex.call(store, { sessionID }) as
          | readonly SessionMessageIndexEntry[]
          | Promise<readonly SessionMessageIndexEntry[]>,
      ).catch((error: unknown) => {
        // 失败不得留毒：下一次读必须能重新打 store，否则一次瞬时 sqlite 错误会把该会话
        // 的索引永久钉在 rejected promise 上。
        if (entries.get(sessionID)?.value === value) entries.delete(sessionID);
        throw error;
      });
      entries.set(sessionID, { value });
      while (entries.size > maxSessions) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      return value;
    },
    invalidate(sessionID) {
      entries.delete(sessionID);
    },
    clear() {
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}
