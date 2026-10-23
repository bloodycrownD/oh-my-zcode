import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { memo, useMemo, type CSSProperties } from "react";
import {
  TID_V4_QUEUE_ITEM,
  TID_V4_QUEUE_ITEM_DELETE,
  TID_V4_QUEUE_ITEM_EDIT,
  TID_V4_QUEUE_ITEM_GUIDE,
  TID_V4_QUEUE_ITEM_SEND_NOW,
  testId,
} from "@zcode/shared";
import type { QueueState } from "@zcode/shared/zcode-protocol-v4";
import { ArrowUpFromLine, GripVertical, PencilIcon, Trash2Icon, Waypoints } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ConversationUserInputContent } from "@/v4/ConversationUserInputContent.js";

export type QueueItem = QueueState["items"][number];

interface QueueRowProps {
  item: QueueItem;
  index: number;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  sortable: boolean;
  onDeleteItem?: (queueItemId: string) => void;
  onEditItem?: (queueItemId: string) => Promise<void> | void;
  editPending: boolean;
  onSendNow?: (queueItemId: string) => void;
  /** 用户拍板 toggle：queue→guide（引导至下一轮工具调用后运行，不抢占当前轮）。 */
  onGuideItem?: (queueItemId: string) => void;
  /** 该行 setQueueItemDelivery ACK 在途；按钮自禁并压暗整行。 */
  guidePending: boolean;
  /**
   * 面板解析好的可见正文（`resolveQueuePreview` 已剥离四类上下文尾块）。
   * composer/A-1：不能直接把 `item.text` 给渲染器，否则预览里会露出
   * `# Code comments:` 等内部块。缺省时回落到原文，兼容未接线的宿主。
   */
  previewText?: string;
  /** 同一次解析出的上下文条数：纯上下文队列项预览正文为空，用条数维持可读。 */
  contextCount?: number;
}

/**
 * 竖切 queue 面板的单行：dnd-kit 拖拽重排 + 「立即」/「引导」/ 编辑 / 删除。
 * dispatch.state !== "queued"（reserved/promoting）或行级 ACK 在途时统一禁用。
 */
const QueueRow = memo(function QueueRow({
  item,
  index,
  intl,
  sortable,
  onDeleteItem,
  onEditItem,
  onSendNow,
  onGuideItem,
  editPending,
  guidePending,
  previewText,
  contextCount = 0,
}: QueueRowProps) {
  const dispatchLocked = item.dispatch.state !== "queued";
  const rowLocked = dispatchLocked || editPending || guidePending;
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    disabled: !sortable || rowLocked,
    id: item.queueItemId,
  });

  const style = useMemo<CSSProperties>(
    () => ({
      transform: CSS.Transform.toString(
        transform
          ? {
              ...transform,
              // dnd-kit 排序时会按 over 节点尺寸附带 scale；
              // 队列行是固定触控目标，缩放会让拖拽中的按钮和文本短暂变形。
              scaleX: 1,
              scaleY: 1,
            }
          : null,
      ),
      transition,
      zIndex: isDragging ? 10 : undefined,
    }),
    [isDragging, transition, transform],
  );
  return (
    <li
      ref={setNodeRef}
      data-testid={testId(TID_V4_QUEUE_ITEM, item.queueItemId)}
      data-queue-item-id={item.queueItemId}
      data-index={index}
      data-kind={item.kind}
      data-dispatch-state={item.dispatch.state}
      data-edit-pending={editPending ? "true" : "false"}
      data-guide-pending={guidePending ? "true" : "false"}
      className={cn(
        "relative flex items-center gap-2 rounded-xl px-1.5 py-1 pr-1 transition-colors hover:bg-hover/30",
        isDragging ? "bg-hover/40 shadow-sm" : null,
        editPending || guidePending ? "opacity-60" : null,
      )}
      style={style}
    >
      <ControlHintTooltip title={intl.formatMessage({ id: "chat.queue.drag" })}>
        <Button
          ref={setActivatorNodeRef}
          type="button"
          variant="ghost"
          size="icon-md"
          data-v4-queue-drag-handle="true"
          data-queue-item-id={item.queueItemId}
          aria-label={intl.formatMessage({ id: "chat.queue.drag" })}
          className="shrink-0 cursor-grab touch-none text-foreground-subtlest active:cursor-grabbing"
          disabled={rowLocked}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </Button>
      </ControlHintTooltip>
      <span
        className="flex min-w-0 flex-1 items-center gap-2 truncate text-ui-base text-foreground"
        title={previewText ?? item.text}
      >
        {/*
          队列预览与用户消息气泡共用同一渲染器：队列项落库后就是一条 user row，
          两处解析口径必须一致，否则撤回后重发的胶囊和预览对不上。
          composer/A-1：渲染的是面板解析好的可见正文（previewText），不是含四类上下文
          尾块的 `item.text`；纯上下文项正文为空时用 +N 维持可读。
        */}
        <span
          className="truncate"
          data-v4-queue-item-preview="true"
          data-v4-queue-item-context-count={contextCount}
        >
          <ConversationUserInputContent text={previewText ?? item.text} />
          {!previewText && contextCount > 0 ? (
            <span className="text-foreground-subtlest" aria-hidden="true">
              {`+${contextCount}`}
            </span>
          ) : null}
        </span>
      </span>
      {onSendNow ? (
        <Button
          type="button"
          variant="secondary"
          size="default"
          data-icon="inline-start"
          data-testid={testId(TID_V4_QUEUE_ITEM_SEND_NOW, item.queueItemId)}
          data-queue-item-id={item.queueItemId}
          disabled={rowLocked}
          onClick={() => onSendNow(item.queueItemId)}
        >
          <ArrowUpFromLine className="size-3.5" />
          {intl.formatMessage({ id: "chat.queue.sendNow" })}
        </Button>
      ) : null}
      {onGuideItem ? (
        <ControlHintTooltip title={intl.formatMessage({ id: "chat.queue.guide.description" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            data-testid={testId(TID_V4_QUEUE_ITEM_GUIDE, item.queueItemId)}
            data-queue-item-id={item.queueItemId}
            aria-label={intl.formatMessage({ id: "chat.queue.guide" })}
            className="shrink-0 text-foreground-subtlest hover:text-foreground"
            disabled={rowLocked}
            onClick={() => onGuideItem(item.queueItemId)}
          >
            <Waypoints className="size-4" />
          </Button>
        </ControlHintTooltip>
      ) : null}
      {onEditItem ? (
        <ControlHintTooltip title={intl.formatMessage({ id: "chat.queue.edit" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            data-testid={testId(TID_V4_QUEUE_ITEM_EDIT, item.queueItemId)}
            data-queue-item-id={item.queueItemId}
            aria-label={intl.formatMessage({ id: "chat.queue.edit" })}
            disabled={rowLocked}
            onClick={() => void onEditItem(item.queueItemId)}
          >
            <PencilIcon className="size-4" />
          </Button>
        </ControlHintTooltip>
      ) : null}
      {onDeleteItem ? (
        <ControlHintTooltip title={intl.formatMessage({ id: "chat.queue.remove" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            data-testid={testId(TID_V4_QUEUE_ITEM_DELETE, item.queueItemId)}
            data-queue-item-id={item.queueItemId}
            aria-label={intl.formatMessage({ id: "chat.queue.remove" })}
            disabled={rowLocked}
            onClick={() => onDeleteItem(item.queueItemId)}
          >
            <Trash2Icon className="size-4" />
          </Button>
        </ControlHintTooltip>
      ) : null}
    </li>
  );
});

export { QueueRow };
