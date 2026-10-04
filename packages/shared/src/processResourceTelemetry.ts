/**
 * 全进程 CPU / 内存监控埋点的共享契约。
 *
 * 这里只放"main 与单测都要用同一份"的常量与纯校验：进程角色枚举、CLI 采样节拍与泳道。
 * 真正的采样与聚合在 desktop main 侧。
 */

/** 第一期 10 个进程角色。 */
export const PROCESS_RESOURCE_ROLES = [
  "main",
  "renderer_main",
  "renderer_guest",
  "gpu",
  "chromium_other",
  "host",
  "scheduler",
  "cli_chat",
  "cli_aux",
  "mcp",
] as const;

export type ProcessResourceRole = (typeof PROCESS_RESOURCE_ROLES)[number];

/**
 * zcode-cli 的自采周期，是 CLI 与 app 之间的节拍契约：
 * CLI 侧是定时器周期，main 侧既是「多久算一个 CLI 样本」也是过期判据（2 个周期）的基数。
 * 两侧必须同源，否则改 CLI 节拍会让 main 的 `sample_count` 静默偏离约定值。
 */
export const ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS = 60_000;

/**
 * zcode-cli 的进程泳道。
 *
 * lane 不是 CLI 协议字段——CLI 进程不知道自己被哪个进程管理器拉起，由 app 侧 services 层
 * 在解析样本时按所属进程管理器打标（`chat` 是 workspace 级 Agent，其余两条是控制面 lane）。
 */
export const PROCESS_RESOURCE_CLI_LANES = ["chat", "plugin", "mcp-status"] as const;

export type ProcessResourceCliLane = (typeof PROCESS_RESOURCE_CLI_LANES)[number];
