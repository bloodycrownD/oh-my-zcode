#!/usr/bin/env node
/**
 * T-C2 — U2：dynamic-workflows skill 的「跨 provider 提示词加固」（纯文本断言）。
 *
 * ============================================================================
 * 这一步要钉死什么
 * ============================================================================
 *
 * 上游 v3.16.2（3c5b2276）给 `dynamic-workflows/SKILL.md` 加了「不得在用户未要求时
 * 把子代理换到另一个 provider 的模型；应先询问用户」的纪律句。SKILL.md 是直接进入
 * 模型上下文的提示词，纯文本改动没有任何运行时兜底——写错了只有靠这里的断言钉住。
 *
 * omz 侧只迁 3 个**有锚点**的 hunk（上游 §2 的 per-subagent model 段与 patterns.md
 * #13 不迁：omz 的 `agent()` facade 没有 model 参数，patterns.md 只有 §1-§10）：
 *   ① §16.1 `CreateWorkflow` 的 `subagent_model` 字段说明；
 *   ② §16.4 `AmendWorkflow` 的 `subagent_model` 字段说明；
 *   ③ §16.4 的 **Confirmation** 段（跨 provider 的修订必须走确认窗）。
 *
 * 同时钉住 omz 内部矛盾的修正：§2 的「Persona, frozen at creation」段原写
 * 「there is no per-subagent tool profile or model choice」，与 §16.1/§16.4 的
 * run 级 `subagent_model` 自相矛盾（omz 运行时确实支持 run 级 `subagent_model`，
 * 见 bootstrap/src/app/workflow-actor-model.ts）。改后口径是：**模型选择唯一杠杆
 * 是 run 级 `subagent_model`**，没有 per-subagent 的模型开关。
 *
 * 断言方式：node:fs 读 SKILL.md 原文 → 折叠空白 → 按章节/段落切片 → 逐句断言。
 * 不做任何网络/构建依赖，`node --test` 可直接跑。
 *
 * Exits 0 on success, 1 on any failed assertion（node:test 自行置退出码）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SKILL_PATH = fileURLToPath(
  new URL("../../bundled-skills/skills/dynamic-workflows/SKILL.md", import.meta.url),
);

const RAW = readFileSync(SKILL_PATH, "utf8");
/** 折叠所有空白（含换行）后的一句一段文本，便于跨行断言整句。 */
const FLAT = RAW.replace(/\s+/g, " ");

function section(startMarker, endMarker) {
  const start = FLAT.indexOf(startMarker);
  assert.notEqual(start, -1, `SKILL.md 缺少章节起始标记：${startMarker}`);
  const end = FLAT.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `SKILL.md 缺少章节结束标记：${endMarker}`);
  return FLAT.slice(start, end);
}

function paragraph(startMarker, endMarker) {
  const start = FLAT.indexOf(startMarker);
  assert.notEqual(start, -1, `SKILL.md 缺少段落起始标记：${startMarker}`);
  const end = FLAT.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `SKILL.md 缺少段落结束标记：${endMarker}`);
  return FLAT.slice(start, end);
}

test("T-C2 §16.1 CreateWorkflow.subagent_model 含跨 provider 纪律句", () => {
  const s = section("### 16.1 `CreateWorkflow`", "### 16.2 The facade");

  assert.match(
    s,
    /NEVER set a model under another provider the user did not ask for/,
    "CreateWorkflow.subagent_model 段缺少「不得擅自设置另一 provider 的模型」纪律句",
  );
  assert.match(
    s,
    /a bare name resolves only within the session's provider/,
    "CreateWorkflow.subagent_model 段缺少「裸模型名不跨 provider」的解释句",
  );
  assert.match(
    s,
    /ask the user before calling — model, provider, what it saves — and treat their yes as the request/,
    "CreateWorkflow.subagent_model 段缺少「先问用户、以用户的答复为请求」纪律句",
  );
});

test("T-C2 §16.4 AmendWorkflow.subagent_model 含跨 provider 纪律句", () => {
  const s = section("### 16.4 `AmendWorkflow`", "### 16.5 `SaveWorkflow`");

  assert.match(
    s,
    /never a model under another provider the user did not name — ask them first if you think one would help/,
    "AmendWorkflow.subagent_model 段缺少「不得用用户未点名的另一 provider 模型、先问用户」纪律句",
  );
});

test("T-C2 §16.4 Confirmation 段含跨 provider 修订须确认窗", () => {
  const s = paragraph("**Confirmation.**", "### 16.5 `SaveWorkflow`");

  assert.match(
    s,
    /an amendment that would put subagents on a provider neither the session nor the run used/,
    "Confirmation 段缺少「跨 provider 修订必须走确认窗」的表述",
  );
  assert.match(
    s,
    /that choice is the user's, and the window is where they make it/,
    "Confirmation 段缺少「该选择属于用户、在确认窗内由用户做出」的表述",
  );
});

test("T-C2 §2 persona 段无「无 per-subagent 模型选择」矛盾句", () => {
  const s = paragraph("**Persona, frozen at creation.**", "**Loops.**");

  assert.doesNotMatch(
    s,
    /no per-subagent tool profile or model choice/,
    "persona 段仍写着「没有 per-subagent 工具配置或模型选择」，与 run 级 subagent_model 矛盾",
  );
  assert.doesNotMatch(
    s,
    /no per-subagent model choice/,
    "persona 段仍写着「没有 per-subagent 模型选择」，与 run 级 subagent_model 矛盾",
  );
  assert.match(
    s,
    /the one lever is the run-level `subagent_model`/,
    "persona 段未点明「模型选择唯一杠杆是 run 级 subagent_model」",
  );
  assert.match(
    s,
    /with it unset they run on the session's model/,
    "persona 段未说明未设 subagent_model 时子代理跑在会话模型上",
  );
});

test("T-C2 未误迁上游 per-subagent model API（omz facade 无 model 参数）", () => {
  assert.doesNotMatch(
    FLAT,
    /\*\*Per-subagent model\*\*/,
    "上游 §2 的 per-subagent model 段不应迁入（omz facade 的 agent() 没有 model 参数）",
  );
  assert.doesNotMatch(
    FLAT,
    /agent\("judge", \{ model:/,
    "上游 §2 的 agent(..., { model }) 调用示例不应迁入（omz facade 的 agent() 没有 model 参数）",
  );
  assert.match(
    FLAT,
    /declare function agent\(name\?: string, persona\?: string \| AgentPersona\): Agent;/,
    "omz facade 的 agent() 声明应保持无 model 参数形态",
  );
});
