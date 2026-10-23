import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import { cn } from "../lib/utils.js";

function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />;
}

function CollapsibleContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      className={cn(
        "overflow-hidden",
        "data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up data-[state=closed]:[animation-fill-mode:forwards] transition-none duration-300 ease-in-out",
        "data-[state=open]:[&>div]:animate-in data-[state=open]:[&>div]:fade-in-0",
        "data-[state=closed]:[&>div]:animate-out data-[state=closed]:[&>div]:fade-out-0 data-[state=closed]:[&>div]:[animation-fill-mode:forwards]",
        className,
      )}
      {...props}
    >
      <div className="transition-none duration-300 ease-in-out">
        {/* 大会话 resize trace 显示 collapsible 动画层只设置 duration/ease 时，
            浏览器会用默认 transition-property: all 动画 scrollbar-color，拖拽窗口时触发非合成动画。
            这里显式禁用 CSS transition，只保留 animate-in/out 的关键帧动画。 */}
        {/* tw-animate-css 并没有 animate-fade-in / animate-fade-out 这类工具类，
            必须用 animate-in/out 搭配 fade-in-0 / fade-out-0。
            子层 div 本身没有 data-state，所以用父层 content 的 data-[state] 经 [&>div] 直接选中子层。 */}
        {/* fork 原先给这个 content 起了 group/collapsible-content 组名，让子层读父层 state；
            但嵌套 content 的同名 group 会匹配到祖先的 open，覆盖当前 closed 的淡出。
            去掉组名后动画只由当前 content 的 data-state 作用于直接子层，高度/透明度分层仍然稳定。 */}
        {children}
      </div>
    </CollapsiblePrimitive.CollapsibleContent>
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
