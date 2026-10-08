#!/usr/bin/env node
/**
 * PL-G-1（prompt-language-option）：ContextBuilder 语言选择的常驻回归网。
 *
 * 三组断言：
 *
 *   A. **zh-CN 装配**：cli_prefix（「你是 omz…」）、identity（intro / SECURITY_NOTICE /
 *      Harness 三段）、dynamic_behavior（含「与用户交流时使用简体中文」显式指令）、
 *      context_management、session_guidance、desktop 段（仅 presentationSurface=
 *      zcode_desktop 输出）全部走中文文案。
 *
 *   B. **未覆盖段落回落英文**：同一次构建里 memory / env_info / skills（meta_user）/
 *      request_user_context / current_date 仍英文（Layer 1 刻意不中文化），且不因
 *      language=zh-CN 出现中文。
 *
 *   C. **en-US / undefined 与工作流子代理分支**：en-US 与 undefined 下交互段全英文；
 *      desktop 段仅 desktop 表面输出；workflowActor 分支下交互式身份段（cli_prefix /
 *      identity / desktop / dynamic_behavior / session_guidance）全部缺席，
 *      workflow_actor_identity 的基座（契约 + SECURITY_NOTICE + Harness）保持英文
 *      ——子代理面向程序，中文化留给后续层次评估（builder 刻意保留 context_management
 *      与其后各段，故该段随 language 走）。
 *
 *   D. **PL-B-2**：`isChinesePromptLanguage` 认 POSIX 风格标签（zh_CN / zh-TW / ZH /
 *      zh_CN.UTF-8），不认 en / auto / undefined。
 *
 * 依赖已构建的 dist：`pnpm --filter @zcode/core build`（以及 @zcode/shared /
 * @zcode/model-option-map 的 dist 兜底，见下方 resolve 钩子——与
 * test-sidecar-model-request.mjs 同一范式）。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map"]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const segments = specifier.split("/");
    const packageName = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : TS_SOURCE_PACKAGES.has(segments.slice(0, 2).join("/"))
        ? segments.slice(0, 2).join("/")
        : null;
    if (packageName !== null) {
      const distRoot = `${REPO_ROOT}packages/${packageName.slice("@zcode/".length)}/dist/`;
      const subpath = specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
      for (const candidate of [`${distRoot}${subpath}.js`, `${distRoot}${subpath}/index.js`]) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
      throw new Error(`no compiled dist for "${specifier}" — build ${packageName} first`);
    }
    return nextResolve(specifier, context);
  },
});

const { ContextBuilder } = await import(
  new URL("../dist/context/builder.js", import.meta.url).href
);
const { isChinesePromptLanguage } = await import(
  new URL("../dist/context/prompt-copy-zh-cn.js", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — ContextBuilder language selection (zh-CN / en-US / undefined / workflowActor)"
      : `TEST FAIL — ContextBuilder language selection (exit code ${code})`,
  );
});

/** CJK 统一表意文字；用来断言「这一段不应该出现中文」。 */
const CJK = /[\u4e00-\u9fff]/;

const SKILL = {
  name: "demo-skill",
  description: "Explains how to run the demo workflow.",
  whenToUse: "when the demo workflow needs to be run",
  path: "D:/tmp/project/.omz/skills/demo/SKILL.md",
  directory: "D:/tmp/project/.omz/skills/demo",
  rootPath: "D:/tmp/project/.omz/skills",
  scope: "project",
  source: "workspace",
  safeToAutoLoad: true,
  frontmatterKeys: ["name", "description"],
};

const USER_INSTRUCTIONS = {
  filePath: "D:/tmp/project/AGENTS.md",
  fileName: "AGENTS.md",
  content: "Always keep the workspace tidy and run the test suite before finishing.",
  bytesRead: 70,
  sizeBytes: 70,
  truncated: false,
};

function buildConfig(language, overrides = {}) {
  return new ContextBuilder({
    workingDirectory: "D:/tmp/project",
    envInfo: {
      cwd: "D:/tmp/project",
      platform: "win32",
      shell: "cmd.exe",
      osVersion: "10.0.26200",
      nodeVersion: "v24.14.0",
      isGitRepository: false,
    },
    currentDate: "2026-10-09",
    memoryRoot: "D:/tmp/project/.omz/memory",
    skills: { skills: [SKILL], diagnostics: [], totalDiscovered: 1 },
    userInstructions: USER_INSTRUCTIONS,
    guidanceToolNames: ["Skill"],
    language,
    ...overrides,
  });
}

function sectionBySource(result, source) {
  return result.sections.find((section) => section.source === source);
}

function mustSection(result, source) {
  const section = sectionBySource(result, source);
  assert.ok(section, `expected a section with source "${source}"`);
  return section;
}

// ── A: zh-CN 装配 ────────────────────────────────────────────────────────────

test("A1: zh-CN uses Chinese copy for cli_prefix / identity / desktop / dynamic / guidance / context_management", () => {
  const result = buildConfig("zh-CN", { presentationSurface: "zcode_desktop" }).build();

  assert.equal(mustSection(result, "cli_prefix").content, "你是 omz，一个交互式编码助手");

  const identity = mustSection(result, "identity").content;
  assert.match(identity, /你是 omz 的交互式编码代理/);
  assert.match(identity, /重要：仅在获得明确的授权场景|重要：仅在获得明确授权/);
  assert.match(identity, /# Harness/);
  assert.match(identity, /工具调用之外输出的文本/);

  assert.match(mustSection(result, "desktop_context").content, /# omz 桌面端上下文/);
  assert.doesNotMatch(mustSection(result, "desktop_context").content, /ZCode Desktop Context/);

  const dynamicBehavior = mustSection(result, "dynamic_behavior").content;
  assert.match(dynamicBehavior, /# 与用户交流/);
  assert.match(dynamicBehavior, /与用户交流时使用简体中文/);

  assert.match(mustSection(result, "session_guidance").content, /# 会话特定指引/);
  assert.match(mustSection(result, "session_guidance").content, /`\/<skill-name>`/);

  assert.match(mustSection(result, "context_management").content, /# 上下文管理/);

  // systemMessages：第一条 system message 就是中文 cli prefix（装配顺序不变）。
  const firstSystem = result.systemMessages[0];
  assert.equal(firstSystem.role, "system");
  assert.match(String(firstSystem.content), /你是 omz，一个交互式编码助手/);
});

// ── B: 同次构建里未覆盖段落仍英文 ────────────────────────────────────────────

test("B1: memory / env_info / skills / meta_user / current_date stay English under zh-CN", () => {
  const result = buildConfig("zh-CN", { presentationSurface: "zcode_desktop" }).build();

  for (const source of ["memory", "env_info", "skills", "request_user_context", "current_date"]) {
    const section = mustSection(result, source);
    assert.doesNotMatch(
      section.content,
      CJK,
      `${source} 不在 Layer 1 中文化范围内，绝不能出现中文`,
    );
  }
  assert.match(mustSection(result, "env_info").content, /Environment|Working directory|Platform/);
  assert.match(mustSection(result, "skills").content, /available for use with the Skill tool/);

  // meta_user 包装语同样是英文（builder 的 buildContextMetaUserBody 不在改动面内）。
  for (const attachment of result.metaUserAttachments) {
    assert.doesNotMatch(attachment.content, CJK);
  }

  // 工具描述不经 system prompt 镜像（`setToolRegistry` 是兼容空实现）：
  // 本次构建里不存在 tools 段，中文化自然不会溢出到工具面。
  assert.equal(
    sectionBySource(result, "tools"),
    undefined,
    "工具说明由 model request 的 tools 字段承载，不应出现在 system sections",
  );
});

// ── C: en-US / undefined / desktop 门控 / workflowActor ──────────────────────

test("C1: en-US and undefined fall back to the English originals", () => {
  for (const language of ["en-US", undefined]) {
    const result = buildConfig(language, { presentationSurface: "zcode_desktop" }).build();

    assert.equal(
      mustSection(result, "cli_prefix").content,
      "You are ZCode, an interactive coding agent",
    );
    assert.match(mustSection(result, "identity").content, /You are an interactive ZCode agent/);
    assert.match(mustSection(result, "identity").content, /^# Harness$/m);
    assert.match(mustSection(result, "dynamic_behavior").content, /# Communicating with the user/);
    assert.match(mustSection(result, "context_management").content, /# Context management/);
    assert.match(mustSection(result, "desktop_context").content, /# ZCode Desktop Context/);
  }
});

test("C2: desktop_context only appears for presentationSurface=zcode_desktop", () => {
  const terminal = buildConfig("zh-CN", { presentationSurface: "terminal" }).build();
  assert.equal(sectionBySource(terminal, "desktop_context"), undefined);

  const desktop = buildConfig("zh-CN", { presentationSurface: "zcode_desktop" }).build();
  assert.ok(sectionBySource(desktop, "desktop_context"));
});

test("C3: workflowActor drops the interactive segments; its base identity stays English under zh-CN", () => {
  const result = buildConfig("zh-CN", {
    presentationSurface: "zcode_desktop",
    workflowActor: { name: "reviewer" },
  }).build();

  for (const source of [
    "cli_prefix",
    "identity",
    "desktop_context",
    "dynamic_behavior",
    "session_guidance",
  ]) {
    assert.equal(
      sectionBySource(result, source),
      undefined,
      `工作流子代理不应有交互式段 ${source}`,
    );
  }

  const actorIdentity = mustSection(result, "workflow_actor_identity").content;
  assert.match(actorIdentity, /You are a subagent inside a dynamic workflow run/);
  assert.match(actorIdentity, /IMPORTANT: Assist with authorized security testing/);
  assert.match(actorIdentity, /# Harness/);
  assert.match(actorIdentity, /# Working inside a workflow/);
  assert.doesNotMatch(actorIdentity, CJK, "子代理身份契约刻意保持英文");

  // builder 刻意保留 memory 与其后各段：context_management 随 runtime language 走中文
  // （见 context/builder.ts 的「保留 memory 与其后各段」注释），这里按事实钉住。
  assert.match(mustSection(result, "context_management").content, /# 上下文管理/);
});

// ── D: PL-B-2 POSIX 风格标签 ─────────────────────────────────────────────────

test("D1 (PL-B-2): isChinesePromptLanguage accepts POSIX-style and regional zh tags", () => {
  for (const zh of ["zh_CN", "zh-TW", "ZH", "zh", "zh_CN.UTF-8", "zh-Hans", " zh_CN "]) {
    assert.equal(isChinesePromptLanguage(zh), true, `${zh} 应按中文处理`);
  }
  for (const notZh of ["en", "en-US", "auto", "fr", "C", "", undefined]) {
    assert.equal(isChinesePromptLanguage(notZh), false, `${String(notZh)} 不应按中文处理`);
  }
});
