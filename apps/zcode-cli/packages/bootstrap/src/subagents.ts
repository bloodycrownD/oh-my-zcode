import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { migrateUserSubagentMarkdown, migrateSubagentStateFile } from "@zcode/shared/node";
import {
  parseAgentProfileFromMarkdown,
  type AgentProfile,
  type AgentProfileParseDiagnostic,
} from "@zcode/core";
import type { Logger, PluginMetadata } from "@zcode/contracts";
import {
  createAgentStateId,
  createPluginAgentStateId,
  parsePluginSubagentModelSelectionOverrides,
  modelSelectionSchema,
  type BuiltInSubagentModelSelectionOverrides,
  type BuiltInSubagentName,
  type ModelSelection,
  type PluginSubagentModelSelectionOverrides,
} from "@zcode/shared";

interface LoadZCodeAgentProfilesInput {
  logger?: Logger;
  storageRoot: string;
  workingDirectory: string;
}

interface LoadZCodeAgentProfilesResult {
  builtInModelSelectionOverrides: BuiltInSubagentModelSelectionOverrides;
  pluginAgentModelSelectionOverrides: PluginSubagentModelSelectionOverrides;
  diagnostics: AgentProfileParseDiagnostic[];
  profiles: AgentProfile[];
}

interface LoadPluginAgentProfilesInput {
  logger?: Logger;
  plugins: readonly PluginMetadata[];
  reservedProfileNames?: Iterable<string>;
  /** 来自已完成存储迁移的启动快照；不在插件 loader 另读磁盘或查询账号。 */
  modelSelectionOverrides?: PluginSubagentModelSelectionOverrides;
}

interface ParsedPluginAgentProfile {
  bareName: string;
  plugin: PluginMetadata;
  profile: AgentProfile;
}

const RESERVED_AGENT_NAMES = new Set(["general-purpose", "Explore"]);

export async function loadZCodeAgentProfiles(
  input: LoadZCodeAgentProfilesInput,
): Promise<LoadZCodeAgentProfilesResult> {
  const migration = await migrateUserSubagentMarkdown(join(input.storageRoot, "agents"));
  await migrateSubagentStateFile(join(input.storageRoot, "v2", "agents-state.json"));
  const roots = [
    { path: join(input.storageRoot, "agents"), source: "user" as const },
    { path: join(input.workingDirectory, ".zcode", "agents"), source: "project" as const },
  ];
  const diagnostics: AgentProfileParseDiagnostic[] = [];
  for (const failure of migration.failures) {
    diagnostics.push({
      code: "agent_read_failed",
      message: "Subagent Markdown migration failed; original file preserved",
      path: failure.path,
    });
    input.logger?.warn("Subagent Markdown migration failed", {
      module: "bootstrap.subagents",
      path: failure.path,
      error: String(failure.error),
    });
  }
  const agentState = readAgentState(input.storageRoot);
  const profiles: AgentProfile[] = [];

  for (const root of roots) {
    for (const filePath of listMarkdownFiles(root.path)) {
      const content = readFileSync(filePath, "utf8");
      const result = parseAgentProfileFromMarkdown({
        content,
        path: filePath,
        source: root.source,
      });
      if (result.diagnostic) {
        diagnostics.push(result.diagnostic);
        input.logger?.warn("Agent profile diagnostic", {
          code: result.diagnostic.code,
          message: result.diagnostic.message,
          module: "bootstrap.subagents",
          path: filePath,
        });
      }
      if (result.profile) {
        const profile = sanitizeProjectAgentProfile(result.profile);
        if (isDisabledUserProfile(profile, agentState.disabledAgentIds)) {
          continue;
        }
        profiles.push(profile);
      }
    }
  }

  input.logger?.debug("Agent profiles loaded", {
    diagnosticCount: diagnostics.length,
    module: "bootstrap.subagents",
    profileCount: profiles.length,
  });

  return {
    builtInModelSelectionOverrides: agentState.builtInModelSelectionOverrides,
    pluginAgentModelSelectionOverrides: agentState.pluginAgentModelSelectionOverrides,
    diagnostics,
    profiles,
  };
}

function sanitizeProjectAgentProfile(profile: AgentProfile): AgentProfile {
  if (profile.source !== "project" || profile.permissionMode === undefined) {
    return profile;
  }

  // 项目级 .zcode/agents/*.md 是仓库内容，不能通过 frontmatter
  // 把 child runtime 切到 bypass/yolo；用户级与受信插件 profile 不受影响。
  const { permissionMode: _permissionMode, ...safeProfile } = profile;
  return safeProfile;
}

export function loadPluginAgentProfiles(
  input: LoadPluginAgentProfilesInput,
): LoadZCodeAgentProfilesResult {
  const diagnostics: AgentProfileParseDiagnostic[] = [];
  const parsedProfiles: ParsedPluginAgentProfile[] = [];
  const reservedProfileNames = new Set([
    ...RESERVED_AGENT_NAMES,
    ...(input.reservedProfileNames ?? []),
  ]);

  for (const plugin of input.plugins) {
    if (!plugin.enabled) continue;
    const agents = plugin.components.find((group) => group.kind === "agent")?.items ?? [];
    for (const agent of agents) {
      const filePath = join(plugin.rootPath, "agents", `${agent.name}.md`);
      const result = parsePluginAgentProfile({ filePath, logger: input.logger, plugin });
      if (result.diagnostic) diagnostics.push(result.diagnostic);
      if (result.parsed) parsedProfiles.push(result.parsed);
    }
  }

  const bareNameCounts = countBareProfileNames(parsedProfiles);
  const profiles: AgentProfile[] = [];
  for (const parsed of parsedProfiles) {
    const override =
      input.modelSelectionOverrides?.[createPluginAgentStateId(parsed.plugin.id, parsed.bareName)];
    // 先替换完整选择再展开别名，避免同一插件的两个调用入口使用不同模型/档位。
    const canonical = {
      ...namespacePluginAgentProfile(parsed),
      ...(override ? { modelSelection: override } : {}),
    };
    profiles.push(canonical);

    const bareName = parsed.bareName.trim();
    if (bareNameCounts.get(bareName) === 1 && !reservedProfileNames.has(bareName)) {
      profiles.push({ ...canonical, name: bareName });
    } else if (reservedProfileNames.has(bareName)) {
      diagnostics.push({
        code: "agent_ambiguous_name",
        message: `Plugin agent bare name conflicts with an existing profile; use ${canonical.name}: ${bareName}`,
        path: canonical.path,
      });
    } else if ((bareNameCounts.get(bareName) ?? 0) > 1) {
      diagnostics.push({
        code: "agent_ambiguous_name",
        message: `Plugin agent bare name is ambiguous; use ${canonical.name}: ${bareName}`,
        path: canonical.path,
      });
    }
  }

  input.logger?.debug("Plugin agent profiles loaded", {
    diagnosticCount: diagnostics.length,
    module: "bootstrap.subagents",
    profileCount: profiles.length,
  });

  return {
    builtInModelSelectionOverrides: {},
    pluginAgentModelSelectionOverrides: {},
    diagnostics,
    profiles,
  };
}

function parsePluginAgentProfile(input: {
  filePath: string;
  logger?: Logger;
  plugin: PluginMetadata;
}): { diagnostic?: AgentProfileParseDiagnostic; parsed?: ParsedPluginAgentProfile } {
  try {
    const content = readFileSync(input.filePath, "utf8");
    const result = parseAgentProfileFromMarkdown({
      content,
      path: input.filePath,
      source: "user",
    });
    if (result.diagnostic) {
      input.logger?.warn("Plugin agent profile diagnostic", {
        code: result.diagnostic.code,
        message: result.diagnostic.message,
        module: "bootstrap.subagents",
        path: input.filePath,
        pluginId: input.plugin.id,
      });
      if (!result.profile) return { diagnostic: result.diagnostic };
    }
    if (!result.profile) return {};
    return {
      ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
      parsed: {
        bareName: result.profile.name,
        plugin: input.plugin,
        profile: result.profile,
      },
    };
  } catch (error) {
    return {
      diagnostic: {
        code: "agent_read_failed",
        message:
          error instanceof Error ? error.message : `Failed to read plugin agent: ${input.filePath}`,
        path: input.filePath,
      },
    };
  }
}

function namespacePluginAgentProfile(parsed: ParsedPluginAgentProfile): AgentProfile {
  return {
    ...parsed.profile,
    name: `${parsed.plugin.name}:${parsed.bareName}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countBareProfileNames(
  parsedProfiles: readonly ParsedPluginAgentProfile[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const parsed of parsedProfiles) {
    const name = parsed.bareName.trim();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function readAgentState(storageRoot: string): {
  builtInModelSelectionOverrides: BuiltInSubagentModelSelectionOverrides;
  pluginAgentModelSelectionOverrides: PluginSubagentModelSelectionOverrides;
  disabledAgentIds: Set<string>;
} {
  try {
    const raw = readFileSync(join(storageRoot, "v2", "agents-state.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      builtInModelSelectionOverrides?: unknown;
      pluginAgentModelSelectionOverrides?: unknown;
      disabledAgentIds?: unknown;
    };
    return {
      pluginAgentModelSelectionOverrides: parsePluginSubagentModelSelectionOverrides(
        parsed.pluginAgentModelSelectionOverrides,
      ),
      builtInModelSelectionOverrides: normalizeBuiltInSelectionOverrides(
        parsed.builtInModelSelectionOverrides,
      ),
      disabledAgentIds: new Set(
        Array.isArray(parsed.disabledAgentIds)
          ? parsed.disabledAgentIds.filter(
              (id): id is string => typeof id === "string" && id.trim().length > 0,
            )
          : [],
      ),
    };
  } catch {
    return {
      builtInModelSelectionOverrides: {},
      pluginAgentModelSelectionOverrides: {},
      disabledAgentIds: new Set(),
    };
  }
}

function normalizeBuiltInSelectionOverrides(
  structured: unknown,
): BuiltInSubagentModelSelectionOverrides {
  const result: BuiltInSubagentModelSelectionOverrides = {};
  const structuredRecord = isRecord(structured) ? structured : {};
  const generalPurpose = modelSelectionSchema.safeParse(structuredRecord["general-purpose"]);
  const explore = modelSelectionSchema.safeParse(structuredRecord.Explore);
  if (generalPurpose.success) result["general-purpose"] = generalPurpose.data;
  if (explore.success) result.Explore = explore.data;
  return result;
}

const BUILT_IN_AGENT_NAMES = [
  "general-purpose",
  "Explore",
] as const satisfies readonly BuiltInSubagentName[];

export interface AgentStateOverrideProviderOptions {
  /** 写侧（host 设置页）与启动读侧共用的 storage 根；状态文件为 `<storageRoot>/v2/agents-state.json`。 */
  storageRoot: string;
  logger?: Logger;
  /**
   * override 指向的模型当前不可用（Provider Registry 查不到）时丢弃该条目并 warn，
   * 让 spawn 回退 profile 默认。缺省不校验（由 core 的 resolveSubagentSelection
   * fail-visible 路径负责可见性）。
   */
  isModelSelectionAvailable?: (selection: ModelSelection) => boolean;
}

/**
 * FORK（bugfix-batch-20261011 / Step 6）：内置子智能体模型 override 的
 * per-spawn 活读源。写侧协议不变（设置页 → Local Host 写 agents-state.json 的
 * builtInModelSelectionOverrides）；读侧从「App 创建时读一次、归一化后冻结进
 * runtimeConfig.subagents」改为每次 spawn 现读：
 *
 * - 同步读 <2KB 的状态文件；内容与上次完全相同（同一字符串）时直接复用已归一化
 *   结果，不重新 parse/normalize——与 mtime 缓存等效，且不受「同毫秒同尺寸改写」
 *   的粒度坑影响；
 * - 文件缺失/不可读、JSON 损坏 = fail-open 返回 undefined，core 回退启动冻结快照；
 *   不写失败缓存，写侧恢复后下一次 spawn 自然跟上；
 * - `builtInModelSelectionOverrides` 字段缺失或不是对象 = 无法确定活值，同样
 *   fail-open（写侧 read-modify-write 恒写该字段，缺字段只可能是外部/旧格式写入，
 *   此时信任启动快照）；字段存在且为 `{}`（用户把 override 改回「继承」）则如实
 *   返回空表 = 所有内置 override 当场清除；
 * - override 指向 Registry 中不存在的模型时丢弃该条目并 warn（回退 profile 默认），
 *   不让 spawn 走进 core 的 fail-visible 抛错；
 * - warn 按签名去重：同一失效形态只记一次，不随每次 spawn 刷屏。
 *
 * 同步 IO 不阻塞 spawn：调用方（core subagent port）在 spawn 前同步调用，失败
 * 一律捕获。
 */
export function createAgentStateOverrideProvider(
  options: AgentStateOverrideProviderOptions,
): () => BuiltInSubagentModelSelectionOverrides | undefined {
  const agentsStatePath = join(options.storageRoot, "v2", "agents-state.json");
  let cachedRaw: string | undefined;
  let cachedOverrides: BuiltInSubagentModelSelectionOverrides | undefined;
  let warnedSignature: string | undefined;

  const warnOnce = (signature: string, message: string, context: Record<string, unknown>): void => {
    if (warnedSignature === signature) return;
    warnedSignature = signature;
    options.logger?.warn(message, { module: "bootstrap.subagents", ...context });
  };

  const readOverrides = (): BuiltInSubagentModelSelectionOverrides | undefined => {
    let raw: string;
    try {
      raw = readFileSync(agentsStatePath, "utf8");
    } catch (error) {
      warnOnce("unreadable", "Subagent agents-state.json 不可读；模型 override 回退启动快照", {
        path: agentsStatePath,
        error: String(error),
      });
      return undefined;
    }
    if (raw === cachedRaw) return cachedOverrides;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // 写侧是原子写，torn read 理论不可见；真出现时 fail-open 且不写缓存——
      // 写侧修好后下一次 spawn 自然恢复，无需重启。
      warnOnce(
        `corrupt:${raw.length}`,
        "Subagent agents-state.json 解析失败；模型 override 回退启动快照",
        { path: agentsStatePath, error: String(error) },
      );
      return undefined;
    }
    if (!isRecord(parsed) || !isRecord(parsed.builtInModelSelectionOverrides)) {
      // 字段缺失/类型不符 = 无法确定活值（见函数注释）：信任启动快照。
      // 这是合法状态（用户从未设置过 override），不记 warn。
      return undefined;
    }

    const normalized = normalizeBuiltInSelectionOverrides(parsed.builtInModelSelectionOverrides);
    // 可用性过滤每次现算（不缓存结果）：Registry 可能在不同 spawn 之间变化，
    // 缓存会把「模型已不可用」的 override 继续递给 core 触发 fail-visible 抛错。
    const result: BuiltInSubagentModelSelectionOverrides = {};
    for (const agentName of BUILT_IN_AGENT_NAMES) {
      const selection = normalized[agentName];
      if (selection === undefined) continue;
      if (options.isModelSelectionAvailable?.(selection) === false) {
        warnOnce(
          `unavailable:${agentName}:${selection.providerId}/${selection.modelId}`,
          "Subagent model override 指向不可用模型；丢弃该 override，回退 profile 默认",
          {
            agentName,
            path: agentsStatePath,
            providerId: selection.providerId,
            modelId: selection.modelId,
          },
        );
        continue;
      }
      result[agentName] = selection;
    }
    cachedRaw = raw;
    cachedOverrides = result;
    return result;
  };

  return () => {
    try {
      return readOverrides();
    } catch {
      // 读侧任何意外都不得阻塞 spawn；上一层 core 会回退启动冻结快照。
      return undefined;
    }
  };
}

function isDisabledUserProfile(
  profile: AgentProfile,
  disabledAgentIds: ReadonlySet<string>,
): boolean {
  if (profile.source !== "user") {
    return false;
  }
  return disabledAgentIds.has(
    createAgentStateId({
      name: profile.name,
      scope: "user",
      source: "user",
    }),
  );
}

function listMarkdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  if (!statSync(root).isDirectory()) return [];

  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...listMarkdownFiles(path));
      continue;
    }
    if (entry.isFile() && /\.(md|markdown)$/iu.test(entry.name)) {
      result.push(path);
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}
