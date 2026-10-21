import { ChevronRightIcon, CircleAlertIcon } from "lucide-react";
import { Fragment, useMemo } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { useTrajectoryExpansion } from "@/ModelTrajectoryExpansion.js";
import { CallCard, type IntlShape } from "@/ModelTrajectoryPaneParts.js";
import {
  formatTurnCounts,
  resolveTrajectoryTurnCounts,
  type TrajectoryTurnCountSegment,
} from "@/ModelTrajectoryTurnCounts.js";
import { trajectoryCallKey, type TrajectoryTurnGroup } from "@/ModelTrajectoryTurns.js";

/** 失败计数段（整段红色 + 同源告警图标）的 i18n id。 */
const FAILURE_COUNT_SEGMENT_ID = "modelTrajectory.turn.failureCount";

/**
 * 回合外壳（spec B-4）：顶层 IA 的一个单元，默认收起。
 *
 * 头部两行（spec N-7 后半）：
 * - 行 1 = 回合序号 + 用户输入预览 + assistant 预览；
 * - 行 2 = 计数行（`data-trajectory-turn-meta`）：调用次数 / 工具调用数 / 输出字数 /
 *   失败数（红色）/ 时长 / 来源，段序列由 `formatTurnCounts` 产出，分隔符在本层插入。
 *
 * 展开 = 该回合的 CallCard 列表（既有 CallCard 渲染逻辑原样保留在回合内部）。
 * 聊天页 ConversationTurnGroup 与本组件共享的只是「折叠外壳 + 预览摘要」范式，
 * 其渲染上下文与对话投影深耦合，不复用代码。
 */
export function ModelTrajectoryTurnGroup({
  group,
  intl,
}: {
  group: TrajectoryTurnGroup;
  intl: IntlShape;
}) {
  // 回合级 key（`turn:<turnId>` / `turn:fallback:<requestId>`）与消息行 key 命名空间分离；
  // 默认收起，面板「全部展开」与搜索命中共用同一 hook 的展开判定。
  const { open, handleOpenChange } = useTrajectoryExpansion({
    key: group.key,
    commandKind: "turn",
    defaultOpen: false,
  });

  // 回合计数（spec N-7）：口径集中在 ModelTrajectoryTurnCounts，group 引用变化时重算。
  const counts = useMemo(() => resolveTrajectoryTurnCounts(group), [group]);
  // 计数行段序列：summaryCalls / toolCalls / charCount / failureCount / 时长 / 每来源一段，
  // 省略规则与顺序由纯函数决定，本层只负责渲染与插入分隔符。
  const metaSegments = useMemo(() => formatTurnCounts(group.stats, counts), [group.stats, counts]);

  // 回合根挂**命名组** `group/turn`：TurnGroup 自身的 open 态变体只认它。
  // 裸 `group` 会污染回合内消息行——Tailwind 的 group-data 变体匹配任意祖先的
  // .group[data-state=open]，回合展开后消息行（自身 closed）的摘要/箭头也会被翻转（B-1）。
  return (
    <Collapsible
      open={open}
      onOpenChange={handleOpenChange}
      data-trajectory-turn=""
      data-trajectory-turn-key={group.key}
      data-trajectory-turn-id={group.turnId ?? undefined}
      data-trajectory-turn-index={group.turnIndex}
      className="group/turn col-span-full grid w-full min-w-0 grid-cols-subgrid"
    >
      <div className="col-span-full grid min-h-8 w-full min-w-0 grid-cols-subgrid items-center">
        <CollapsibleTrigger
          data-trajectory-turn-trigger=""
          className="col-span-2 flex min-w-0 flex-col items-stretch gap-0.5 py-1 pl-3 pr-2 text-left text-ui-sm text-foreground-subtle"
        >
          <span className="flex min-h-6 w-full min-w-0 items-center gap-2">
            <span
              data-trajectory-turn-number=""
              className="shrink-0 font-mono text-ui-xs text-foreground-subtlest"
            >
              {String(group.turnIndex + 1).padStart(2, "0")}
            </span>
            <span
              data-trajectory-turn-label=""
              className="shrink-0 font-mono text-ui-xs uppercase text-foreground-subtle"
            >
              {intl.formatMessage({ id: "modelTrajectory.turn" })}
            </span>
            <span
              data-trajectory-turn-user-preview=""
              className="min-w-0 flex-1 truncate font-mono text-foreground"
              title={group.userPreview}
            >
              {group.userPreview}
            </span>
            {group.assistantPreview && group.userPreviewKind === "user" ? (
              <span
                data-trajectory-turn-assistant-preview=""
                className="hidden min-w-0 max-w-[40%] shrink truncate font-mono text-ui-xs text-foreground-subtlest group-data-[state=open]/turn:hidden lg:inline"
                title={group.assistantPreview}
              >
                → {group.assistantPreview}
              </span>
            ) : null}
          </span>
          {/* 行 2 = 计数行：失败段整段红色，图标与失败数字同源（counts.failureCount）。 */}
          <span
            data-trajectory-turn-meta=""
            className="block w-full min-w-0 truncate font-mono text-ui-xs text-foreground-subtlest"
          >
            {metaSegments.map((segment, index) => (
              <Fragment key={segmentKey(segment, index)}>
                {index > 0 ? <span aria-hidden="true"> · </span> : null}
                <TurnMetaSegment segment={segment} intl={intl} />
              </Fragment>
            ))}
          </span>
        </CollapsibleTrigger>
        <span className="relative -ml-1 mr-1 flex items-center justify-end">
          <CollapsibleTrigger asChild>
            <Button
              data-trajectory-turn-chevron=""
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-5 rounded-sm text-foreground-subtlest"
              aria-label={intl.formatMessage({
                id: open ? "modelTrajectory.collapse" : "modelTrajectory.expand",
              })}
            >
              <ChevronRightIcon
                aria-hidden="true"
                className="size-3 transition-transform group-data-[state=open]/turn:rotate-90"
              />
            </Button>
          </CollapsibleTrigger>
        </span>
      </div>
      <CollapsibleContent data-trajectory-turn-content="" className="col-span-full">
        {/*
         * 共享 Collapsible 的动画包裹层是块级 div，会断开外层 subgrid 链；
         * 这里按时间线的三列模板重建一个网格容器，让回合内 CallCard 的
         * `grid-cols-subgrid` 仍能对齐（角色标签列 / 内容列 / 操作列）。
         */}
        <div className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)_auto] gap-x-2">
          {group.calls.map((call) => {
            // B-5：croppedCount 是「该次调用」的上下文缺口（messageCount − 展开后可见条数），
            // 行内 delta 切片（本回合相对上一回合新增的消息）不参与计数。
            const croppedCount = call.record.request.croppedCount;
            return (
              <Fragment key={trajectoryCallKey(call.record.requestId, call.recordIndex)}>
                {croppedCount > 0 ? (
                  <p
                    data-trajectory-cropped-hint=""
                    data-trajectory-cropped-count={croppedCount}
                    className="col-span-full px-3 py-1 text-ui-xs text-foreground-subtlest"
                  >
                    {intl.formatMessage(
                      { id: "modelTrajectory.turn.croppedHint" },
                      { count: String(croppedCount) },
                    )}
                  </p>
                ) : null}
                <CallCard
                  record={call.record}
                  index={call.recordIndex}
                  inputMessages={call.inputMessages}
                  expansionKeyPrefix={trajectoryCallKey(call.record.requestId, call.recordIndex)}
                  toolCalls={call.toolCalls}
                  pairedResultToolCallIdsInInput={call.pairedResultToolCallIdsInInput}
                  intl={intl}
                />
              </Fragment>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 计数行单段渲染：i18n 段走 formatMessage；失败段整段红色并带同源告警图标。 */
function TurnMetaSegment({
  segment,
  intl,
}: {
  segment: TrajectoryTurnCountSegment;
  intl: IntlShape;
}) {
  if (typeof segment === "string") {
    return <span>{segment}</span>;
  }
  if (segment.id === FAILURE_COUNT_SEGMENT_ID) {
    return (
      <span className="text-destructive">
        <CircleAlertIcon
          data-trajectory-turn-error-icon=""
          aria-hidden="true"
          className="mr-0.5 inline size-3 align-middle text-destructive"
        />
        {intl.formatMessage({ id: segment.id }, segment.values)}
      </span>
    );
  }
  return <span>{intl.formatMessage({ id: segment.id }, segment.values)}</span>;
}

/** 段渲染 key：i18n 段用 id，原样字符串段用文本（同一段序列内 id 唯一）。 */
function segmentKey(segment: TrajectoryTurnCountSegment, index: number): string {
  return typeof segment === "string" ? `text-${index}-${segment}` : `i18n-${index}-${segment.id}`;
}
