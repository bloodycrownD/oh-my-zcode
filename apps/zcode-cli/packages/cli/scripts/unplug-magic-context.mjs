#!/usr/bin/env node
/**
 * unplug-magic-context.mjs — 一键摘除 magic-context（宿主侧），可逆。
 *
 * ============================================================================
 * 这个脚本做什么
 * ============================================================================
 *
 * 把 magic-context（下称 MC）从宿主里**连根拔掉**：
 *   1. 删掉 `apps/zcode-cli/packages/magic-context` 包本体；
 *   2. 删掉宿主侧所有 MC 专属模块（bootstrap 装配门面 / 协议 handler / ctx 命令 /
 *      core 的 ctx 工具与段实现 / UI 的设置分区与用量面板）；
 *   3. 把仍然存活但与 MC 共享的文件里的 MC 段落、导入、类型、注册项逐条删掉
 *      （146 条规则，见下方 `RULES`；每条都用「唯一锚点或唯一子串」定位，
 *      匹配数不符即中止，不做模糊替换）；
 *   4. 清理 `package.json` 的依赖/脚本/导出、knip 忽略项、构建 external 与
 *      打包种子（`sea-tui-assets` 在没有 MC 包时会直接 throw）；
 *   5. 清理**陈留 dist**：tsc 不会删除已消失源码的产物，`dist/app/magic-context*`
 *      留着会让「零加载守卫」与手工 grep 都看到幽灵文件；
 *   6. （可选）`--archive-db` 把 `magic-context.db{,-wal,-shm}` 归档到
 *      `~/.omz/backup-<ts>/`。**不自动改配置**：根配置 schema 是 `.passthrough()`，
 *      残留的 `features.magicContext` 与顶层 `magicContext` 块既不报错也不生效。
 *
 * 摘除后不依赖任何「包缺失探测」：宿主代码里对包的引用被逐条删除，运行期只剩
 * `absent(import_failed)`（动态 import 失败）这一条真实可达分支（spec IM2）。
 *
 * ============================================================================
 * 用法
 * ============================================================================
 *
 *   node apps/zcode-cli/packages/cli/scripts/unplug-magic-context.mjs            # dry-run（默认）
 *   node ... unplug-magic-context.mjs --apply                                   # 真摘除
 *   node ... unplug-magic-context.mjs --apply --archive-db                      # 摘除 + 归档库
 *   node ... unplug-magic-context.mjs --verify                                  # 摘除后自检（9 条）
 *   node ... unplug-magic-context.mjs --audit                                   # grep 清单对账
 *   node ... unplug-magic-context.mjs --restore                                 # 一条命令回滚
 *
 * 幂等：第二次 `--apply` 会识别「已摘除」（MC 包目录不存在）并把每条规则计为
 * skipped，退出码 0。`--restore` 用 `git checkout -- <路径>` 还原（要求改动前的
 * 内容在 git 里，未提交的同路径本地改动会被覆盖——脚本会先检查这些路径是否干净）。
 *
 * 恢复的另一种等价做法：`git checkout -- .`（脚本只改/删 tracked 文件，不产生
 * 未跟踪产物；`--archive-db` 的备份目录除外）。
 *
 * ============================================================================
 * 摘除后必须仍绿的东西（`--verify` 逐条断言）
 * ============================================================================
 *
 *   1. `bootstrap/dist/app/create-app.js` 可 import；
 *   2. `bootstrap/dist/zcode-protocol/server.js` 可 import；
 *   3. core 内置工具表里没有 `ctx_reduce / ctx_expand / ctx_search / ctx_memory`；
 *   4. `BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES` 里没有 `ctx-*` 四条；
 *   5. App 可见命令清单里没有 `ctx-*`；
 *   6. v4 命令面（`placeholder`/`ctxCommand`…）不再导出 ctx 命令符号；
 *   7. UI 设置页不再有 memory / context 两个分区，也不再渲染 MC 组件；
 *   8. 源码里不再有 `@zcode/magic-context` 的**运行期导入**（注释不算）；
 *   9. MC 包目录与陈留 dist 全部消失。
 *
 * 另外 `--audit` 把 `git grep` 出来的 MC 残留逐文件对账：要么是被本脚本删掉/
 * 改写的文件，要么必须落在 `KEEP_LIST`（带保留理由）里；出现任何未登记残留即
 * 失败——这是「升级跟随」口径的机读守卫。
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const MC_PACKAGE_DIR = "apps/zcode-cli/packages/magic-context";

// ============================================================
// 一、整件删除清单（文件或目录）
// ============================================================

/** MC 专属模块与测试：删掉即不再存在，剩余规则只管「共享文件里的 MC 段落」。 */
const DEDICATED_PATHS = [
  // MC 包本体
  "apps/zcode-cli/packages/magic-context",

  // bootstrap 宿主侧
  "apps/zcode-cli/packages/bootstrap/src/app/magic-context",
  "apps/zcode-cli/packages/bootstrap/src/app/magic-context-turn-transform.ts",
  "apps/zcode-cli/packages/bootstrap/src/app/magic-context-historian.ts",
  "apps/zcode-cli/packages/bootstrap/src/app/magic-context-usage-summary.ts",
  "apps/zcode-cli/packages/bootstrap/src/app/magic-context-prompt-section-zh-cn.ts",
  "apps/zcode-cli/packages/bootstrap/src/app/magic-context-absent-event.ts",
  "apps/zcode-cli/packages/bootstrap/src/ctx-commands",
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/magic-context-config.ts",
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/magic-context-memories.ts",
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/ctx.ts",

  // cli 命令面
  "apps/zcode-cli/packages/cli/src/command-center/handlers/ctx.ts",

  // contracts 工具定义
  "apps/zcode-cli/packages/contracts/src/tools/ctx-context.ts",

  // core 工具实现（handler 内部 `await import("@zcode/magic-context")`）
  "apps/zcode-cli/packages/core/src/tool/handlers/ctx-context.ts",
  "apps/zcode-cli/packages/core/src/tool/handlers/ctx-memory.ts",
  "apps/zcode-cli/packages/core/src/tool/handlers/ctx-search.ts",

  // UI
  "packages/ui/src/settings/MagicContextSettingsSection.tsx",
  "packages/ui/src/settings/MagicContextSettingsFields.tsx",
  "packages/ui/src/settings/magicContextSettingsForm.ts",
  "packages/ui/src/settings/MemoryManagementSection.tsx",
  "packages/ui/src/chat-input-toolbar/magicContextUsageRows.ts",

  // MC 行为测试（含「11 个硬编码 dist/app/magic-context-turn-transform.js 的脚本」）
  // —— 这些脚本测的就是被删掉的行为，留着只会 404 或必红。
  "apps/zcode-cli/packages/adapters/scripts/test-magic-context-boundaries.mjs",
  "apps/zcode-cli/packages/adapters/scripts/test-magic-context-config-narrow.mjs",
  "apps/zcode-cli/packages/adapters/scripts/test-magic-context-domain.mjs",
  "apps/zcode-cli/packages/adapters/scripts/test-feature-flag.mjs",
  "apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-absent-event.mjs",
  "apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-config-rpc.mjs",
  "apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-gate.mjs",
  "apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-historian.mjs",
  "apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-lifecycle.mjs",
  "apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-memories-rpc.mjs",
  "apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-plugin.mjs",
  "apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-section-zh.mjs",
  "apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-tag-strip.mjs",
  "apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-turn-transform.mjs",
  "apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-ui-config.mjs",
  "apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-ui-model-picker.mjs",
  "apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-usage-projection.mjs",
  "apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-zero-load.mjs",
  "apps/zcode-cli/packages/bootstrap/scripts/test-mc-compartment-rewind-host.mjs",
  "apps/zcode-cli/packages/bootstrap/scripts/test-mc-entry-identity-guard.mjs",
  "apps/zcode-cli/packages/bootstrap/scripts/test-e2e-live-all.mjs",
  "apps/zcode-cli/packages/bootstrap/scripts/test-mural-media-blocks.mjs",
  "apps/zcode-cli/packages/bootstrap/scripts/test-prompt-surface-toolset-hash.mjs",
  "apps/zcode-cli/packages/bootstrap/scripts/test-settle-background.mjs",
  "apps/zcode-cli/packages/bootstrap/scripts/diag-first-send-latency.mjs",
  "apps/zcode-cli/packages/core/scripts/test-ctx-memory-archive.mjs",
  "apps/zcode-cli/packages/core/scripts/test-ctx-search-memory.mjs",
  "apps/zcode-cli/packages/core/scripts/test-ctx-tool-descriptions.mjs",
  "apps/zcode-cli/packages/core/scripts/test-magic-context-prompt-section.mjs",
  "apps/zcode-cli/packages/core/scripts/test-magic-context-section-ctx-note.mjs",
  "apps/zcode-cli/packages/core/scripts/test-prompt-surface-tiering.mjs",
  "apps/zcode-cli/packages/cli/scripts/test-ctx-commands.mjs",
  "packages/ui/test/magicContextPromptSurfaceOverrides.test.ts",
  "packages/services/test/magicContextMemoriesDegradation.test.ts",
];

/**
 * 陈留 dist：tsc 只写不删，被删源码的产物会留下幽灵文件。
 *
 * 最阴的一条是 `dist/app/magic-context-turn-transform.js`：零加载守卫
 * （`test-magic-context-absent-event.mjs`）曾把它当**阳性对照 marker**，文件在、
 * 但源码已删时那条守卫仍然会「看到」它——所以摘除必须同时清理 dist，而不能只删源码。
 */
const STALE_DIST_PATHS = [
  "apps/zcode-cli/packages/bootstrap/dist/app/magic-context",
  "apps/zcode-cli/packages/bootstrap/dist/app/magic-context-turn-transform.js",
  "apps/zcode-cli/packages/bootstrap/dist/app/magic-context-turn-transform.d.ts",
  "apps/zcode-cli/packages/bootstrap/dist/app/magic-context-turn-transform.d.ts.map",
  "apps/zcode-cli/packages/bootstrap/dist/app/magic-context-historian.js",
  "apps/zcode-cli/packages/bootstrap/dist/app/magic-context-historian.d.ts",
  "apps/zcode-cli/packages/bootstrap/dist/app/magic-context-usage-summary.js",
  "apps/zcode-cli/packages/bootstrap/dist/app/magic-context-usage-summary.d.ts",
  "apps/zcode-cli/packages/bootstrap/dist/app/magic-context-prompt-section-zh-cn.js",
  "apps/zcode-cli/packages/bootstrap/dist/app/magic-context-prompt-section-zh-cn.d.ts",
  "apps/zcode-cli/packages/bootstrap/dist/app/magic-context-absent-event.js",
  "apps/zcode-cli/packages/bootstrap/dist/app/magic-context-absent-event.d.ts",
  "apps/zcode-cli/packages/bootstrap/dist/ctx-commands",
  "apps/zcode-cli/packages/bootstrap/dist/zcode-protocol/magic-context-config.js",
  "apps/zcode-cli/packages/bootstrap/dist/zcode-protocol/magic-context-config.d.ts",
  "apps/zcode-cli/packages/bootstrap/dist/zcode-protocol/magic-context-memories.js",
  "apps/zcode-cli/packages/bootstrap/dist/zcode-protocol/magic-context-memories.d.ts",
  "apps/zcode-cli/packages/bootstrap/dist/zcode-protocol-v4/commands/handlers/ctx.js",
  "apps/zcode-cli/packages/bootstrap/dist/zcode-protocol-v4/commands/handlers/ctx.d.ts",
  "apps/zcode-cli/packages/core/dist/tool/handlers/ctx-context.js",
  "apps/zcode-cli/packages/core/dist/tool/handlers/ctx-context.d.ts",
  "apps/zcode-cli/packages/core/dist/tool/handlers/ctx-memory.js",
  "apps/zcode-cli/packages/core/dist/tool/handlers/ctx-memory.d.ts",
  "apps/zcode-cli/packages/core/dist/tool/handlers/ctx-search.js",
  "apps/zcode-cli/packages/core/dist/tool/handlers/ctx-search.d.ts",
  "apps/zcode-cli/packages/cli/dist/command-center/handlers/ctx.js",
  "apps/zcode-cli/packages/cli/dist/command-center/handlers/ctx.d.ts",
  "packages/ui/dist/settings/MagicContextSettingsSection.js",
  "packages/ui/dist/settings/MagicContextSettingsFields.js",
  "packages/ui/dist/settings/magicContextSettingsForm.js",
  "packages/ui/dist/settings/MemoryManagementSection.js",
  "packages/ui/dist/chat-input-toolbar/magicContextUsageRows.js",
];

/**
 * 摘除后**刻意保留**的 MC 痕迹（`--audit` 的白名单，逐条写理由）。
 *
 * 判断口径：这段代码在 MC 包不存在时是否仍需要存在？
 *   - 是 → 保留（接缝 / 历史转写 / 协议字段），列出理由；
 *   - 否 → 它应该已经被 DEDICATED_PATHS 或 RULES 处理掉了。
 */
const KEEP_LIST = [
  {
    // 接缝（IM4）：端口类型与落位点，零包依赖，端口缺席即零行为
    paths: [
      "apps/zcode-cli/packages/core/src/index.ts",
      "apps/zcode-cli/packages/core/src/context/builder.ts",
      "apps/zcode-cli/packages/core/src/context/types.ts",
      "apps/zcode-cli/packages/core/src/context/sections/magic-context.ts",
      "apps/zcode-cli/packages/core/src/subagent/context-builder.ts",
      "apps/zcode-cli/packages/core/src/runtime/types.ts",
      "apps/zcode-cli/packages/core/src/runtime/internal.ts",
      "apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts",
      "apps/zcode-cli/packages/core/src/runtime/helpers/magic-context-turn-transform.ts",
      "apps/zcode-cli/packages/core/src/runtime/helpers/magic-context-prompt-section.ts",
      "apps/zcode-cli/packages/core/src/runtime/helpers/magic-context-effective-enabled.ts",
      "apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts",
      "apps/zcode-cli/packages/core/src/runtime/methods/context.ts",
      "apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts",
      "apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts",
      "apps/zcode-cli/packages/core/src/runtime/methods/cancelled-stream-persistence.ts",
    ],
    reason:
      "core 侧三端口接缝（IM4）：类型/编排/落位点全部零包依赖，bootstrap 不装端口时只做一次判空。这是将来重新插件化的唯一接口，不是插件的残留。",
  },
  {
    // 只认信封形状、不依赖 MC 包的 wire 修复：历史 transcript 仍可能带该形状
    paths: ["apps/zcode-cli/packages/adapters/src/model/anthropic-stream-compat.ts"],
    reason:
      "wire 层对 `<session-history>` / `<session-history-since>` 双消息信封的修复：判据是形状不是包，历史上已落库的 transcript 仍可能带它。",
  },
  {
    // 历史数据面的展示层：§N§ 剥离（已在库里的正文）
    paths: [
      "packages/shared/src/text/magic-context-tag.ts",
      "packages/shared/src/index.ts",
      "packages/ui/src/v4/ConversationRowView.tsx",
      "packages/ui/src/v4/conversationFindIndex.ts",
      "apps/zcode-cli/packages/bootstrap/src/session-transcript.ts",
      "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-projection.ts",
    ],
    reason:
      "`§N§` 标签剥离：历史库里已有上万条 assistant 正文以模型自写的 §N§ 开头，展示/查找/预览前必须继续剥；纯文本处理，零 MC 依赖。",
  },
  {
    // additive 协议字段：usage.magicContext（无生产者 ⇒ 恒缺席 ⇒ UI 不渲染）
    paths: [
      "packages/shared/src/zcode-protocol/index.ts",
      "packages/shared/src/zcode-protocol-v4/snapshot.ts",
      "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts",
      "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts",
      "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts",
      "apps/zcode-cli/packages/bootstrap/src/app/types.ts",
      "packages/ui/src/v4/composer/V4ComposerToolbar.tsx",
      "packages/services/src/zcode-agent/zcodeAgentService.ts",
    ],
    reason:
      "协议存量字段与注释：`usage.magicContext` 是 additive 的可选派生态，摘除后没有任何生产者（恒缺席，UI 整段不渲染）；其余命中都是注释里对历史的说明。",
  },
  {
    // i18n：两侧键必须对等（uiLocaleContract 断言）
    paths: ["packages/ui/src/i18n/locales/en-US.ts", "packages/ui/src/i18n/locales/zh-CN.ts"],
    reason:
      "i18n 键两侧必须保持对等（uiLocaleContract 测试断言），删一侧会让 locale 契约失败；不可达分区不渲染时这些键没有消费者。",
  },
  {
    // 非 MC 测试里的注释 / 可选端口用法
    paths: [
      "apps/zcode-cli/packages/bootstrap/scripts/test-edit-retry.mjs",
      "apps/zcode-cli/packages/bootstrap/scripts/test-publisher-buffer-clamp.mjs",
      "apps/zcode-cli/packages/bootstrap/scripts/test-turn-directory.mjs",
      "apps/zcode-cli/packages/bootstrap/scripts/test-model-live.mjs",
      "apps/zcode-cli/packages/bootstrap/scripts/test-prompt-language-rpc.mjs",
      "apps/zcode-cli/packages/bootstrap/scripts/test-legacy-cli-provider-config-import.mjs",
      "apps/zcode-cli/packages/core/scripts/test-subagent-cache-breakpoints.mjs",
      "apps/zcode-cli/packages/core/scripts/test-subagent-sync-dispatch.mjs",
      "apps/zcode-cli/packages/core/scripts/test-sidecar-model-request.mjs",
      "apps/zcode-cli/packages/core/scripts/test-workflow-report-count.mjs",
      "apps/zcode-cli/packages/adapters/scripts/test-bash-output-limit.mjs",
    ],
    reason:
      "非 MC 测试：命中只在注释与可选端口的用法上（端口缺席时用例本就按「跳过」走），没有任何 MC 断言。",
  },
  {
    // 构建注释 / CI 注释 / 历史文档
    paths: [
      "apps/zcode-cli/packages/cli/scripts/build.mjs",
      "packages/desktop/scripts/stage-agent-bundle.mjs",
      ".github/workflows/release-desktop.yml",
      "CHANGELOG.md",
      "UPSTREAM-SYNC.md",
    ],
    reason:
      "构建/CI 注释与文档：解释「为什么它曾是 esbuild external / 打包种子」，摘除后不再是可执行配置。",
  },
];

// ============================================================
// 二、共享文件里的逐段删除规则
// ============================================================
//
// 规则四种形态：
//   sub  { file, find, replace? }             逐字子串替换（默认要求恰好出现 1 次）
//   del  { file, start, end }                 按唯一**整行**锚点删 [start..end]
//   cut  { file, start, endBefore, includePrev?, extraEnd? }
//                                             删 [start 行 .. endBefore 行的前一行]，
//                                             includePrev 负数可带上块前的 `/**`，
//                                             extraEnd 负数可吃掉块尾的空行/闭括号
//   json { file, mutate }                     结构化改 package.json / knip.json
//
// 所有规则都做**匹配数校验**：锚点不唯一、子串出现 0 次或多次都会中止，
// 因此规则表本身就是「清单逐项确认」的机读形式。

const CONTRACTS_CONFIG_INDEX = "apps/zcode-cli/packages/contracts/src/config/index.ts";
const CONTRACTS_TOOLS_INDEX = "apps/zcode-cli/packages/contracts/src/tools/index.ts";
const ADAPTERS_CONFIG_SCHEMA = "apps/zcode-cli/packages/adapters/src/config/schema.ts";
const ADAPTERS_CONFIG_INDEX = "apps/zcode-cli/packages/adapters/src/config/index.ts";
const ADAPTERS_FILE_CONFIG = "apps/zcode-cli/packages/adapters/src/config/file-config.adapter.ts";
const CORE_TOOL_HANDLERS = "apps/zcode-cli/packages/core/src/tool/handlers/index.ts";
const CORE_RUNTIME_TOOLS = "apps/zcode-cli/packages/core/src/runtime/helpers/runtime-tools.ts";
const CORE_EMBEDDED_SEARCH_BRANCH =
  "apps/zcode-cli/packages/core/src/runtime/methods/embedded-search-branch.ts";
const CORE_MC_PROMPT_SECTION =
  "apps/zcode-cli/packages/core/src/runtime/helpers/magic-context-prompt-section.ts";
const BOOTSTRAP_CREATE_APP = "apps/zcode-cli/packages/bootstrap/src/app/create-app.ts";
const BOOTSTRAP_APP_TYPES = "apps/zcode-cli/packages/bootstrap/src/app/types.ts";
const BOOTSTRAP_RUNTIME_CONFIG = "apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts";
const BOOTSTRAP_PROTOCOL_SERVER = "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts";
const BOOTSTRAP_SESSION_FACADE = "apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts";
const BOOTSTRAP_WORKSPACE_MODEL_RUNTIME =
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-runtime.ts";
const BOOTSTRAP_SLASH_COMMAND_SURFACE =
  "apps/zcode-cli/packages/bootstrap/src/slash-command-surface.ts";
const BOOTSTRAP_V4_HANDLERS_INDEX =
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/index.ts";
const BOOTSTRAP_V4_EXECUTOR =
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/executor.ts";
const BOOTSTRAP_V4_FORK_EDIT_RETRY =
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/fork-edit-retry.ts";
const BOOTSTRAP_V4_PROJECTION_STATE =
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/projection-state.ts";
const CLI_COMMAND_CENTER_CREATE = "apps/zcode-cli/packages/cli/src/command-center/create.ts";
const CLI_COMMAND_CENTER_SLASH_COMMANDS =
  "apps/zcode-cli/packages/cli/src/command-center/slash-commands.ts";
const CLI_COMMAND_CENTER_TYPES = "apps/zcode-cli/packages/cli/src/command-center/types.ts";
const CLI_SLASH_COMMAND_TYPES =
  "apps/zcode-cli/packages/cli/src/command-center/slash-command-types.ts";
const SERVICES_AGENT_CONTRACT = "packages/services/src/zcode-agent/zcodeAgent.ts";
const SERVICES_AGENT_SERVICE = "packages/services/src/zcode-agent/zcodeAgentService.ts";
const UI_SETTINGS_PAGE = "packages/ui/src/SettingsPage.tsx";
const UI_SETTINGS_PAGE_CONFIG = "packages/ui/src/settings/settingsPageConfig.ts";
const UI_SETTINGS_NAVIGATION = "packages/ui/src/lib/settingsNavigation.ts";
const UI_CONTEXT_USAGE = "packages/ui/src/chat-input-toolbar/contextUsage.tsx";
const UI_V4_COMPOSER_TOOLBAR = "packages/ui/src/v4/composer/V4ComposerToolbar.tsx";
const UI_V4_SLASH_COMMANDS = "packages/ui/src/v4/slashCommands.ts";
const UI_V4_SESSION_PANE = "packages/ui/src/v4/SessionPane.tsx";
const CLI_SEA_TUI_ASSETS = "apps/zcode-cli/packages/cli/scripts/sea-tui-assets.mjs";
const CLI_BUILD = "apps/zcode-cli/packages/cli/scripts/build.mjs";
const DESKTOP_STAGE_AGENT_BUNDLE = "packages/desktop/scripts/stage-agent-bundle.mjs";
const ROOT_BUILD_DESKTOP_AGENT_CLI = "scripts/build-desktop-agent-cli.mjs";
const BOOTSTRAP_TEST_EDIT_RETRY = "apps/zcode-cli/packages/bootstrap/scripts/test-edit-retry.mjs";
const SHARED_PROTOCOL_INDEX = "packages/shared/src/zcode-protocol/index.ts";
const SHARED_V4_COMMAND = "packages/shared/src/zcode-protocol-v4/command.ts";
const SHARED_V4_SNAPSHOT = "packages/shared/src/zcode-protocol-v4/snapshot.ts";
const SHARED_SLASH_COMMAND_HELP = "packages/shared/src/zcode-slash-command-help.ts";
const PACKAGE_JSON_FILES = [
  "package.json",
  "knip.json",
  "apps/zcode-cli/packages/adapters/package.json",
  "apps/zcode-cli/packages/bootstrap/package.json",
  "apps/zcode-cli/packages/cli/package.json",
  "apps/zcode-cli/packages/core/package.json",
];

const RULES = [
  // ── contracts: ConfigKey / ConfigValue / RuntimeConfig / defaults ──────────
  {
    kind: "sub",
    file: CONTRACTS_CONFIG_INDEX,
    find: `  FeatureMagicContext: "features.magicContext",\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: CONTRACTS_CONFIG_INDEX,
    find:
      "  // Magic Context 参数域（D-12 配置真源 ~/.omz/cli/config.json 顶层 `magicContext`）\n" +
      `  MagicContext: "magicContext",\n\n`,
    replace: ``,
  },
  {
    kind: "del",
    file: CONTRACTS_CONFIG_INDEX,
    start: ` * FORK（S23 / D-12）：\`"magicContext"\` 走的就是链尾兜底 \`unknown\`——它曾有一个`,
    end: ` * 于是「进入 ConfigPort 的值一定已通过 schema」成为运行时不变量而非类型保证。`,
  },
  {
    kind: "sub",
    file: CONTRACTS_CONFIG_INDEX,
    find: ` * 每个 key 的值类型；链尾的兜底是 \`unknown\`。\n *\n */`,
    replace: ` * 每个 key 的值类型；链尾的兜底是 \`unknown\`。\n */`,
  },
  {
    kind: "sub",
    file: CONTRACTS_CONFIG_INDEX,
    find: `                  | "features.magicContext"\n`,
    replace: ``,
  },
  {
    kind: "del",
    file: CONTRACTS_CONFIG_INDEX,
    start: `// \`"magicContext"\` 曾在这里占一个恒等分支（\`K extends "magicContext" ? unknown : unknown\`）。`,
    end: `type _MagicContextConfigKeyAnchor = typeof _;`,
  },
  {
    kind: "sub",
    file: CONTRACTS_CONFIG_INDEX,
    find: `    magicContext: boolean;\n  };\n  memory: {`,
    replace: `  };\n  memory: {`,
  },
  {
    kind: "sub",
    file: CONTRACTS_CONFIG_INDEX,
    find:
      "  /**\n" +
      "   * FORK（S23 / D-12）：magic-context 参数域。承载类型 `unknown` 的理由与\n" +
      '   * `ConfigValue<"magicContext">` 分支同源（见上方注释）：唯一权威结构是包内\n' +
      "   * `MagicContextConfig`，这里只声明「这个域存在」。\n" +
      "   *\n" +
      "   * 缺席（undefined）表示配置文件没写过这个域，消费侧应回落到\n" +
      "   * `DEFAULT_MAGIC_CONTEXT_CONFIG`（由 adapters 的 `getDefaultValue()` 登记）。\n" +
      "   */\n" +
      "  magicContext?: unknown;\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: CONTRACTS_CONFIG_INDEX,
    find: `  /** FORK（S23 / D-12）：见 \`RuntimeConfig.magicContext\` 的类型承载说明。 */\n  magicContext?: unknown;\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: CONTRACTS_CONFIG_INDEX,
    find: `    // D-11 收官：magicContext 随 MVP 验收（T-M1..T-M8）与「压缩移除全量回归」\n    // 一并通过，在 step 28 翻为默认开启。off 现在只表示「transform 直通、无预算\n    // 管理」这条用户显式退路（T-M8 语义），因此与邻居的 \`?? true\` 一致。\n    magicContext: true,\n`,
    replace: ``,
  },

  // ── contracts: 工具面导出 ────────────────────────────────────────────────
  {
    kind: "del",
    file: CONTRACTS_TOOLS_INDEX,
    start: `// magic-context 上下文回收面（S21）。名字常量被 core 的工具注册与 workflow-child`,
    end: `export * from "./ctx-context.js";`,
  },

  // ── adapters: config schema ───────────────────────────────────────────────
  {
    kind: "del",
    file: ADAPTERS_CONFIG_SCHEMA,
    start: ` * FORK（magic-context-decoupling / phase-zero-load / Step 5）：走**窄子路径**，`,
    end: `} from "@zcode/magic-context/host/config/schema";`,
  },
  {
    kind: "sub",
    file: ADAPTERS_CONFIG_SCHEMA,
    find: `import type { RuntimeConfigPatch } from "@zcode/contracts";\n/**\n\nconst stringRecordSchema`,
    replace: `import type { RuntimeConfigPatch } from "@zcode/contracts";\n\nconst stringRecordSchema`,
  },
  {
    kind: "sub",
    file: ADAPTERS_CONFIG_SCHEMA,
    find: `  magicContext: z.boolean().optional(),\n`,
    replace: ``,
  },
  {
    kind: "del",
    file: ADAPTERS_CONFIG_SCHEMA,
    start: ` * FORK（S23 / D-12）：\`magicContext\` 参数域**直接复用包内 schema**，`,
    end: `const magicContextDomainSchema = MagicContextConfigSchema.optional();`,
  },
  {
    kind: "sub",
    file: ADAPTERS_CONFIG_SCHEMA,
    find: `\n/**\n\nconst mcpServerBaseSchema`,
    replace: `\nconst mcpServerBaseSchema`,
  },
  {
    kind: "sub",
    file: ADAPTERS_CONFIG_SCHEMA,
    find: `    magicContext: magicContextDomainSchema,\n`,
    replace: ``,
  },
  {
    kind: "del",
    file: ADAPTERS_CONFIG_SCHEMA,
    start: `// FORK（S23 / D-12）：参数域的 schema / 默认值 / 类型原样转出，不在 adapters 侧`,
    end: `export { DEFAULT_MAGIC_CONTEXT_CONFIG, MagicContextConfigSchema, type MagicContextConfig };`,
  },
  {
    kind: "sub",
    file: ADAPTERS_CONFIG_SCHEMA,
    find: `  if (parsed.magicContext) config.magicContext = parsed.magicContext;\n`,
    replace: ``,
  },

  // ── adapters: ConfigPort 读写 ─────────────────────────────────────────────
  {
    kind: "sub",
    file: ADAPTERS_CONFIG_INDEX,
    find: `import { DEFAULT_MAGIC_CONTEXT_CONFIG } from "./schema.js";\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: ADAPTERS_CONFIG_INDEX,
    find: `      if (config.features.magicContext !== undefined)\n        this.set(ConfigKey.FeatureMagicContext, config.features.magicContext, scope);\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: ADAPTERS_CONFIG_INDEX,
    find:
      "    // FORK（S23 / D-12）：参数域整域透传，不做逐字段 merge。写进 ConfigPort 的值\n" +
      "    // 必然已通过 `MagicContextConfigSchema`（config.json 装载与 RPC handler 两条入口\n" +
      "    // 都如此），因此永远是完整域——手写一层浅合并只会凭空造出「半配置」中间态。\n" +
      "    if (config.magicContext !== undefined) {\n" +
      "      this.set(ConfigKey.MagicContext, config.magicContext, scope);\n" +
      "    }\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: ADAPTERS_CONFIG_INDEX,
    find: `        // D-11 收官：MVP 验收与「压缩移除全量回归」通过后默认开启（step 28），\n        // 于是这里与邻居的 \`?? true\` 一致；off 是用户的显式退路，不是缺省态。\n        magicContext: this.store.get(ConfigKey.FeatureMagicContext) ?? true,\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: ADAPTERS_CONFIG_INDEX,
    find: `      // FORK（S23 / D-12）：缺席时给全默认域（而非 undefined），让消费侧\n      // （bootstrap 的 config bridge）永远拿到一个可校验的对象，不必自己再兜一层。\n      magicContext: this.store.get(ConfigKey.MagicContext) ?? DEFAULT_MAGIC_CONTEXT_CONFIG,\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: ADAPTERS_CONFIG_INDEX,
    find: `    case ConfigKey.FeatureMagicContext:\n      return defaults.features.magicContext;\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: ADAPTERS_CONFIG_INDEX,
    find:
      "    // FORK（S23 / D-12）：spec Step 23 写的是「若默认值全靠 zod `.default()` 则\n" +
      "    // 显式声明不登记」。这里选择**登记**，因为不登记会让 `ConfigPortImpl.get`\n" +
      "    // 抛 `Config key not found`——而这个域永远有值（缺席 = 全默认），\n" +
      "    // 抛错等于把「没配置」误报成「配置不存在」。登记的不是第二份默认值声明，\n" +
      "    // 只是把包内 schema 物化出的那个对象引过来。\n" +
      "    case ConfigKey.MagicContext:\n" +
      "      return DEFAULT_MAGIC_CONTEXT_CONFIG;\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: ADAPTERS_CONFIG_INDEX,
    find: `  updateMagicContextInFileConfig,\n  type MagicContextPatchResult,\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: ADAPTERS_CONFIG_INDEX,
    find: `  ZCodeConfigFileSchema,\n  MagicContextConfigSchema,\n  DEFAULT_MAGIC_CONTEXT_CONFIG,\n  type ZCodeConfigFile,\n  type MagicContextConfig,\n} from "./schema.js";`,
    replace: `  ZCodeConfigFileSchema,\n  type ZCodeConfigFile,\n} from "./schema.js";`,
  },

  // ── adapters: 写盘层 ─────────────────────────────────────────────────────
  {
    kind: "sub",
    file: ADAPTERS_FILE_CONFIG,
    find:
      "/**\n" +
      " * FORK（S23 / D-12）：`magicContext` 参数域写盘的结果。\n" +
      " *\n" +
      " * 只回报「写到了哪里」——域值由**协议层**统一回显（`workspace/updateMagicContextConfig`\n" +
      " * 的 result 带 `config` 字段，取自写盘之后的 `ConfigPort`），写盘层再回显一份就成了\n" +
      " * 第二份出口：两份出口迟早会分叉，而分叉的那份没人测。这里刻意只给 `path` + `changed`，\n" +
      " * 调用方要的「写成功 + 后续从 ConfigPort 读到的就是这个值」这条保证由协议层兑现。\n" +
      " */\n" +
      "export interface MagicContextPatchResult {\n" +
      "  path: string;\n" +
      "  /** 是否真的改动了文件内容（幂等重写返回 false）。 */\n" +
      "  changed: boolean;\n" +
      "}\n\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: ADAPTERS_FILE_CONFIG,
    find:
      "/**\n" +
      " * FORK（prompt-language-option）：`promptLanguage` 顶层字段写盘的结果。\n" +
      " *\n" +
      " * 与 `MagicContextPatchResult` 同一形态：写盘层只回报「写到了哪里 + 写了什么」，\n" +
      " * effective 回显由协议层统一负责（见 magic-context-config.ts 的注释）。\n" +
      " */",
    replace:
      "/**\n" +
      " * FORK（prompt-language-option）：`promptLanguage` 顶层字段写盘的结果。\n" +
      " *\n" +
      " * 写盘层只回报「写到了哪里 + 写了什么」，effective 回显由协议层统一负责。\n" +
      " */",
  },
  {
    kind: "sub",
    file: ADAPTERS_FILE_CONFIG,
    find:
      "/**\n" +
      " * FORK（S23 / D-12）：把整个 `magicContext` 参数域写进用户级 config.json 顶层。\n" +
      " *\n" +
      " * 三点与 `updateUiLocaleInFileConfig` 刻意一致：走同一条 `atomicWriteJson`（临时文件\n" +
      " * + rename，避免半截文件被下一次 `loadFileConfig` 读成非法 JSON）、读改写保留其余\n" +
      " * 顶层键、不做任何项目级/环境级联写入。\n" +
      " *\n" +
      " * 与 locale 的两点差异：\n" +
      " *   1. **整域替换**而非单字段合并。locale 是 6 个标量之一，逐字段 merge 很便宜；\n" +
      " *      参数域是 zod 派生的 ~20 字段子树，在写盘层再实现一次 merge 就是把包内\n" +
      " *      `MagicContextConfigSchema` 的语义复制成第二份——漂移方向不可接受。调用方\n" +
      " *      （`workspace/updateMagicContextConfig` handler）必须先过 schema，schema 的\n" +
      " *      `.default()` 保证传进来的是完整域，整域替换因此无损。\n" +
      " *   2. **幂等短路**：内容相同就不写盘。参数域写盘发生在每次 UI 保存上，重写一个\n" +
      " *      字节没变的文件只会无谓地更新 mtime——而某些同步工具按 mtime 触发扫描。\n" +
      " *\n" +
      " * 未知键（如参考插件遗留的 `compaction`）随整域替换被清掉：`z.object` 在校验时已\n" +
      " * strip 它们，留着只会让「文件里有、运行时不认」持续误导读者。\n" +
      " */\n" +
      "export async function updateMagicContextInFileConfig(\n" +
      "  filePath: string,\n" +
      "  config: unknown,\n" +
      "): Promise<MagicContextPatchResult> {\n" +
      "  const resolvedPath = resolvePath(filePath);\n" +
      "  const parsed = await readJsonConfigFileOrEmpty(resolvedPath);\n" +
      "  const next = patchMagicContext(parsed, config);\n" +
      "  const changed = !isDeepEqualJson(parsed.magicContext, next.magicContext);\n" +
      "\n" +
      "  if (changed) {\n" +
      "    await atomicWriteJson(resolvedPath, next);\n" +
      "  }\n" +
      "  return {\n" +
      "    path: resolvedPath,\n" +
      "    changed,\n" +
      "  };\n" +
      "}\n" +
      "\n" +
      "function patchMagicContext(\n" +
      "  parsed: Record<string, unknown>,\n" +
      "  config: unknown,\n" +
      "): Record<string, unknown> {\n" +
      "  return {\n" +
      "    ...parsed,\n" +
      "    magicContext: config,\n" +
      "  };\n" +
      "}\n\n",
    replace: ``,
  },

  // ── core: 工具注册面（四个 ctx 工具 + prompt-surface 分档） ────────────────
  {
    kind: "sub",
    file: CORE_TOOL_HANDLERS,
    find: `  CTX_EXPAND_TOOL_NAME,\n  CTX_MEMORY_TOOL_NAME,\n  CTX_REDUCE_TOOL_NAME,\n  CTX_SEARCH_TOOL_NAME,\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: CORE_TOOL_HANDLERS,
    find:
      `import { ctxExpandToolEntry, ctxReduceToolEntry } from "./ctx-context.js";\n` +
      `import { ctxMemoryToolEntry } from "./ctx-memory.js";\n` +
      `import { ctxSearchToolEntry } from "./ctx-search.js";\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: CORE_TOOL_HANDLERS,
    find:
      "  // magic-context 上下文回收面（S21）。只有 `features.magicContext` 打开的会话才注册\n" +
      "  // （见 registerBuiltInTools 的 includeMagicContextTools 过滤）：默认态下模型看到的\n" +
      "  // 工具表里没有 ctx_*，而包也整棵没被 import。\n" +
      "  ctxReduceToolEntry,\n" +
      "  ctxExpandToolEntry,\n" +
      "  // magic-context 记忆面（Step 10：ctx_search=D4 检索 / ctx_memory=D14 写入）。\n" +
      "  // 与上面两个同门（includeMagicContextTools）：handler 都是动态 import 包的，\n" +
      "  // flag 关时整棵模块图不进内存。ctx_search 纯读记忆库，ctx_memory 写本项目\n" +
      "  // 记忆库一行（幂等，见 handler 注释）。\n" +
      "  ctxSearchToolEntry,\n" +
      "  ctxMemoryToolEntry,\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: CORE_TOOL_HANDLERS,
    find:
      "/**\n" +
      " * FORK（Step 14）：prompt-surface 分档只作用于这四个 ctx_* 工具——它们是 prompt-surface\n" +
      " * 唯一有 full/light 两份文案的工具族（`ACTIVE_TOOL_IDS` 的同族集合）。\n" +
      " * 用与注册过滤**同一个**常量集合而不是另写一份名单：漏一个名字意味着那个工具永远拿不到\n" +
      " * light 描述，而那种偏差在 prompt 面上是静默的。\n" +
      " */\n" +
      "const MAGIC_CONTEXT_PROMPT_SURFACE_TOOL_NAMES: ReadonlySet<string> = new Set([\n" +
      "  CTX_REDUCE_TOOL_NAME,\n" +
      "  CTX_EXPAND_TOOL_NAME,\n" +
      "  CTX_SEARCH_TOOL_NAME,\n" +
      "  CTX_MEMORY_TOOL_NAME,\n" +
      "]);\n\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: CORE_TOOL_HANDLERS,
    find:
      "  /**\n" +
      "   * magic-context 上下文回收面与记忆面（`ctx_reduce` / `ctx_expand` /\n" +
      "   * `ctx_search` / `ctx_memory`）是否注册。\n" +
      "   *\n" +
      "   * **跟随 `features.magicContext`**（step 28 起默认开），理由与 `includeNodeRepl`\n" +
      "   * 同款但更强一层：这四个工具的实现在 `@zcode/magic-context` 里（ctx_search /\n" +
      "   * ctx_memory 的薄封装在 core），而 handler 是**动态 import** 它的，所以 flag 关时\n" +
      "   * 包整棵不会被拉进内存（zod schema + sqlite chokepoint + 迁移模块）——用户显式\n" +
      "   * 关掉后，「零行为」这条不变式（今天记作 D-11）才仍然成立。\n" +
      "   *\n" +
      "   * 由 `runtime-tools.ts` 从 `RuntimeConfig.magicContext.enabled` 推导。\n" +
      "   */\n" +
      "  includeMagicContextTools?: boolean;\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: CORE_TOOL_HANDLERS,
    find:
      "  /**\n" +
      "   * FORK（bugfix-batch-20261011 / Step 14）：prompt-surface 的 preset 分档描述求值器。\n" +
      "   *\n" +
      "   * `prompt_surface.default` / `prompt_surface.models` 决定当前这届用 full 还是 light\n" +
      "   * 档 ctx_* 工具描述；light 档的紧凑文案在 `@zcode/magic-context` 的\n" +
      "   * `light-descriptions` 里（宿主不得自抄），因此这里收一个**求值器**而不是字面量表——\n" +
      "   * 由 bootstrap 侧（唯一 import 包的地方）把 `createPromptSurfaceRuntime().\n" +
      "   * resolveRegistration(config, modelKey).descriptionFor` 投影进来。\n" +
      "   *\n" +
      "   * 缺席 = 不换档，照原样注册 full 描述。求值器内部已经把「用户 tool_descriptions 覆盖\n" +
      "   * > light 目录 > full 原文」的优先级排好，注册侧不重复实现这套优先级。\n" +
      "   */\n" +
      "  magicContextToolDescription?: (input: {\n" +
      "    toolId: string;\n" +
      "    fullDescription: string;\n" +
      "    modelKey?: string;\n" +
      "  }) => string;\n" +
      "  /** preset 路由用的模型 key（`provider/model`）；缺席时只按 configured default 解析。 */\n" +
      "  magicContextModelKey?: string;\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: CORE_TOOL_HANDLERS,
    find:
      "    if (\n" +
      "      (entry.metadata.name === CTX_REDUCE_TOOL_NAME ||\n" +
      "        entry.metadata.name === CTX_EXPAND_TOOL_NAME ||\n" +
      "        entry.metadata.name === CTX_SEARCH_TOOL_NAME ||\n" +
      "        entry.metadata.name === CTX_MEMORY_TOOL_NAME) &&\n" +
      "      options.includeMagicContextTools !== true\n" +
      "    ) {\n" +
      "      continue;\n" +
      "    }\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: CORE_TOOL_HANDLERS,
    find:
      "  // FORK（Step 14）：ctx_* 四工具的 preset 分档。只换 `metadata.description`，参数\n" +
      "  // schema / 权限 / 预算 / 超时一律不动——分档是「同一份能力的详简叙述」，不是第二个工具。\n" +
      "  // 与 Agent/Task 的灰度门同款纪律：首次装配与分支刷新走同一个 options 推导，两次产出的\n" +
      "  // 描述必然一致（否则一次刷新就会把换档结果悄悄翻回 full）。\n" +
      "  if (\n" +
      "    MAGIC_CONTEXT_PROMPT_SURFACE_TOOL_NAMES.has(entry.metadata.name) &&\n" +
      "    options.magicContextToolDescription !== undefined\n" +
      "  ) {\n" +
      "    const fullDescription = entry.metadata.description;\n" +
      "    // 没有 description 的工具不参与分档：分档是「同一份文案的详简两版」，\n" +
      "    // 没有原文就无从简化，也不该凭空造一段。\n" +
      "    if (fullDescription === undefined) return entry;\n" +
      "    const description = options.magicContextToolDescription({\n" +
      "      toolId: entry.metadata.name,\n" +
      "      fullDescription,\n" +
      "      ...(options.magicContextModelKey === undefined\n" +
      "        ? {}\n" +
      "        : { modelKey: options.magicContextModelKey }),\n" +
      "    });\n" +
      "    if (description !== fullDescription) {\n" +
      "      return {\n" +
      "        ...entry,\n" +
      "        metadata: { ...entry.metadata, description },\n" +
      "      };\n" +
      "    }\n" +
      "  }\n",
    replace: ``,
  },

  // ── core: runtime-tools 注册选项推导 ──────────────────────────────────────
  {
    kind: "sub",
    file: CORE_RUNTIME_TOOLS,
    find:
      "import {\n" +
      "  CTX_EXPAND_TOOL_NAME,\n" +
      "  CTX_MEMORY_TOOL_NAME,\n" +
      "  CTX_REDUCE_TOOL_NAME,\n" +
      "  CTX_SEARCH_TOOL_NAME,\n" +
      '} from "@zcode/contracts";\n',
    replace: ``,
  },
  {
    kind: "sub",
    file: CORE_RUNTIME_TOOLS,
    find: `import { isMagicContextEffectiveByConfig } from "./magic-context-effective-enabled.js";\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: CORE_RUNTIME_TOOLS,
    find:
      "/** 见 `resolveRuntimeDisallowedToolsWithMagicContext` 的根因注释。 */\n" +
      "const MAGIC_CONTEXT_WORKFLOW_CHILD_DISALLOWED_TOOLS: readonly string[] = [\n" +
      "  CTX_REDUCE_TOOL_NAME,\n" +
      "  CTX_EXPAND_TOOL_NAME,\n" +
      "  // Step 10（D4/D14）同族加入。ctx_memory 是**跨会话持久写**：workflow child\n" +
      "  // 的工具交互只在 subagent 路径镜像到父会话，而一条记忆的影响远大于一次会话\n" +
      "  // （所有后续会话的 m0/m1 注入与 ctx_search 都会看见它），用户在父界面没有\n" +
      "  // 否决机会——与 ctx_reduce「盖章不可见」同属结构性禁用，不是权限档位问题。\n" +
      "  // ctx_search 读的是同一个 store，与 ctx_expand 同理禁掉。\n" +
      "  CTX_SEARCH_TOOL_NAME,\n" +
      "  CTX_MEMORY_TOOL_NAME,\n" +
      "];\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: CORE_RUNTIME_TOOLS,
    find:
      "/**\n" +
      " * FORK（bugfix-batch-20261011 / Step 14）：prompt-surface 分档描述的一组注册选项。\n" +
      " *\n" +
      " * 首次装配（{@link registerRuntimeBuiltInTools}）与分支刷新\n" +
      " * （`refreshBranchAwareBuiltInTools`，embedded-search 分支的第二个注册入口）**必须**拿到\n" +
      " * 同一个推导结果。后者只传一个精简选项集，漏传这一组的后果不是「保持原样」而是「把 light\n" +
      " * 档描述翻回 full」——registry.register 覆盖同名项且 silentDuplicateWarnings 吞告警，\n" +
      " * 全程无声。因此抽成这一个函数，两个入口各自调用。\n" +
      " *\n" +
      " * `modelKey` 取会话当前的模型选择：它是 preset 路由的输入（`prompt_surface.models` 的\n" +
      " * per-model 键）。缺席（还没有活模型 / 无选择）时求值器自己按 configured default 解析——\n" +
      " * 那是配置的事实，不是退化路径。\n" +
      " */\n" +
      "export function resolveMagicContextPromptSurfaceOptions(runtime: AgentRuntimeInternal): {\n" +
      '  magicContextToolDescription?: NonNullable<AgentRuntimeDeps["magicContextToolDescription"]>;\n' +
      "  magicContextModelKey?: string;\n" +
      "} {\n" +
      "  const describe = runtime.magicContextToolDescription;\n" +
      "  if (describe === undefined) return {};\n" +
      "  const selection = runtime.config.modelSelection;\n" +
      "  const modelKey =\n" +
      "    selection === undefined ? undefined : `${selection.providerId}/${selection.modelId}`;\n" +
      "  return {\n" +
      "    magicContextToolDescription: describe,\n" +
      "    ...(modelKey === undefined ? {} : { magicContextModelKey: modelKey }),\n" +
      "  };\n" +
      "}\n\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: CORE_RUNTIME_TOOLS,
    find:
      "    // magic-context 上下文回收面：门是 bootstrap 三轴求值后的冷值\n" +
      "    // （`features.magicContext` × 域值 × override），不是 `features.magicContext` 单轴。\n" +
      "    // ctx handler 是动态 import 包的，所以这道门同时决定了「模型看得见这两个工具吗」\n" +
      "    // 与「整棵 magic-context 模块图进不进内存」——见 handlers/index.ts 的注释。\n" +
      "    //\n" +
      "    // IM3：读的是 bootstrap 唯一口径算出的冷值，缺省方向（缺席按关，原 `=== true`）\n" +
      "    // 显式写在 whenUnset 上，见 `magic-context-effective-enabled.ts` 的真值表。\n" +
      "    includeMagicContextTools: isMagicContextEffectiveByConfig(\n" +
      "      runtime.config.magicContext?.enabled,\n" +
      "      { whenUnset: false },\n" +
      "    ),\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: CORE_RUNTIME_TOOLS,
    find: `    disallowedTools: resolveRuntimeDisallowedToolsWithMagicContext(runtime.config),\n`,
    replace: `    disallowedTools: resolveRuntimeDisallowedTools(runtime.config),\n`,
  },
  {
    kind: "sub",
    file: CORE_RUNTIME_TOOLS,
    find:
      "    // FORK（Step 14）：prompt-surface 分档描述。与 embedded-search 分支刷新共用同一个\n" +
      "    // 推导入口，见 resolveMagicContextPromptSurfaceOptions 的说明。\n" +
      "    ...resolveMagicContextPromptSurfaceOptions(runtime),\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: CORE_RUNTIME_TOOLS,
    find:
      "/**\n" +
      " * workflow_child 额外不注册四个 ctx 工具。\n" +
      " *\n" +
      " * 根因与 `WORKFLOW_CHILD_DISALLOWED_TOOLS` 的第一条同源，但更硬：child 的工具交互\n" +
      " * 事件只在 subagent 路径上镜像到父会话，一个 workflow child 在自己的会话里盖掉的\n" +
      " * §N§ 标记，父会话与用户**都看不到**——用户会以为那段上下文还在，而它已经被排队\n" +
      " * 清掉了。这不是「无窗可弹」，是「用户失去了否决的机会」，因此属于**结构性禁用**\n" +
      " * 而不是权限档位问题。\n" +
      " *\n" +
      " * `ctx_expand` 也一并禁掉：它读的是同一个 store，读到被别的 actor 盖掉的 tag 只会\n" +
      " * 让 child 拿到一份用户没批准过的视图。\n" +
      " *\n" +
      " * Step 10 起 `ctx_search` / `ctx_memory` 同族入列：前者读同一个记忆 store（同\n" +
      " * ctx_expand 理由），后者是跨会话持久写——一条从 child 钉进去的记忆会影响之后\n" +
      " * **所有**会话的注入与检索，比一次盖章的可见性缺口更大（见常量处的展开注释）。\n" +
      " *\n" +
      " * 这份追加刻意留在本文件而不是 `tool-allowlist.ts`：`resolveRuntimeDisallowedTools`\n" +
      " * 是两个 child runtime 构造点共用的推导入口，而 ctx 这道门只跟「magic-context 开着」\n" +
      " * 这件事有关，与 workflow child 的构造点无关。\n" +
      " */\n" +
      "function resolveRuntimeDisallowedToolsWithMagicContext(\n" +
      "  config: AgentRuntimeConfig,\n" +
      "): readonly string[] | undefined {\n" +
      "  const base = resolveRuntimeDisallowedTools(config);\n" +
      '  if (config.taskType !== "workflow_child") return base;\n' +
      "  const disallowed = new Set(base ?? []);\n" +
      "  for (const toolName of MAGIC_CONTEXT_WORKFLOW_CHILD_DISALLOWED_TOOLS) {\n" +
      "    disallowed.add(toolName);\n" +
      "  }\n" +
      "  return [...disallowed];\n" +
      "}\n\n",
    replace: ``,
  },

  // ── core: 分支刷新的第二个注册入口 ────────────────────────────────────────
  {
    kind: "sub",
    file: CORE_EMBEDDED_SEARCH_BRANCH,
    find: `import { resolveMagicContextPromptSurfaceOptions } from "../helpers/runtime-tools.js";\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: CORE_EMBEDDED_SEARCH_BRANCH,
    find:
      "    // FORK（Step 14）：prompt-surface 分档描述必须与首次装配同源。这里用的是同一个\n" +
      "    // helper（runtime-tools.ts 的 resolveMagicContextPromptSurfaceOptions），因为本函数\n" +
      "    // 是**第二个**注册入口且只传精简选项集——漏传不会「保持原样」，而会把 light 档描述\n" +
      "    // 静默翻回 full。\n" +
      "    ...resolveMagicContextPromptSurfaceOptions(runtime),\n",
    replace: ``,
  },
  // ── core: 段端口的 ctx_reduce 可调性判据（工具已摘除 → 恒 false） ─────────
  {
    kind: "sub",
    file: CORE_MC_PROMPT_SECTION,
    find: `import { CTX_REDUCE_TOOL_NAME } from "@zcode/contracts";\n\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: CORE_MC_PROMPT_SECTION,
    find: `    ctxReduceCallable: runtime.getTools(model).some((tool) => tool.name === CTX_REDUCE_TOOL_NAME),\n`,
    replace: `    ctxReduceCallable: false,\n`,
  },
  // ── bootstrap: create-app 装配面 ─────────────────────────────────────────
  {
    kind: "sub",
    file: BOOTSTRAP_CREATE_APP,
    find: `import { emitMagicContextTransformAbsent } from "./magic-context-absent-event.js";\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: BOOTSTRAP_CREATE_APP,
    find: `import { projectMagicContextEffectiveEnabled } from "./magic-context/effective-enabled.js";\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: BOOTSTRAP_CREATE_APP,
    find:
      "/**\n" +
      " * FORK（S24）：把 magic-context 的 usage recorder 挂进事件扇出。\n" +
      " *\n" +
      " * `model_complete` 是主会话每一次 provider 请求的 usage 落点。**只认\n" +
      ' * `querySource === "main_turn"`**：标题生成、压缩摘要、子代理与工具内部的模型调用\n' +
      " * 也发这个事件，而它们不是用户可见的上下文——混进来会把上下文占比算成「一个几百\n" +
      " * token 的侧车请求」，transform 于是永远看不到压力。这条判据与\n" +
      " * `event-reducer.ts` 的 `shouldModelCompleteUpdateContextUsed` 是同一条，不在这里\n" +
      " * 另立一套。\n" +
      " *\n" +
      " * recorder 缺席（flag off，用户显式关掉）时**原样返回下游 sink**，不产生任何包装；\n" +
      " * recorder 在场而下游没有 sink 时**仍然造一个**——headless CLI 根本没有下游 sink，\n" +
      " * 而 usage 是 transform 的压力输入，不是可选的诊断。\n" +
      " */\n" +
      "function composeMagicContextUsageSink(\n" +
      "  sink: SessionEventSink | undefined,\n" +
      "  recorder: { record: (input: { at?: number; usage: ModelUsage }) => void } | undefined,\n" +
      "): SessionEventSink | undefined {\n" +
      "  if (!recorder) return sink;\n" +
      "  return {\n" +
      "    async onSessionEvent(event) {\n" +
      "      try {\n" +
      "        if (\n" +
      "          event.type === SessionEventType.ModelComplete &&\n" +
      '          (event.payload as { querySource?: string } | undefined)?.querySource === "main_turn"\n' +
      "        ) {\n" +
      "          recorder.record({\n" +
      "            at: new Date(event.timestamp).getTime(),\n" +
      "            usage: (event.payload as { usage?: ModelUsage }).usage as ModelUsage,\n" +
      "          });\n" +
      "        }\n" +
      "      } catch {\n" +
      "        // 诊断面绝不能把一次已处理的事件变成一次失败投递。\n" +
      "      }\n" +
      "      return sink?.onSessionEvent(event);\n" +
      "    },\n" +
      "  };\n" +
      "}\n\n",
    replace: ``,
  },
  {
    kind: "del",
    file: BOOTSTRAP_CREATE_APP,
    start: `    // Step 19b：\`features.magicContext\` 关闭时，本行连 \`import()\` 都不发生——于是`,
    end: `    const magicContextTurnTransform = magicContextPlugin?.turnTransform;`,
  },
  {
    kind: "sub",
    file: BOOTSTRAP_CREATE_APP,
    find: `    });\n    runtime = new AgentRuntime(`,
    replace: `    });\n\n    runtime = new AgentRuntime(`,
  },
  {
    kind: "sub",
    file: BOOTSTRAP_CREATE_APP,
    find:
      "      // FORK（S24）：把 recorder 挂进事件扇出。`model_complete` 是主会话每一次\n" +
      '      // provider 请求的 usage 落点（`querySource === "main_turn"` 才是主会话；\n' +
      "      // 标题生成/压缩/子代理的模型调用也会发这个事件，它们不是用户可见的上下文，\n" +
      '      // 混进来会把占比算成"侧车小请求"——与 event-reducer 的同一条判据）。\n' +
      "      eventSink: composeMagicContextUsageSink(options.eventSink, magicContextUsageRecorder),\n",
    replace: `      eventSink: options.eventSink,\n`,
  },
  {
    kind: "sub",
    file: BOOTSTRAP_CREATE_APP,
    find:
      "      // 端口在场即注册门：缺席（默认）时 turn-loop 的插入点是纯判空。\n" +
      "      ...(magicContextTurnTransform === undefined ? {} : { magicContextTurnTransform }),\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: BOOTSTRAP_CREATE_APP,
    find:
      "      // FORK（bugfix-batch-20261011 / Step 13，D1）：`## Magic Context` agent 提示词段\n" +
      "      // 的装配端口。与 turn transform 同一个门（插件在场即 `features.magicContext`\n" +
      "      // 开着），同一个动态 import 唯一的消费点——core 的 context builder 是同步的且\n" +
      "      // 不许静态 import 包，所以 11 参装配只能由这里做。\n" +
      "      // 缺席时 context builder 回落原生 `# Memory` 段（互斥裁定，\n" +
      "      // 见 core `context/sections/magic-context.ts`）。\n" +
      "      //\n" +
      "      // Step 4：两个 resolver 由插件用**同一份** `configPort` / `configDomain` /\n" +
      "      // `logger` 构造并返回（此前是这里各调一次同名工厂，参数逐字相同）。\n" +
      "      // FORK（bugfix-batch-20261011 / Step 14）：`magicContextToolDescription` 是\n" +
      "      // preset 分档描述求值器——设置页的 `prompt_surface.default` / `models` 经它\n" +
      "      // 第一次真正影响模型看得见的工具描述（light 档换紧凑文案）；在那之前这两个\n" +
      "      // 字段写下去没有任何运行期消费者。\n" +
      "      ...(magicContextPlugin === undefined\n" +
      "        ? {}\n" +
      "        : {\n" +
      "            magicContextPromptSection: magicContextPlugin.promptSection,\n" +
      "            magicContextToolDescription: magicContextPlugin.toolDescription,\n" +
      "          }),\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: BOOTSTRAP_CREATE_APP,
    find:
      "      // App 关闭时收口 magic-context（drain → shutdown → bridge.dispose）。参照上面\n" +
      "      // `closeDynamicWorkflowRuns` 的注入范式；缺席即本装配没有 magic-context。\n" +
      "      ...(closeMagicContext === undefined ? {} : { closeMagicContext }),\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: BOOTSTRAP_CREATE_APP,
    find:
      "      // FORK（spec phase-compartment-rewind / C1）：rewind → compartment 失效的\n" +
      "      // 可选端口。插件在场（DB 真的开出来了）才挂；缺席即「本 App 没有可失效的\n" +
      "      // magic-context 库」，调用方按可选方法跳过。闭包由插件在构造期回填，不在这里\n" +
      "      // 另造实现（水位换算归包 + 工厂持有的 db/sessionStore）。\n" +
      "      ...(magicContextPlugin?.invalidateCompartments === undefined\n" +
      "        ? {}\n" +
      "        : { invalidateMagicContextCompartments: magicContextPlugin.invalidateCompartments }),\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: BOOTSTRAP_CREATE_APP,
    find:
      "      // FORK（S23 / D-12）：`workspace/updateMagicContextConfig` 把参数域写进内存\n" +
      "      // 侧的唯一入口必须是**本 App 正在用的** ConfigPort——magic-context 的 config\n" +
      "      // bridge 订阅的就是它（见 magic-context-turn-transform.ts）。\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: BOOTSTRAP_CREATE_APP,
    find:
      "      // FORK（MF-06）：命令面读同一个 effective 开关，与 turn-loop 的门**同源同值**\n" +
      "      // ——都来自 `runtimeConfig.magicContext.enabled` 那一次求值（MF-01 算出来的\n" +
      "      // 那个）。`/ctx-*` 消费它来决定要不要开库，不再自行读 `features`。\n" +
      "      isMagicContextEnabled: () => magicContextEffectiveEnabled,\n",
    replace: ``,
  },

  // ── bootstrap: app/types.ts ─────────────────────────────────────────────
  {
    kind: "sub",
    file: BOOTSTRAP_APP_TYPES,
    find:
      "import type {\n" +
      "  SessionMagicContextUsage,\n" +
      "  WorkspaceHookReviewDecision,\n" +
      "  WorkspaceHookTrustRevokeTarget,\n" +
      '} from "@zcode/shared/zcode-protocol-v4";',
    replace:
      "import type {\n" +
      "  WorkspaceHookReviewDecision,\n" +
      "  WorkspaceHookTrustRevokeTarget,\n" +
      '} from "@zcode/shared/zcode-protocol-v4";',
  },
  {
    kind: "sub",
    file: BOOTSTRAP_APP_TYPES,
    find:
      "  /**\n" +
      "   * FORK（D-13）：magic-context 预算摘要的出口。由协议宿主注入，接到 v4 gateway 的\n" +
      "   * `updateMagicContextUsage` → `snapshot.usage.magicContext` → 桌面 ChatContextUsage 面板。\n" +
      "   *\n" +
      "   * **缺席 = 不推送**（CLI/TUI 前端没有 snapshot 投影层）。传 `null` 表示「这次读不到」，\n" +
      "   * 投影层据此删掉该键，面板整段收起。\n" +
      "   */\n" +
      "  onMagicContextUsage?: (usage: SessionMagicContextUsage | null) => void;\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: BOOTSTRAP_APP_TYPES,
    find:
      "  /**\n" +
      "   * FORK（spec phase-compartment-rewind / C1）：rewind 之后让 magic-context 里被裁\n" +
      "   * 轮次的 compartment 摘要失效（DB 按水位标记 + 清持久/进程内缓存）。\n" +
      "   *\n" +
      "   * **可选 = 能力之门**：flag 关、MC 包缺失或 DB 开不出来时本键不存在，调用方\n" +
      "   * （v4 `fork-edit-retry.ts`）按可选方法跳过——绝不在这里塞一个空实现，那会让\n" +
      "   * 「有没有真的失效」在两处各有说法。\n" +
      "   *\n" +
      "   * 语义：内部已把失败收成 warn（rewind 已提交，不因收尾失败把命令判失败）；读侧\n" +
      "   * （`inject-compartments.ts`）另有 water-level 过滤 + refused 掐块两道独立闸。\n" +
      "   */\n" +
      "  invalidateMagicContextCompartments?(input: {\n" +
      "    /** 被裁掉的第一条消息（`ConversationRewindResult.targetMessageId`）。 */\n" +
      "    anchorMessageId: string;\n" +
      "    /** rewind 结果里的保留条数：持久序换算不出来时的兜底水位。 */\n" +
      "    keptMessageCount: number;\n" +
      "  }): Promise<void>;\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: BOOTSTRAP_APP_TYPES,
    find:
      "  /**\n" +
      "   * FORK（MF-01 / MF-06）：本 App 的 magic-context **effective 开关**。\n" +
      "   *\n" +
      "   * 值就是 `runtimeConfig.magicContext.enabled` 那一次求值的结果\n" +
      "   * （契约 8：`features.magicContext && magicContext.enabled`），由 `create-app`\n" +
      "   * 填充。命令面（`/ctx-status` / `/ctx-reduce` / …）**必须**经这一条读，不能自己\n" +
      "   * 去读 `features` 或重算一遍——否则 features=true 而 `enabled=false` 时，命令面\n" +
      "   * 与 turn-loop 会分叉：一边开库出报告，一边根本不插桩。\n" +
      "   *\n" +
      "   * 可选而非必需：与 `getConfigPort` 同理，测试与轻量 embedder 可以不实现。\n" +
      "   */\n" +
      "  isMagicContextEnabled?(): boolean;\n",
    replace: ``,
  },

  // ── bootstrap: runtime-config.ts ────────────────────────────────────────
  {
    kind: "sub",
    file: BOOTSTRAP_RUNTIME_CONFIG,
    find: `import { resolveMagicContextEffectiveEnabled } from "./magic-context/effective-enabled.js";\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: BOOTSTRAP_RUNTIME_CONFIG,
    find:
      "    // Step 19b 门控：`features.magicContext`（S19a 落地的 kill switch，step 28 起\n" +
      "    // 默认 true）投影进 runtime config。core 的 turn-loop 只读这一位做二次门控，\n" +
      "    // 真正的注册门是装配层——它在 false 时连 transform 实例都不构造（用户显式\n" +
      "    // 关闭时的零成本态，T-M8 语义）。\n" +
      "    //\n" +
      "    // FORK（MF-01）：这里补上 spec 契约 8 的另一半——`effective = features.magicContext\n" +
      "    // && magicContext.enabled`。之前只镜像 features flag，于是 D-12 设置页把\n" +
      "    // `enabled` 当表单字段提交时「保存成功」而行为逐行不变。域值缺席时按包内\n" +
      "    // schema 的缺省 true 处理（`enabled: z.boolean().default(true)`）。\n" +
      "    //\n" +
      "    // 这是**冷**求值：结果冻结进 runtime.config。运行中改 `enabled` 走端口上的\n" +
      "    // 活值谓词 `isEnabled()`（core 每 turn 现读），见 core\n" +
      "    // `runtime/helpers/magic-context-turn-transform.ts` 与 bootstrap\n" +
      "    // `magic-context-turn-transform.ts`。\n" +
      "    magicContext: {\n" +
      "      // 唯一口径见 `app/magic-context/effective-enabled.ts`（契约 8）；这里只做冷求值。\n" +
      "      enabled: resolveMagicContextEffectiveEnabled({\n" +
      "        featureFlag: configResult.config.features.magicContext,\n" +
      "        ...(options.runtimeConfig?.magicContext?.enabled === undefined\n" +
      "          ? {}\n" +
      "          : { overrideEnabled: options.runtimeConfig.magicContext.enabled }),\n" +
      "        // 配置契约层把参数域收敛成不透明对象（`create-app.ts` 侧同样靠断言读它），\n" +
      "        // 这里只需要 `enabled` 那一位。\n" +
      "        domainEnabled: (configResult.config as { magicContext?: { enabled?: boolean } }).magicContext\n" +
      "          ?.enabled,\n" +
      "      }),\n" +
      "    },\n",
    replace: ``,
  },

  // ── bootstrap: zcode-protocol/server.ts ─────────────────────────────────
  {
    kind: "sub",
    file: BOOTSTRAP_PROTOCOL_SERVER,
    find:
      `import { readMagicContextConfig, updateMagicContextConfig } from "./magic-context-config.js";\n` +
      "// FORK（magic-context-memory-management / 变更点 7 · Step 6）：设置页「记忆」分区的\n" +
      "// 管理面板数据面（列表 / 批量废弃）。\n" +
      "import {\n" +
      "  archiveMagicContextMemories,\n" +
      "  listMagicContextMemories,\n" +
      '} from "./magic-context-memories.js";\n',
    replace: ``,
  },
  {
    kind: "sub",
    file: BOOTSTRAP_PROTOCOL_SERVER,
    find:
      "      // FORK（S23 / D-12）：写盘 + ConfigPort 内存双写；推送由 observe 扇出，不在此层。\n" +
      "      case zcodeProtocolMethods.workspaceUpdateMagicContextConfig:\n" +
      "        return await updateMagicContextConfig(this.context, request.params);\n" +
      "      // FORK（Step 29 / D-12）：设置的表单初值。放在 update 旁边而不是独立文件，\n" +
      "      // 因为它与 update 共用同一个 ConfigPort 读取约定与同一个 schema 对象。\n" +
      "      case zcodeProtocolMethods.workspaceReadMagicContextConfig:\n" +
      "        return await readMagicContextConfig(this.context, request.params);\n" +
      "      // FORK（magic-context-memory-management / Step 6）：设置页「记忆」分区的管理\n" +
      "      // 面板数据面。list 的降级（disabled/unavailable）在 handler 内收敛成\n" +
      "      // available:false 信封；archive 的错误（authority/BUSY）走本层统一错误响应。\n" +
      "      case zcodeProtocolMethods.workspaceListMagicContextMemories:\n" +
      "        return await listMagicContextMemories(this.context, request.params);\n" +
      "      case zcodeProtocolMethods.workspaceArchiveMagicContextMemories:\n" +
      "        return await archiveMagicContextMemories(this.context, request.params);\n",
    replace: ``,
  },

  // ── bootstrap: session-facade.ts ────────────────────────────────────────
  {
    kind: "sub",
    file: BOOTSTRAP_SESSION_FACADE,
    find:
      "  /**\n" +
      "   * FORK（MF-05）：收口 magic-context 装配层。缺席即本装配没装 magic-context\n" +
      "   * （features/`enabled` 为关、单测装配）。\n" +
      "   *\n" +
      "   * 钩子内部按 drain → shutdown → bridge.dispose 顺序做完三件事：\n" +
      "   * 有界 drain 在飞的后台 pass、停调度并 abort 在飞的 sidecar 请求、退掉 config\n" +
      "   * bridge 对 `ConfigPort` 的订阅。\n" +
      "   *\n" +
      "   * 调用位置被两个约束夹住：在 `beginShutdown()` **之后**（关闭中的会话不该再被新\n" +
      "   * pass 叫醒），在 `closeSessionResources` **之前**（historian 的在飞请求要写库，\n" +
      "   * store / execution port 一旦先关，写库就落在已关闭的端口上）。\n" +
      "   */\n" +
      "  closeMagicContext?: () => Promise<void>;\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: BOOTSTRAP_SESSION_FACADE,
    find:
      "        // FORK（MF-05）：magic-context 先收口。位置在 dwf 与资源关闭**之前**——\n" +
      "        // historian 的在飞请求要写库，store / execution port 一旦先关，写库就落在已\n" +
      "        // 关闭的端口上；而在 `beginShutdown()` 之后，它也不会再被新的 pass 叫醒。\n" +
      "        //\n" +
      "        // 整段套 try/catch + logger.warn：historian 关闭抛错绝不能吃掉后面的资源关闭。\n" +
      "        if (deps.closeMagicContext !== undefined) {\n" +
      "          try {\n" +
      "            await deps.closeMagicContext();\n" +
      "          } catch (error: unknown) {\n" +
      "            deps.logger.warn?.(\n" +
      '              "Closing magic context historian failed; continuing to close resources",\n' +
      "              {\n" +
      "                errorMessage: error instanceof Error ? error.message : String(error),\n" +
      '                event: "magic_context.historian_close_failed",\n' +
      '                module: "bootstrap.app",\n' +
      "              },\n" +
      "            );\n" +
      "          }\n" +
      "        }\n",
    replace: ``,
  },

  // ── bootstrap: workspace-model-runtime.ts（D-13 出口） ────────────────────
  {
    kind: "sub",
    file: BOOTSTRAP_WORKSPACE_MODEL_RUNTIME,
    find: `import type { SessionMagicContextUsage } from "@zcode/shared/zcode-protocol-v4";\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: BOOTSTRAP_WORKSPACE_MODEL_RUNTIME,
    find:
      "    // FORK（D-13）：magic-context 的预算摘要 side state 出口。App 侧每轮 pass /\n" +
      "    // 每次 provider usage 落库后读一次 `magic-context.db` 并推过来，这里接到 v4\n" +
      "    // gateway 的投影层。`sessionId` 缺席的临时 App（模型连通性探测）不装这条——\n" +
      "    // 它没有会话 topic，gateway 侧本就按「publisher 不在就丢弃」处理。\n" +
      "    ...(sessionId === undefined\n" +
      "      ? {}\n" +
      "      : {\n" +
      "          onMagicContextUsage: (usage: SessionMagicContextUsage | null) =>\n" +
      "            context.v4Gateway?.updateMagicContextUsage(sessionId, usage),\n" +
      "        }),\n",
    replace: ``,
  },

  // ── bootstrap: 斜杠命令面 ────────────────────────────────────────────────
  {
    kind: "sub",
    file: BOOTSTRAP_SLASH_COMMAND_SURFACE,
    find:
      " *\n" +
      " * `ctx-*` 四条排在 `init` 之后：它们是 magic-context 的上下文控制面，靠后免得挤在\n" +
      " * 「开启一段工作」的入口前面。\n",
    replace: "",
  },
  {
    kind: "sub",
    file: BOOTSTRAP_SLASH_COMMAND_SURFACE,
    find: `  "init",\n  "ctx-status",\n  "ctx-reduce",\n  "ctx-expand",\n  "ctx-recomp",\n`,
    replace: `  "init",\n`,
  },
  {
    kind: "sub",
    file: BOOTSTRAP_SLASH_COMMAND_SURFACE,
    find:
      "/**\n" +
      " * magic-context 的控制命令（Step 22）。\n" +
      " *\n" +
      " * 这四个名字在 `BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES` 里有条目，因此已经被\n" +
      " * `RESERVED_SLASH_COMMAND_NAMES` 收进去（用户/插件的同名自定义命令不会漏回来）。\n" +
      " * 它们同时进了 `APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES`，所以这份名单在这里\n" +
      " * 只是**显式复述**一个事实，而不是把它们排除在外：\n" +
      " *\n" +
      " *   - 两个执行面各有各的派发路径，但语义只有一份（`bootstrap/src/ctx-commands`）：\n" +
      " *     CLI TUI 由 `cli/src/command-center/handlers/ctx.ts` 就地消费；桌面 App 由\n" +
      " *     `zcode-protocol-v4/commands/handlers/ctx.ts` 经 v4 命令通道消费，结果回在 ACK 的\n" +
      " *     `ctxCommand.response` 里。**两条路径都不经过 prompt 解析**，因此命令原文不会被\n" +
      " *     转发给模型。\n" +
      " *   - 保留名单仍然必要：没有它，用户在 `.zcode/commands/` 里写一个 `ctx-status.md`\n" +
      " *     会抢走这个名字，让上面两条本地语义静默失效。\n" +
      " *\n" +
      " * 保留名单与「可见目录」是两份互不干涉的清单：删掉这份名单不会让命令重新出现在 `/`\n" +
      " * 面板，但会让自定义命令重新抢名。\n" +
      " */\n" +
      "const MAGIC_CONTEXT_LOCAL_SLASH_COMMAND_NAMES = [\n" +
      '  "ctx-status",\n' +
      '  "ctx-reduce",\n' +
      '  "ctx-expand",\n' +
      '  "ctx-recomp",\n' +
      "] as const;\n\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: BOOTSTRAP_SLASH_COMMAND_SURFACE,
    find:
      "const EXTRA_RESERVED_SLASH_COMMAND_NAMES = [\n" +
      '  "plan",\n' +
      "  // 本地命令不在 App 目录里，但要占住名字（见上方注释）。\n" +
      "  ...MAGIC_CONTEXT_LOCAL_SLASH_COMMAND_NAMES,\n" +
      "] as const;\n",
    replace: `const EXTRA_RESERVED_SLASH_COMMAND_NAMES = ["plan"] as const;\n`,
  },

  // ── bootstrap: v4 命令面 ────────────────────────────────────────────────
  {
    kind: "sub",
    file: BOOTSTRAP_V4_HANDLERS_INDEX,
    find: `import { ctxHandlers } from "./ctx.js";\n`,
    replace: ``,
  },
  { kind: "sub", file: BOOTSTRAP_V4_HANDLERS_INDEX, find: `  ...ctxHandlers,\n`, replace: `` },
  {
    kind: "sub",
    file: BOOTSTRAP_V4_HANDLERS_INDEX,
    find: `// goal / ctx / model-config / interaction-background / fork-edit-retry。`,
    replace: `// goal / model-config / interaction-background / fork-edit-retry。`,
  },
  {
    kind: "sub",
    file: BOOTSTRAP_V4_EXECUTOR,
    find:
      "  // magic-context 控制面同样按「操作会话自身状态」处理：副屏是一次性的选区问答，\n" +
      "  // 它没有独立的 magic-context 会话归属，`/ctx-reduce` 写进去的 pending_ops 会归错会话。\n" +
      '  "ctxStatus",\n' +
      '  "ctxReduce",\n' +
      '  "ctxExpand",\n' +
      '  "ctxRecomp",\n',
    replace: ``,
  },
  {
    kind: "sub",
    file: BOOTSTRAP_V4_FORK_EDIT_RETRY,
    find:
      "  // FORK（spec phase-compartment-rewind / C1）：rewind 之后让 magic-context 里被裁\n" +
      "  // 轮次的 compartment 摘要失效——旧摘要活在 M0 的 `<session-history>`，只要库还在\n" +
      "  // 就会照旧注入，模型因此看得见用户已经撤回的对话。\n" +
      "  //\n" +
      "  // 只挂**可选**调用：flag 关 / DB 开不出来时通道不存在，跳过即可（不塞空实现，\n" +
      "  // 见 `ZCodeApp.invalidateMagicContextCompartments` 的契约）。调用点放在 rewind\n" +
      "  // 成功之后、重发新文本之前——那一轮 transform 才会读到清理后的状态。\n" +
      "  await record.app.invalidateMagicContextCompartments?.({\n" +
      "    anchorMessageId: result.targetMessageId,\n" +
      "    keptMessageCount: result.keptMessageCount,\n" +
      "  });\n",
    replace: ``,
  },

  // ── bootstrap: v4 可用性投影 ────────────────────────────────────────────
  {
    kind: "sub",
    file: BOOTSTRAP_V4_PROJECTION_STATE,
    find:
      "    // `/ctx-*` 与 goal 状态无关，也不受 phase 影响（它们就地执行，不起 turn、不入队）。\n" +
      "    // magicContext.enabled 的判定刻意留在命令内部：那边回的是与 CLI/TUI 逐字相同的\n" +
      "    // UNAVAILABLE 文案，在这里藏能力只会制造客户端间的行为分叉。\n" +
      "    ctxStatus: ALLOWED,\n" +
      "    ctxReduce: ALLOWED,\n" +
      "    ctxExpand: ALLOWED,\n" +
      "    ctxRecomp: ALLOWED,\n",
    replace: ``,
  },

  // ── cli: 命令中心 ───────────────────────────────────────────────────────
  {
    kind: "sub",
    file: CLI_COMMAND_CENTER_CREATE,
    find: `import { handleCtxCommand, type CtxCommandName } from "./handlers/ctx.js";\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: CLI_COMMAND_CENTER_CREATE,
    find:
      "      // magic-context 本地控制命令（S22）。它们就地执行、只回文本，**不**走\n" +
      "      // submitPrompt——这正是本 fork 替代上游 Effect 204 sentinel 的地方：命令在\n" +
      "      // command-center 里就被消费，压根不存在「被转发给 LLM」这条路径。\n" +
      "      if (\n" +
      '        command.name === "ctx-status" ||\n' +
      '        command.name === "ctx-reduce" ||\n' +
      '        command.name === "ctx-expand" ||\n' +
      '        command.name === "ctx-recomp"\n' +
      "      ) {\n" +
      "        return handleCtxCommand(command.name as CtxCommandName, command.args, deps);\n" +
      "      }\n\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: CLI_COMMAND_CENTER_SLASH_COMMANDS,
    find:
      "  // magic-context 的四个本地控制命令（S22）。它们**不**发模型提示，由\n" +
      "  // `handlers/ctx.ts` 就地执行：/ctx-status 读一份文本快照，/ctx-reduce 与\n" +
      "  // /ctx-expand 走工具同一条路径，/ctx-recomp 触发一次 compartment 重算。\n" +
      "  // 上游把这四个名字挂在一个「内部 Effect 返回 204」的哨兵上，由 hook 拦截以阻止\n" +
      "  // 命令被转发给 LLM；ZCode 侧不需要那套机制——命令在 command-center 里就被消费了，\n" +
      "  // 根本不会走到 submitPrompt。\n" +
      "  if (\n" +
      '    rawName === "ctx-status" ||\n' +
      '    rawName === "ctx-reduce" ||\n' +
      '    rawName === "ctx-expand" ||\n' +
      '    rawName === "ctx-recomp"\n' +
      "  ) {\n" +
      "    return {\n" +
      "      args,\n" +
      "      name: rawName,\n" +
      "      rawName,\n" +
      '      type: "known",\n' +
      "    };\n" +
      "  }\n\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: CLI_COMMAND_CENTER_TYPES,
    find:
      "  /**\n" +
      "   * FORK（MF-06）：magic-context 的 effective 开关（契约 8：\n" +
      "   * `features.magicContext && magicContext.enabled`），值由 `create-app` 从\n" +
      "   * `runtimeConfig.magicContext.enabled` 透传——与 turn-loop 的插桩门同源同一次求值。\n" +
      "   * `/ctx-*` 读它决定要不要开库，不自行读 `features`（MF-06 r2 硬约束）。\n" +
      "   *\n" +
      "   * 可选而非必需：与 bootstrap 侧的同名能力一致，缺席按「关」处理。\n" +
      "   */\n" +
      "  isMagicContextEnabled?(): boolean;\n",
    replace: ``,
  },

  {
    kind: "sub",
    file: CLI_SLASH_COMMAND_TYPES,
    find:
      "  | {\n" +
      "      args: string;\n" +
      '      name: "ctx-status" | "ctx-reduce" | "ctx-expand" | "ctx-recomp";\n' +
      "      rawName: string;\n" +
      '      type: "known";\n' +
      "    }\n",
    replace: ``,
  },

  // ── services: agent 契约与转发层 ────────────────────────────────────────
  {
    kind: "cut",
    file: SERVICES_AGENT_CONTRACT,
    start: `  ZCodeWorkspaceUpdateMagicContextConfigResult,`,
    endBefore: `  // FORK（prompt-language-option）：模型语言（agent 提示词语言）。`,
  },
  {
    kind: "cut",
    file: SERVICES_AGENT_CONTRACT,
    start: ` * FORK（S23 / D-12）：写 magic-context 参数域。`,
    includePrev: -1,
    endBefore: ` * FORK（prompt-language-option）：写「模型语言」（agent 系统提示词语言）。`,
    extraEnd: -1,
  },
  {
    kind: "cut",
    file: SERVICES_AGENT_CONTRACT,
    start: ` * FORK（S23 / D-12）：把 magic-context 参数域写进用户级 config.json 并同步到`,
    includePrev: -1,
    endBefore: ` * FORK（prompt-language-option）：读回 effective 的模型语言。`,
    extraEnd: -1,
  },
  {
    kind: "sub",
    file: SERVICES_AGENT_SERVICE,
    find:
      "  zcodeWorkspaceUpdateMagicContextConfigResultSchema,\n" +
      "  zcodeWorkspaceReadMagicContextConfigResultSchema,\n" +
      "  // FORK（magic-context-memory-management / D2）：记忆管理面板 list/archive 结果信封。\n" +
      "  zcodeWorkspaceListMagicContextMemoriesResultSchema,\n" +
      "  zcodeWorkspaceArchiveMagicContextMemoriesResultSchema,\n",
    replace: ``,
  },
  {
    kind: "cut",
    file: SERVICES_AGENT_SERVICE,
    start: `    // 走 read-only 控制面（与 \`grantWorkspaceHookTrust\` 同一条）：设置页在`,
    includePrev: -1,
    endBefore: `    // FORK（prompt-language-option）：模型语言读回。`,
  },

  // ── ui: 设置页（两个 MC 分区） ───────────────────────────────────────────
  {
    kind: "sub",
    file: UI_SETTINGS_PAGE,
    find:
      `import { MemoryManagementSection } from "@/settings/MemoryManagementSection.js";\n` +
      `import { MagicContextSettingsSection } from "@/settings/MagicContextSettingsSection.js";\n`,
    replace: ``,
  },
  {
    kind: "cut",
    file: UI_SETTINGS_PAGE,
    start: `  // FORK（magic-context-memory-management / 变更点 10 · Step 8）：存量迁移。`,
    endBefore: `  const handleHttpProxyChange = useCallback(`,
  },
  {
    kind: "sub",
    file: UI_SETTINGS_PAGE,
    find:
      '                        ) : activeSection === "memory" ? (\n' +
      "                          <ServiceProvider services={localHostServices}>\n" +
      "                            {/* 项目记忆管理面板始终使用本地 Host 的 CLI 记忆库，\n" +
      "                                避免远程 workspace 误读远端数据（占位文案里已注明）。 */}\n" +
      "                            <MemoryManagementSection\n" +
      "                              workspacePath={activeWorkspacePath ?? captionWorkspacePath}\n" +
      "                            />\n" +
      "                          </ServiceProvider>\n" +
      '                        ) : activeSection === "context" ? (\n' +
      "                          <ServiceProvider services={localHostServices}>\n" +
      "                            {/* magicContext 是用户级参数域：写盘固定落在\n" +
      "                                ~/.omz/cli/config.json，workspace 只用于定位本机控制面\n" +
      "                                （读/写都走同一条 read-only lane）。 */}\n" +
      "                            <MagicContextSettingsSection\n" +
      "                              workspacePath={activeWorkspacePath ?? captionWorkspacePath}\n" +
      "                            />\n" +
      "                          </ServiceProvider>\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: UI_SETTINGS_PAGE_CONFIG,
    find:
      '  // FORK（magic-context-memory-management / Step 8）：分区 id 保持 "memory"（导航锚点\n' +
      "  // 与本地偏好稳定），语义改为 magic-context 跨会话「项目记忆」管理面板；标题文案随\n" +
      "  // i18n 键 `settings.memory` 更新为「项目记忆」/「Project memory」。\n" +
      "  {\n" +
      '    id: "memory",\n' +
      "    icon: Brain,\n" +
      '    titleId: "settings.memory",\n' +
      '    groupId: "agentCapabilities",\n' +
      "  },\n" +
      "  // FORK（Step 29 / D-12）：magic-context 参数域。紧跟 Memory——两者都是\n" +
      "  // Agent 侧的上下文供给配置，Memory 管「注入什么」，本分区管「怎么裁剪/分舱」。\n" +
      "  {\n" +
      '    id: "context",\n' +
      "    icon: Layers,\n" +
      '    titleId: "settings.context.title",\n' +
      '    groupId: "agentCapabilities",\n' +
      "  },\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: UI_SETTINGS_NAVIGATION,
    find: `  | "memory"\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: UI_SETTINGS_NAVIGATION,
    find: `  // FORK（Step 29 / D-12）：magic-context 参数域的设置分区。\n  | "context"\n`,
    replace: ``,
  },
  { kind: "sub", file: UI_SETTINGS_NAVIGATION, find: `    value === "memory" ||\n`, replace: `` },
  {
    kind: "sub",
    file: UI_SETTINGS_NAVIGATION,
    find: `    value === "automations" ||\n    value === "context" ||\n`,
    replace: `    value === "automations" ||\n`,
  },

  // ── ui: 上下文用量面板（D-13 摘要段） ─────────────────────────────────────
  {
    kind: "sub",
    file: UI_CONTEXT_USAGE,
    find: `import type { SessionMagicContextUsage } from "@zcode/shared/zcode-protocol-v4";\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: UI_CONTEXT_USAGE,
    find: `import { buildMagicContextUsageRows } from "@/chat-input-toolbar/magicContextUsageRows.js";\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: UI_CONTEXT_USAGE,
    find: `  TID_CHAT_CONTEXT_USAGE_MAGIC_CONTEXT,\n`,
    replace: ``,
  },
  {
    kind: "cut",
    file: UI_CONTEXT_USAGE,
    start: `/** D-13：面板里的 magic-context 段是「有就说」，字段缺席时整段不渲染。 */`,
    endBefore: `const BREAKDOWN_SOURCE_ORDER: Record<ContextUsageBreakdownSource, number> = {`,
  },
  {
    kind: "sub",
    file: UI_CONTEXT_USAGE,
    find: `  magicContext,\n  selectedProvider: _selectedProvider,`,
    replace: `  selectedProvider: _selectedProvider,`,
  },
  {
    kind: "sub",
    file: UI_CONTEXT_USAGE,
    find: `  magicContext?: SessionMagicContextUsage | null;\n`,
    replace: ``,
  },
  {
    kind: "cut",
    file: UI_CONTEXT_USAGE,
    start: `  const magicContextRows = useMemo(`,
    endBefore: `    (!renderableTaskUsage || !contextUsageLabel) &&`,
    extraEnd: -2,
  },
  {
    kind: "sub",
    file: UI_CONTEXT_USAGE,
    find: `    !hasStartPlanBalance &&\n    magicContextRows.length === 0\n  ) {`,
    replace: `    !hasStartPlanBalance\n  ) {`,
  },
  {
    kind: "cut",
    file: UI_CONTEXT_USAGE,
    start: `          {/* D-13：magic-context 预算摘要。与上面两段不同，它**不依赖**`,
    endBefore: `          {/* FORK（D-4）：Coding Plan 剩余额度与 Start Plan 余额面板随订阅面整删；`,
  },
  {
    kind: "sub",
    file: UI_CONTEXT_USAGE,
    find:
      "          {/* FORK（D-4）：Coding Plan 剩余额度与 Start Plan 余额面板随订阅面整删；\n" +
      "              context 面板只保留 Context windows / Magic Context / cache / breakdown 通用区。 */}\n",
    replace:
      "          {/* FORK（D-4）：Coding Plan 剩余额度与 Start Plan 余额面板随订阅面整删；\n" +
      "              context 面板只保留 Context windows / cache / breakdown 通用区。 */}\n",
  },

  // ── ui: composer 传递的 usage 字段 ───────────────────────────────────────
  {
    kind: "sub",
    file: UI_V4_COMPOSER_TOOLBAR,
    find: `        magicContext={usage?.magicContext ?? null}\n`,
    replace: ``,
  },
  {
    kind: "sub",
    file: UI_V4_COMPOSER_TOOLBAR,
    find:
      "  // FORK（D-4）：连接方式选择随订阅面整删，恒为无连接形态。\n" +
      "// FORK（D-4）：账号访问判定、Start Plan 余额、团队套餐产品目录、团队 usage source、\n" +
      "  // Coding Plan 权益与个人额度余额全部随订阅面整删。context 区只保留通用用量\n" +
      "  // （contextWindow / magicContext / taskUsage），由 ChatContextUsage 继续渲染。\n",
    replace:
      "  // FORK（D-4）：连接方式选择随订阅面整删，恒为无连接形态。\n" +
      "  // FORK（D-4）：账号访问判定、Start Plan 余额、团队套餐产品目录、团队 usage source、\n" +
      "  // Coding Plan 权益与个人额度余额全部随订阅面整删。context 区只保留通用用量\n" +
      "  // （contextWindow / taskUsage），由 ChatContextUsage 继续渲染。\n",
  },

  // ── ui: v4 命令面 ────────────────────────────────────────────────────────
  {
    kind: "sub",
    file: UI_V4_SLASH_COMMANDS,
    find:
      "  | {\n" +
      "      /**\n" +
      "       * magic-context 本地控制命令（`/ctx-status` / `/ctx-reduce` / `/ctx-expand` /\n" +
      "       * `/ctx-recomp`）。App 侧由 v4 `ctxCommand` 通道就地执行，结果以文本回来，\n" +
      "       * 不进对话历史——与 CLI/TUI 的 command-center 语义同源。\n" +
      "       *\n" +
      "       * `range` 是命令名之后的**剩余文本逐字**：文法（tag=/message=/区间/verbose）只有\n" +
      "       * 服务端与包内工具路径共享一份实现，客户端不再抄第二遍。\n" +
      "       */\n" +
      '      kind: "ctxCommand";\n' +
      "      command: CtxCommandKind;\n" +
      "      range?: string;\n" +
      "      displayText: string;\n" +
      "    };\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: UI_V4_SLASH_COMMANDS,
    find:
      "/** 四个 `/ctx-*` 对应的 v4 命令 kind（契约见 shared/zcode-protocol-v4/command.ts）。 */\n" +
      `export type CtxCommandKind = "ctxStatus" | "ctxReduce" | "ctxExpand" | "ctxRecomp";\n\n`,
    replace: ``,
  },
  {
    kind: "cut",
    file: UI_V4_SLASH_COMMANDS,
    start: ` * \`/ctx-*\` 的命令名 → v4 kind。键是连字符形式，与 App \`/\` 目录（\`/ctx-status\` 等）`,
    includePrev: -1,
    endBefore: `export function parseV4VisibleSlashCommand(`,
  },
  {
    kind: "sub",
    file: SERVICES_AGENT_SERVICE,
    find:
      "  ZCodeAgentUpdateMagicContextConfigParams,\n" +
      "  // FORK（magic-context-memory-management / D2）：记忆管理面板 list/archive 入参。\n" +
      "  ZCodeAgentListMagicContextMemoriesParams,\n" +
      "  ZCodeAgentArchiveMagicContextMemoriesParams,\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: UI_V4_SLASH_COMMANDS,
    find:
      "  // magic-context 本地控制命令。它们与 goal 一样**不走 prompt 通道**（那会把 `/ctx-status`\n" +
      "  // 原文当 prompt 发给模型），改由 v4 `ctxCommand` 就地执行。\n" +
      "  //\n" +
      "  // 位置在附件门之后：携带附件/网页元素上下文时不消费为 v4 原生命令，随 sendText 直发。\n" +
      "  // 这与 `/goal` 的取舍一致——先不引入「带附件敲 `/ctx-*` 该怎么办」这份额外语义，\n" +
      "  // 也让未消费时的行为与本次改动前逐字相同（原文进 prompt）。\n" +
      "  const ctxKind = CTX_COMMAND_KINDS[commandName];\n" +
      "  if (ctxKind) {\n" +
      '    return { command: ctxKind, displayText, kind: "ctxCommand", ...(args ? { range: args } : {}) };\n' +
      "  }\n\n",
    replace: ``,
  },

  // ── ui: SessionPane 的 ctx 回执通道 ─────────────────────────────────────
  {
    kind: "cut",
    file: UI_V4_SESSION_PANE,
    start: `/** \`/ctx-reduce|expand|recomp\` 的回执只有 1~3 行，给一个够读完的定时。 */`,
    endBefore: ` * 单 pane 竖切：订阅 → 渲染 rows → composer 发送 / stop。`,
    extraEnd: -1,
  },
  {
    kind: "sub",
    file: UI_V4_SESSION_PANE,
    find:
      '        case "ctxCommand":\n' +
      "          // magic-context 本地控制命令：不经 prompt 通道，服务端就地执行完把一段文本\n" +
      "          // 回在 ACK 的 `ctxCommand.response` 里。承载它的是**已存在的** notice toast\n" +
      "          // （variant=info 会把首行当标题、余下按 pre-line 正文渲染），不新造组件。\n" +
      "          type = command.command;\n" +
      "          payload =\n" +
      '            command.command === "ctxReduce"\n' +
      '              ? { tags: command.range ?? "" }\n' +
      "              : command.range\n" +
      "                ? { range: command.range }\n" +
      "                : {};\n" +
      "          break;\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: UI_V4_SESSION_PANE,
    find:
      '      if (command.kind === "ctxCommand") {\n' +
      "        presentCtxCommandAck(ack, intl, command);\n" +
      "        return true;\n" +
      "      }\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: UI_V4_SESSION_PANE,
    find:
      "      // `/ctx-*` 是会话自身的上下文控制面，不起 turn、不入队、不需要模型就绪——所以在\n" +
      "      // `ensureDraftModelReadyForSend` 之前就地消费：让一条纯本地的读命令不必先备好模型。\n" +
      "      // 没有会话时（draft 首条）无处可作用，明确提示而不是把 `/ctx-status` 当 prompt 发出去。\n" +
      '      if (slashCommand?.kind === "ctxCommand") {\n' +
      "        if (sessionId) {\n" +
      "          // 这四条不携带 Submission（没有模型/模式/队列语义），因此不受 draft promotion\n" +
      "          // 与 held-queue choice 影响——它们本来就不进对话。\n" +
      "          await dispatchSlashCommand(\n" +
      "            slashCommand,\n" +
      "            sessionId,\n" +
      "            snapshotRef.current?.revision,\n" +
      "            undefined,\n" +
      "            undefined,\n" +
      "            undefined,\n" +
      "          );\n" +
      '          return "sent" as const;\n' +
      "        }\n" +
      '        toast(intl.formatMessage({ id: "chat.ctx.sessionRequired" }));\n' +
      '        return "blocked" as const;\n' +
      "      }\n\n",
    replace: ``,
  },

  // ── shared: 协议面（v3 RPC） ─────────────────────────────────────────────
  {
    kind: "del",
    file: SHARED_PROTOCOL_INDEX,
    start: ` * FORK（S23 / D-12）：\`magicContext\` 参数域的整域覆盖请求。`,
    end: `  typeof zcodeWorkspaceArchiveMagicContextMemoriesResultSchema`,
  },
  {
    kind: "sub",
    file: SHARED_PROTOCOL_INDEX,
    find: `/**\n>;\n\n/**\n * FORK（prompt-language-option）：模型语言（agent 系统提示词语言）。`,
    replace: `/**\n * FORK（prompt-language-option）：模型语言（agent 系统提示词语言）。`,
  },
  {
    kind: "sub",
    file: SHARED_PROTOCOL_INDEX,
    find:
      "  // FORK（S23 / D-12）：magic-context 参数域。与 interaction-preferences 的关键\n" +
      "  // 差异是**写盘 + 内存双写**——后者只改进程内 registry，改完即失、不落盘、无推送。\n" +
      '  workspaceUpdateMagicContextConfig: "workspace/updateMagicContextConfig",\n' +
      "  // FORK（Step 29 / D-12）：update 的配对读方法。设置分区渲染表单初值必须先读\n" +
      "  // effective 域——update 是整域覆盖，UI 不先读就会在首次保存时抹掉其余字段。\n" +
      '  workspaceReadMagicContextConfig: "workspace/readMagicContextConfig",\n' +
      "  // FORK（magic-context-memory-management / 变更点 5）：设置页「记忆」分区的\n" +
      "  // magic-context 项目记忆管理面（list 结构化条目+计数 / archive 批量软删+reason）。\n" +
      "  // 四处手工对齐（schema 导出/方法名/CLI case/services 方法）——schema 对在本文件\n" +
      "  // `zcodeWorkspace{List,Archive}MagicContextMemories*`；CLI dispatch = Step 6，\n" +
      "  // services 方法 = Step 5。降级：旧 CLI -32601 → list 由 services 合成\n" +
      "  // supported:false 零值 / archive 抛可读错误。additive，旧 Host 不受影响。\n" +
      '  workspaceListMagicContextMemories: "workspace/listMagicContextMemories",\n' +
      '  workspaceArchiveMagicContextMemories: "workspace/archiveMagicContextMemories",\n',
    replace: ``,
  },

  // ── shared: 协议面（v4 命令 / 快照） ────────────────────────────────────
  {
    kind: "sub",
    file: SHARED_V4_COMMAND,
    find:
      "  // ── magic-context 本地控制命令（S22 的桌面执行面）────────────────────────\n" +
      "  //\n" +
      "  // 这四个名字的语义与 CLI/TUI 完全同源（实现见 bootstrap/src/ctx-commands）：\n" +
      "  // 桌面 composer 敲 `/ctx-status` 时不再走 `sendText`（那会把命令原文发给模型），\n" +
      "  // 而是发一条 v4 命令，由 `zcode-protocol-v4/commands/handlers/ctx.ts` 就地执行并\n" +
      "  // 把文本回在 ACK 的 `ctxCommand` 结果里。\n" +
      "  //\n" +
      "  // 参数一律**逐字携带命令名之后的剩余文本**，解析在服务端做：文法只有服务端与包内\n" +
      "  // 工具路径共享一份实现，客户端再抄一遍必然漂移。字段名沿用「这段文本指向哪段\n" +
      "  // 历史」的读法——`tags` 是 `/ctx-reduce` 的 tag-id 列表，`range` 是 expand/recomp 的\n" +
      "  // 选择器文本（`/ctx-expand` 的 `range` 覆盖工具同款文法\n" +
      "  // `tag=N | message=N | <start>-<end> [verbose]`，`/ctx-recomp` 的覆盖\n" +
      "  // `full | --upgrade | <start>-<end>`），缺省即「不限定」。\n" +
      "  ctxStatus: z.object({}),\n" +
      "  // `/ctx-reduce <tag-ids>`，例如 `3-5, 8, 12-15`。空串由服务端回用法提示。\n" +
      "  ctxReduce: z.object({ tags: z.string() }),\n" +
      "  ctxExpand: z.object({ range: z.string().optional() }),\n" +
      "  ctxRecomp: z.object({ range: z.string().optional() }),\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: SHARED_V4_COMMAND,
    find:
      "  z.object({\n" +
      "    // `/ctx-*` 的执行结果：命令就地算完，把**逐字文本**回给客户端，不进对话历史。\n" +
      "    // 形态对齐 applyFileRewind 的 `response`（同一类「命令自带一段可展示文本」），\n" +
      "    // 差别只是这里没有别的结构化字段要带——四个命令的输出都是一段人读的文本。\n" +
      '    type: z.literal("ctxCommand"),\n' +
      '    command: z.enum(["ctxStatus", "ctxReduce", "ctxExpand", "ctxRecomp"]),\n' +
      "    response: z.string(),\n" +
      "  }),\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: SHARED_V4_SNAPSHOT,
    find:
      "  // `/ctx-*`（magic-context 本地控制面）：恒定可用。刻意**不**按 magicContext.enabled\n" +
      "  // 过滤目录/能力——关掉时命令自己回一条 UNAVAILABLE 文案，与 CLI/TUI 逐字一致；\n" +
      "  // 在这里藏起来会让「命令列出来了但按了没反应」和「命令回了为什么不能用」这两种\n" +
      "  // 失败模式在不同客户端上分叉。\n" +
      "  ctxStatus: actionAvailabilitySchema,\n" +
      "  ctxReduce: actionAvailabilitySchema,\n" +
      "  ctxExpand: actionAvailabilitySchema,\n" +
      "  ctxRecomp: actionAvailabilitySchema,\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: SHARED_SLASH_COMMAND_HELP,
    find:
      "    // ── magic-context 本地控制命令（Step 22） ─────────────────────────────────\n" +
      "    // 这一组是**本地命令**：它们在 CLI/TUI 里就地执行，直接读 magic-context.db 或\n" +
      "    // 触发一次排队，**不**发一条模型提示。因此它们不是 bootstrap 展开的 prompt\n" +
      "    // 命令，也不进 App 的 `/` 面板（见 bootstrap/slash-command-surface.ts 的说明）。\n" +
      "    {\n" +
      "      details: [\n" +
      '        "Prints a text snapshot read straight from magic-context.db: the protected-token floor and last context usage, the compartment count and the last compacted message ordinal, and the active/dropped/compacted tag counts with the pending-operation queue depth.",\n' +
      '        "Read-only: it never writes, never compacts and never triggers a model turn.",\n' +
      '        "Shows the Magic Context status is unavailable notice when the store cannot be opened.",\n' +
      "      ],\n" +
      '      name: "ctx-status",\n' +
      '      summary: "Show the Magic Context status snapshot for this session.",\n' +
      '      usage: "/ctx-status",\n' +
      "    },\n" +
      "    {\n" +
      "      details: [\n" +
      '        \'Queues the given tag numbers for reclaim. Accepts "3-5", "1,2,9" and "1-5,8,12-15".\',\n' +
      '        "Stamping is not a delete: the item stays readable until Magic Context clears stamped items in one sweep, and the newest tags stay protected.",\n' +
      '        "The same invocation repeated with the same command id is answered from the idempotency ledger and is not queued twice.",\n' +
      "      ],\n" +
      '      name: "ctx-reduce",\n' +
      '      summary: "Queue context tags the work ahead no longer needs.",\n' +
      '      usage: "/ctx-reduce <tag-ids>",\n' +
      "    },\n" +
      "    {\n" +
      "      details: [\n" +
      '        "Recovers content that is no longer on the desk. Takes tag=N (a §N§ tag or a [dropped §N§] placeholder) to return one item whole, or message=N / start-end message ordinals to return a range.",\n' +
      '        "Tag numbers and message ordinals are never interchangeable: an ordinal counts whole messages, a tag counts each text and tool result separately.",\n' +
      '        "Ranges are capped at about 15K tokens; an oversized range returns the head and says where to continue.",\n' +
      "      ],\n" +
      '      name: "ctx-expand",\n' +
      '      summary: "Recover dropped or compacted context content.",\n' +
      '      usage: "/ctx-expand [tag=N | message=N | <start>-<end>]",\n' +
      "    },\n" +
      "    {\n" +
      "      details: [\n" +
      '        "Triggers one compartment recomputation pass for this session. Memories are not changed.",\n' +
      '        "This is the simplified first version: it schedules the recomputation and reports what the next pass will rebuild, rather than running a synchronous full rebuild.",\n' +
      "      ],\n" +
      '      name: "ctx-recomp",\n' +
      '      summary: "Trigger one compartment recomputation pass (simplified).",\n' +
      '      usage: "/ctx-recomp [full | <start>-<end>]",\n' +
      "    },\n",
    replace: ``,
  },

  // ── 测试脚本：改写剩下的非 MC 测试（rewind 端口的用例随端口一起摘除） ────
  {
    kind: "sub",
    file: BOOTSTRAP_TEST_EDIT_RETRY,
    find:
      "      // FORK（spec phase-compartment-rewind / C1）：可选端口的宿主侧实现（测试替身）。\n" +
      "      // 真实装配里只有 MC 库真的开出来时这个键才存在，所以下面还有一条「端口缺席」\n" +
      "      // 用例（删掉本键后命令必须照常完成）。\n" +
      "      invalidateMagicContextCompartments: async (input) => {\n" +
      "        calls.invalidations.push(input);\n" +
      '        calls.order.push("invalidate");\n' +
      "      },\n",
    replace: ``,
  },
  { kind: "sub", file: BOOTSTRAP_TEST_EDIT_RETRY, find: `    invalidations: [],\n`, replace: `` },
  {
    kind: "cut",
    file: BOOTSTRAP_TEST_EDIT_RETRY,
    start: `// ── FORK（spec phase-compartment-rewind / C1）：rewind → compartment 失效端口 ──`,
    endBefore: `test("E6: 端口缺席（MC 未装配）⇒ 命令照常完成，不伪造调用、不抛错", async () => {`,
  },
  {
    kind: "sub",
    file: BOOTSTRAP_TEST_EDIT_RETRY,
    find:
      'test("E6: 端口缺席（MC 未装配）⇒ 命令照常完成，不伪造调用、不抛错", async () => {\n' +
      '  const harness = createEditHarness({ activeTurnKind: "idle" });\n' +
      "  delete harness.record.app.invalidateMagicContextCompartments;\n" +
      "  const result = await forkEditRetryHandlers.editUserQuery(harness.host, harness.envelope);\n" +
      "  await settleIdlePoll();\n" +
      "\n" +
      '  assert.deepEqual(harness.calls.invalidations, [], "端口缺席不得伪造一次失效调用");\n' +
      '  assert.deepEqual(harness.calls.order, ["rewind", "send"], "其余链路不受影响");\n' +
      "  assert.equal(harness.calls.rewinds.length, 1);\n" +
      '  assert.equal(result?.disposition, "rewind");\n' +
      "});\n",
    replace: ``,
  },

  // ── 构建 / 打包 / 门禁配置 ───────────────────────────────────────────────
  {
    kind: "sub",
    file: CLI_SEA_TUI_ASSETS,
    find:
      "  // FORK（S35-fix）：`@zcode/magic-context` 与 `@zcode/tui` 一样是 esbuild external\n" +
      '  // （build.mjs 的 resolveBuildExternal），产物里是运行期 `require("@zcode/magic-context")`。\n' +
      "  // 它不在 @zcode/tui 的 manifest 依赖闭包里，所以必须显式作为种子入队；漏掉它时\n" +
      "  // tarball 与 SEA 两条通道装出来都报 `Cannot find module '@zcode/magic-context'`，\n" +
      "  // 仓库内却因为 pnpm workspace 软链而一切正常。\n" +
      "  //\n" +
      "  // **必须排在 TUI 闭包之后**：首轮队列是 BFS，种子排在第 7 位仍会先于 @zcode/tui\n" +
      "  // 的传递依赖被取出，于是本包的 `zod` 4.6.5 会抢走 `node_modules/zod` 这个根位，\n" +
      "  // 把 @zcode/contracts 的 Zod 3 挤到嵌套位——TUI 闭包里 `zod-to-json-schema`\n" +
      "  // （contracts 的 peer=^3）解析到的版本就变了。放进 `deferred`，等首轮队列排空\n" +
      "  // 再入队，`placeRuntimePackage` 才会把 4.6.5 放到\n" +
      "  // `node_modules/@zcode/magic-context/node_modules/zod`，与既有放置逐字节一致。\n" +
      "  //\n" +
      '  // `fromAssetPath: "node_modules"` 让放置逻辑从资产根起算；随后按 manifest 递归收\n' +
      "  // 依赖，`ai-tokenizer`（read-session-formatting 的 createRequire 动态加载）落到\n" +
      "  // `node_modules/ai-tokenizer`，从 `agent/node_modules/@zcode/magic-context/dist/**`\n" +
      "  // 向上查找即可命中。\n" +
      '  const magicContextDirectory = workspacePackageDirectories.get("@zcode/magic-context");\n' +
      "  if (!magicContextDirectory) {\n" +
      '    throw new Error("Missing @zcode/magic-context workspace package.");\n' +
      "  }\n",
    replace: ``,
  },
  {
    kind: "sub",
    file: CLI_SEA_TUI_ASSETS,
    find:
      "  const deferred = [\n" +
      "    {\n" +
      '      fromAssetPath: "node_modules",\n' +
      "      fromDirectory: magicContextDirectory,\n" +
      '      packageName: "@zcode/magic-context",\n' +
      "    },\n" +
      "  ];\n",
    replace: "  const deferred = [];\n",
  },
  { kind: "sub", file: CLI_BUILD, find: `  "@zcode/magic-context",\n`, replace: `` },
  {
    kind: "sub",
    file: DESKTOP_STAGE_AGENT_BUNDLE,
    find: `export const AGENT_BUNDLE_RUNTIME_EXTERNAL_MODULES = ["@zcode/magic-context"];`,
    replace: `export const AGENT_BUNDLE_RUNTIME_EXTERNAL_MODULES = [];`,
  },
  {
    kind: "sub",
    file: ROOT_BUILD_DESKTOP_AGENT_CLI,
    find:
      "  // magic-context 在 zcode.cjs 里是 esbuild external（TLA + import.meta.url 无法内联 CJS），\n" +
      "  // stage-agent-bundle 会把它的 dist 平铺进 glm/node_modules——必须先出 dist，\n" +
      "  // 否则暂存自检的 require.resolve 直接失败。无 workspace 依赖，排在最前即可。\n" +
      '  { packageName: "@zcode/magic-context", packageDir: "magic-context" },\n',
    replace: ``,
  },

  // package.json / knip.json：依赖、脚本、导出与忽略项
  ...PACKAGE_JSON_FILES.map((file) => ({
    kind: "json",
    file,
    mutate(json) {
      if (json.dependencies) delete json.dependencies["@zcode/magic-context"];
      if (json.devDependencies) delete json.devDependencies["@zcode/magic-context"];
      if (json.exports) delete json.exports["./ctx-commands"];
      if (json.scripts) {
        for (const [name, command] of Object.entries(json.scripts)) {
          if (
            typeof command === "string" &&
            /scripts\/(test-)?(magic-context|mc-|ctx-)/.test(command)
          ) {
            delete json.scripts[name];
          }
        }
        const perf = json.scripts["test:v4-perf"];
        if (typeof perf === "string") {
          json.scripts["test:v4-perf"] = perf
            .split(" && ")
            .filter(
              (segment) =>
                !/magicContext|magic-context|ctx-tool-descriptions|prompt-surface-toolset-hash|mc-section-zh/.test(
                  segment,
                ),
            )
            .join(" && ");
        }
      }
      if (json.workspaces && json.workspaces["apps/zcode-cli/packages/magic-context"]) {
        delete json.workspaces["apps/zcode-cli/packages/magic-context"];
      }
      const cliEntry = json.workspaces?.["apps/zcode-cli/packages/cli"];
      if (cliEntry?.ignoreDependencies) {
        cliEntry.ignoreDependencies = cliEntry.ignoreDependencies.filter(
          (dep) => dep !== "@zcode/magic-context",
        );
        if (cliEntry.ignoreDependencies.length === 0) delete cliEntry.ignoreDependencies;
      }
    },
  })),
];

// ============================================================
// 三、引擎：dry-run / --apply / --restore / --verify / --audit
// ============================================================

const args = new Set(process.argv.slice(2));
const hasFlag = (name) => args.has(name);

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(
    [
      "用法: node unplug-magic-context.mjs [--apply] [--archive-db] [--verify] [--audit] [--restore]",
      "",
      "  (无参数)       dry-run：只打印将要删除/改写的文件与条数",
      "  --apply        真摘除（幂等：已摘除时退出码 0）",
      "  --archive-db   把 magic-context.db{,-wal,-shm} 移到 ~/.omz/backup-<ts>/",
      "  --verify       摘除后自检 9 条（dist import / 工具 / 命令 / UI / 残留）",
      "  --audit        grep 清单对账：未登记的 MC 残留即失败",
      "  --restore      git checkout 还原本脚本改过/删过的全部路径",
    ].join("\n"),
  );
  process.exit(0);
}

const abs = (relative) => join(REPO_ROOT, relative);

function isAlreadyUnplugged() {
  return !existsSync(abs(MC_PACKAGE_DIR));
}

// ── 虚拟文件树：dry-run 与 --apply 走同一条代码路径 ─────────────────────────
const fileCache = new Map();
function readVirtual(file) {
  if (!fileCache.has(file)) {
    const path = abs(file);
    fileCache.set(file, existsSync(path) ? readFileSync(path, "utf8") : null);
  }
  return fileCache.get(file);
}
function writeVirtual(file, content) {
  fileCache.set(file, content);
}

function normLine(line) {
  return line.trim();
}

function findLine(lines, needle, file) {
  const hits = [];
  lines.forEach((line, index) => {
    if (normLine(line) === normLine(needle)) hits.push(index);
  });
  if (hits.length !== 1) {
    throw new Error(`${file}: 锚点行命中 ${hits.length} 次（要求唯一）: ${JSON.stringify(needle)}`);
  }
  return hits[0];
}

function applyEdit(rule) {
  const file = rule.file;
  const source = readVirtual(file);
  if (source === null) {
    if (isAlreadyUnplugged()) return "skipped";
    throw new Error(`${file}: 文件不存在`);
  }

  if (rule.kind === "sub") {
    const count = source.split(rule.find).length - 1;
    if (count === 0) {
      if (isAlreadyUnplugged()) return "skipped";
      throw new Error(`${file}: 子串命中 0 次（规则已失效？）`);
    }
    const want = rule.count ?? 1;
    if (count !== want) throw new Error(`${file}: 子串命中 ${count} 次（要求 ${want}）`);
    writeVirtual(file, source.split(rule.find).join(rule.replace ?? ""));
    return "edited";
  }

  const lines = source.split("\n");

  if (rule.kind === "del") {
    let from;
    let to;
    try {
      from = findLine(lines, rule.start, file);
      to = rule.end === undefined ? from : findLine(lines, rule.end, file);
      if (to < from) throw new Error(`${file}: 删除范围为空`);
    } catch (error) {
      if (isAlreadyUnplugged()) return "skipped";
      throw error;
    }
    lines.splice(from, to - from + 1);
    writeVirtual(file, lines.join("\n"));
    return "edited";
  }

  if (rule.kind === "cut") {
    let from;
    let to;
    try {
      const start = findLine(lines, rule.start, file);
      const end = findLine(lines, rule.endBefore, file);
      from = start + (rule.includePrev ?? 0);
      to = end - 1 + (rule.extraEnd ?? 0);
      if (to < from) throw new Error(`${file}: 删除范围为空`);
    } catch (error) {
      if (isAlreadyUnplugged()) return "skipped";
      throw error;
    }
    lines.splice(from, to - from + 1);
    writeVirtual(file, lines.join("\n"));
    return "edited";
  }

  if (rule.kind === "json") {
    let json;
    try {
      json = JSON.parse(source);
    } catch (error) {
      throw new Error(`${file}: 不是合法 JSON (${error.message})`);
    }
    const before = JSON.stringify(json);
    rule.mutate(json);
    const after = JSON.stringify(json);
    if (before === after) {
      if (isAlreadyUnplugged()) return "skipped";
      throw new Error(`${file}: JSON 规则没有产生任何改动（规则已失效？）`);
    }
    writeVirtual(file, JSON.stringify(json, null, 2) + "\n");
    return "edited";
  }

  throw new Error(`未知规则类型: ${rule.kind}`);
}

// ── 计划 ───────────────────────────────────────────────────────────────────
function expandDedicatedPaths() {
  return DEDICATED_PATHS.filter((relative) => existsSync(abs(relative)));
}

function runRules() {
  const perFile = new Map();
  let skipped = 0;
  for (const rule of RULES) {
    const outcome = applyEdit(rule);
    if (outcome === "skipped") {
      skipped++;
      continue;
    }
    perFile.set(rule.file, (perFile.get(rule.file) ?? 0) + 1);
  }
  return { perFile, skipped };
}

function printPlan(deleted, perFile) {
  console.log(`仓库根: ${REPO_ROOT}`);
  console.log(`\n删整件（${deleted.length}）：`);
  for (const relative of deleted) console.log(`  - ${relative}`);
  console.log(`\n改写共享文件（${perFile.size}）：`);
  for (const [file, count] of [...perFile.entries()].sort()) {
    console.log(`  ~ ${file} (${count} 条规则)`);
  }
  console.log(
    `\n陈留 dist 清理（存在即删）：${STALE_DIST_PATHS.filter((p) => existsSync(abs(p))).length} 个路径`,
  );
}

function flushVirtual() {
  for (const [file, content] of fileCache) {
    if (content === null) continue;
    const path = abs(file);
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current === content) continue;
    writeFileSync(path, content);
  }
}

function applyDedicatedPaths(paths) {
  for (const relative of paths) {
    rmSync(abs(relative), { recursive: true, force: true });
  }
}

function purgeStaleDist() {
  let removed = 0;
  for (const relative of STALE_DIST_PATHS) {
    const path = abs(relative);
    if (!existsSync(path)) continue;
    rmSync(path, { recursive: true, force: true });
    removed++;
  }
  // pnpm workspace 软链：包目录已删，链接成了悬空项
  const link = abs("node_modules/@zcode/magic-context");
  if (existsSync(link)) {
    try {
      rmSync(link, { recursive: false, force: true });
    } catch {
      // Windows 上被占用的链接交给 `pnpm install` 收尾
    }
  }
  return removed;
}

// ── 数据库归档 ─────────────────────────────────────────────────────────────
function archiveDatabase() {
  const dbDir = join(homedir(), ".omz", "cli", "db");
  const names = ["magic-context.db", "magic-context.db-wal", "magic-context.db-shm"];
  const present = names.filter((name) => existsSync(join(dbDir, name)));
  if (present.length === 0) {
    console.log("数据库归档：没有 magic-context.db 文件，跳过");
    return;
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backupDir = join(homedir(), ".omz", `backup-${stamp}`);
  mkdirSync(backupDir, { recursive: true });
  for (const name of present) {
    const to = join(backupDir, name);
    renameSync(join(dbDir, name), to);
    console.log(`归档 ${name} -> ${to}`);
  }
}

// ── 还原 ───────────────────────────────────────────────────────────────────
function restore() {
  const paths = [...new Set([...DEDICATED_PATHS, ...RULES.map((rule) => rule.file)])];
  const tracked = paths.filter((relative) => {
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", relative], {
        cwd: REPO_ROOT,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  });
  if (tracked.length === 0) {
    console.log("没有可还原的 tracked 路径");
    return 0;
  }
  const result = spawnSync("git", ["checkout", "--", ...tracked], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  console.log(`\n还原 ${tracked.length} 个路径（git checkout --）`);
  return result.status ?? 1;
}

// ── 摘除后自检 ─────────────────────────────────────────────────────────────
const MC_IMPORT_RE = /(?:from|import)\s*\(?\s*["']@zcode\/magic-context(?:\/|["'])/;

async function verifyChild() {
  const moduleUrl = (relative) => new URL(`file://${abs(relative).replace(/\\/g, "/")}`).href;
  const results = [];
  const check = async (name, fn) => {
    try {
      results.push({ name, ok: true, detail: await fn() });
    } catch (error) {
      results.push({
        name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  await check("import bootstrap/dist/app/create-app.js", async () => {
    const mod = await import(moduleUrl("apps/zcode-cli/packages/bootstrap/dist/app/create-app.js"));
    if (typeof mod.createZCodeApp !== "function") throw new Error("createZCodeApp 不是函数");
    return "createZCodeApp ok";
  });
  await check("import bootstrap/dist/zcode-protocol/server.js", async () => {
    const mod = await import(
      moduleUrl("apps/zcode-cli/packages/bootstrap/dist/zcode-protocol/server.js")
    );
    if (Object.keys(mod).length === 0) throw new Error("零导出");
    return `${Object.keys(mod).length} exports`;
  });
  await check("core 工具表无 ctx_*", async () => {
    const mod = await import(moduleUrl("apps/zcode-cli/packages/core/dist/tool/handlers/index.js"));
    const names = mod.builtInTools.map((entry) => entry.metadata.name);
    const found = names.filter((name) => /^ctx_/.test(name));
    if (found.length > 0) throw new Error(`仍注册: ${found.join(",")}`);
    return `${names.length} tools, 无 ctx_*`;
  });
  await check("slash help 无 ctx-*", async () => {
    const mod = await import(moduleUrl("packages/shared/dist/zcode-slash-command-help.js"));
    const names = mod.BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.map((entry) => entry.name);
    const found = names.filter((name) => /^ctx-/.test(name));
    if (found.length > 0) throw new Error(`仍有: ${found.join(",")}`);
    return `${names.length} commands, 无 ctx-*`;
  });
  await check("App 可见命令无 ctx-*", async () => {
    const mod = await import(
      moduleUrl("apps/zcode-cli/packages/bootstrap/dist/slash-command-surface.js")
    );
    const names = [...mod.APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES];
    const found = names.filter((name) => /^ctx-/.test(name));
    if (found.length > 0) throw new Error(`仍有: ${found.join(",")}`);
    return names.join(",");
  });
  await check("v4 命令面无 ctx 符号", async () => {
    const mod = await import(moduleUrl("packages/shared/dist/zcode-protocol-v4/command.js"));
    if (/ctxStatus|ctxReduce|ctxExpand|ctxRecomp|ctxCommand/.test(Object.keys(mod).join(","))) {
      throw new Error("仍导出 ctx 命令符号");
    }
    return `${Object.keys(mod).length} exports`;
  });
  await check("UI 设置分区无 memory/context", async () => {
    const config = readFileSync(abs("packages/ui/src/settings/settingsPageConfig.ts"), "utf8");
    if (
      /MagicContextSettingsSection|MemoryManagementSection|id: "memory"|id: "context"/.test(config)
    ) {
      throw new Error("settingsPageConfig 仍引用 MC 分区");
    }
    const page = readFileSync(abs("packages/ui/src/SettingsPage.tsx"), "utf8");
    if (
      /MemoryManagementSection|MagicContextSettingsSection|activeSection === "context"/.test(page)
    ) {
      throw new Error("SettingsPage 仍渲染 MC 分区");
    }
    return "两个设置分区均已消失";
  });
  await check("源码无 MC 运行期导入", async () => {
    const files = execFileSync(
      "git",
      [
        "grep",
        "-l",
        "@zcode/magic-context",
        "--",
        "apps",
        "packages",
        "scripts",
        "knip.json",
        ".github",
      ],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    )
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    const offenders = files.filter((file) => MC_IMPORT_RE.test(readFileSync(abs(file), "utf8")));
    if (offenders.length > 0) throw new Error(`仍有运行期导入: ${offenders.join(", ")}`);
    return `${files.length} 个文件仅剩注释/文档引用`;
  });
  await check("MC 包与陈留 dist 已消失", async () => {
    const leftovers = [MC_PACKAGE_DIR, ...STALE_DIST_PATHS].filter((relative) =>
      existsSync(abs(relative)),
    );
    if (leftovers.length > 0) throw new Error(`仍存在: ${leftovers.join(", ")}`);
    return `${1 + STALE_DIST_PATHS.length} 个目标路径均不存在`;
  });

  for (const result of results) {
    console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name} — ${result.detail}`);
  }
  return results.every((result) => result.ok) ? 0 : 1;
}

function verify() {
  // dist import 需要 tsx（仓库内 workspace 包的 exports 指向 .ts 源码，Node 原生
  // 类型剥离不重写 `.js` 说明符）。tsx 缺席时如实报告，不静默通过。
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), "--verify-child"],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  if (child.status === 0) return 0;
  console.error("\n自检失败（tsx 载入或断言失败）。若 tsx 不可用，请在仓库根执行 `pnpm install`。");
  return child.status ?? 1;
}

// ── 清单对账 ───────────────────────────────────────────────────────────────
function audit() {
  const listGrep = (pattern) => {
    try {
      return execFileSync(
        "git",
        ["grep", "-il", pattern, "--", "apps", "packages", "scripts", "knip.json", ".github"],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        },
      )
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  const importUsers = listGrep("@zcode/magic-context").filter((file) =>
    MC_IMPORT_RE.test(readFileSync(abs(file), "utf8")),
  );
  const residue = listGrep("magiccontext");
  const unaccounted = residue.filter((file) => {
    if (DEDICATED_PATHS.some((relative) => file === relative || file.startsWith(`${relative}/`)))
      return false;
    return !KEEP_LIST.some((entry) => entry.paths.includes(file));
  });

  let failed = false;
  if (importUsers.length > 0) {
    failed = true;
    console.error(`✗ 仍有 ${importUsers.length} 个文件 import @zcode/magic-context：`);
    for (const file of importUsers) console.error(`    ${file}`);
  } else {
    console.log("✓ 没有任何运行期导入 @zcode/magic-context");
  }

  if (unaccounted.length > 0) {
    failed = true;
    console.error(`✗ 有 ${unaccounted.length} 个未登记残留（既不在删除清单，也不在 KEEP_LIST）：`);
    for (const file of unaccounted) console.error(`    ${file}`);
  } else {
    console.log(`✓ ${residue.length} 个残留文件全部登记在 KEEP_LIST（或属于已删清单）`);
  }
  return failed ? 1 : 0;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
async function main() {
  if (hasFlag("--verify-child")) return await verifyChild();

  // 根目录守卫：脚本被复制/移动后 REPO_ROOT 会算错，此时 grep 与 path 断言会「零命中通过」
  // ——先把这条假绿堵掉（探针实测：把脚本放 .scratch/ 下时 --audit 空跑通过）。
  if (!existsSync(abs("pnpm-workspace.yaml"))) {
    console.error(`不是仓库根目录（${REPO_ROOT}）：缺少 pnpm-workspace.yaml，拒绝执行。`);
    return 2;
  }
  if (hasFlag("--verify")) return verify();
  if (hasFlag("--audit")) return audit();
  if (hasFlag("--restore")) return restore();

  const already = isAlreadyUnplugged();
  if (already) {
    console.log(`MC 包目录已不存在（${MC_PACKAGE_DIR}）——视为已摘除。`);
  }

  const dedicated = expandDedicatedPaths();
  const { perFile, skipped } = runRules();
  const shouldApply = hasFlag("--apply");
  const archive = hasFlag("--archive-db");

  printPlan(dedicated, perFile);
  if (skipped > 0) console.log(`\n跳过 ${skipped} 条规则（已摘除状态）`);

  if (!shouldApply) {
    console.log("\n[dry-run] 没有写入任何文件。加 --apply 执行。");
    return 0;
  }

  flushVirtual();
  applyDedicatedPaths(dedicated);
  const purged = purgeStaleDist();
  console.log(
    `\n已删除 ${dedicated.length} 个整件路径、改写 ${perFile.size} 个文件、清理 ${purged} 个陈留 dist 路径`,
  );

  if (archive) archiveDatabase();

  console.log("\n下一步（顺序不可换）：");
  console.log("  pnpm typecheck");
  console.log("  pnpm --dir apps/zcode-cli exec turbo run typecheck --force");
  console.log("  pnpm --dir apps/zcode-cli exec turbo run lint --force");
  console.log("  node apps/zcode-cli/packages/cli/scripts/unplug-magic-context.mjs --verify");
  console.log(
    "  回滚：node apps/zcode-cli/packages/cli/scripts/unplug-magic-context.mjs --restore",
  );
  return 0;
}

process.exit(await main());
