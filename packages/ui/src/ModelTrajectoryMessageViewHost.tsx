// 全屏只读视图的挂载宿主（spec trace-nm-borrow Step 5 / N-6）。
//
// 为什么独立成文件：Modal 状态必须活回合虚拟化之外——入口按钮在 Virtualizer 的行里，
// 行被回收时已打开的 Modal 不能跟着卸载；状态挂在回合外层的 Host 上，
// 入口只通过 context 打开，行卸载不影响已打开的视图（spec 实现注）。
//
// 挂载点：ModelTrajectoryPane 的时间线外层（Pane 只挂这一处，Dialog 走 Portal 到 body）。
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ModelTrajectoryMessageDialog } from "@/ModelTrajectoryMessageDialog.js";
import {
  TrajectoryMessageViewContext,
  type TrajectoryMessageViewContextValue,
  type TrajectoryMessageViewRequest,
} from "@/ModelTrajectoryMessageView.js";

/**
 * 全屏视图宿主：context Provider + 查看状态 + Dialog 挂载内聚在一处。
 *
 * 状态所有权：查看中的内容（request）是本组件的局部 state，唯一写入口是 context 的 open/close；
 * 入口组件不持有任何副本，避免多处状态漂移。
 */
export function ModelTrajectoryMessageViewHost({ children }: { children?: ReactNode }) {
  const [request, setRequest] = useState<TrajectoryMessageViewRequest | null>(null);
  const open = useCallback((next: TrajectoryMessageViewRequest) => {
    setRequest(next);
  }, []);
  const close = useCallback(() => {
    setRequest(null);
  }, []);
  const value = useMemo<TrajectoryMessageViewContextValue>(() => ({ open, close }), [close, open]);

  return (
    <TrajectoryMessageViewContext.Provider value={value}>
      {children}
      <ModelTrajectoryMessageDialog open={request !== null} request={request} onClose={close} />
    </TrajectoryMessageViewContext.Provider>
  );
}
