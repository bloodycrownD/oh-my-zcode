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
 *      （规则表见下方 `RULES`；**条数不在这里手写**——`json` 规则按
 *      `PACKAGE_JSON_FILES` 展开成每个文件一个处理单元，所以「字面量声明条数」与
 *      「运行期处理单元数」是两个数，都由脚本自己统计并在 dry-run / `--apply` 的
 *      计划头部与 `--help` 里打印。手写数字必然随规则增删漂移：上一版写的
 *      「158 条」是对的，但它没算展开，实际运行 163 个单元；每条规则都用
 *      「唯一锚点或唯一子串」定位，匹配数不符即中止，不做模糊替换）；
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
 *   8. 源码里不再有 `@zcode/magic-context` 的**运行期导入**（只有 `from`/`import`
 *      关键字落在**代码位置**才算：注释里的示例、字符串/正则字面量里的规则锚点都不算；
 *      摘除脚本自身同上口径——注释/锚点里的命中被排除并打 NOTE，代码位置的命中照旧报红）；
 *   9. MC 包目录与陈留 dist 全部消失。
 *
 * 另外 `--audit` 把**摘除后仍带 MC 痕迹**的文件（kebab / camel / `ctx-` 三种写法）逐文件
 * 对账：要么是被本脚本删掉/改写的文件，要么必须落在 `KEEP_LIST`（带保留理由）里；出现
 * 任何未登记残留即失败。它同时校验「没有 package script 指向已删文件」——这是
 * 「升级跟随」口径的机读守卫，跑在虚拟树上，所以 dry-run 阶段就能对账。
 *
 * `--audit` 的三档退出码（cr-func 第 3 轮 P1-2）：`0` = 全绿；`1` = 下限 / 未登记残留 /
 * 悬空 script（**内容**层面的红）；`3` = 规则表锚点失配（**脚本自身**的维护信号，
 * 「非 MC 功能故障」，改 RULES 不改 MC）。分码是为了让 CI 红能被正确分诊——这三类都
 * 挂在 MC 的 job 里，混成 exit 1 会被读成「MC 坏了」。
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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
  // Step 15 新增：IM7 耦合预算门禁。它统计的就是「宿主指向 MC 的导入行」，
  // 摘除后每一项都为 0/路径不存在，留着必红——**新加门禁必须同批进摘除清单**。
  "apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-coupling-budget.mjs",
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

  // CI：整份 workflow 39 条全是 `pnpm --filter <包> run <MC script>`。摘除后包不在、
  // script 已删 → 每一条都 404，workflow 永久红。**它必须整份删除**，不能改写成
  // 「跳过 MC」——本 workflow 的存在理由就是这 39 条，改写成空壳只会留下一个假绿。
  ".github/workflows/mc-tests.yml",
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
      // 接缝的 barrel 再导出（`export * from "./magic-context-turn-transform.js"`）：
      // 它是三端口对外的唯一名字来源，删掉这一行等于把已保留的接缝从公开面摘掉。
      "apps/zcode-cli/packages/core/src/runtime/helpers/index.ts",
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
    //
    // cr-func 第 2 轮 P2-2 修正理由：初稿写「其余命中都是注释」，那是不实陈述——
    // `product-projection.ts` 的 `applyMagicContextUsage()`（40+ 行）、
    // `magicContextUsageField()` 及两处调用、v4-gateway 的同名代理方法都是**活代码**。
    // 它们的真实性质是：**写入面在场、但摘除后没有任何生产者**（`updateMagicContextUsage`
    // 的唯一调用方是 `create-app` 的 MC 装配）。所以口径写「无生产者但仍在场的写入面
    // （零行为）」，不写成注释。
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
      "协议存量字段 + 无生产者但仍在场的写入面：`usage.magicContext` 是 additive 的可选派生态，摘除后没有任何生产者（恒缺席，UI 整段不渲染）；`applyMagicContextUsage()` / `magicContextUsageField()` / gateway 的同名代理方法与 `zcodeAgentService` 的方法都是活代码，但没有调用方，保持在场是零行为（删掉反而要改 4 个文件并可能改变快照字段的 shape）。",
  },
  // cr-func 第 2 轮 P2-2：i18n 两份 locale（`packages/ui/src/i18n/locales/{en-US,zh-CN}.ts`）
  // 已从本清单**移除**，改用下面的 `cut` 规则删掉 MC 独占的键组。
  // 初稿把它们整份留在这里，理由是「uiLocaleContract 断言两侧键必须对等」——那是**不实**的：
  // 该测试全文只测 host `init-local` 的 `uiLocale` 字段，两份 locale 是 `Record<string,
  // string>`、无类型级对等约束、也没有任何测试 import 它们，真删并不会红。实际约束只有
  // 「删键前确认没有存活消费者」——已逐组核对：
  //   · `settings.context.*` / `settings.memory`：消费者是整件删除的
  //     `MagicContextSettingsSection/Fields.tsx`，`settingsPageConfig.ts` 的 titleId 由
  //     规则删掉；
  //   · `settings.memory.management.*`：消费者是整件删除的 `MemoryManagementSection.tsx`
  //     （`legacySwitchRetired` 例外——`SettingsPage.tsx` 的迁移 effect 还在用它，保留）；
  //   · `chat.contextUsage.magicContext.*`：`contextUsage.tsx` 的标签表由规则整块删掉；
  //   · `chat.ctx.*`：`SessionPane.tsx` 的回执通道与 toast 由规则删掉。
  // 「缺少对等约束」这件事本身登记在本轮 spec（fix-b9 小节），不在代码里补一条假断言。
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
  {
    // P2-1：旧 audit 口径（`git grep -il magiccontext`）看不见 kebab 写法，于是
    // 下面这些「只以 `magic-context` 出现」的文件从来没被对账过。逐条看过：全是
    // **注释 / 文档串 / onboarding 文案**，没有一处 import 包、注册命令或产生运行时值。
    paths: [
      "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/prompt-language.ts",
      "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts",
      "apps/zcode-cli/packages/cli/src/prompt-command.ts",
      "apps/zcode-cli/packages/cli/src/tui-prompt-handler.ts",
      "apps/zcode-cli/packages/core/src/agent/message-history.ts",
      "apps/zcode-cli/packages/core/scripts/test-promotion-lease.mjs",
      "packages/ui/src/ModelTrajectoryWireFilter.ts",
      "packages/shared/src/onboardingRecord.ts",
      "packages/services/test/onboardingMemoryWriteStop.test.ts",
    ],
    reason:
      "只出现在注释 / 文案里（解释某个判据与 MC 同源，或记录迭代名）：摘除后没有可执行语义。删注释只会让每次上游重放多一处手工改动，故保留。",
  },
  {
    // P2-1：同样是旧口径的盲区，但这两条不是注释——
    //   · `system-reminder/source.ts`：提醒源**注册表键** `magic_context`。MC 不在时没有
    //     生产者，键恒不触发；删它需要同改 4 处（source / descriptor 表 / 两个 consumer），
    //     摘除脚本多背一处冲突，收益为零。
    //     cr-func 第 2 轮 P2-2：**删掉**「删键会重排 descriptor 表」这条论据——Record 顺序
    //     没有语义，重排不是行为风险；真实理由只有「删它要同改 4 处」。
    //   · `.oxfmtrc.json`：格式器的 ignore glob。目录摘除后命中 0 个文件。
    paths: [
      "apps/zcode-cli/packages/core/src/system-reminder/source.ts",
      "apps/zcode-cli/.oxfmtrc.json",
    ],
    reason:
      "注册表键与格式器 ignore glob：都是「MC 不在时命中 0 次」的数据项，零包依赖、零行为；注册表键删掉要同改 4 处（source / descriptor 表 / 两个 consumer），ignore glob 删掉只会让重放多一处冲突。",
  },
  {
    // cr-func 第 2 轮 P2-5：`--audit` 的自动化入口（`test:mc-unplug-audit`）挂在 cli 的
    // package.json 上，命令串里必然带 `scripts/unplug-magic-context.mjs` 这个文件名——
    // 于是 package.json 本身成了残留。它必须留下：删掉这条 script，`--audit` 就又回到
    // 「只能人手跑」的状态，这正是 P2-5 要根治的。字面量是入口名的组成部分，不是耦合。
    paths: ["apps/zcode-cli/packages/cli/package.json"],
    reason:
      "摘除脚本对账（`--audit`）的自动化入口：命令串里的 `scripts/unplug-magic-context.mjs` 是文件名，不是 MC 耦合；这条 script 必须留下，否则 fail-loud 重新变成全靠人手动跑。",
  },
  {
    // 摘除工具自己：规则表与清单里必然满是 MC 字面量。摘除后它必须仍在场
    // （`--restore` 回滚、将来重新引入、以及 `--audit` 的机读守卫都靠它）。
    paths: ["apps/zcode-cli/packages/cli/scripts/unplug-magic-context.mjs"],
    reason:
      "本脚本就是摘除工具本身，字面量是它的数据而不是耦合。摘除后仍需在场以支持 `--restore` 与 `--audit` 对账。",
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
const UI_LOCALE_EN = "packages/ui/src/i18n/locales/en-US.ts";
const UI_LOCALE_ZH = "packages/ui/src/i18n/locales/zh-CN.ts";
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

/**
 * 「哪些 package script 指向已删路径」——**结构化推导**，不是名字枚举。
 *
 * 旧口径拿名字正则匹配命令（`scripts/(test-)?(magic-context|mc-|ctx-)`），于是
 * `test:settle-background` / `test:mural-media-blocks` / `test:e2e-live-all` /
 * `test:prompt-surface-toolset-hash` / `test:prompt-surface-tiering` 这 5 个
 * **名字里没有 MC 前缀、却硬编码了被删测试文件**的 script 全部留在 package.json 里：
 * 摘除删掉了 `.mjs`，script 还在 → 失败从「文件 404」转移到「script 404」，而
 * `--verify`（dist 层）与旧 `--audit`（残留 grep）都看不见这一类。
 *
 * 判据改成「命令里出现的仓库内路径命中 DEDICATED_PATHS」：路径是唯一事实。以后新增
 * 一个 MC 测试文件，只要进了清单，引用它的 script 自动被删，不需要再枚举一遍脚本名。
 */
const SCRIPT_PATH_TOKEN = /\.(?:mjs|cjs|js|json|ts|tsx)$/;

/** 去掉命令 token 两侧的引号 / 反斜杠 / `./` 前缀（命令串里的写法差异不参与判据）。 */
function normalizeCommandToken(raw) {
  return raw
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

/**
 * 单个命令 token → 仓库内路径候选；`null` = 不是路径 token。
 *
 * **cr-func 第 2 轮 P2-4（假候选）**：`apps/` / `packages/` 开头的 token 一律按**仓库根**
 * 相对路径解析，**不再**二次拼成 `<包目录>/apps/…`。旧实现对这类 token 同时产出两种候选，
 * 其中 `<pkg>/apps/…` 必然不存在——嵌套 package.json 里出现一行 `node apps/…` 就会让
 * `--audit` 红在一个荒诞路径上（而且红的原因与被删文件无关）。
 *
 * 其余 token（`scripts/x.mjs` / `test/y.test.ts` / `./z.mjs`）按**所在包**目录解析：
 * 包脚本里的 `scripts/` 指的是该包的 `scripts/`，不是仓库根的 `scripts/`。只有仓库根
 * 的 package.json（`packageDir === ""`）里 `scripts/` 才表示仓库根目录。
 */
function pathCandidatesOfToken(raw, packageDir) {
  const token = normalizeCommandToken(raw);
  if (token === "" || token.startsWith("-") || !SCRIPT_PATH_TOKEN.test(token)) return null;
  if (/^(?:apps|packages)\//.test(token)) return [token];
  if (packageDir !== "") return [`${packageDir}/${token}`];
  return token.startsWith("scripts/") ? [token] : null;
}

/** 命令 token → 仓库内路径候选（段级批量形态；保留给对账与日志使用）。 */
function scriptPathCandidates(command, packageDir) {
  const candidates = [];
  for (const raw of command.split(/\s+/)) {
    const single = pathCandidatesOfToken(raw, packageDir);
    if (single !== null) candidates.push(...single);
  }
  return candidates;
}

/** 路径（或其任一祖先目录）是否在整件删除清单里。 */
function isDedicatedPath(candidate) {
  return DEDICATED_PATHS.some(
    (relative) => candidate === relative || candidate.startsWith(`${relative}/`),
  );
}

/**
 * `pnpm [-C|--dir <dir>] run <name>` 的**间接点名**（cr-func 第 2 轮 P2-4）。
 *
 * 旧口径只把「命令里出现的文件路径」当判据，于是 `pnpm -C <pkg> run <被删的 script>`
 * 既不进删除判据、也不进悬空检查——摘除后静默 404。现在解析 script 名：目标 package.json
 * 里的那条 script 若会被删（递归分诊），引用它的这条脚本也一并删/收窄。
 *
 * `--filter` 定位不到包目录（名字 ≠ 路径），返回 `null` 表示「解析不出」，按存活处理
 * ——宁可不删也不猜错包。
 */
function parseRunReference(segment) {
  const tokens = segment.split(/\s+/).map(normalizeCommandToken);
  if (tokens[0] !== "pnpm") return null;
  let dir = null;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "-C" || token === "--dir") {
      const value = tokens[index + 1];
      if (!value) return null;
      dir = value.replace(/\/+$/, "");
      index += 1;
      continue;
    }
    if (token === "--filter" || token === "-F") return null;
    if (token === "run") {
      const name = tokens[index + 1];
      return name === undefined ? null : { dir, name };
    }
    if (token === "exec") return null;
  }
  return null;
}

/** 原始 scripts 快照（按磁盘读一次；与规则执行顺序无关，避免「先删的包影响后判的包」）。 */
const ORIGINAL_SCRIPTS = new Map();
function originalScriptsOf(packageFile) {
  if (!ORIGINAL_SCRIPTS.has(packageFile)) {
    let scripts;
    if (existsSync(abs(packageFile))) {
      try {
        scripts = JSON.parse(readFileSync(abs(packageFile), "utf8")).scripts ?? {};
      } catch {
        scripts = undefined;
      }
    }
    ORIGINAL_SCRIPTS.set(packageFile, scripts);
  }
  return ORIGINAL_SCRIPTS.get(packageFile);
}

/** 目标 script 是否会被摘除删掉（递归分诊；`seen` 防环，环按存活处理）。 */
function isDeadScript(packageFile, name, seen) {
  const key = `${packageFile}#${name}`;
  if (seen.has(key)) return false;
  const scripts = originalScriptsOf(packageFile);
  const command = scripts?.[name];
  // 不存在 / package.json 读不到 = 不是**我们**删的，不据此删上游脚本。
  if (typeof command !== "string") return false;
  const nextSeen = new Set(seen);
  nextSeen.add(key);
  const packageDir = dirname(packageFile) === "." ? "" : dirname(packageFile);
  return (
    planScriptCommand(command, { packageDir, packageFile, seen: nextSeen }).action === "delete"
  );
}

/**
 * **分诊一条 script 命令**（结构化推导，P2-4：`test:v4-perf` 不再有名字特例）。
 *
 * 先按 ` && ` 切段，逐段判：
 *   1. 间接点名（`pnpm [-C|--dir …] run <name>`）→ 目标 script 会被删 ⇒ 丢整段；
 *   2. 直接路径 token 命中 `DEDICATED_PATHS` ⇒ 剔掉这些 token；
 *      · 段内还剩别的路径 token（`tsx --test a b c` 的长命令）⇒ 只收窄这一段；
 *      · 一个都不剩 ⇒ 丢整段（`node --test <被删文件>`）；
 *   3. 名字兜底（命令引用了已删文件却没带扩展名）⇒ 丢整段。
 * 全部段都丢掉 ⇒ 删整条 script；部分收窄 ⇒ 重写；没有变化 ⇒ 保留。
 */
function planScriptCommand(command, { packageDir, packageFile, seen }) {
  const segments = command.split(" && ");
  const kept = [];
  const removedPaths = [];
  const droppedSegments = [];
  let droppedByRun = 0;
  let droppedByName = 0;
  let droppedByPath = 0;

  for (const segment of segments) {
    const reference = parseRunReference(segment);
    if (reference !== null) {
      const targetFile = reference.dir === null ? packageFile : `${reference.dir}/package.json`;
      if (isDeadScript(targetFile, reference.name, seen)) {
        droppedByRun += 1;
        droppedSegments.push(segment);
        continue;
      }
      kept.push(segment);
      continue;
    }

    const tokens = segment.split(/\s+/);
    const deadTokens = [];
    let livePathTokens = 0;
    for (const raw of tokens) {
      const candidates = pathCandidatesOfToken(raw, packageDir);
      if (candidates === null) continue;
      if (candidates.some(isDedicatedPath)) deadTokens.push(raw);
      else livePathTokens += 1;
    }

    if (deadTokens.length === 0) {
      if (/scripts\/(?:test-)?(?:magic-context|mc-|ctx-)/.test(segment)) {
        droppedByName += 1;
        droppedSegments.push(segment);
        continue;
      }
      kept.push(segment);
      continue;
    }
    if (livePathTokens > 0) {
      removedPaths.push(...deadTokens);
      kept.push(tokens.filter((raw) => !deadTokens.includes(raw)).join(" "));
      continue;
    }
    droppedByPath += 1;
    droppedSegments.push(segment);
  }

  const dropped = droppedByRun + droppedByName + droppedByPath;
  if (dropped === 0 && removedPaths.length === 0) return { action: "keep" };
  if (kept.length === 0) {
    return {
      action: "delete",
      reason: droppedByRun > 0 ? "run" : droppedByName > 0 ? "name" : "path",
    };
  }
  return {
    action: "rewrite",
    command: kept.join(" && "),
    removed: [...removedPaths, ...droppedSegments.map((segment) => `整段「${segment}」`)],
  };
}

/** dry-run / --apply 用的「被删 script」台账（printPlan 与 audit 共用同一份推导）。 */
const DELETED_SCRIPTS = [];
/** 被收窄（保留但剔掉被删段/token）的 script 台账——与删除分开列，避免混算。 */
const REWRITTEN_SCRIPTS = [];

/** 对一个 package.json 的 scripts 施加分诊结果（就地改写 json，返回是否有改动）。 */
function applyScriptPlan(json, file) {
  if (!json.scripts) return false;
  const packageDir = dirname(file) === "." ? "" : dirname(file);
  let changed = false;
  for (const [name, command] of Object.entries(json.scripts)) {
    if (typeof command !== "string") continue;
    const plan = planScriptCommand(command, { packageDir, packageFile: file, seen: new Set() });
    if (plan.action === "keep") continue;
    changed = true;
    if (plan.action === "delete") {
      delete json.scripts[name];
      DELETED_SCRIPTS.push({ file, name, reason: plan.reason });
      continue;
    }
    json.scripts[name] = plan.command;
    REWRITTEN_SCRIPTS.push({ file, name, removed: plan.removed });
  }
  return changed;
}

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
    // cut 而不是逐字 sub：这段注释在 cr-func 第 2 轮 P1-2 里改过（`absent` 不再是「夹具
    // 形态」），逐字匹配会让规则随注释措辞一起失效；锚点只认首行与下一个字段名。
    kind: "cut",
    file: BOOTSTRAP_CREATE_APP,
    start:
      "      // FORK（spec phase-zero-load / W2 / 变更点 #11）：库句柄端口。**无条件挂**（哪怕",
    endBefore: "      respondWorkspaceHookReview: (input) =>",
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
    // cut 而不是逐字 sub：这块注释在 cr-func 第 2 轮 P1-2 里改过分类（`absent` 不再是
    // 「夹具形态」），逐字匹配会让规则随注释措辞一起失效；锚点只认首行与下一个方法名。
    kind: "cut",
    file: BOOTSTRAP_APP_TYPES,
    start:
      "   * FORK（spec phase-zero-load / W2 / 变更点 #11）：本 App **已经装好**的 magic-context",
    includePrev: -1,
    endBefore: "  setModel(",
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

  // ── ui: i18n locale 里 MC 独占的键组（cr-func 第 2 轮 P2-2）─────────────────
  //
  // 两份 locale 不再整份进 KEEP_LIST（理由不实，见该清单位置的注释）。这里逐组删键，
  // 只删**其消费者已被本脚本删掉**的那些组：
  //   ① 设置分区 `settings.memory` + `settings.context.*`（消费者：MagicContextSettings*.tsx
  //      + settingsPageConfig 的 titleId 条目，均由规则/整件删除处理）；
  //   ② 记忆管理面板 `settings.memory.management.*`（消费者：MemoryManagementSection.tsx），
  //      **例外** `legacySwitchRetired`——SettingsPage.tsx 的存量迁移 effect 还在用它；
  //   ③ 上下文用量段 `chat.contextUsage.magicContext.*`（标签表在 contextUsage.tsx 里被整块删）；
  //   ④ `/ctx-*` 桌面回执 `chat.ctx.*`（回执通道在 SessionPane.tsx 里被整段删）。
  // 每条都用**整行锚点**（findLine 要求唯一），删完 `--audit` 会重新对账这两份文件的残留。
  {
    kind: "cut",
    file: UI_LOCALE_EN,
    start:
      "// FORK（magic-context-memory-management / Step 8）：分区语义切换为跨会话「项目记忆」。",
    endBefore: `"settings.memory.management.noWorkspace": "Open a workspace before managing project memories.",`,
  },
  {
    kind: "cut",
    file: UI_LOCALE_EN,
    start: `"settings.memory.management.noWorkspace": "Open a workspace before managing project memories.",`,
    endBefore: `"settings.memory.management.legacySwitchRetired":`,
  },
  {
    kind: "cut",
    file: UI_LOCALE_EN,
    start: `"settings.memory.management.category.PROJECT_RULES": "Project rules",`,
    endBefore: `"settings.httpProxy": "HTTP Proxy",`,
  },
  {
    kind: "cut",
    file: UI_LOCALE_EN,
    start: `"chat.contextUsage.magicContext.title": "Magic Context budget",`,
    endBefore: `"tokenDebug.open": "Open token debug",`,
  },
  {
    kind: "cut",
    file: UI_LOCALE_EN,
    start: "// /ctx-*：命令本身的输出来自服务端（与 CLI/TUI 逐字相同），这里只补桌面自己才有的",
    endBefore: "// 编辑重发被 CLI 拒绝（restoreWarning / admission 竞态等）；rewind 可能已执行。",
  },
  {
    kind: "cut",
    file: UI_LOCALE_EN,
    start: `"chat.ctx.sessionRequired":`,
    endBefore: `"chat.toolbar.mode.label": "Switch mode",`,
  },
  {
    kind: "cut",
    file: UI_LOCALE_ZH,
    start:
      "// FORK（magic-context-memory-management / Step 8）：分区语义切换为跨会话「项目记忆」。",
    endBefore: `"settings.memory.management.noWorkspace": "请先打开一个工作区，再管理项目记忆。",`,
  },
  {
    kind: "cut",
    file: UI_LOCALE_ZH,
    start: `"settings.memory.management.noWorkspace": "请先打开一个工作区，再管理项目记忆。",`,
    endBefore: `"settings.memory.management.legacySwitchRetired":`,
  },
  {
    kind: "cut",
    file: UI_LOCALE_ZH,
    start: `"settings.memory.management.category.PROJECT_RULES": "项目规则",`,
    endBefore: `"settings.httpProxy": "HTTP 代理",`,
  },
  {
    kind: "cut",
    file: UI_LOCALE_ZH,
    start: `"chat.contextUsage.magicContext.title": "Magic Context 预算",`,
    endBefore: `"tokenDebug.open": "打开 Token 调试",`,
  },
  {
    // zh 的三条 `chat.ctx.*` 与注释是**连续**的（rejected / noResponse / sessionRequired
    // 中间没有 `chat.edit.rejected` 隔着），所以上一条规则已经一并删掉，不需要第二条。
    kind: "cut",
    file: UI_LOCALE_ZH,
    start: "// /ctx-*：命令本身的输出来自服务端（与 CLI/TUI 逐字相同），这里只补桌面自己才有的",
    endBefore: "// 编辑重发被 CLI 拒绝（restoreWarning / admission 竞态等）；rewind 可能已执行。",
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

  // ── CLI 帮助文本里的 ctx-* 命令（P2-1：旧 audit 口径看不见 kebab / `ctx-` 写法）──
  //
  // 命令面（`ctx-commands` / slash-command-surface）摘除后，这两份帮助表仍然逐行
  // 宣传 `/ctx-status` 等四条已被删掉的命令——用户照着敲只会得到 unknown command。
  // 两份 locale 必须同批删（`uiLocaleContract` 之外，CLI 侧也成对维护）。
  {
    kind: "del",
    file: "apps/zcode-cli/packages/i18n/src/locales/en-US.ts",
    start: "  /ctx-status           Show the Magic Context status snapshot for this session",
    end: "  /ctx-recomp [range]   Trigger one compartment recomputation pass (simplified)",
  },
  {
    kind: "del",
    file: "apps/zcode-cli/packages/i18n/src/locales/zh-CN.ts",
    start: "  /ctx-status           查看当前 session 的 Magic Context 状态快照",
    end: "  /ctx-recomp [range]   触发一次分舱重算（简化版）",
  },

  // ── 共享 test-id 常量：消费它们的 UI 件已被整件删除，留着即死导出 ──────────
  //
  // 两条都只被 `MemoryManagementSection.tsx` / `contextUsage.tsx` 引用（两文件已在
  // DEDICATED_PATHS 里）。旧 audit 抓不到它们是因为常量名与值都是 kebab 写法
  // （`settings-mcm-*` / `chat-context-usage-magic-context`）——P2-1 扩口径后由本案兜住。
  {
    kind: "del",
    file: "packages/shared/src/test-ids.ts",
    start: "// FORK（magic-context-memory-management / Step 8）：「记忆」分区改挂 magic-context",
    end: `export const TID_SETTINGS_MCM_ENTRY_EXPAND = "settings-mcm-entry-expand";`,
  },
  {
    kind: "del",
    file: "packages/shared/src/test-ids.ts",
    start:
      "/** context 面板内的 magic-context 预算段（D-13；字段缺席时该段不渲染，e2e 据此断言） */",
    end: `export const TID_CHAT_CONTEXT_USAGE_MAGIC_CONTEXT = "chat-context-usage-magic-context";`,
  },

  // package.json / knip.json：依赖、脚本、导出与忽略项
  ...PACKAGE_JSON_FILES.map((file) => ({
    kind: "json",
    file,
    // 声明只有 1 条 json 规则，运行期按文件展开成 6 个处理单元。打标是为了让
    // `ruleStats()` 能同时算出「源码声明条数」与「运行期处理单元数」——
    // 两个数手写在头部注释里必然漂移（旧版写 158 条、实际跑 163 个单元）。
    expandedFrom: "PACKAGE_JSON_FILES",
    mutate(json) {
      if (json.dependencies) delete json.dependencies["@zcode/magic-context"];
      if (json.devDependencies) delete json.devDependencies["@zcode/magic-context"];
      if (json.exports) delete json.exports["./ctx-commands"];
      if (json.scripts) {
        // 结构化分诊（cr-func 第 2 轮 P2-4）：**没有名字特例**。`test:v4-perf` 过去靠一条
        // 硬编码正则按段收窄（`if (name === "test:v4-perf") continue` + 名字白名单），
        // 「路径是唯一事实」恰恰没用在最需要它的那条长命令上；现在它与其它脚本走同一条
        // `planScriptCommand`：间接点名解析到被删 script、直接路径 token 命中清单、或
        // 段内只剩被删文件，三种形态自动收窄/丢弃，不认脚本名字。
        applyScriptPlan(json, file);
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
      "  --audit        grep 清单对账：未登记的 MC 残留即失败（exit 1；规则表锚点失配 exit 3）",
      "  --restore      git checkout 还原本脚本改过/删过的全部路径",
      "",
      formatRuleStats(),
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
/**
 * 规则表条数（**运行期统计**，不在注释里手写）。
 *
 * 口径有两层，混用就会漂移：
 *   - 「字面量声明条数」= `RULES` 数组里手写出来的对象数（每个算一条）；
 *   - 「运行期处理单元数」= `RULES.length`：`PACKAGE_JSON_FILES.map(...)` 那**一个**
 *     表达式会按 6 个 package/knip 文件展开成 6 个单元。
 *
 * 旧头部手写「158 条 = sub 121 / del 12 / cut 24 / json 1」没有错在字面量上
 * （157 条 + 1 个 map 表达式 = 158），错在把「声明」当成「实际执行」：运行期是
 * 163 个单元。文件头因此只写口径不写数字；`dry-run` / `--apply` 计划头部与
 * `--help` 都打印本函数的输出，增删规则后不需要同步任何注释。
 */
function ruleStats() {
  const literalByKind = { sub: 0, del: 0, cut: 0, json: 0 };
  let expanded = 0;
  for (const rule of RULES) {
    if (rule.expandedFrom === undefined) {
      literalByKind[rule.kind] = (literalByKind[rule.kind] ?? 0) + 1;
    } else {
      expanded += 1;
    }
  }
  const total = (byKind) => Object.values(byKind).reduce((sum, count) => sum + count, 0);
  return {
    literal: total(literalByKind),
    runtime: RULES.length,
    literalByKind,
    expanded,
    expandedFiles: PACKAGE_JSON_FILES.length,
  };
}

function formatRuleStats() {
  const { literal, runtime, literalByKind, expanded, expandedFiles } = ruleStats();
  const kinds = (byKind) =>
    ["sub", "del", "cut", "json"]
      .filter((kind) => byKind[kind] > 0)
      .map((kind) => `${kind} ${byKind[kind]}`)
      .join(" / ");
  return (
    `规则表：字面量声明 ${literal} 条（${kinds(literalByKind)}）` +
    (expanded > 0
      ? ` + json 展开 ${expanded} 个（${expandedFiles} 个 package/knip 文件 × 1）`
      : "") +
    ` = 运行期 ${runtime} 个处理单元`
  );
}

function expandDedicatedPaths() {
  return DEDICATED_PATHS.filter((relative) => existsSync(abs(relative)));
}

function runRules() {
  const perFile = new Map();
  let skipped = 0;
  DELETED_SCRIPTS.length = 0;
  REWRITTEN_SCRIPTS.length = 0;
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
  console.log(`\n${formatRuleStats()}`);
  console.log(`\n删整件（${deleted.length}）：`);
  for (const relative of deleted) console.log(`  - ${relative}`);
  console.log(`\n改写共享文件（${perFile.size}）：`);
  for (const [file, count] of [...perFile.entries()].sort()) {
    console.log(`  ~ ${file} (${count} 条规则)`);
  }
  // 被删的 package script 必须逐个列出来：它们的判据是「命令里引用了已删路径 / 已删
  // script」，不列名字的话，dry-run 只能看到 package.json 被改写过，看不出删的是哪几条。
  console.log(`\n删除 package script（${DELETED_SCRIPTS.length}）：`);
  for (const entry of [...DELETED_SCRIPTS].sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  - ${entry.file}: ${entry.name}（依据 ${entry.reason}）`);
  }
  // 收窄与删除分列：`test:v4-perf` 这类长命令只剔掉被删段/token，脚本本体要留着。
  console.log(`\n收窄 package script（${REWRITTEN_SCRIPTS.length}）：`);
  for (const entry of [...REWRITTEN_SCRIPTS].sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  - ${entry.file}: ${entry.name}（剔掉 ${entry.removed.join(", ")}）`);
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
  // 恢复后立刻跑 dry-run 会看到「陈留 dist 清理：N 个路径」，N 只统计**当前存在**的
  // 未跟踪构建产物：git checkout 不重建它们，所以那不是「恢复不完整」。
  console.log(
    `说明：--apply 清理的 ${STALE_DIST_PATHS.length} 个「陈留 dist」是**未跟踪的构建产物**，` +
      "git checkout 不会重建。恢复后立刻跑 dry-run 仍会看到「陈留 dist 清理：N 个路径」" +
      "（N 只统计当前存在的那部分）——那是待清理项，不是恢复遗漏；需要可运行产物时按包重新 build。",
  );
  return result.status ?? 1;
}

// ── 摘除后自检 ─────────────────────────────────────────────────────────────
const MC_IMPORT_RE = /(?:from|import)\s*\(?\s*["']@zcode\/magic-context(?:\/|["'])/;

/**
 * 摘除脚本自己的仓库相对路径（`git grep` 的输出口径：正斜杠、相对仓库根）。
 *
 * 第 8 条检查的扫描面由 `git grep -l "@zcode/magic-context"` 决定，本脚本必然在内：
 * `RULES` 的锚点与文档注释里满是 MC 字面量。这些字面量是**数据**，不是耦合，与
 * `--audit` 的 `KEEP_LIST` 对「本脚本」的登记同一口径（见 `KEEP_LIST` 末条）。
 * 所以按身份排除，而不是指望正则侥幸躲开——旧实现正是这里自匹配，导致这条门禁
 * 从首个 commit 起恒红（`--verify` 永远 8/9），真故障会被噪声淹掉。
 *
 * 排除**只覆盖注释/字面量里的命中**：脚本里真写了 `import "@zcode/magic-context"`
 * （关键字落在代码位置）照旧报红，摘除工具自己不能有 MC 运行期依赖。
 */
const SELF_RELATIVE = relative(REPO_ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, "/");

/** 按扩展名分派：只有 JS/TS 与 YAML 有注释语法，其余（`.json` 等）原文即代码。 */
const JS_SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const YAML_SOURCE_EXT = /\.ya?ml$/;

/** 这些字符之后出现的 `/` 才当正则起点（否则是除号）。`<` `>` 故意不在列（见下）。 */
const REGEX_ALLOWED_AFTER = new Set([
  "",
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "~",
  "^",
  "|",
]);

/**
 * 扫描 JS/TS 源码，返回「剥掉注释的文本」与「代码位置掩码」。
 *
 * 为什么不能直接用正则匹配原文：第 8 条的契约是「运行期导入（注释不算）」（见文件头
 * 第 8 条），而旧实现直接在原文上跑 `MC_IMPORT_RE`——注释里的示例
 * `await import("@zcode/magic-context")` 会被当成真导入。正则本身无法区分
 * 「注释里的 import」「字符串里的 import」与「真的 import」，所以先做一次词法扫描：
 * 注释内容替换成空格（换行保留，行号不变），字符串/模板/正则体原样保留但标记为
 * **非代码位置**。判据因此变成「`from`/`import` 关键字落在代码位置」，三件事各归其位：
 *   - 注释里的示例 → 关键字在注释里 → 不算；
 *   - 规则锚点 `} from "@zcode/magic-context/..."` 这种字符串字面量 → 关键字在字符串里
 *     → 不算（这也是本脚本自动排除之外的第二道保险）；
 *   - `import { x } from "@zcode/magic-context"` / `await import("@zcode/magic-context")`
 *     → 关键字是代码 → 算，照旧报红。
 *
 * 覆盖的形态：
 *   - `// ...` 行注释 → 到行尾；
 *   - `/* ... *\/` 块注释（含跨行、含 JSDoc `/** ... *\/`）→ 到闭合；
 *   - `'...'` / `"..."` → 原样拷贝，`\` 转义照抄：因此 `"http://x"`、`"a//b"` 里的
 *     `//` **不会**被当成注释起点（这是「字符串里的 // 不误判」的实现方式）；
 *   - 模板串 `` `...` `` → 原样拷贝；`${ ... }` 回到代码态（花括号可嵌套，模板串可
 *     嵌套），所以插值里的注释仍会被剥掉，而模板正文里的 `//` 保留；
 *   - 正则字面量 → 只在前一个有意义字符允许时进入（`(` `,` `=` `:` `[` `!` `&` `?`
 *     `{` `}` `;` `+` `-` `*` `%` `~` `^` `|` 与行首），体内原样拷贝：否则
 *     `/["']/` 里的引号会把扫描器带进假字符串态。`<` `>` **不在允许列**——`.tsx` 的
 *     `</div>` 会被误判成正则起点。
 *
 * 守势设计（宁可多剥少判、绝不把真导入藏起来）：
 *   - 字符串与正则扫描遇到换行即止。JS 的字符串与正则都不能跨行，因此 JSX 文本里的
 *     撇号（`Don't`）最坏只影响**那一行**，且那些字符仍按原文保留、仍会被匹配。
 */
function scanJsSource(source) {
  const len = source.length;
  const text = new Array(len);
  const isCode = new Uint8Array(len);
  // 帧：code（顶层代码或模板 `${` 内的代码，depth 数花括号）/ template（模板正文）
  const stack = [{ kind: "code", depth: 0 }];
  let prev = ""; // 上一个有意义的代码字符（空白与注释不算）
  let i = 0;

  const copy = (index) => {
    text[index] = source[index];
  };

  while (i < len) {
    const frame = stack[stack.length - 1];
    const ch = source[i];
    const next = source[i + 1];

    if (frame.kind === "template") {
      if (ch === "\\") {
        copy(i);
        if (i + 1 < len) copy(i + 1);
        i += 2;
      } else if (ch === "`") {
        copy(i);
        stack.pop();
        prev = "`";
        i += 1;
      } else if (ch === "$" && next === "{") {
        copy(i);
        copy(i + 1);
        stack.push({ kind: "code", depth: 0 });
        prev = "{";
        i += 2;
      } else {
        copy(i);
        i += 1;
      }
      continue;
    }

    // 行注释 → 到行尾（换行留给下一轮，行号不变）
    if (ch === "/" && next === "/") {
      while (i < len && source[i] !== "\n") {
        text[i] = " ";
        i += 1;
      }
      continue;
    }
    // 块注释（含跨行、含 JSDoc）
    if (ch === "/" && next === "*") {
      text[i] = " ";
      text[i + 1] = " ";
      i += 2;
      while (i < len && !(source[i] === "*" && source[i + 1] === "/")) {
        text[i] = source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < len) {
        text[i] = " ";
        text[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    // 单/双引号字符串：原样拷贝（`//`、`/*` 在这里都不是注释）
    if (ch === '"' || ch === "'") {
      const quote = ch;
      copy(i);
      i += 1;
      while (i < len) {
        const c = source[i];
        if (c === "\\") {
          copy(i);
          if (i + 1 < len) copy(i + 1);
          i += 2;
          continue;
        }
        copy(i);
        i += 1;
        if (c === quote || c === "\n") break;
      }
      prev = quote;
      continue;
    }
    // 模板串起点
    if (ch === "`") {
      copy(i);
      stack.push({ kind: "template" });
      i += 1;
      continue;
    }
    // 正则字面量（只在允许的位置）
    if (ch === "/" && REGEX_ALLOWED_AFTER.has(prev)) {
      copy(i);
      i += 1;
      let inClass = false;
      while (i < len) {
        const c = source[i];
        if (c === "\\") {
          copy(i);
          if (i + 1 < len) copy(i + 1);
          i += 2;
          continue;
        }
        copy(i);
        i += 1;
        if (c === "\n") break;
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
      }
      while (i < len && /[a-z]/i.test(source[i])) {
        copy(i);
        i += 1;
      }
      prev = "/";
      continue;
    }

    // 普通代码字符
    copy(i);
    isCode[i] = 1;
    i += 1;
    if (!/\s/.test(ch)) prev = ch;
    if (ch === "{") frame.depth += 1;
    else if (ch === "}") {
      if (frame.depth === 0 && stack.length > 1) stack.pop();
      else frame.depth = Math.max(0, frame.depth - 1);
    }
  }

  return { text: text.join(""), isCode };
}

/**
 * YAML 的 `#` 行注释（扫描面含 `.github/**`）。
 *
 * 只认「行首或前面是空白」的 `#`，所以 `https://x#frag`、`"a # b"` 里的 `#` 都保留
 * （YAML 本身也是这个规则）。同样返回掩码：注释位置不算代码。
 */
function scanYamlSource(source) {
  const text = source.split("");
  const isCode = new Uint8Array(source.length);
  let offset = 0;
  for (const line of source.split("\n")) {
    let quote = "";
    let commentAt = -1;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quote) {
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
        commentAt = i;
        break;
      }
    }
    if (commentAt >= 0) {
      for (let i = commentAt; i < line.length; i += 1) text[offset + i] = " ";
    } else {
      for (let i = 0; i < line.length; i += 1) isCode[offset + i] = 1;
    }
    offset += line.length + 1; // +1 = 被 split 吃掉的那个 \n
  }
  return { text: text.join(""), isCode };
}

/**
 * 「运行期导入」的唯一判据：`MC_IMPORT_RE` 的命中里，`from`/`import` 关键字
 * **落在代码位置**才算。注释与字面量里的命中一律不算（见文件头第 8 条的契约）。
 */
function findRuntimeImports(file, source) {
  const scanned = JS_SOURCE_EXT.test(file)
    ? scanJsSource(source)
    : YAML_SOURCE_EXT.test(file)
      ? scanYamlSource(source)
      : { text: source, isCode: new Uint8Array(source.length).fill(1) };
  // 每次新建带 g 的正则：复用会带 lastIndex 状态，漏掉第二条命中。
  const matcher = new RegExp(MC_IMPORT_RE.source, "g");
  const hits = [];
  for (let match = matcher.exec(scanned.text); match !== null; match = matcher.exec(scanned.text)) {
    if (scanned.isCode[match.index] === 1) hits.push(match.index);
  }
  return hits;
}

async function verifyChild() {
  const moduleUrl = (relative) => new URL(`file://${abs(relative).replace(/\\/g, "/")}`).href;
  const results = [];
  // 检查器自身缺陷的附注（不是 PASS/FAIL 条目，避免把「9 条」变成 10 条）。
  const verifyNotes = [];
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
    const offenders = [];
    const dataOnly = [];
    const selfData = [];
    const selfCode = [];
    for (const file of files) {
      const source = readFileSync(abs(file), "utf8");
      const hits = findRuntimeImports(file, source);
      if (hits.length === 0) {
        // 原文出现过、但关键字不在代码位置 → 只在注释/字面量里，契约明确不算。
        if (MC_IMPORT_RE.test(source)) {
          dataOnly.push(file);
          if (file === SELF_RELATIVE) selfData.push(file);
        }
        continue;
      }
      // 检查器自身：命中只落在注释/规则锚点里时，上面那条已经把它记进 dataOnly
      // （PASS + NOTE，口径与 KEEP_LIST 一致）。能走到这里说明关键字在**代码位置**
      // ——那是脚本里真的写了 MC 导入，摘除工具不该有这个依赖，照旧报红，不开后门。
      if (file === SELF_RELATIVE) {
        selfCode.push(file);
        offenders.push(file);
        continue;
      }
      offenders.push(file);
    }
    // 附注先登记：即便下面的 offender 检查抛错，`--verify` 仍会在 PASS/FAIL 之后打印
    // NOTE（results 与 notes 是两份，互不吞没）。
    if (selfData.length > 0) {
      // 「offender 是摘除工具自己」必须显式说出来：它是检查器的数据，不是摘除遗漏。
      // 不说的话，下一个人看到本文件出现在 grep 结果里又要从头查一遍——这条门禁
      // 从首个 commit 到 3f03a584 一直恒红，起因就是没人说出这句话。
      verifyNotes.push(
        `附注：${selfData.join(", ")} 命中 MC 字面量，但命中只落在注释 / 规则锚点` +
          `（字符串字面量）里——那是**摘除工具自身的数据**，按 KEEP_LIST 口径排除，` +
          "不是摘除遗漏，也不是待修项。",
      );
    }
    if (selfCode.length > 0) {
      verifyNotes.push(
        `附注：${selfCode.join(", ")} 在**代码位置**出现 MC 引用（真导入，不是注释/锚点），` +
          "已按普通 offender 报红——摘除工具本身不该在运行期依赖 MC 包。",
      );
    }
    if (offenders.length > 0) {
      throw new Error(`仍有运行期导入: ${offenders.join(", ")}`);
    }
    return (
      `${files.length} 个文件：${dataOnly.length} 个只在注释/字面量里出现` +
      `（不算运行期导入，含检查器自身 ${selfData.length} 个）`
    );
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
  for (const note of verifyNotes) console.log(`NOTE ${note}`);
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
/**
 * 残留口径（P2-1）：三种写法都算。
 *
 *   `magic-context`（kebab）—— 包名 / 路径 / 事件名 / CI 文件
 *   `magicContext`  （camel）—— 字段名、变量名
 *   `ctx-`                  —— `/ctx-status` 这类连字符命令与文件名
 *
 * 旧口径是 `git grep -il magiccontext`：`-i` 只抹平大小写，抹不平**连字符**。
 * 于是 kebab-only（`magic-context`）与 `ctx-`-only 的残留文件**完全不在对账范围内**
 * ——「未登记即失败」这条守卫漏掉了一整类形态（P1-1 的 workflow、P1-2 的 script
 * 都栽在这个盲区里）。
 */
const RESIDUE_RE = /magic[-_]?context|ctx-/i;

/** 对账扫描面：与旧 `git grep` 的路径参数一致（不扩大到 docs / 仓库根文档）。 */
const AUDIT_ROOTS = ["apps", "packages", "scripts", ".github"];
const AUDIT_FILES = ["knip.json"];
const AUDIT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".json",
  ".yml",
  ".yaml",
  ".md",
]);
const AUDIT_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".turbo",
  ".next",
  ".reference",
  ".zcode",
  "out",
]);

function* walkAuditFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (AUDIT_SKIP_DIRS.has(entry.name)) continue;
      yield* walkAuditFiles(join(dir, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf(".");
    if (dot < 0 || !AUDIT_EXTENSIONS.has(entry.name.slice(dot))) continue;
    yield join(dir, entry.name);
  }
}

/**
 * 对账走**虚拟树**：`runRules()` 先把每条规则的改写结果放进 `fileCache`，这里读到的
 * 就是「摘除后的内容」，整件删除路径直接跳过。
 *
 * 为什么不用 `git grep`：它只能看磁盘。于是 `--audit` 必须**真的 apply 过**才有意义，
 * 而摘除脚本的第一纪律是 dry-run 优先。虚拟树让同一条对账在 dry-run 上就能跑，
 * 判据（未登记即失败）一字不变。
 */
function collectAuditPaths() {
  const paths = [];
  for (const root of AUDIT_ROOTS) {
    for (const absolute of walkAuditFiles(abs(root))) {
      paths.push(relative(REPO_ROOT, absolute).split("\\").join("/"));
    }
  }
  for (const file of AUDIT_FILES) {
    if (existsSync(abs(file))) paths.push(file);
  }
  return paths;
}

function collectResidue() {
  const residue = [];
  for (const file of collectAuditPaths()) {
    if (isDedicatedPath(file)) continue;
    const content = readVirtual(file);
    if (content === null) continue;
    if (RESIDUE_RE.test(content)) residue.push(file);
  }
  return residue;
}

/**
 * 悬空 script：命令里点到的路径已被删、或间接点名的 script 已被删 → 摘除后必然 404。
 *
 * 这是 P1-2 的机读守卫。它不认 script 名（旧口径只认 `magic-context|mc-|ctx-` 前缀），
 * 只认「命令里那个文件/那条 script 还在不在」——所以 `test:settle-background` 这类名字里
 * 没有 MC 字样、却硬编码了 MC 测试文件的 script 一样会被抓。
 *
 * cr-func 第 2 轮 P2-4：**间接点名**（`pnpm -C <pkg> run <name>` / `pnpm --dir <pkg> run
 * <name>`）现在也进判据。旧实现只看带扩展名的路径 token，于是「引用了一条会被删掉的
 * script」既不进删除判据、也不进本检查——摘除后静默 404，要等 CI 真跑到才暴露。
 */
function collectDanglingScripts() {
  const dangling = [];
  for (const file of PACKAGE_JSON_FILES) {
    const raw = readVirtual(file);
    if (raw === null) continue;
    const packageDir = dirname(file) === "." ? "" : dirname(file);
    for (const [name, command] of Object.entries(JSON.parse(raw).scripts ?? {})) {
      if (typeof command !== "string") continue;
      const report = firstDanglingReference(file, packageDir, command);
      if (report !== null) dangling.push(`${file}: ${name} → ${report}`);
    }
  }
  return dangling;
}

/** 一条命令里第一个悬空引用（路径或间接 script 名）；没有则 null。 */
function firstDanglingReference(file, packageDir, command) {
  for (const segment of command.split(" && ")) {
    const reference = parseRunReference(segment);
    if (reference !== null) {
      const targetFile = reference.dir === null ? file : `${reference.dir}/package.json`;
      const targetRaw = readVirtual(targetFile);
      // 目标包本身已被整件删除（例如 MC 包）→ 引用方自己会在分诊里被删，这里不重复报。
      if (targetRaw === null) continue;
      let targetScripts;
      try {
        targetScripts = JSON.parse(targetRaw).scripts ?? {};
      } catch {
        continue;
      }
      if (typeof targetScripts[reference.name] !== "string") {
        return `script ${reference.dir ?? "."}: ${reference.name}（不存在 / 已被摘除删掉）`;
      }
      continue;
    }
    for (const candidate of scriptPathCandidates(segment, packageDir)) {
      // 只对「根本不存在」的路径报警：`dist/` 之类尚未构建的产物不在扫描面内，
      // 判据刻意收在「DEDICATED_PATHS 命中 或 文件真的不存在」两条上。
      if (isDedicatedPath(candidate) || !existsSync(abs(candidate))) return candidate;
    }
  }
  return null;
}

/**
 * `--audit` 的残留数**下限**（cr-func 第 2 轮 P2-6）。
 *
 * 实测值见 `audit()` 的输出；只设下限、不设等式：新增 MC 文件会让残留变多（正常），
 * 而扫描面变窄（跳过某个根、扩展名表漏一类文件、虚拟树读不到内容、grep 口径被改窄）
 * 会让残留掉到 0，而「全部登记」的判定照样绿——「残留 0 个」本身就是最可疑的绿。
 * 下限取实测值向下留一点余量：合法的整件删除会让它变小，**每次变小都要在这里改一次**
 * 并说明为什么，不许静默滑走。
 */
const MIN_RESIDUE_FILES = 55;

/**
 * 判据自身的**正例**（先例：`test-magic-context-plugin.mjs` 的 A0）。
 *
 * 为什么必须有：`--audit` 的两条判据都是「解析命令串」。解析器一旦退化成「什么都返回
 * null」（改坏正则、少一个分支、把 `run` 关键字判漏），对账会**零命中通过**——残留 0、
 * 悬空 0，看起来像最健康的一次检查。所以先在已知形状上跑一遍正例，任何一条不成立
 * 就整份对账失败（cr-func 第 2 轮 P2-4 的「变异下必须红」）。
 */
function auditSelfCheckFailures() {
  const failures = [];
  const expect = (label, actual, expected) => {
    const actualJson = JSON.stringify(actual);
    const expectedJson = JSON.stringify(expected);
    if (actualJson !== expectedJson)
      failures.push(`${label}: 期望 ${expectedJson}，实际 ${actualJson}`);
  };

  expect(
    "parseRunReference(--dir + run)",
    parseRunReference("pnpm --dir apps/zcode-cli/packages/core run test:foo"),
    { dir: "apps/zcode-cli/packages/core", name: "test:foo" },
  );
  expect("parseRunReference(run only)", parseRunReference("pnpm run test:bar"), {
    dir: null,
    name: "test:bar",
  });
  expect(
    "parseRunReference(--filter 定位不到包 → null（不猜））",
    parseRunReference("pnpm --filter @zcode/x run test:baz"),
    null,
  );
  expect(
    "pathCandidatesOfToken(apps/… 只按仓库根解析，不再二次拼接)",
    pathCandidatesOfToken("apps/x/scripts/a.mjs", "apps/a/b"),
    ["apps/x/scripts/a.mjs"],
  );
  expect(
    "pathCandidatesOfToken(包内相对路径按包目录解析)",
    pathCandidatesOfToken("scripts/a.mjs", "apps/a/b"),
    ["apps/a/b/scripts/a.mjs"],
  );
  expect(
    "planScriptCommand 只收窄命中的路径 token（长命令保留其余用例）",
    planScriptCommand(
      "tsx --test packages/ui/test/keep.test.ts packages/ui/test/magicContextPromptSurfaceOverrides.test.ts",
      { packageDir: "", packageFile: "package.json", seen: new Set() },
    ),
    {
      action: "rewrite",
      command: "tsx --test packages/ui/test/keep.test.ts",
      removed: ["packages/ui/test/magicContextPromptSurfaceOverrides.test.ts"],
    },
  );
  expect(
    "planScriptCommand 段内只剩被删路径 → 丢整段（节点式 test 命令）",
    planScriptCommand("node --test scripts/test-magic-context-turn-transform.mjs", {
      packageDir: "apps/zcode-cli/packages/bootstrap",
      packageFile: "apps/zcode-cli/packages/bootstrap/package.json",
      seen: new Set(),
    }),
    { action: "delete", reason: "path" },
  );
  return failures;
}

function audit() {
  // 先跑一遍规则（只写虚拟树），让对账看到的是**摘除后**的内容。
  //
  // FORK（cr-func 第 3 轮 P1-2）：`runRules()` 在规则表锚点失配时会 **throw**
  // （`findLine` 命中数 ≠ 1 / `sub` 子串命中数不符 / `json` 规则零改动，见
  // `applyEdit`），而本函数原先没有任何捕获。它挂在 CI 的
  // `Run magic-context suites` step 里（job 名 `magic-context suite`，见
  // `.github/workflows/mc-tests.yml`），于是「源文件漂移把某条锚点改坏」会以
  // 「未捕获异常 + 堆栈 + exit 1」的样子混进 MC 测试的红里——人第一眼必然读成
  // **MC 功能坏了**，而真相是脚本自己的维护信号。所以：
  //   · 单独 exit **3**（下限 / 未登记残留 / 悬空 script 三类仍是 1，按码可分诊）；
  //   · 文案开头就写明「非 MC 功能故障」并给出下一步（同步 RULES 锚点）。
  try {
    runRules();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗ 摘除脚本规则表失配（非 MC 功能故障）：${message}；请同步更新 RULES 锚点。`);
    console.error(
      "  含义：某条规则的定位串在源文件里不再唯一 / 子串命中数或 JSON 变更数变了 —— " +
        "改的是本脚本的 RULES，不是 magic-context。exit 3 = 规则表失配（本脚本约定）。",
    );
    return 3;
  }

  const selfCheck = auditSelfCheckFailures();
  if (selfCheck.length > 0) {
    console.error("✗ 对账判据自身的正例不成立（解析器退化会让对账零命中通过）：");
    for (const failure of selfCheck) console.error(`    ${failure}`);
    return 1;
  }

  const residue = collectResidue();
  const unaccounted = residue.filter((file) => {
    if (isDedicatedPath(file)) return false;
    return !KEEP_LIST.some((entry) => entry.paths.includes(file));
  });
  const dangling = collectDanglingScripts();

  let failed = false;
  // 下限断言排在「全部登记」之前：两者都绿才算对账通过，而「残留 0 个」永远先红在这里。
  const belowFloor = residue.length < MIN_RESIDUE_FILES;
  if (belowFloor) {
    failed = true;
    // 两种完全不同的成因会落到同一条断言上（cr-func 第 3 轮 P1-2）：
    //   ① 扫描面变窄（根 / 扩展名 / 虚拟树 / grep 口径被改小）→ 修判据；
    //   ② **合法地删掉了 MC 文件**（例如上游把某个 host 文件合并掉）→ 扫描面没坏，
    //      是基准变了，此时要**同步下调 `MIN_RESIDUE_FILES`** 并在注释里说明为什么。
    // 旧文案只说 ①，于是踩到 ② 的人（CI 红在 59 → 55 的那 4 个余量上）被明确告知了
    // 一个错误的原因，只能靠翻源码猜。两种成因必须并列。
    console.error(
      `✗ 残留文件只有 ${residue.length} 个，低于下限 ${MIN_RESIDUE_FILES}。两种成因，按证据二选一：`,
    );
    console.error(
      "  ① 扫描面变窄（AUDIT_ROOTS / 扩展名表 / 虚拟树读取 / RESIDUE_RE 口径之一被改小）" +
        "→ 修判据；否则「全部登记」已经退化成「什么都没扫到」；",
    );
    console.error(
      "  ② 合法地删了 MC 文件（文件真的不存在了，不是漏扫）→ 扫描面没坏、基准变了：" +
        `**同步下调 MIN_RESIDUE_FILES**（当前 ${MIN_RESIDUE_FILES}）并在该常量的注释里写清为什么。`,
    );
  }
  if (unaccounted.length > 0) {
    failed = true;
    console.error(`✗ 有 ${unaccounted.length} 个未登记残留（既不在删除清单，也不在 KEEP_LIST）：`);
    for (const file of unaccounted) console.error(`    ${file}`);
  } else if (!belowFloor) {
    console.log(
      `✓ ${residue.length} 个残留文件全部登记在 KEEP_LIST（或属于已删清单）` +
        `，不低于下限 ${MIN_RESIDUE_FILES}`,
    );
  }

  if (dangling.length > 0) {
    failed = true;
    console.error(`✗ 有 ${dangling.length} 个 package script 指向已删/不存在的文件或 script：`);
    for (const entry of dangling) console.error(`    ${entry}`);
  } else {
    console.log("✓ 没有 package script 指向已删/不存在的文件或 script（含 pnpm run 间接点名）");
  }

  if (failed) {
    console.error(
      "\n对账失败：要么把残留登记进 KEEP_LIST（写清理由），要么让对应的 RULES / DEDICATED_PATHS 处理它。",
    );
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
