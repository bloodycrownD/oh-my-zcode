#!/usr/bin/env node
/**
 * V4 迟到原始流不得覆盖已定稿输入（上游 v3.15.1 → v3.16.2 backport，U3）。
 *
 * ============================================================================
 * 失效面
 * ============================================================================
 *
 * V4 投影里工具行的输入有两个来源：
 *
 *   A. **原始模型流**（ModelStreaming 的 tool_input_delta / tool_call）：
 *      模型侧边吐边定稿，omz 的 `tool_call`（带 input）drain 即发，
 *      `tool_input_delta` 排队滞后。
 *   B. **调度事实**（ToolCallScheduled）：runtime 已经接纳这次调用，
 *      带权威 toolName + 完整 input。
 *
 * 断流恢复会二次投递同 id 的事件，A/B 到达顺序不再单调。旧实现里 A 无条件覆盖
 * B 已经写进 row 的 input/inputText → 轨迹面板的「调用参数」格显示的是迟到
 * chunk 拼出来的半截内容，而不是真正被执行的那次调用。
 *
 * 移植上游三处（同一处修复必须三处同落，缺一就会出现新缺口）：
 *
 *   1. `appendStreamingToolInput`：行已经定稿（row.input !== undefined）时丢弃
 *      迟到的 tool_input_delta。
 *   2. `finalizeStreamingToolInput`：行已经定稿时丢弃迟到的 tool_call
 *      （不再无条件覆盖 input/inputText，也不再改写 toolName）。
 *   3. `onToolCallScheduled`：existing-upsert 补写 toolName——因为第 2 条守卫
 *      挡住了「靠迟到原始流补身份」，工具名只能由 scheduled 这个权威事实落。
 *
 * ============================================================================
 * 被测模块怎么载入（两种都支持，行为等价）
 * ============================================================================
 *
 * - **tsx 在场**（`tsx --test` / `node --import tsx --test`）：直接载入
 *   `src/.../product-projection.ts`，测的永远是当前工作区代码。
 * - **裸 node**（`node --test`）：源码里相对导入写成 "./x.js" 而磁盘上是 ".ts"，
 *   且 `@zcode/shared` 的包入口发布的是原始 TypeScript（`exports["."] =
 *   "./src/index.ts"`），裸 node 两者都解析不了；因此改从构建产物
 *   `dist/.../product-projection.js` 载入，并用 `registerHooks` 只把
 *   `@zcode/shared` 的解析改指到它自己的 dist（只改解析，不桩被测逻辑）。
 *   前置条件：`pnpm --filter @zcode/bootstrap build`（与 T-C1 同款约束）。
 *   构建产物若陈旧，用例第 0 条断言会直接点名要求重建。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

const TSX_ACTIVE =
  process.execArgv.some((arg) => arg.includes("tsx")) ||
  (process.env.NODE_OPTIONS ?? "").includes("tsx");

/** 裸 node 路径：把「入口发布原始 TypeScript」的包解析改指到它自己的构建产物。 */
function redirectSharedPackageToDist() {
  const tsSourcePackages = new Set(["@zcode/shared", "@zcode/model-option-map", "@zcode/provider"]);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const segments = specifier.split("/");
      const packageName = tsSourcePackages.has(specifier)
        ? specifier
        : segments.length >= 2 && tsSourcePackages.has(segments.slice(0, 2).join("/"))
          ? segments.slice(0, 2).join("/")
          : null;
      if (packageName === null) return nextResolve(specifier, context);
      const distRoot = join(REPO_ROOT, "packages", packageName.slice("@zcode/".length), "dist");
      const subpath = specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
      for (const candidate of [
        join(distRoot, `${subpath}.js`),
        join(distRoot, subpath, "index.js"),
      ]) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
      throw new Error(`no compiled dist for "${specifier}" — build ${packageName} first`);
    },
  });
}

/**
 * 返回 { ProductProjection, implementationPath }——implementationPath 用于校验
 * 载入的到底是新实现还是陈旧构建产物。
 */
async function loadProductProjection() {
  if (TSX_ACTIVE) {
    const sourcePath = fileURLToPath(
      new URL("../src/zcode-protocol-v4/product-projection.ts", import.meta.url),
    );
    return {
      module: await import(pathToFileURL(sourcePath).href),
      implementationPath: sourcePath,
    };
  }
  redirectSharedPackageToDist();
  const distPath = fileURLToPath(
    new URL("../dist/zcode-protocol-v4/product-projection.js", import.meta.url),
  );
  if (!existsSync(distPath)) {
    throw new Error(`missing ${distPath} — run \`pnpm --filter @zcode/bootstrap build\` first`);
  }
  return {
    module: await import(pathToFileURL(distPath).href),
    implementationPath: distPath,
  };
}

const { module: projectionModule, implementationPath } = await loadProductProjection();
const { ProductProjection } = projectionModule;
const { SessionEventType } = await import("@zcode/contracts");

const SESSION_ID = "ses_late_tool_input";
const EPOCH = "epoch-late";
const TURN_ID = "turn-late-1";

let eventSeq = 0;
function event(type, payload) {
  eventSeq += 1;
  return {
    id: `evt-${eventSeq}`,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    type,
    timestamp: new Date(),
    traceId: "trace-late-tool-input",
    sequenceNumber: eventSeq,
    payload,
  };
}

function turnStarted() {
  return event(SessionEventType.TurnStarted, {
    input: "跑一下迟到流守卫",
    messageId: "msg_u_late",
  });
}

function scheduled(toolCallId, toolName, input) {
  return event(SessionEventType.ToolCallScheduled, {
    toolCallId,
    toolName,
    input,
    schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
  });
}

function rawStream(payload) {
  return event(SessionEventType.ModelStreaming, {
    delta: "",
    done: false,
    ...payload,
  });
}

function toolRow(projection, toolCallId) {
  const row = projection
    .getSnapshot()
    .rows.window.find((item) => item.kind === "toolCall" && item.toolCallId === toolCallId);
  assert.ok(row, `工具行 ${toolCallId} 必须被投影出来`);
  return row;
}

test("0: 载入的实现确实带着 U3 守卫（裸 node 路径用于识别陈旧构建产物）", () => {
  const source = readFileSync(implementationPath, "utf8");
  assert.ok(
    source.includes("existing?.input !== undefined"),
    `${implementationPath} 不含 U3 守卫——构建产物陈旧，请先 ` +
      "`pnpm --filter @zcode/bootstrap build`",
  );
});

test("1: scheduled 已定稿输入后，迟到的 tool_call 不覆盖 input/inputText", () => {
  const projection = new ProductProjection(SESSION_ID, EPOCH);
  projection.applyEvent(turnStarted());
  projection.applyEvent(scheduled("call_late_1", "Bash", { command: "echo scheduled" }));

  const before = toolRow(projection, "call_late_1");
  assert.deepEqual(before.input, { command: "echo scheduled" });
  assert.equal(before.inputText, JSON.stringify({ command: "echo scheduled" }));

  // 迟到的原始流：同一 toolCallId、另一个工具名与另一份 input。
  projection.applyEvent(
    rawStream({
      kind: "tool_call",
      toolCallId: "call_late_1",
      toolName: "shell",
      input: { command: "echo late" },
    }),
  );

  const after = toolRow(projection, "call_late_1");
  assert.deepEqual(after.input, { command: "echo scheduled" }, "迟到原始流不得覆盖已定稿 input");
  assert.equal(after.inputText, JSON.stringify({ command: "echo scheduled" }));
});

test("2: tool_call 定稿后，迟到的 tool_input_delta 被丢弃", () => {
  const projection = new ProductProjection(SESSION_ID, EPOCH);
  projection.applyEvent(turnStarted());
  projection.applyEvent(
    rawStream({ kind: "tool_input_start", toolCallId: "call_late_2", toolName: "Bash" }),
  );
  projection.applyEvent(
    rawStream({
      kind: "tool_call",
      toolCallId: "call_late_2",
      toolName: "Bash",
      input: { command: "echo final" },
    }),
  );

  const before = toolRow(projection, "call_late_2");
  assert.deepEqual(before.input, { command: "echo final" });

  projection.applyEvent(
    rawStream({ kind: "tool_input_delta", toolCallId: "call_late_2", delta: "LEAKED_TAIL" }),
  );

  const after = toolRow(projection, "call_late_2");
  assert.equal(
    after.inputText,
    JSON.stringify({ command: "echo final" }),
    "定稿后的迟到 delta 不得再拼进 inputText",
  );
  assert.equal(after.inputText.includes("LEAKED_TAIL"), false);
});

test("3: existing-upsert 由 scheduled 补写 toolName", () => {
  const projection = new ProductProjection(SESSION_ID, EPOCH);
  projection.applyEvent(turnStarted());
  // 原始流先到：工具名还是模型/提供方的原始名。
  projection.applyEvent(
    rawStream({ kind: "tool_input_start", toolCallId: "call_late_3", toolName: "shell" }),
  );
  projection.applyEvent(
    rawStream({
      kind: "tool_call",
      toolCallId: "call_late_3",
      toolName: "shell",
      input: { command: "echo identity" },
    }),
  );
  assert.equal(toolRow(projection, "call_late_3").toolName, "shell");

  // scheduled 后到：它带权威工具名，必须写回既有行。
  projection.applyEvent(scheduled("call_late_3", "Bash", { command: "echo identity" }));

  const after = toolRow(projection, "call_late_3");
  assert.equal(after.toolName, "Bash", "既有行的工具名必须由 scheduled 补写");
  assert.deepEqual(after.input, { command: "echo identity" });
});
