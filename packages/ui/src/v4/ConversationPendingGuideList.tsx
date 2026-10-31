import { memo, useMemo } from "react";
import type { QueueItem, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
// 合并后的 @zcode/shared 顶层未再 re-export test-ids.ts，测试 id 统一走子路径。
import { TID_V4_QUEUE_ITEM_UNQUEUE_GUIDE, testId } from "@zcode/shared/test-ids";
import { Waypoints } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { ConversationTurnRow } from "@/v4/ConversationTurnRow.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

interface ConversationPendingGuideListProps {
  context: ConversationRowRenderContext;
  items: readonly QueueItem[];
  turnId: string;
  /**
   * 用户拍板 toggle：guide→queue（setQueueItemDelivery，恢复排队）。
   * 项回到队列面板原数组位（core 不改 pendingInputs 顺序，guide 行从面板滤出、
   * 恢复后按原 FIFO 位回现）。
   */
  onRestoreItem?: (queueItemId: string) => void;
  /** setQueueItemDelivery ACK 在途的目标项；仅锁该行。 */
  pendingRestoreQueueItemId?: string | null;
}

function pendingGuideRow(item: QueueItem, turnId: string): UserInputRow {
  return {
    rowId: -(item.order.admissionSeq + 1),
    turnId,
    productTurnId: turnId,
    entityId: item.queueItemId,
    kind: "userInput",
    text: item.text,
    origin: "realUser",
    sourceCommandId: item.sourceCommandId,
    clientId: item.clientId,
    attachments: item.attachments,
    createdAt: item.admittedAt,
    createdAtSeq: item.order.admissionSeq,
  };
}

function ConversationPendingGuideListImpl({
  context,
  items,
  turnId,
  onRestoreItem,
  pendingRestoreQueueItemId = null,
}: ConversationPendingGuideListProps) {
  const { intl } = useZCodeIntl();
  // 同时带 QueueItem 本体：entityId/queueItemId 是 toggle 的目标键，
  // 不能从 row 反查（UserInputRow.entityId 类型可选）。
  const entries = useMemo(
    () => items.map((item) => ({ item, row: pendingGuideRow(item, turnId) })),
    [items, turnId],
  );
  const status = intl.formatMessage({ id: "chat.message.turnSteer.pending" });

  if (entries.length === 0) return null;
  return (
    <div data-v4-pending-guide-list="true" className="flex flex-col gap-5 pt-5">
      {entries.map(({ item, row }) => (
        <div
          key={item.queueItemId}
          data-v4-pending-guide-item="true"
          data-queue-item-id={item.queueItemId}
          data-guide-restore-pending={
            pendingRestoreQueueItemId === item.queueItemId ? "true" : "false"
          }
        >
          <ConversationTurnRow row={row} context={context} userInputStatus={status} />
          {onRestoreItem ? (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid={testId(TID_V4_QUEUE_ITEM_UNQUEUE_GUIDE, item.queueItemId)}
                data-queue-item-id={item.queueItemId}
                aria-label={intl.formatMessage({
                  id: "chat.queue.guideRestore",
                })}
                className="shrink-0 text-foreground-subtle hover:text-foreground"
                disabled={pendingRestoreQueueItemId !== null}
                onClick={() => onRestoreItem(item.queueItemId)}
              >
                <Waypoints className="size-3.5" />
                {intl.formatMessage({ id: "chat.queue.guideRestore" })}
              </Button>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export const ConversationPendingGuideList = memo(ConversationPendingGuideListImpl);
