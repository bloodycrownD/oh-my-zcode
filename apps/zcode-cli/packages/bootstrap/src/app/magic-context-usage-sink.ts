import { SessionEventType, type ModelUsage, type SessionEventSink } from "@zcode/contracts";

/**
 * FORK（S24）：把 magic-context 的 usage recorder 挂进事件扇出。
 *
 * `model_complete` 是主会话每一次 provider 请求的 usage 落点。**只认
 * `querySource === "main_turn"`**：标题生成、压缩摘要、子代理与工具内部的模型调用
 * 也发这个事件，而它们不是用户可见的上下文——混进来会把上下文占比算成「一个几百
 * token 的侧车请求」，transform 于是永远看不到压力。这条判据与
 * `event-reducer.ts` 的 `shouldModelCompleteUpdateContextUsed` 是同一条，不在这里
 * 另立一套。
 *
 * recorder 缺席（flag off，用户显式关掉）时**原样返回下游 sink**，不产生任何包装；
 * recorder 在场而下游没有 sink 时**仍然造一个**——headless CLI 根本没有下游 sink，
 * 而 usage 是 transform 的压力输入，不是可选的诊断。
 *
 * 抽成独立文件的理由与 `magic-context-absent-event.ts` 相同：它是纯事件整形，
 * 与装配流程的其余部分无关，留在 `create-app.ts`（上游文件）里纯属冲突面。
 */
export function composeMagicContextUsageSink(
  sink: SessionEventSink | undefined,
  recorder: { record: (input: { at?: number; usage: ModelUsage }) => void } | undefined,
): SessionEventSink | undefined {
  if (!recorder) return sink;
  return {
    async onSessionEvent(event) {
      try {
        if (
          event.type === SessionEventType.ModelComplete &&
          (event.payload as { querySource?: string } | undefined)?.querySource === "main_turn"
        ) {
          recorder.record({
            at: new Date(event.timestamp).getTime(),
            usage: (event.payload as { usage?: ModelUsage }).usage as ModelUsage,
          });
        }
      } catch {
        // 诊断面绝不能把一次已处理的事件变成一次失败投递。
      }
      return sink?.onSessionEvent(event);
    },
  };
}
