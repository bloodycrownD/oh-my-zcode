// 轨迹面板的「消息全屏只读视图」（spec trace-nm-borrow Step 5 / N-6，③ 全屏只读 Modal）。
//
// 底座用 components/ui/dialog.tsx 的 Radix Dialog：Portal 默认挂到 body，
// 因此不嵌在行内的 Collapsible 里，Esc / 遮罩关闭 / 焦点圈定全部开箱即用，
// 也天然不与聊天页的「Esc 停止生成」监听冲突（不新增任何 window 级 Esc 监听）。
import { CopyIcon } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  restoreTrajectoryFocusReturn,
  type TrajectoryMessageViewRequest,
} from "@/ModelTrajectoryMessageView.js";

/**
 * 全屏只读视图：等宽 pre-wrap 全文 + 复制按钮。
 *
 * - 标题走 sr-only（先例 image-preview-dialog.tsx:402），保证读屏可达又不抢视觉；
 * - aria-describedby={undefined}：Radix 默认要求 Description，本视图没有描述文案（先例同上 :396）；
 * - Esc / 遮罩关闭由 Radix 自带，这里只把 open 变更回传给状态所有者。
 */
export function ModelTrajectoryMessageDialog({
  open,
  request,
  onClose,
}: {
  open: boolean;
  /** 当前查看的内容；null 表示尚未打开任何内容。 */
  request: TrajectoryMessageViewRequest | null;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const copyLabel = intl.formatMessage({ id: "modelTrajectory.copyContent" });
  const fallbackTitle = intl.formatMessage({ id: "modelTrajectory.fullContentTitle" });
  const title = request?.title.trim() || fallbackTitle;
  const text = request?.text ?? "";

  // 焦点归位：全屏视图是程序化打开的（无 Radix trigger），
  // Esc / 遮罩关闭时把焦点还给打开前的元素（Radix onCloseAutoFocus 的补偿）。
  useEffect(() => {
    if (!open) restoreTrajectoryFocusReturn();
  }, [open]);

  const handleCopy = () => {
    if (!text || typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(text).catch((error: unknown) => {
      logger.warn("[ModelTrajectory] 复制全屏内容失败", error);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        // 窄视口不贴边：w 覆盖底座的 w-full，max-w 覆盖底座的 max-w-[calc(100%-2rem)]。
        className="w-[calc(100%-2rem)] max-w-3xl"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <div className="flex min-w-0 items-center justify-between gap-2 pr-8">
          <span
            data-trajectory-message-view-title=""
            // 可见标题与 sr-only 标题同文：读屏只念一次（aria-hidden 交给 sr-only 标题）。
            aria-hidden="true"
            className="min-w-0 truncate text-ui-sm font-medium text-foreground"
          >
            {title}
          </span>
          <Button
            data-trajectory-message-view-copy=""
            type="button"
            variant="outline"
            size="xs"
            className="h-6 shrink-0 gap-1 px-2 text-ui-xs"
            aria-label={copyLabel}
            title={copyLabel}
            disabled={!text}
            onClick={handleCopy}
          >
            <CopyIcon className="size-3" />
            {copyLabel}
          </Button>
        </div>
        <pre
          data-trajectory-message-view-content=""
          className="max-h-[70vh] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface/50 p-3 font-mono text-ui-sm leading-relaxed text-foreground"
        >
          {text}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
