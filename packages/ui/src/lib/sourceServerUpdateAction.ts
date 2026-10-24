// 上游 v3.16.2 的 lib/ 路径锚点：更新动作的唯一实现由 source-server-management/ 承载（P9-3 面板先落地）。
// 提示 toast 与设备卡必须共用同一份 guard 逻辑，本文件只重导出，避免两份实现的 force 分支漂移。
export {
  getSourceServerForceUpdateDescription,
  runSourceServerUpdate,
} from "@/source-server-management/sourceServerUpdateAction.js";
