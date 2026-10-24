// 上游 v3.16.2 的 lib/ 路径锚点：偏好唯一 owner 由 source-server-management/ 承载（P9-3 面板先落地）。
// Step 10 曾在本路径再建一份同形 singleton，导致设置面板的「稍后」写不进通知控制器读取的 store；
// 这里只重导出同一实例与键函数，两个消费面共享「已提示」与「稍后」状态。
// useDeferredSourceServerUpdates 不再从这里导出：面板已从 owner 模块直接消费，重复导出只会再制造一条分叉入口。
import {
  createSourceServerUpdatePreferences,
  sourceServerUpdateKey,
  sourceServerUpdatePreferences,
} from "@/source-server-management/sourceServerUpdatePreferences.js";

export {
  createSourceServerUpdatePreferences,
  sourceServerUpdateKey,
  sourceServerUpdatePreferences,
};
