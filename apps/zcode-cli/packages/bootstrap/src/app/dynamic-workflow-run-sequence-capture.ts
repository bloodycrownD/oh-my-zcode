// 引擎事件的 journal sequence 截取层。独立成模块而不是留在 launch.ts 里：那边的职责是「装配并启动一个 run」，而这里是
// 「把 appendEvent 分配到的号截给紧随其后的 emit」——两件事各自完整，且这一件只有一个消费者。
import type { JournalStorePort, RunEvent, StoredEvent } from "@zcode/dynamic-workflow";

/**
 * 包一层 journal，只为把 `appendEvent` 分配到的 sequence 截下来供紧随其后的 emit 使用。
 *
 * 前提（由引擎的 `record()` 保证，且被测试钉住）：每条事件都是「appendEvent 后同步紧接着
 * emit」，一一对应。所以"最后一次 append 的 sequence"就是"当前正在 emit 的那条"的 sequence。
 * 为稳妥起见按事件对象**引用相等**核对：不相等说明前提破了，此时退回最后一次 sequence 而不是
 * 猜一个——沉默的错号比停在原地更难查，而测试会先于生产发现它。
 */
export function createJournalSequenceCapture(journal: JournalStorePort): {
  journal: JournalStorePort;
  sequenceOf: (event: RunEvent) => number;
  /** 同一条事件落库时盖的戳（`StoredEvent.timeCreated`）；引用不相等时不猜，回 `undefined`。 */
  timeCreatedOf: (event: RunEvent) => number | undefined;
} {
  let lastStored: StoredEvent | undefined;
  // 端口上仍有两个**可选**成员（FORK 偏离上游的必填形状；`listEventPage` 见 types.ts 的偏离
  // 声明）。转发必须保留「缺席即没有这个能力」的语义：无条件挂一个
  // `(runId) => journal.countTaggedReports(runId)`，能力探测会以为包装层支持它，真调用时却
  // TypeError。`.bind(journal)` 同时把实现的 this 保住。
  //
  // `countNodes` 不在此列：上游 v3.16.2 把它做成引擎端口的**必填**成员（resume 恢复报告的 run
  // 级条数与字节计数直接调用），端口上已不存在「缺席」状态，所以按端口显式转发。
  const countTaggedReports = journal.countTaggedReports?.bind(journal);
  const listEventPage = journal.listEventPage?.bind(journal);
  // 逐方法显式转发而不是 `{...journal, appendEvent}`：两个实现都是 class，展开只拷贝自有属性，
  // 原型上的方法会全部丢掉（引擎随后调 getRun 就会 TypeError）。转发面**只有引擎端口**：
  // 孤儿收敛与枚举的窄查询刻意不在其中——它们发生在 service 侧、直接对 deps.journal，不经这一层。
  const wrapped: JournalStorePort = {
    createRun: (record) => journal.createRun(record),
    getRun: (runId) => journal.getRun(runId),
    updateRunStatus: (runId, status, settlement) =>
      journal.updateRunStatus(runId, status, settlement),
    updateRunUsage: (runId, spentTokens) => journal.updateRunUsage(runId, spentTokens),
    updateRunCaps: (runId, caps) => journal.updateRunCaps(runId, caps),
    // 补全把有效脚本写回 run 行（docs/execution-engine.md「Holes」）；与其余写入同样原样转发。
    updateRunScript: (runId, scriptText, scriptHash) =>
      journal.updateRunScript(runId, scriptText, scriptHash),
    putActor: (record) => journal.putActor(record),
    getActor: (runId, siteId, ordinal) => journal.getActor(runId, siteId, ordinal),
    // 读面选项必须原样转发（docs/execution-engine.md「Reading the journal」）：TS 允许实现的形参
    // 比签名少，`(runId) => journal.listNodes(runId, <固定选项>)` 这种写法照样编译通过，却把调用方
    // 的过滤悄悄换掉，引擎的窄读就退化回整表读。
    listActors: (runId, opts) => journal.listActors(runId, opts),
    putNode: (record) => journal.putNode(record),
    // 上游 v3.16.2：`getNode` 多了 `opts`（`withResult: false` 的窄读，引擎 report 路径依赖它），
    // 必须原样转发——丢掉它会让调用方以为没读结果、实际把整条结果解码进内存。
    getNode: (runId, siteId, ordinal, opts) => journal.getNode(runId, siteId, ordinal, opts),
    // 读面选项必须原样转发（docs/execution-engine.md「Reading the journal」）：TS 允许实现的形参
    // 比签名少，`(runId) => journal.listNodes(runId, <固定选项>)` 这种写法照样编译通过，却把调用方
    // 的过滤悄悄换掉，引擎的窄读就退化回整表读。
    listNodes: (runId, opts) => journal.listNodes(runId, opts),
    // 上游 v3.16.2 新增的窄读：resume 恢复报告 run 级字节计数时只问字节数，不读结果行。
    sumResultBytes: (runId, kind) => journal.sumResultBytes(runId, kind),
    // 必填成员：连同 kind 原样转发，缺失/降级语义不归包装层解释。
    countNodes: (runId, kind) => journal.countNodes(runId, kind),
    ...(countTaggedReports === undefined ? {} : { countTaggedReports }),
    appendEvent: (runId, event) => {
      const stored = journal.appendEvent(runId, event);
      lastStored = stored;
      return stored;
    },
    listEvents: (runId, opts) => journal.listEvents(runId, opts),
    // 事件页的字节读面：包装层不吞能力——run-service 探测的是 deps.journal（不经本层），
    // 但引擎端口一旦被别处探测/复用，转发缺席就会静默降级成 count-only 分页。
    ...(listEventPage === undefined ? {} : { listEventPage }),
  };
  return {
    journal: wrapped,
    sequenceOf: (event) =>
      lastStored?.event === event ? lastStored.sequence : (lastStored?.sequence ?? 0),
    // 与 sequenceOf 同一条回落：内存 journal 在存储边界上深拷贝事件（引用不等），而「刚 append 的
    // 就是正在 emit 的」是引擎 record() 的契约，所以这里按最后一次 append 的戳给。
    timeCreatedOf: () => lastStored?.timeCreated,
  };
}
