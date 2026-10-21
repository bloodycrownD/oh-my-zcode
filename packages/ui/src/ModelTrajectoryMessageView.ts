// 轨迹面板「全屏只读视图」的中性模块（spec trace-nm-borrow Step 5 / N-6、N-9）。
//
// 为什么是零 JSX 的 .ts：本模块只承载「打开全屏视图」的请求契约与上下文接口，
// 不依赖任何组件库，行内组件（折叠行 / 扁平行 / 配对卡）都能直接引用。
//
// 依赖方向：本模块 → React（createContext）+ services 类型 + ToolPayload（复制文本口径）。
// 不反向依赖 PaneParts / TurnGroup / Timeline 等渲染模块，避免循环导入（AGENTS.md）。
import type { ZCodeModelTrajectoryMessage } from "@zcode/services";
import { createContext, useContext } from "react";
import { trajectoryToolOutputs } from "@/ModelTrajectoryToolPayload.js";

/**
 * 打开全屏只读视图的请求。
 *
 * 刻意保持最小：标题 + 全文文本。
 * - 消息行（路径 A / 路径 B）传消息的复制文本口径（messageClipboardText）；
 * - 工具配对卡传 trajectoryToolCallDisplayText(info)（与卡片复制按钮逐字同源）。
 *
 * 不传 ReactNode：全屏层是纯文本只读视图（等宽 pre-wrap），避免把行内结构
 * （Collapsible / 徽标 / 高亮 Range）搬进 Portal 后语义漂移。
 */
export interface TrajectoryMessageViewRequest {
  /** 标题：sr-only 标题与可见标题行共用（消息行=「消息全文」，配对卡=工具名）。 */
  title: string;
  /** 正文：等宽 pre-wrap 全文渲染；复制按钮复制同一份文本。 */
  text: string;
}

/** 全屏视图上下文接口：打开 / 关闭。 */
export interface TrajectoryMessageViewContextValue {
  open: (request: TrajectoryMessageViewRequest) => void;
  close: () => void;
}

/**
 * 全屏视图上下文（唯一所有者是 ModelTrajectoryMessageViewHost）。
 *
 * 入口组件在虚拟化行内，Modal 状态必须挂在回合外层的 Host 上——
 * 行被虚拟化卸载时已打开的 Modal 不能跟着消失（spec 实现注）。
 */
export const TrajectoryMessageViewContext = createContext<TrajectoryMessageViewContextValue | null>(
  null,
);

/** 读取全屏视图上下文；缺少 Provider 说明挂载点漏了 Host，直接报错优于静默失效。 */
export function useTrajectoryMessageView(): TrajectoryMessageViewContextValue {
  const value = useContext(TrajectoryMessageViewContext);
  if (!value) {
    throw new Error(
      "useTrajectoryMessageView 必须在 ModelTrajectoryMessageViewHost 内使用（轨迹面板挂载点缺失）",
    );
  }
  return value;
}

/**
 * 消息的复制文本口径（自 ModelTrajectoryExpandableMessage 迁入，实现原样搬）。
 *
 * 迁入原因：全屏视图的正文与复制按钮共用同一份文本口径，
 * 放在中性模块里可让「折叠行 / 扁平行 / 配对卡」三条入口共用一个来源，
 * 避免各入口各写一份拼接逻辑导致复制与全屏内容不一致。
 */
export function messageClipboardText(message: ZCodeModelTrajectoryMessage): string {
  if (message.role === "tool") return trajectoryToolOutputs(message).join("\n\n");
  return message.parts
    .map((part) => {
      if ("text" in part && typeof part.text === "string") return part.text;
      return JSON.stringify(part, null, 2);
    })
    .filter(Boolean)
    .join("\n\n");
}
