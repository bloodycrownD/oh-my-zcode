# realdevice-e2e 证据包（bugfix-batch-20261011）

节点：realdevice-e2e（重派）｜生成时间：2026-10-11｜分支：bugfix-batch-20261011（HEAD=9182a420，任务描述参考点 3d482b8f 附近）
纪律：ZCODE_STORAGE_DIR/MAGIC_CONTEXT_DB_DIR 指向 os.tmpdir() 一次性目录（绝不写真实 ~/.omz）；不改任何仓库文件，本证据包为唯一落盘物。

## 环境信息

| 项 | 值 |
| --- | --- |
| 仓库路径 | D:\Dev\Js\oh-my-zcode |
| 分支 | bugfix-batch-20261011 |
| HEAD | 9182a420 |
| Node | v22.22.0（E:\App\Scoop\apps\nvm\current\nodejs\nodejs\node.exe） |
| OS | win32 10.0.26200 x64 |
| CDP 端口 | 9229（主进程自动开，packages/desktop/src/main/index.ts:165-167） |
| renderer | http://localhost:5174 |
| 应用进程 | 待填（PID/启动方式） |
| ZCODE_STORAGE_DIR | 待填（os.tmpdir() 一次性目录） |
| MAGIC_CONTEXT_DB_DIR | 待填（os.tmpdir() 一次性目录） |

## 场景状态表

| # | 场景 | 状态 | 原因/结论 | 证据 |
| --- | --- | --- | --- | --- |
| S1 | 切模型即时下发：`chat-model-select-trigger` 换模型 → 无错误 toast + `v4-model-config` data-model 更新 + 发消息后时间线 `data-marker-type="modelChange"` `data-status="applied"` | blocked | 骨架初始化，未开测 | - |
| S2 | 排队提升不被 settle 卡：发 A（turn 进行中）→ 再发 B 入队（`v4-queue-item-*`）→ 切模型 → A 完成 → 队列自动消失、提升轮开跑；粗测 A→Q 间隔无 60s 级等待 | blocked | 骨架初始化，未开测 | - |
| S3 | 子代理设置即时生效：`settings-section-nav-subagents` → `subagent-built-in-model-trigger-<name>` 改具体模型 → 断言注入存储目录下 v2/agents-state.json 已写入且 UI 无错 | blocked | 骨架初始化，未开测 | - |
| S4 | magic-context 设置面：`magic-context-enabled-switch` 可切换；`chat-context-usage-magic-context` 段状态符合开关 | blocked | 骨架初始化，未开测 | - |

## 前置检查

- 9229 占用检查：待执行
- 9229/9231 区分：9229=renderer debug（本节点用），9231=主进程 inspector（勿动）
- /json/list URL 过滤法：`type==='page' && url 命中 http://localhost:5174/ && 排除 resource-manager.html`（title 已是 omz，旧脚本 title==="ZCode" 不可用）
- provider 凭据检查：待执行（无凭据则对应场景如实 blocked）

## 应用日志 mc 关键行

（待填）

## 清理确认

（待填）
