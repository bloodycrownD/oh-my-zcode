// Config Port - Scoped configuration with change notification

import type { CollaborationMode } from "../interfaces/session.port.js";
import type { McpServerConfig } from "../interfaces/mcp.port.js";
import type { HooksRuntimeConfig, HooksRuntimeConfigPatch } from "../hooks/index.js";
import type { PluginConfig, PluginOptionValues } from "../plugins/index.js";

// ============================================================
// Config Key Types
// ============================================================

export const ConfigKey = {
  ModelStreamIdleTimeout: "modelStream.idleTimeoutMs",

  // Permission
  PermissionMode: "permission.mode",
  PermissionAllowedTools: "permission.allowedTools",
  PermissionDisallowedTools: "permission.disallowedTools",
  PermissionAutoApproveHighRisk: "permission.autoApproveHighRisk",
  PermissionAllowMediumRiskInAuto: "permission.allowMediumRiskInAuto",

  // Storage
  StorageDir: "storage.dir",
  StorageSessionDbPath: "storage.sessionDbPath",

  // Network
  HttpProxy: "network.httpProxy",
  NoProxy: "network.noProxy",
  CaCertFile: "network.caCertFile",
  HttpTimeout: "network.timeout",

  // Features
  FeatureRewind: "features.rewind",
  FeatureSubagent: "features.subagent",
  FeatureMemory: "features.memory",
  FeatureSkill: "features.skill",
  FeatureMcp: "features.mcp",
  FeatureMagicContext: "features.magicContext",

  // Memory
  MemoryUse: "memory.use",

  // Magic Context 参数域（D-12 配置真源 ~/.omz/cli/config.json 顶层 `magicContext`）
  MagicContext: "magicContext",

  // MCP
  McpServers: "mcp.servers",

  // Plugins
  PluginsEnabled: "plugins.enabled",
  PluginsDirs: "plugins.dirs",
  PluginsEnabledPlugins: "plugins.enabledPlugins",
  PluginsExtraKnownMarketplaces: "plugins.extraKnownMarketplaces",
  PluginsOptions: "plugins.options",
  PluginsSuppressedBuiltins: "plugins.suppressedBuiltins",

  // Skills
  SkillsEnabled: "skills.enabled",
  SkillsIncludeInstructions: "skills.includeInstructions",
  SkillsMetadataBudget: "skills.metadataBudget",
  SkillsRoots: "skills.roots",

  // Skill / Command 可用性覆盖（按 SKILL.md / 命令 .md 的绝对路径过滤）
  SkillOverrides: "skill",
  CommandOverrides: "command",

  // Logging
  LogLevel: "logging.level",
  LogFormat: "logging.format",

  // Tool Concurrency
  ToolConcurrencyMax: "toolConcurrency.maxConcurrency",

  // Model anomaly guards
  ModelAnomalyGuard: "modelAnomalyGuard",

  // Hooks
  Hooks: "hooks",

  // UI
  UiLocale: "ui.locale",
  UiTheme: "ui.theme",
} as const;

export type ConfigKey = (typeof ConfigKey)[keyof typeof ConfigKey];

// ============================================================
// Config Value Types
// ============================================================

/**
 * 每个 key 的值类型；链尾的兜底是 `unknown`。
 *
 * FORK（S23 / D-12）：`"magicContext"` 走的就是链尾兜底 `unknown`——它曾有一个
 * `K extends "magicContext" ? unknown : unknown` 的恒等分支，与兜底同值、对类型零贡献，
 * 却让人以为这个 key 有特殊承载类型。分支已删，理由登记在该类型定义之后。
 *
 * 为什么是 `unknown` 而不是结构类型：`@zcode/magic-context` 的
 * `MagicContextConfig` 是 zod 推断出的 ~20 字段子树，contracts 是它所有下游包的
 * 类型底座。为它加一条 workspace 依赖边会把包图倒过来（包已经依赖 contracts 的
 * 兄弟），并且把 schema 一旦演化就变成契约破坏。改由**消费侧 narrow**：adapters 的
 * `ZCodeConfigFileSchema` 与 `workspace/updateMagicContextConfig` handler 都用包内
 * `MagicContextConfigSchema` 做运行时校验，bootstrap 侧 `import type` 收窄，
 * 于是「进入 ConfigPort 的值一定已通过 schema」成为运行时不变量而非类型保证。
 */
export type ConfigValue<K extends ConfigKey> = K extends "modelStream.idleTimeoutMs"
  ? number
  : K extends "permission.mode"
    ? CollaborationMode
    : K extends "permission.allowedTools" | "permission.disallowedTools"
      ? string[]
      : K extends "permission.autoApproveHighRisk" | "permission.allowMediumRiskInAuto"
        ? boolean
        : K extends
              | "storage.dir"
              | "storage.sessionDbPath"
              | "network.httpProxy"
              | "network.noProxy"
              | "network.caCertFile"
          ? string | undefined
          : K extends "network.timeout"
            ? number
            : K extends
                  | "features.rewind"
                  | "features.subagent"
                  | "features.memory"
                  | "features.skill"
                  | "features.mcp"
                  | "features.magicContext"
                  | "skills.enabled"
                  | "skills.includeInstructions"
              ? boolean
              : K extends "memory.use"
                ? boolean
                : K extends "skills.metadataBudget"
                  ? number
                  : K extends "skills.roots"
                    ? string[]
                    : K extends "skill" | "command"
                      ? Record<string, SkillCommandOverride>
                      : K extends "mcp.servers"
                        ? Record<string, McpServerConfig>
                        : K extends "plugins.enabled"
                          ? boolean
                          : K extends "plugins.dirs"
                            ? string[]
                            : K extends "plugins.enabledPlugins"
                              ? Record<string, boolean>
                              : K extends "plugins.extraKnownMarketplaces"
                                ? PluginConfig["extraKnownMarketplaces"]
                                : K extends "plugins.options"
                                  ? Record<string, PluginOptionValues>
                                  : K extends "plugins.suppressedBuiltins"
                                    ? string[]
                                    : K extends "logging.level"
                                      ? "debug" | "info" | "warn" | "error"
                                      : K extends "logging.format"
                                        ? "text" | "json"
                                        : K extends "toolConcurrency.maxConcurrency"
                                          ? number
                                          : K extends "modelAnomalyGuard"
                                            ? ModelAnomalyGuardConfig
                                            : K extends "hooks"
                                              ? HooksRuntimeConfig
                                              : K extends "ui.locale"
                                                ? UiLocale
                                                : K extends "ui.theme"
                                                  ? UiThemePreference
                                                  : unknown;
// `"magicContext"` 曾在这里占一个恒等分支（`K extends "magicContext" ? unknown : unknown`）。
// 它与兜底完全同值，因此对类型**零**贡献，却让读者以为这个 key 有特殊承载类型——
// 而它的承载类型恰恰就是兜底的 `unknown`。删掉分支、改成这条注释，理由见
// `ConfigValue` 的头注：唯一权威结构在 `@zcode/magic-context` 的
// `MagicContextConfig`，contracts 只能声明 `unknown`。
//
// 恒等分支删掉后，「key 还在不在」就只剩注释在说了——所以下面这条编译期锚点把它钉住：
// 删掉 `ConfigKey.MagicContext` 里那个 `"magicContext"` 字面量，会让本行**编译失败**
// （`"magicContext"` 不再是合法 `ConfigKey`），而不是静默地让整条链退回兜底。
// `_` 前缀是 oxlint 的未使用豁免；类型别名把它固定成 `ConfigKey` 而非 `string`。
const _: ConfigKey = "magicContext";
type _MagicContextConfigKeyAnchor = typeof _;

// ============================================================
// Config Scope
// ============================================================

export const ConfigScope = {
  System: "system",
  User: "user",
  Project: "project",
  Session: "session",
  Env: "env",
  Cli: "cli",
} as const;

export type ConfigScope = (typeof ConfigScope)[keyof typeof ConfigScope];

export const ConfigScopePriority: Record<ConfigScope, number> = {
  [ConfigScope.System]: 0,
  [ConfigScope.User]: 10,
  [ConfigScope.Project]: 20,
  [ConfigScope.Session]: 30,
  [ConfigScope.Env]: 40,
  [ConfigScope.Cli]: 50,
};

// ============================================================
// Config Source
// ============================================================

export interface ConfigSource {
  scope: ConfigScope;
  key: ConfigKey;
  value: unknown;
  path?: string; // For file-based configs, the file path
}

// ============================================================
// Skill / Command 可用性覆盖
// ============================================================

// 按绝对路径覆盖单个 skill / 命令是否可用。未列出的条目默认可用，
// 只有显式 enable:false 才会在发现阶段被过滤掉。
export interface SkillCommandOverride {
  enable?: boolean;
}

// ============================================================
// Runtime Config
// ============================================================

export interface RuntimeConfig {
  modelStream: ModelStreamConfig;
  permission: {
    mode: CollaborationMode;
    allowedTools: string[];
    disallowedTools: string[];
    autoApproveHighRisk: boolean;
    allowMediumRiskInAuto: boolean;
  };
  storage: {
    dir: string;
    sessionDbPath: string;
  };
  network: {
    httpProxy?: string;
    noProxy?: string;
    caCertFile?: string;
    timeout: number;
  };
  features: {
    rewind: boolean;
    subagent: boolean;
    memory: boolean;
    skill: boolean;
    mcp: boolean;
    magicContext: boolean;
  };
  memory: {
    use: boolean;
  };
  /**
   * FORK（S23 / D-12）：magic-context 参数域。承载类型 `unknown` 的理由与
   * `ConfigValue<"magicContext">` 分支同源（见上方注释）：唯一权威结构是包内
   * `MagicContextConfig`，这里只声明「这个域存在」。
   *
   * 缺席（undefined）表示配置文件没写过这个域，消费侧应回落到
   * `DEFAULT_MAGIC_CONTEXT_CONFIG`（由 adapters 的 `getDefaultValue()` 登记）。
   */
  magicContext?: unknown;
  mcp: {
    servers: Record<string, McpServerConfig>;
  };
  plugins: PluginConfig;
  skills: {
    enabled: boolean;
    includeInstructions: boolean;
    metadataBudget: number;
    roots: string[];
    [skillPath: string]: boolean | number | string[] | { enable?: boolean };
  };
  // key 为 SKILL.md 绝对路径，value.enable=false 表示禁用该 skill
  skillOverrides: Record<string, SkillCommandOverride>;
  // key 为命令 .md 绝对路径，value.enable=false 表示禁用该命令
  commandOverrides: Record<string, SkillCommandOverride>;
  logging: {
    level: "debug" | "info" | "warn" | "error";
    format: "text" | "json";
  };
  toolConcurrency: ToolConcurrencyConfig;
  modelAnomalyGuard: ModelAnomalyGuardConfig;
  hooks: HooksRuntimeConfig;
  ui: {
    locale: UiLocale;
    theme: UiThemePreference;
  };
}

export interface RuntimeConfigPatch {
  modelStream?: Partial<ModelStreamConfig>;
  permission?: Partial<RuntimeConfig["permission"]>;
  storage?: Partial<RuntimeConfig["storage"]>;
  network?: Partial<RuntimeConfig["network"]>;
  features?: Partial<RuntimeConfig["features"]>;
  memory?: Partial<RuntimeConfig["memory"]>;
  /** FORK（S23 / D-12）：见 `RuntimeConfig.magicContext` 的类型承载说明。 */
  magicContext?: unknown;
  mcp?: Partial<RuntimeConfig["mcp"]>;
  plugins?: Partial<RuntimeConfig["plugins"]>;
  skills?: Partial<RuntimeConfig["skills"]>;
  skillOverrides?: RuntimeConfig["skillOverrides"];
  commandOverrides?: RuntimeConfig["commandOverrides"];
  logging?: Partial<RuntimeConfig["logging"]>;
  toolConcurrency?: Partial<RuntimeConfig["toolConcurrency"]>;
  modelAnomalyGuard?: Partial<RuntimeConfig["modelAnomalyGuard"]>;
  hooks?: HooksRuntimeConfigPatch;
  ui?: Partial<RuntimeConfig["ui"]>;
}

export type SupportedLocale = "en-US" | "zh-CN";
export type UiLocale = SupportedLocale | "auto";
export type UiThemeMode = "dark" | "light";
export type UiThemePreference = UiThemeMode | "auto";

export const DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS = 600_000;

export interface ModelStreamConfig {
  idleTimeoutMs: number;
}

export const DefaultRuntimeConfig: RuntimeConfig = {
  modelStream: {
    idleTimeoutMs: DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
  },
  permission: {
    mode: "build",
    allowedTools: [],
    disallowedTools: [],
    autoApproveHighRisk: false,
    allowMediumRiskInAuto: false,
  },
  storage: {
    dir: "~/.omz",
    sessionDbPath: "~/.omz/cli/db/db.sqlite",
  },
  network: {
    timeout: 180000,
  },
  features: {
    rewind: true,
    subagent: true,
    memory: true,
    skill: true,
    mcp: true,
    // D-11 收官：magicContext 随 MVP 验收（T-M1..T-M8）与「压缩移除全量回归」
    // 一并通过，在 step 28 翻为默认开启。off 现在只表示「transform 直通、无预算
    // 管理」这条用户显式退路（T-M8 语义），因此与邻居的 `?? true` 一致。
    magicContext: true,
  },
  memory: {
    use: true,
  },
  mcp: {
    servers: {},
  },
  plugins: {
    dirs: [],
    enabled: true,
    enabledPlugins: {},
    extraKnownMarketplaces: {},
    options: {},
    suppressedBuiltins: [],
  },
  skills: {
    enabled: true,
    includeInstructions: true,
    metadataBudget: 20_000,
    roots: [],
  },
  skillOverrides: {},
  commandOverrides: {},
  logging: {
    level: "info",
    format: "text",
  },
  toolConcurrency: {
    maxConcurrency: 10,
  },
  modelAnomalyGuard: {
    maxBudgetWarningsPerTurn: 3,
    repeatedToolCallWarningThreshold: 3,
  },
  hooks: {
    enabled: false,
    events: {},
    maxOutputBytes: 32768,
    timeoutMs: 60000,
  },
  ui: {
    locale: "en-US",
    theme: "auto",
  },
};

// ============================================================
// Tool Concurrency Config
// ============================================================

export interface ToolConcurrencyConfig {
  maxConcurrency: number;
}

export interface ModelAnomalyGuardConfig {
  toolCallWarningThreshold?: number;
  repeatedToolCallWarningThreshold: number;
  maxBudgetWarningsPerTurn: number;
}

// ============================================================
// Config Port Interface
// ============================================================

export interface Unsubscribe {
  (): void;
}

export interface ConfigObserver {
  subscribe<K extends ConfigKey>(
    key: K,
    handler: (value: ConfigValue<K>, prev: ConfigValue<K>) => void,
  ): Unsubscribe;
  subscribeAll(handler: (key: ConfigKey, value: unknown, prev: unknown) => void): Unsubscribe;
}

export interface ConfigPort {
  // Get configuration value
  get<K extends ConfigKey>(key: K): ConfigValue<K>;
  getAll(): RuntimeConfig;

  // Check if key exists
  has(key: ConfigKey): boolean;

  // Set configuration value (runtime only, not persisted by default)
  set<K extends ConfigKey>(key: K, value: ConfigValue<K>): void;

  // Get observer for scoped subscriptions
  observe(): ConfigObserver;

  // Get all sources for a key (for debugging/audit)
  getSources(key: ConfigKey): ConfigSource[];

  // Merge additional config (e.g., from file/env)
  merge(config: RuntimeConfigPatch, scope: ConfigScope): void;
}
