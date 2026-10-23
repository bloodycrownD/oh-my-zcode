import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { CircleAlertIcon } from "lucide-react";
import {
  TID_MODEL_PROVIDER_NAME_DIALOG,
  TID_MODEL_PROVIDER_NAME_DIALOG_CONFIRM,
  TID_MODEL_PROVIDER_NAME_DIALOG_INPUT,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import {
  PROVIDER_NAME_EXISTS_MESSAGE,
  resolveCreateProviderName,
  type ProviderTemplatePick,
} from "./createProviderNameDialog.js";

/**
 * 新建供应商名称弹窗：Template 选择页（或「自定义」）之后、真正创建之前的一次确认。
 *
 * 名称校验落在本组件（`resolveCreateProviderName`）：空/纯空白不进提交，重名直接提示
 * 与重命名相同的「Provider 名称已存在」；通过后由 Section 调既有
 * `createPersonalProvider` 链路。服务层失败（schema 等）由 Section 回填
 * `errorMessage`，这里复用 templateCreateFailed 文案与重试动作。
 */
export function ProviderCreateNameDialog({
  open,
  pick,
  prefillName,
  existingNames,
  creating,
  errorMessage,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  pick: ProviderTemplatePick | null;
  /** 打开时的名称预填（模板名或「新供应商」），由 Section 用纯逻辑算好后传入。 */
  prefillName: string;
  existingNames: readonly string[];
  creating: boolean;
  /** 服务层失败的统一提示（templateCreateFailed）；前端校验失败不走这里。 */
  errorMessage: string | null;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const [nameValue, setNameValue] = useState("");
  const compositionActiveRef = useRef(false);
  const inputId = useId();

  // 每次打开都回到预填值：关闭后不保留上一轮输入，换模板重开也不会串名。
  useEffect(() => {
    if (!open) return;
    setNameValue(prefillName);
    compositionActiveRef.current = false;
  }, [open, prefillName]);

  const resolution = resolveCreateProviderName({ rawName: nameValue, existingNames });
  const duplicateMessage = resolution.status === "duplicate" ? PROVIDER_NAME_EXISTS_MESSAGE : null;
  const blockingMessage = duplicateMessage ?? errorMessage;
  const canSubmit = !creating && resolution.status === "ok";

  const submit = () => {
    const next = resolveCreateProviderName({ rawName: nameValue, existingNames });
    // 必填与重名都在前端拦截：不进创建链路，也就不会让服务层再改序号或抛错。
    if (next.status !== "ok" || creating) return;
    onSubmit(next.name);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    // 中文输入法用 Enter 确认候选时不能当作提交，否则会带着拼音建供应商。
    if (
      isImeComposingKeyEvent({
        compositionActive: compositionActiveRef.current,
        nativeEvent: event.nativeEvent,
      })
    ) {
      return;
    }
    event.preventDefault();
    submit();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 创建在途时忽略关闭，避免请求成功后弹窗又「复活」或重复提交。
        if (!next && !creating) onCancel();
      }}
    >
      <DialogContent data-testid={TID_MODEL_PROVIDER_NAME_DIALOG} className="max-w-md">
        <DialogHeader className="pr-8">
          <DialogTitle>
            {intl.formatMessage({ id: "settings.modelProvider.addProviderTitle" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.modelProvider.addProviderDescription" })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {/* 选中的来源：模板路径显示「供应商目录 + 模板名」，自定义路径显示「自定义端点」。 */}
          <div
            className="flex min-w-0 items-center gap-2 text-ui-base text-foreground-subtle"
            data-provider-create-source={pick?.templateId ? "template" : "custom"}
          >
            <span className="shrink-0 rounded-md bg-hover px-1.5 py-0.5 text-ui-sm">
              {intl.formatMessage({
                id: pick?.templateId
                  ? "settings.modelProvider.addFromCatalog"
                  : "settings.modelProvider.addPureCustom",
              })}
            </span>
            {pick?.templateId ? (
              <span className="min-w-0 truncate text-foreground">{pick.suggestedName}</span>
            ) : null}
          </div>
          <div>
            <label htmlFor={inputId} className="mb-1 block text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.name" })}
            </label>
            <Input
              {...TECHNICAL_INPUT_ATTRIBUTES}
              id={inputId}
              autoFocus
              data-testid={TID_MODEL_PROVIDER_NAME_DIALOG_INPUT}
              type="text"
              size="lg"
              value={nameValue}
              placeholder={intl.formatMessage({
                id: "settings.modelProvider.namePlaceholder",
              })}
              aria-invalid={Boolean(blockingMessage)}
              onChange={(event) => setNameValue(event.target.value)}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => {
                compositionActiveRef.current = true;
              }}
              onCompositionEnd={() => {
                compositionActiveRef.current = false;
              }}
            />
            {blockingMessage ? (
              <div
                role="alert"
                className="mt-2 flex items-center gap-2 text-ui-sm text-destructive"
                data-provider-create-error={errorMessage ? "create" : "duplicate"}
              >
                <CircleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">{blockingMessage}</span>
                {errorMessage ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!canSubmit}
                    onClick={submit}
                  >
                    {intl.formatMessage({ id: "settings.modelProvider.templateCreateRetry" })}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={creating} onClick={onCancel}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            type="button"
            data-testid={TID_MODEL_PROVIDER_NAME_DIALOG_CONFIRM}
            disabled={!canSubmit}
            onClick={submit}
          >
            {intl.formatMessage({ id: "settings.modelProvider.addProviderAction" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
