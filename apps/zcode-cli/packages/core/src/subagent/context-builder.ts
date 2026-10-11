import type { Model, ModelInputMessage } from "@zcode/contracts";
import { ContextBuilder } from "../context/builder.js";
import {
  buildContextMetaUserBody,
  buildSkillsMetaUserBody,
  type ContextBuilderConfig,
  type ContextBuildResult,
  type ContextSection,
  type EnvInfo,
} from "../context/index.js";
import { buildCliPrefixSection } from "../context/sections/cli-prefix.js";
import { buildCurrentDateSection } from "../context/sections/current-date.js";
import { buildMagicContextSectionEntry } from "../context/sections/magic-context.js";
import { buildRequestUserContextSection } from "../context/sections/request-user-context.js";
import { buildSkillsSection } from "../context/sections/skills.js";
import { estimateTokens } from "../context/utils.js";
import { buildSubagentCommonNotes, buildSubagentEnvironmentContext } from "./system-prompt.js";

export interface SubagentContextBuilderConfig {
  agentPrompt: string;
  currentDate?: string;
  envInfo: EnvInfo;
  model?: Model;
  skillMetadataBudget?: number;
  skills?: ContextBuilderConfig["skills"];
  userInstructions?: ContextBuilderConfig["userInstructions"];
  /**
   * Step 13：已装配好的 `## Magic Context` 段（子智能体档：只保留 §N§ + ctx_reduce
   * 机制）。子代理同样注册 ctx 工具，因此同样需要知道「盖过章的东西去了哪、没有 tool
   * result 就不能编」这两条；上游用 `buildMagicContextSection` 的 subagentMode 分支
   * 产出这段。装配权在 bootstrap，见 `runtime/helpers/magic-context-prompt-section.ts`。
   */
  magicContextSection?: string;
}

const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" as const };

export class SubagentContextBuilder extends ContextBuilder {
  private subagentConfig: SubagentContextBuilderConfig;

  constructor(config: SubagentContextBuilderConfig) {
    super(toBaseContextBuilderConfig(config));
    this.subagentConfig = config;
  }

  override setEnvInfo(envInfo: EnvInfo): this {
    this.subagentConfig = {
      ...this.subagentConfig,
      envInfo,
    };
    return this;
  }

  override build(): ContextBuildResult {
    const sections = buildSubagentContextSections(this.subagentConfig);
    const orderedSections = orderSubagentSections(sections);
    const totalChars = orderedSections.reduce((sum, section) => sum + section.chars, 0);
    const totalTokens = orderedSections.reduce((sum, section) => sum + section.tokens, 0);
    const systemSections = orderedSections.filter(
      (section) => section.injectionTarget === "system",
    );
    // 逐段标记会耗尽缓存断点额度，导致对话末尾标记被丢弃；正文合并时保留各段自带的换行。
    const systemMessages = [
      systemSections.filter((section) => section.source === "cli_prefix"),
      systemSections.filter((section) => section.source !== "cli_prefix"),
    ]
      .filter((group) => group.length > 0)
      .map(
        (group): ModelInputMessage => ({
          role: "system",
          content: joinSubagentSystemSectionContents(group),
          cacheControl: EPHEMERAL_CACHE_CONTROL,
        }),
      );
    const skillsContent = buildSkillsMetaUserBody(
      orderedSections.filter(
        (section) => section.injectionTarget === "meta_user" && section.source === "skills",
      ),
    );
    const contextContent = buildContextMetaUserBody(
      orderedSections.filter(
        (section) => section.injectionTarget === "meta_user" && section.source !== "skills",
      ),
    );

    return {
      sections: orderedSections,
      totalChars,
      totalTokens,
      systemMessages,
      metaUserAttachments: [
        ...(skillsContent
          ? [
              {
                source: "skills_listing" as const,
                content: skillsContent,
              },
            ]
          : []),
        ...(contextContent
          ? [
              {
                source: "context_prefix" as const,
                content: contextContent,
              },
            ]
          : []),
      ],
    };
  }
}

export function createSubagentContextBuilder(
  config: SubagentContextBuilderConfig,
): SubagentContextBuilder {
  return new SubagentContextBuilder(config);
}

function buildSubagentContextSections(config: SubagentContextBuilderConfig): ContextSection[] {
  const sections: ContextSection[] = [buildCliPrefixSection()];
  const agentPrompt = config.agentPrompt.trimEnd();
  if (agentPrompt) {
    sections.push(
      createSubagentSection({
        name: "Subagent Agent Prompt",
        source: "subagent_agent_prompt",
        cacheHint: "stable",
        // 空 prompt 不是语义段，不能让左边界单独成为 system block。
        // ZCode by design：Subagent agent prompt 自带相对 CLI prefix 的单换行左边界。
        content: `\n${agentPrompt}`,
      }),
    );
  }

  sections.push(
    createSubagentSection({
      name: "Subagent Notes",
      source: "subagent_notes",
      cacheHint: "stable",
      // ZCode by design：后续 Subagent system block 统一自带双换行左边界。
      content: `\n\n${buildSubagentCommonNotes()}`,
    }),
    createSubagentSection({
      name: "Subagent Environment",
      source: "subagent_environment",
      cacheHint: "dynamic",
      content: `\n\n${buildSubagentEnvironmentContext({
        agentPrompt: config.agentPrompt,
        envInfo: config.envInfo,
        model: config.model,
      })}`,
    }),
  );

  // Step 13：magic-context 子智能体档段。放在 request-user-context 之前——它是 agent
  // 行为契约（怎么对待桌面上的 §N§ 与工具结果），不该被「以下是工作区说明」隔开。
  const magicContextEntry = buildMagicContextSectionEntry(config.magicContextSection);
  if (magicContextEntry) {
    sections.push(magicContextEntry);
  }

  const requestUserContextSection = buildRequestUserContextSection({
    userInstructions: config.userInstructions,
  });
  if (requestUserContextSection) {
    sections.push(requestUserContextSection);
  }
  const currentDateSection = buildCurrentDateSection(config.currentDate);
  if (currentDateSection) {
    sections.push(currentDateSection);
  }
  if (config.skills) {
    const skillsSection = buildSkillsSection({
      outcome: config.skills,
      metadataBudget: config.skillMetadataBudget,
    });
    if (skillsSection) {
      sections.push(skillsSection);
    }
  }

  return sections;
}

function orderSubagentSections(sections: ContextSection[]): ContextSection[] {
  return [
    ...sections.filter((section) => section.injectionTarget === "system"),
    ...sections.filter((section) => section.injectionTarget === "meta_user"),
  ];
}

/**
 * FORK (upstream-v3.15.1-backport): 上游合并 system 段用 `join("")`，依赖各段自带边界
 * 换行；fork 新增的 `## Magic Context` 段以 heading 起头（无前导换行），而它前面的
 * Subagent Environment 段以 `</env>`/model 行收尾（无尾随换行），合并后出现
 * `</env>## Magic Context` 粘连。这里按「段尾已有 / 无换行」两种情况归一相邻段边界：
 * 前段尾或后段首自带换行时原样相接，两侧都不自带时补一个 "\n"；Notes/Environment 的
 * 自带 "\n\n" 前导等既有字节不受影响（该函数对单段组是零操作）。
 */
function joinSubagentSystemSectionContents(sections: ContextSection[]): string {
  return sections.reduce(
    (merged, section) =>
      merged.length === 0 || merged.endsWith("\n") || section.content.startsWith("\n")
        ? `${merged}${section.content}`
        : `${merged}\n${section.content}`,
    "",
  );
}

function createSubagentSection(input: {
  name: string;
  source: ContextSection["source"];
  cacheHint: ContextSection["cacheHint"];
  content: string;
}): ContextSection {
  return {
    ...input,
    injectionTarget: "system",
    chars: input.content.length,
    tokens: estimateTokens(input.content),
    preview: input.content.slice(0, 100),
  };
}

function toBaseContextBuilderConfig(config: SubagentContextBuilderConfig): ContextBuilderConfig {
  return {
    workingDirectory: config.envInfo.cwd,
    envInfo: config.envInfo,
    model: config.model,
    currentDate: config.currentDate,
    skillMetadataBudget: config.skillMetadataBudget,
    skills: config.skills,
  };
}
