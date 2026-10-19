#!/usr/bin/env node
/**
 * mc/T-1（cr-fix-spec，bugfix-batch-20261009 CR 批次）——ctx 工具描述的
 * 主动使用时机引导句防线。
 *
 * 背景：ctx_reduce / ctx_expand 在 prompt 面零曝光（全仓 system prompt 无一处
 * 提及，tools prompt-section 写入侧也不存在——ContextBuilder.setToolRegistry
 * 是显式 no-op），模型了解这两个工具的唯一渠道就是工具自身的 description。
 * mc/T-1 因此在两侧描述里各补了一句「Use it proactively」主动引导（§N§ 标签
 * 出现 → ctx_expand 找回；能判断后续不再需要 → ctx_reduce 显式声明）。
 *
 * 本测试把这两句钉住：引导句被误删/改写时这里必须红，避免「描述增强」
 * 在后续迭代里无声回退（cr-func-all 终检时该验收缺口被登记为 open 项，
 * 此处补齐自动化断言）。
 *
 * 运行方式：`npx tsx --test scripts/test-ctx-tool-descriptions.mjs`
 * （必须 tsx：被测模块是 TypeScript 源码，与同目录 subagent 测试同范式；
 *  断言只涉及 description 字符串，不依赖契约单实例钩子。）
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ctxExpandToolEntry, ctxReduceToolEntry } from "../src/tool/handlers/ctx-context.js";

const reduceDescription = ctxReduceToolEntry.metadata.description;
const expandDescription = ctxExpandToolEntry.metadata.description;

test("T-CTX-1: ctx_reduce 描述含主动声明引导句（mc/T-1）", () => {
  // 引导句的核心承诺：「能判断后续不再需要 → 主动声明，不必等被要求」。
  assert.match(
    reduceDescription,
    /Use it proactively: the moment you can tell the work ahead no longer needs something on your desk, ctx_reduce is how you declare that/,
    "ctx_reduce 描述缺主动使用时机引导句——mc/T-1 的交付被回退了",
  );
});

test("T-CTX-2: ctx_expand 描述含 §N§ 标签主动找回引导句（mc/T-1）", () => {
  // 引导句的核心承诺：§N§ / [dropped §N§] 出现 → 立即 tag=N 取单项、message=N 取整条。
  // 压缩真正开始工作后 §N§ 标签才会出现在上下文里（依赖 e2e/R-2 的 percentage 修复），
  // 这句是模型把标签和工具关联起来的唯一入口。
  assert.match(
    expandDescription,
    /Use it proactively: when a §N§ tag or a `\[dropped §N§\]` placeholder shows up in your context, reach for ctx_expand right away/,
    "ctx_expand 描述缺 §N§ 标签主动找回引导句——mc/T-1 的交付被回退了",
  );
  // 取回方式的两种粒度必须与引导句同在，否则「何时用」有了、「怎么用」断了。
  assert.match(expandDescription, /tag=N brings that one item back whole/);
  assert.match(expandDescription, /message=N brings the whole message back in full/);
});

test("T-CTX-3: 两侧描述的既有机制说明不被引导句覆盖（回归护栏）", () => {
  // mc/T-1 只增不改：这些是 HEAD 就有的机制关键句，被挤掉说明描述被重写而非增补。
  assert.match(reduceDescription, /\[dropped §N§\]/);
  assert.match(reduceDescription, /never blanket-stamp a range like "1-50"/);
  assert.match(expandDescription, /they are never interchangeable/);
  assert.match(expandDescription, /capped at ~15K tokens/);
});

test("T-CTX-4: ctx_reduce 宿主 full 描述含 system prompt 段禁盖句（system-prompt-guard）", () => {
  // 模型可见的 ctx_reduce 描述有两份：宿主 full（本测试钉的这份）与包内 light
  // （magic-context/src/core/tools/light-descriptions.ts）。禁盖句落错对象
  // （例如只写进包内 constants.ts 的死文案）时，模型实际视野没有约束——
  // 这里锁死宿主这份的存在性。
  assert.match(
    reduceDescription,
    /Never stamp a system prompt segment — tags on system \(prompt\) messages are protected and never archivable; a drop request containing them is refused\./,
    "ctx_reduce 宿主 full 描述缺 system prompt 段禁盖句——magic-context-system-prompt-guard 的防线一教育层被回退",
  );
});
