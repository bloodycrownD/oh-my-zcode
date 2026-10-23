#!/usr/bin/env node
/**
 * 幽灵消息事故（2026-10-23）回归——MC 反投影的输入身份元数据守卫。
 *
 * 事故链（全部落库实证，见 docs/iterations/backlog-sweep 与事故调查记录）：
 *   1. MC 压缩重排让 `originals`（按消息 id 查找的「原 entry」映射）与 transform
 *      输出错位：一段 assistant 旁白被换到真实 user_steer 输入的 id/role 上。
 *   2. 旧 `rebuildEntry` 把 original 的 `{source:"real_user", inputPresentation:
 *      "user_steer"}` **整拷**到重建条目——旁白内容就此伪造了「真实用户输入」身份。
 *   3. request 组装（core `projectIncomingMessageEntries`）看到 inputPresentation
 *      就把该内容包装成 "The user sent a new message" 注入运行中的轮。
 *
 * 修复 = 两道守卫（`projectMagicContextEntries` 配对守卫 + `rebuildEntry` 元数据剥离），
 * 本文件用**桩 transform** 驱动真实反投影复刻事故形状：
 *
 *   1. 压缩错配嫁接（id 换到 steer 头上 + role 翻转 + 原 steer 消息被丢弃）
 *      → 重建条目**不得**携带 inputPresentation / source:"real_user"。
 *   2. 合法压缩改写（id/role 保持、内容被改写）→ 身份元数据同样剥离：
 *      改写后的内容不再是「被准入的那条输入」。
 *   3. 未被 transform 触碰的 steer（isUnchanged 通过）→ 原 entry 逐引用返回、
 *      身份元数据完整保留（合法路径零回归）。
 *
 * 依赖已构建的 dist（同 test-magic-context-turn-transform.mjs 的手法）。
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

const { DEFAULT_MAGIC_CONTEXT_CONFIG } = await import("@zcode/magic-context");

const { createZCodeMagicContextTurnTransformPort } = await import(
  new URL("../dist/app/magic-context-turn-transform.js", import.meta.url).href
);

const SESSION_ID = "ses_test_mc_identity_guard";
const NOOP_LOGGER = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
};

const STEER_TEXT = "real queued steer text from the user";
const NARRATION_TEXT = "§1487§ E1 restored. Recover E2/E3/E4 the same way:";

/** system → 真 steer（user_steer）→ assistant 旁白 → 新 user 输入。 */
function incidentEntries() {
  return [
    { kind: "message", message: { role: "system", content: "you are zcode" } },
    {
      kind: "message",
      message: { role: "user", content: STEER_TEXT },
      metadata: { source: "real_user", inputPresentation: "user_steer" },
    },
    {
      kind: "message",
      message: { role: "assistant", content: NARRATION_TEXT },
    },
    {
      kind: "message",
      message: { role: "user", content: "next question" },
      metadata: { source: "real_user" },
    },
  ];
}

function portWith(transform, config = DEFAULT_MAGIC_CONTEXT_CONFIG) {
  return createZCodeMagicContextTurnTransformPort(transform, {
    getConfig: () => config,
    options: {
      sessionId: SESSION_ID,
      logger: NOOP_LOGGER,
    },
  });
}

async function runPort(port, entries) {
  return await port({
    entries,
    model: { providerId: "zcode", modelId: "glm-4.6" },
    sessionId: SESSION_ID,
    workingDirectory: "D:/tmp/project",
  });
}

function messageTextOf(entry) {
  const content = entry?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

test("事故复刻：压缩错配把旁白嫁接到 steer 身上 → 身份元数据被剥离", async () => {
  // originals 映射在 transform 之前构建（真实时序）；桩在 transform 内改写数组，
  // 模拟 MC 压缩：旁白消息拿走 steer 的 id 与 role，原 steer 消息被丢弃。
  const ghostInjection = async (_input, output) => {
    const messages = output.messages;
    const steer = messages.find((m) => m.parts?.[0]?.text === STEER_TEXT);
    const narration = messages.find((m) => m.parts?.[0]?.text === NARRATION_TEXT);
    if (!steer || !narration) throw new Error("stub could not locate steer/narration");
    narration.info.id = steer.info.id;
    narration.info.role = "user";
    messages.splice(messages.indexOf(steer), 1);
  };
  const result = await runPort(portWith(ghostInjection), incidentEntries());

  const ghost = result.entries.find((entry) => messageTextOf(entry).includes("E1 restored"));
  assert.ok(ghost, "旁白内容必须仍进入请求（不丢内容，只剥注入身份）");
  assert.equal(ghost.message.role, "user", "role 来自 MC 消息本身，保持 user");
  assert.equal(
    ghost.metadata?.inputPresentation,
    undefined,
    "重建条目不得携带 inputPresentation（否则会被包装成真实用户 mid-turn 注入）",
  );
  // source 保留（real_user）：§N§ 打标等合法改写依赖气泡身份，见 sanitize 注释。
  assert.equal(ghost.metadata?.source, "real_user");
});

test("合法压缩改写（id/role 保持、内容变化）→ 注入身份剥离、气泡身份保留", async () => {
  const rewriteSteer = async (_input, output) => {
    const steer = output.messages.find((m) => m.parts?.[0]?.text === STEER_TEXT);
    if (!steer) throw new Error("stub could not locate steer");
    steer.parts = [{ type: "text", text: "[compressed] " + STEER_TEXT }];
  };
  const result = await runPort(portWith(rewriteSteer), incidentEntries());

  const rewritten = result.entries.find((entry) => messageTextOf(entry).includes("[compressed]"));
  assert.ok(rewritten, "改写后的 steer 内容必须进入请求");
  assert.equal(rewritten.metadata?.inputPresentation, undefined, "改写内容不再是被准入输入");
  assert.equal(rewritten.metadata?.source, "real_user", "气泡身份保留（provider projection 依赖）");
});

test("配对守卫：id 不变但 role 被翻转（assistant→user）→ 断配对，重建无模板", async () => {
  // MC 内部 role 翻转但未换 id 的变体：originals 命中 assistant 原件，role 不符，
  // 配对必须断开——重建走无模板路径，连气泡身份都不得继承（legacy_synthetic）。
  const flipRoleOnly = async (_input, output) => {
    const narration = output.messages.find((m) => m.parts?.[0]?.text === NARRATION_TEXT);
    if (!narration) throw new Error("stub could not locate narration");
    narration.info.role = "user";
  };
  const result = await runPort(portWith(flipRoleOnly), incidentEntries());

  const flipped = result.entries.find((entry) => messageTextOf(entry).includes("E1 restored"));
  assert.ok(flipped, "内容不丢");
  assert.equal(flipped.message.role, "user", "role 来自 MC 消息");
  assert.equal(flipped.metadata?.inputPresentation, undefined);
  assert.equal(flipped.metadata?.source, "legacy_synthetic", "role 不符的配对不得继承任何身份");
});

test("未被触碰的 steer → 原 entry 逐引用返回、身份元数据完整（零回归）", async () => {
  const noop = async () => {};
  const entries = incidentEntries();
  const steerOriginal = entries[1];
  const result = await runPort(portWith(noop), entries);

  const steerOut = result.entries.find((entry) => messageTextOf(entry) === STEER_TEXT);
  assert.ok(steerOut, "steer 内容必须在输出中");
  assert.equal(steerOut, steerOriginal, "未改写条目必须逐引用复用原 entry");
  assert.equal(steerOut.metadata?.source, "real_user");
  assert.equal(steerOut.metadata?.inputPresentation, "user_steer");
});
