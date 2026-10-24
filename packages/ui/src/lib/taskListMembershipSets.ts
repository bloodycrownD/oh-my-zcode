// E2E hold 状态机：TSL18 用它确定性制造「旧 running 快照在 Stop 终态之后返回」的窗口。
// 经典侧栏的 membership 读取链路已随侧栏切换退役，这里只保留 window.__testActions 的
// hold 入口；当前没有 fetch 会进入 hold，enteredCallCount 保持 0。
export interface TaskListMembershipRefreshHoldState {
  armed: boolean;
  enteredCallCount: number;
  released: boolean;
}

interface ActiveTaskListMembershipRefreshHold {
  released: Promise<void>;
  release: () => void;
}

let activeTaskListMembershipRefreshHold: ActiveTaskListMembershipRefreshHold | null = null;
let taskListMembershipRefreshHoldState: TaskListMembershipRefreshHoldState = {
  armed: false,
  enteredCallCount: 0,
  released: true,
};

export function armTaskListMembershipRefreshHoldForE2E(): void {
  if (activeTaskListMembershipRefreshHold) {
    throw new Error("task list membership refresh hold 已经启动");
  }
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  activeTaskListMembershipRefreshHold = { released, release };
  taskListMembershipRefreshHoldState = {
    armed: true,
    enteredCallCount: 0,
    released: false,
  };
}

export function releaseTaskListMembershipRefreshHoldForE2E(): void {
  const hold = activeTaskListMembershipRefreshHold;
  if (!hold) {
    return;
  }
  activeTaskListMembershipRefreshHold = null;
  taskListMembershipRefreshHoldState = {
    ...taskListMembershipRefreshHoldState,
    armed: false,
    released: true,
  };
  hold.release();
}

export function getTaskListMembershipRefreshHoldStateForE2E(): TaskListMembershipRefreshHoldState {
  return { ...taskListMembershipRefreshHoldState };
}
