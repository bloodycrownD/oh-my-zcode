#!/usr/bin/env node
/**
 * Step 18 acceptance tests — B-group transform core.
 *
 * "Compiles but does not run" is the failure mode a verbatim port cannot catch
 * with `tsc --noEmit`, so the load-bearing pure functions get executed for real:
 *
 *   b1 — `apply-operations`' `[dropped §N§]` replacement contract and the
 *        `§N§` tag prefix/parse round trip that every later pass replays;
 *   b2 — budget derivation (`deriveTriggerBudget`, `deriveHistorianChunkTokens`),
 *        the tokenizer calibration table, and the tier-decay curve.
 *
 * WHY THIS STILL COMPILES ITS OWN TREE (S18 close-out). The obvious move is to
 * run the assertions against `dist/`, but `dist/` is a whole-package build: it
 * also contains the `src/host/` layer and every deferred seam, so a failure
 * there would say nothing about the B group specifically, and a change to an
 * unrelated group would break this suite. This script therefore still stages
 * `src/core/**` alone and compiles it with its own `tsc` invocation. What changed
 * is that the staged tree is now COMPLETE: the b1/b2 graph previously reached two
 * upstream files the fork did not port (`hooks/magic-context/dropped-input-guard.ts`
 * and `features/magic-context/dreamer/token-budget.ts`), and this script used to
 * copy them out of `.reference/` into the staging dir to close the graph. Both
 * are now real ported package files (`src/core/hooks/magic-context/dropped-input-guard.ts`,
 * `src/core/features/magic-context/dreamer/token-budget.ts`), so the overlay is
 * gone and the suite exercises shipped sources only — nothing under test is read
 * from outside the repository.
 *
 * The staging dir stays inside the workspace's `node_modules/.cache` rather than
 * the OS temp dir: `read-session-formatting.ts` resolves `ai-tokenizer` with
 * `createRequire(import.meta.url)`, so a build tree that cannot walk up to the
 * hoisted `node_modules` would silently fall back to character counts and the
 * tokenizer assertions below would prove nothing.
 *
 * Exits 0 on success, 1 on any failed assertion or build error.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG = fileURLToPath(new URL("../", import.meta.url));
const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const NODE = process.execPath;
// magic-context lives at <repo>/apps/zcode-cli/packages/magic-context.
const TSC = join(REPO, "node_modules", "typescript", "bin", "tsc");

// The b1/b2 modules the assertions below exercise. The whole staged tree is
// compiled (the A-group storage layer the B group imports has to be emitted too),
// so this list is the expected floor, not the build input: if a b1/b2 module ever
// stops emitting, the suite says so instead of silently testing less than it did.
const SUBJECT = [
  "hooks/magic-context/apply-operations.ts",
  "hooks/magic-context/tag-messages.ts",
  "hooks/magic-context/tag-content-primitives.ts",
  "hooks/magic-context/tag-id-fallback.ts",
  "hooks/magic-context/tag-part-guards.ts",
  "hooks/magic-context/drop-stale-reduce-calls.ts",
  "hooks/magic-context/tool-drop-target.ts",
  "hooks/magic-context/tool-input-size.ts",
  "hooks/magic-context/tool-sweep-policy.ts",
  "hooks/magic-context/tool-reclaim.ts",
  "hooks/magic-context/dropped-token-estimate.ts",
  "hooks/magic-context/edit-marker.ts",
  "hooks/magic-context/final-wire-token-estimate.ts",
  "hooks/magic-context/image-token-estimate.ts",
  "hooks/magic-context/tokenizer-calibration.ts",
  "hooks/magic-context/sentinel.ts",
  "hooks/magic-context/strip-content.ts",
  "hooks/magic-context/strip-structural-noise.ts",
  "hooks/magic-context/stripped-command.ts",
  "hooks/magic-context/system-injection-stripper.ts",
  "hooks/magic-context/reasoning-removal.ts",
  "hooks/magic-context/heuristic-cleanup.ts",
  "hooks/magic-context/execute-flush.ts",
  "hooks/magic-context/caveman.ts",
  "hooks/magic-context/caveman-cleanup.ts",
  "hooks/magic-context/emergency-drop.ts",
  "hooks/magic-context/emergency-fail-closed.ts",
  "hooks/magic-context/ctx-reduce-nudge.ts",
  "hooks/magic-context/tail-hygiene-walk.ts",
  "hooks/magic-context/todo-view.ts",
  "hooks/magic-context/protected-tail-boundary.ts",
  "hooks/magic-context/host-served-rows.ts",
  "hooks/magic-context/degraded-pass-refusal.ts",
  "hooks/magic-context/single-store-refusal.ts",
  "hooks/magic-context/storage-busy-refusal.ts",
  "hooks/magic-context/store-ahead-refusal.ts",
  "hooks/magic-context/maintenance-authority.ts",
  "hooks/magic-context/unmanaged-over-window.ts",
  "hooks/magic-context/unresolved-history-boundary.ts",
  "hooks/magic-context/empty-task-output.ts",
  "hooks/magic-context/fold-execution-gate.ts",
  "features/magic-context/tagger.ts",
  "features/magic-context/overflow-detection.ts",
  "features/magic-context/session-decision-calibration.ts",
  "features/magic-context/tool-definition-tokens.ts",
  "shared/commit-detection.ts",
  "shared/user-answer.ts",
  "shared/internal-initiator-marker.ts",
  "shared/system-directive.ts",
  "agents/language-directive.ts",
  "hooks/magic-context/derive-budgets.ts",
  "hooks/magic-context/decision-calibration.ts",
  "hooks/magic-context/decay-curve.ts",
  "hooks/magic-context/decay-render.ts",
  "hooks/magic-context/lkg-slot.ts",
  "hooks/magic-context/lkg-persist.ts",
  "hooks/magic-context/lkg-replay.ts",
  "hooks/magic-context/lkg-replay-fit.ts",
  "hooks/magic-context/openai-compat-adjacency.ts",
  "hooks/magic-context/read-session-chunk.ts",
  "hooks/magic-context/read-session-db.ts",
  "hooks/magic-context/read-session-formatting.ts",
  "hooks/magic-context/read-session-raw.ts",
  "hooks/magic-context/read-session-true-raw-tokens.ts",
  "hooks/magic-context/transform-operations.ts",
  "hooks/magic-context/transform-stage-logger.ts",
  "hooks/magic-context/raw-fallback-context-limit.ts",
  "hooks/magic-context/cache-busting-signals.ts",
  "hooks/magic-context/temporal-awareness.ts",
  "features/magic-context/no-content-compartment.ts",
  "shared/models-dev-cache.ts",
  "shared/background-batch-drain.ts",
  "shared/opencode-db-path.ts",
];

// S18 close-out: the OVERLAY list is GONE. `dropped-input-guard` and
// `dreamer/token-budget` used to be copied out of `.reference/` into the staging
// dir because the fork did not port them; both are now real ported package files,
// so `src/core/**` alone closes the b1/b2 graph and nothing under test is read
// from outside the repository. The assertion that would have caught a regression
// here is `subjectPresence()` below: it fails if either file stops emitting, so a
// future "un-port it again" cannot silently reintroduce an overlay.
const OVERLAY_REPLACED = [
  "hooks/magic-context/dropped-input-guard.ts",
  "features/magic-context/dreamer/token-budget.ts",
];

function stage() {
  // Staged inside the workspace's `node_modules/.cache`, not the OS temp dir:
  // `read-session-formatting.ts` resolves `ai-tokenizer` with
  // `createRequire(import.meta.url)`, so a build tree that cannot walk up to the
  // hoisted `node_modules` would silently fall back to character counts and the
  // tokenizer assertions below would prove nothing.
  mkdirSync(join(REPO, "node_modules", ".cache"), { recursive: true });
  const root = mkdtempSync(join(REPO, "node_modules", ".cache", "magic-context-s18-"));
  const src = join(root, "src");
  cpSync(join(PKG, "src", "core"), src, { recursive: true });
  return { root, src };
}

// Every `.ts` under the staged tree except the sibling `host/` layer. tsc only
// emits the files it is handed, so the A-group storage modules the B group
// imports have to be named explicitly or they enter the program for type
// resolution only and the emitted graph is missing them at run time.
function listSources(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "host") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

function build({ root, src }) {
  const outDir = join(root, "out");
  // The staged tree has no package.json, so Node would read the emitted `.js`
  // as CommonJS and refuse the top-level await the SQLite chokepoint uses.
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }) + "\n");
  const files = listSources(src);
  const listFile = join(root, "files.txt");
  writeFileSync(listFile, files.join("\n") + "\n");
  const run = spawnSync(
    NODE,
    [
      TSC,
      "--outDir",
      outDir,
      "--rootDir",
      src,
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "es2022",
      "--skipLibCheck",
      "--types",
      "node",
      "--ignoreConfig",
      "@" + listFile,
    ],
    { cwd: PKG, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  // Type errors are expected and irrelevant here: the modules owned by other
  // groups (C/D/E) are absent by design. Only a hard emit failure is fatal.
  const out = ((run.stdout || "") + (run.stderr || "")).replace(/\r/g, "");
  if (!fileExists(join(outDir, "hooks", "magic-context", "apply-operations.js"))) {
    console.error(out.slice(0, 4000));
    throw new Error("tsc did not emit the b1/b2 graph");
  }
  const missing = SUBJECT.filter((rel) => !fileExists(join(outDir, rel.replace(/\.ts$/, ".js"))));
  if (missing.length > 0) throw new Error("tsc did not emit: " + missing.join(", "));
  // The two files that used to be staged from `.reference/` must now come from
  // the fork's own `src/core/`. Asserting it here is what makes removing the
  // overlay safe: if either is deleted (or re-classified as un-ported) the suite
  // fails loudly instead of quietly testing a graph it no longer owns.
  const missingOverlay = OVERLAY_REPLACED.filter(
    (rel) => !fileExists(join(outDir, rel.replace(/\.ts$/, ".js"))),
  );
  if (missingOverlay.length > 0)
    throw new Error(
      "these used to be staged from .reference/ and must now be real ported files: " +
        missingOverlay.join(", "),
    );
  if (process.env.MAGIC_CONTEXT_TEST_VERBOSE) console.log(out);
  return outDir;
}

function fileExists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function fs_exists(p) {
  try {
    return readFileSync(p) !== undefined || true;
  } catch {
    return false;
  }
}

const { root, src } = stage();
const out = build({ root, src });
const load = (rel) => import(pathToFileURL(join(out, rel)).href);

const applyOps = await load("hooks/magic-context/apply-operations.js");
const tagPrimitives = await load("hooks/magic-context/tag-content-primitives.js");
const tagParts = await load("hooks/magic-context/tag-part-guards.js");
const toolDropTarget = await load("hooks/magic-context/tool-drop-target.js");
const deriveBudgets = await load("hooks/magic-context/derive-budgets.js");
const tokenizerCalibration = await load("hooks/magic-context/tokenizer-calibration.js");
const decayCurve = await load("hooks/magic-context/decay-curve.js");
const formatting = await load("hooks/magic-context/read-session-formatting.js");
const lkgReplay = await load("hooks/magic-context/lkg-replay.js");
const lkgSlot = await load("hooks/magic-context/lkg-slot.js");

const SECTION = "§"; // § — the ported sources spell it as an escape
const dropped = (n) => `[dropped ${SECTION}${n}${SECTION}]`;

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// --- b1: the `[dropped §N§]` replacement contract --------------------------
// The marker is load-bearing (spec 防误删清单): `tagMessages` restores pristine
// source text every pass, so the drop has to be byte-reproducible from the tag
// number alone.

test("b1 buildReplacementContent emits the canonical [dropped §N§] marker", () => {
  const marker = applyOps.buildReplacementContent(42);
  if (marker !== dropped(42)) throw new Error(`got ${JSON.stringify(marker)}`);
  if (marker !== "[dropped §42§]") throw new Error("marker is not the documented literal");
});

test("b1 buildReplacementContent is byte-stable across calls", () => {
  const a = applyOps.buildReplacementContent(7);
  const b = applyOps.buildReplacementContent(7);
  if (a !== b) throw new Error("marker drifted between calls");
  if (applyOps.buildReplacementContent(8) === a) throw new Error("distinct tags share a marker");
});

test("b1 applyNewToolDrop keeps real arguments and marks skeleton_real in-window", () => {
  let droppedCalled = 0;
  const target = {
    // `hasSmallToolInput` reads the serialized input size, not a boolean.
    inputStringBytes: () => 64,
    drop: () => {
      droppedCalled += 1;
      return "full";
    },
    skeletonReal: () => "truncated",
  };
  const outcome = applyOps.applyNewToolDrop(target, { inWindow: true });
  if (outcome.mode !== "skeleton_real") throw new Error(`mode=${outcome.mode}`);
  if (outcome.result !== "truncated") throw new Error(`result=${outcome.result}`);
  if (droppedCalled !== 0) throw new Error("in-window drop must not remove the call");
});

test("b1 applyNewToolDrop drops a call whose arguments are too large to keep", () => {
  const target = {
    inputStringBytes: () => 1 << 20,
    drop: () => "full",
    skeletonReal: () => "truncated",
  };
  const outcome = applyOps.applyNewToolDrop(target, { inWindow: true });
  if (outcome.mode !== "full") throw new Error(`mode=${outcome.mode}`);
  if (outcome.result !== "full") throw new Error(`result=${outcome.result}`);
});

test("b1 applyNewToolDrop falls through to a full drop outside the window", () => {
  const target = {
    drop: () => "full",
    skeletonReal: () => "truncated",
  };
  const outcome = applyOps.applyNewToolDrop(target, { inWindow: false });
  if (outcome.mode !== "full") throw new Error(`mode=${outcome.mode}`);
  if (outcome.result !== "full") throw new Error(`result=${outcome.result}`);
});

test("b1 applyNewToolDrop reports absent when the target is gone", () => {
  const outcome = applyOps.applyNewToolDrop(undefined, { inWindow: true });
  if (outcome.result !== "absent" || outcome.mode !== "full")
    throw new Error(JSON.stringify(outcome));
});

// --- b1: §N§ tag assignment round trip -------------------------------------
// `prependTag` must strip whatever the model emitted before writing a new tag,
// otherwise every pass compounds another prefix onto the same text.

test("b1 prependTag writes §N§ and stripTagPrefix reads it back", () => {
  const tagged = tagPrimitives.prependTag(12, "hello world");
  if (tagged !== `${SECTION}12${SECTION} hello world`)
    throw new Error(`got ${JSON.stringify(tagged)}`);
  if (tagPrimitives.stripTagPrefix(tagged) !== "hello world")
    throw new Error("round trip did not restore the body");
});

test("b1 prependTag replaces a malformed leading tag instead of stacking", () => {
  const once = tagPrimitives.prependTag(3, `${SECTION}15298">${SECTION} stale`);
  const twice = tagPrimitives.prependTag(3, once);
  if (twice !== once) throw new Error(`re-tagging changed the bytes: ${JSON.stringify(twice)}`);
  if (tagPrimitives.stripTagPrefix(once) !== "stale") throw new Error("malformed prefix survived");
});

test("b1 stripTagPrefix leaves bare leading digits alone", () => {
  const body = "99 files changed";
  if (tagPrimitives.stripTagPrefix(body) !== body) throw new Error("numeric content was mangled");
});

test("b1 byteSize counts UTF-8 bytes, not code units", () => {
  if (tagPrimitives.byteSize("abc") !== 3) throw new Error("ascii");
  if (tagPrimitives.byteSize("日") !== 3) throw new Error("multi-byte");
});

test("b1 peelLeadingMcTagNotation splits prefix from body", () => {
  const split = tagPrimitives.peelLeadingMcTagNotation(`${SECTION}9${SECTION} body`);
  if (split.tagPrefix !== `${SECTION}9${SECTION} `) throw new Error(JSON.stringify(split));
  if (split.body !== "body") throw new Error(JSON.stringify(split));
});

test("b1 isThinkingPart classifies reasoning under both host spellings", () => {
  if (!tagPrimitives.isThinkingPart({ type: "thinking" })) throw new Error("thinking");
  if (!tagPrimitives.isThinkingPart({ type: "reasoning" })) throw new Error("reasoning");
  if (tagPrimitives.isThinkingPart({ type: "text" })) throw new Error("text misread");
  if (tagPrimitives.isThinkingPart(null)) throw new Error("null misread");
});

test("b1 tag-part-guards strips the same prefix the tagger wrote", () => {
  const tagged = tagPrimitives.prependTag(5, "payload");
  if (tagParts.stripTagPrefix(tagged) !== "payload") throw new Error("guard drifted");
});

// --- b1: tool 弧分类（ZCode 拆分形态 FIFO 配对的前提） ------------------------
//
// extractToolCallObservation 是 owner 推导的入口：`type:"tool"` 必须按弧是否
// 闭合（partHasCompletedResult）分流。若一律按 result 分类，ZCode 拆分形态
// （assistant 上 running invocation + user 上 completed result）的两个 part
// 会落进不同 composite key，drop 只清 result 一侧、invocation 成孤儿，宿主
// 报 AI_MissingToolResultsError 且重启/重放不恢复。
// 见 docs/specs/magic-context-tool-arc-pairing.md。

test("b1 extractToolCallObservation classifies a running tool part as an invocation", () => {
  const running = toolDropTarget.extractToolCallObservation({
    type: "tool",
    callID: "call_zc_running",
    tool: "read",
    state: { status: "running", input: { path: "a.txt" } },
  });
  if (!running || running.callId !== "call_zc_running" || running.kind !== "invocation") {
    throw new Error(`running part -> ${JSON.stringify(running)}`);
  }
  const pending = toolDropTarget.extractToolCallObservation({
    type: "tool",
    callID: "call_zc_pending",
    state: { input: {} },
  });
  if (!pending || pending.kind !== "invocation") {
    throw new Error(`pending part (no status/output) -> ${JSON.stringify(pending)}`);
  }
});

test("b1 extractToolCallObservation classifies completed and errored tool parts as results", () => {
  const completed = toolDropTarget.extractToolCallObservation({
    type: "tool",
    callID: "call_zc_completed",
    state: { status: "completed", input: {}, output: "42 lines" },
  });
  if (!completed || completed.callId !== "call_zc_completed" || completed.kind !== "result") {
    throw new Error(`completed part -> ${JSON.stringify(completed)}`);
  }
  const errored = toolDropTarget.extractToolCallObservation({
    type: "tool",
    callID: "call_zc_errored",
    state: { status: "error", input: {}, error: "ENOENT: no such file" },
  });
  if (!errored || errored.kind !== "result") {
    throw new Error(`errored part -> ${JSON.stringify(errored)}`);
  }
});

test("b1 extractToolCallObservation keeps the anthropic shapes type-driven", () => {
  const use = toolDropTarget.extractToolCallObservation({
    type: "tool_use",
    id: "toolu_anthropic",
    name: "bash",
    input: { command: "ls" },
  });
  if (!use || use.callId !== "toolu_anthropic" || use.kind !== "invocation") {
    throw new Error(`tool_use -> ${JSON.stringify(use)}`);
  }
  const result = toolDropTarget.extractToolCallObservation({
    type: "tool_result",
    tool_use_id: "toolu_anthropic",
    content: "ok",
  });
  if (!result || result.callId !== "toolu_anthropic" || result.kind !== "result") {
    throw new Error(`tool_result -> ${JSON.stringify(result)}`);
  }
});

// --- b2: budget derivation ---------------------------------------------------

test("b2 deriveTriggerBudget scales with context × threshold and clamps low", () => {
  // 128k × 65% × 5% = 4,160 → floored at TRIGGER_BUDGET_MIN (5,000).
  const small = deriveBudgets.deriveTriggerBudget(128_000, 65);
  if (small !== 5_000) throw new Error(`128k -> ${small}`);
});

test("b2 deriveTriggerBudget lands inside the 5k..50k band", () => {
  const mid = deriveBudgets.deriveTriggerBudget(1_000_000, 65);
  // 1M × 65% × 5% = 32,500, inside the band.
  if (mid !== 32_500) throw new Error(`1M -> ${mid}`);
});

test("b2 deriveTriggerBudget clamps at the ceiling and floors a bad window", () => {
  if (deriveBudgets.deriveTriggerBudget(8_000_000, 90) !== 50_000)
    throw new Error("ceiling not applied");
  if (deriveBudgets.deriveTriggerBudget(0, 65) !== 5_000)
    throw new Error("non-positive window did not fall back to the floor");
});

test("b2 deriveHistorianChunkTokens is 25% of the historian window, clamped", () => {
  if (deriveBudgets.deriveHistorianChunkTokens(16_000) !== 8_000)
    throw new Error("floor not applied");
  if (deriveBudgets.deriveHistorianChunkTokens(200_000) !== 50_000)
    throw new Error("50k × 25% = 50,000 (ceiling)");
  if (deriveBudgets.deriveHistorianChunkTokens(1_000_000) !== 50_000)
    throw new Error("ceiling not applied");
});

// --- b2: tokenizer calibration ----------------------------------------------

const SEEDED_PROVIDER = "google";
const SEEDED_MODEL = "gemini-3.8-flash";

test("b2 tokenizer calibration resolves a seeded model by longest prefix", () => {
  if (!tokenizerCalibration.hasModelCalibration(SEEDED_PROVIDER, SEEDED_MODEL))
    throw new Error("the seed table does not cover the probed model");
  const resolved = tokenizerCalibration.resolveModelCalibration(SEEDED_PROVIDER, SEEDED_MODEL);
  if (!(resolved.systemRatio > 0)) throw new Error("systemRatio not populated");
  if (!(resolved.toolsRatio > 0)) throw new Error("toolsRatio not populated");
});

test("b2 tokenizer calibration stays neutral without a provider or model", () => {
  for (const args of [
    [undefined, undefined],
    ["google", undefined],
    [undefined, SEEDED_MODEL],
  ]) {
    const resolved = tokenizerCalibration.resolveModelCalibration(...args);
    if (resolved.systemRatio !== 1 || resolved.toolsRatio !== 1)
      throw new Error(`${JSON.stringify(args)} -> ${JSON.stringify(resolved)}`);
  }
});

test("b2 tokenizer calibration falls back to neutral for an unknown provider", () => {
  const resolved = tokenizerCalibration.resolveModelCalibration("nope", "not-a-model");
  if (resolved.systemRatio !== 1 || resolved.toolsRatio !== 1)
    throw new Error(`expected the neutral fallback, got ${JSON.stringify(resolved)}`);
});

test("b2 calibrateBuckets applies the per-model ratios to the local counts", () => {
  const calibration = tokenizerCalibration.resolveModelCalibration(SEEDED_PROVIDER, SEEDED_MODEL);
  const input = {
    inputTokens: 100_000,
    systemLocal: 1_000,
    toolDefsLocal: 2_000,
    compartmentsLocal: 3_000,
    factsLocal: 400,
    memoriesLocal: 600,
    docsLocal: 200,
    profileLocal: 100,
    conversationLocal: 50_000,
    toolCallsLocal: 42_700,
    calibration,
  };
  const buckets = tokenizerCalibration.calibrateBuckets(input);
  // System and tool definitions are the two budget-bearing calibrated buckets.
  if (buckets.systemTokens !== Math.round(input.systemLocal * calibration.systemRatio))
    throw new Error(`system=${buckets.systemTokens}`);
  if (buckets.toolDefinitionTokens !== Math.round(input.toolDefsLocal * calibration.toolsRatio))
    throw new Error(`tools=${buckets.toolDefinitionTokens}`);
  // First-message prose is display-only and carries the prose ratio.
  if (buckets.compartmentTokens !== Math.round(input.compartmentsLocal * calibration.proseRatio))
    throw new Error(`compartments=${buckets.compartmentTokens}`);
  if (buckets.factTokens !== Math.round(input.factsLocal * calibration.proseRatio))
    throw new Error(`facts=${buckets.factTokens}`);
  if (buckets.memoryTokens !== Math.round(input.memoriesLocal * calibration.proseRatio))
    throw new Error(`memories=${buckets.memoryTokens}`);
});

test("b2 calibrateBuckets makes the buckets sum to the reported input tokens", () => {
  const calibration = tokenizerCalibration.resolveModelCalibration(SEEDED_PROVIDER, SEEDED_MODEL);
  for (const inputTokens of [1_000, 100_000, 872_000]) {
    const buckets = tokenizerCalibration.calibrateBuckets({
      inputTokens,
      systemLocal: 1_234,
      toolDefsLocal: 5_678,
      compartmentsLocal: 3_000,
      factsLocal: 400,
      memoriesLocal: 600,
      docsLocal: 200,
      profileLocal: 100,
      conversationLocal: inputTokens * 0.4,
      toolCallsLocal: inputTokens * 0.3,
      calibration,
    });
    const total = Object.values(buckets).reduce((sum, value) => sum + value, 0);
    if (total !== inputTokens)
      throw new Error(`inputTokens=${inputTokens} but buckets sum to ${total}`);
  }
});

test("b2 calibrateBuckets returns an all-zero breakdown for an empty pass", () => {
  const buckets = tokenizerCalibration.calibrateBuckets({
    inputTokens: 0,
    systemLocal: 0,
    toolDefsLocal: 0,
    compartmentsLocal: 0,
    factsLocal: 0,
    memoriesLocal: 0,
    docsLocal: 0,
    profileLocal: 0,
    conversationLocal: 0,
    toolCallsLocal: 0,
    calibration: tokenizerCalibration.resolveModelCalibration("google", SEEDED_MODEL),
  });
  for (const [key, value] of Object.entries(buckets)) {
    if (value !== 0) throw new Error(`${key}=${value}`);
  }
});

// --- b2: decay curve --------------------------------------------------------

test("b2 decay curve archives monotonically with age", () => {
  const tiers = [1, 5, 20, 80, 400].map((age) => decayCurve.tier(age, 50, 1));
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i] < tiers[i - 1]) throw new Error(`tier went backwards: ${tiers}`);
  }
  if (tiers[0] !== 1) throw new Error(`freshest compartment rendered at ${tiers[0]}`);
  if (tiers[tiers.length - 1] !== 5) throw new Error(`oldest compartment not archived`);
});

test("b2 decay curve demotes faster under budget pressure", () => {
  const relaxed = decayCurve.tier(40, 50, 1);
  const pressured = decayCurve.tier(40, 50, 4);
  if (!(pressured > relaxed))
    throw new Error(`pressure did not demote: ${relaxed} -> ${pressured}`);
});

test("b2 decay curve archives exactly when it renders P5", () => {
  for (const age of [1, 10, 60, 200, 900]) {
    const rendered = decayCurve.tier(age, 50, 1.5);
    const archived = decayCurve.shouldArchive(age, 50, 1.5);
    if (archived !== (rendered === 5))
      throw new Error(`age=${age} tier=${rendered} archived=${archived}`);
  }
});

test("b2 decay curve tier costs are the documented geometric ladder", () => {
  const expected = [0, 322, 109, 35, 20, 5];
  for (let i = 0; i < expected.length; i++) {
    if (decayCurve.TIER_COST[i] !== expected[i])
      throw new Error(`TIER_COST[${i}]=${decayCurve.TIER_COST[i]}`);
  }
  for (const [name, value] of [
    ["Z1", decayCurve.Z1],
    ["Z4", decayCurve.Z4],
  ]) {
    if (!(value > 0 && value < 10)) throw new Error(`${name}=${value}`);
  }
});

// --- b2: the ai-tokenizer-backed estimator ----------------------------------

test("b2 estimateTokens loads ai-tokenizer and reports a stable fingerprint", () => {
  const exact = formatting.estimateTokens("Coverage check: const windows = chunk(text);");
  if (!Number.isFinite(exact) || exact <= 0) throw new Error(`estimateTokens -> ${exact}`);
  const again = formatting.estimateTokens("Coverage check: const windows = chunk(text);");
  if (exact !== again) throw new Error("estimateTokens is not deterministic");
  const fingerprint = formatting.getTokenEstimatorFingerprint();
  if (!fingerprint.startsWith("tokenizer:") && !fingerprint.startsWith("heuristic:"))
    throw new Error(`unexpected fingerprint ${fingerprint}`);
  console.log(`  estimator: ${fingerprint}`);
});

test("b2 estimateTokens treats an empty string as zero", () => {
  if (formatting.estimateTokens("") !== 0) throw new Error("empty string counted tokens");
});

test("b2 compactTextForSummary only strips hashes from assistant commits", () => {
  const asUser = formatting.compactTextForSummary("fix in abc1234def", "user");
  if (asUser.text !== "fix in abc1234def") throw new Error("user text was rewritten");
  const asAssistant = formatting.compactTextForSummary("committed abc1234def", "assistant");
  if (asAssistant.commitHashes.length !== 1) throw new Error(JSON.stringify(asAssistant));
  if (asAssistant.commitHashes[0] !== "abc1234def")
    throw new Error(JSON.stringify(asAssistant.commitHashes));
});

// --- b3: M0 / LKG 字节重放（spec「不变量单测」的第三项，Step 24 补） ----------
//
// 契约 1 的落点：一次成功 pass 的输出被冻结成 LKG slot，之后每一 pass 重放的
// **前缀字节必须完全一致**。这不是优化，是缓存前缀稳定性的前提——只要重放
// 的字节抖一下，provider 的 prompt cache 就整段作废，而症状（命中率塌方）与
// 成因（一次字节级重排）离得很远。断言直接比 `JSON.stringify`，不经过任何
// 归一化，所以「等价但不同序」也会失败。

const LKG_SESSION = "ses_s18_lkg";

/** 一条 OpenCode 形状的 MessageLike（`info` + `parts`），LKG 只读这两处。 */
function lkgMessage(id, role, text, created) {
  return {
    info: { id, role, sessionID: LKG_SESSION, time: { created }, synthetic: false },
    parts: [{ type: "text", text }],
  };
}

/** 成功 pass 的输出：与输入同序，但第一条 user 被打上 §N§ —— 前缀因此与输入不同。 */
function lkgPass(input) {
  return input.map((message, index) =>
    index === 0
      ? {
          ...message,
          parts: [{ type: "text", text: `§1§ ${message.parts[0].text}` }],
        }
      : message,
  );
}

test("b3 captureLkgSlot freezes the module output prefix, not the raw input", () => {
  lkgSlot.resetLkgSlotsForTest();
  const input = [
    lkgMessage("msg_1", "user", "first question", 1000),
    lkgMessage("msg_2", "assistant", "an answer", 2000),
    lkgMessage("msg_3", "user", "second question", 3000),
  ];
  const captured = lkgReplay.captureLkgSlot({
    sessionId: LKG_SESSION,
    input,
    output: lkgPass(input),
    modelKey: "zcode/glm-4.6",
    providerKey: "zcode",
    capturedAt: 4000,
  });
  if (!captured) throw new Error("captureLkgSlot refused a well-formed pass");

  const slot = lkgSlot.getSlot(LKG_SESSION);
  if (!slot) throw new Error("no slot was stored");
  // 冻结的是**模块输出**：`§N§` 打标必须在里面。若这里冻的是原始输入，
  // 失败时重放就会把打标丢掉——正是打标每 pass 重放要保住的东西。
  if (!slot.jsonPrefix.includes("§1§ first question")) {
    throw new Error(`slot did not freeze the tagged output: ${slot.jsonPrefix}`);
  }
  if (slot.inputIdSeq.join(",") !== "msg_1,msg_2,msg_3") {
    throw new Error(`unexpected id seq: ${slot.inputIdSeq.join(",")}`);
  }
  if (slot.lastInputMessageId !== "msg_3") throw new Error(`anchor=${slot.lastInputMessageId}`);
  lkgSlot.resetLkgSlotsForTest();
});

test("b3 two consecutive replays of the same pass are byte-identical", () => {
  lkgSlot.resetLkgSlotsForTest();
  const input = [
    lkgMessage("msg_1", "user", "first question", 1000),
    lkgMessage("msg_2", "assistant", "an answer", 2000),
    lkgMessage("msg_3", "user", "second question", 3000),
  ];
  if (
    !lkgReplay.captureLkgSlot({
      sessionId: LKG_SESSION,
      input,
      output: lkgPass(input),
      modelKey: "zcode/glm-4.6",
      providerKey: "zcode",
      capturedAt: 4000,
    })
  ) {
    throw new Error("captureLkgSlot refused a well-formed pass");
  }

  // 下一 pass：同一段历史 + 一条更新的 user 轮。
  const nextPass = [...input, lkgMessage("msg_4", "user", "third question", 5000)];
  const first = lkgReplay.replayLkg({
    sessionId: LKG_SESSION,
    messages: nextPass,
    modelKey: "zcode/glm-4.6",
    providerKey: "zcode",
  });
  const second = lkgReplay.replayLkg({
    sessionId: LKG_SESSION,
    messages: nextPass,
    modelKey: "zcode/glm-4.6",
    providerKey: "zcode",
  });
  if (!first.ok) throw new Error(`first replay declined: ${first.reason}`);
  if (!second.ok) throw new Error(`second replay declined: ${second.reason}`);

  const firstBytes = JSON.stringify(first.messages);
  const secondBytes = JSON.stringify(second.messages);
  if (firstBytes !== secondBytes) {
    throw new Error("two consecutive replays produced different bytes");
  }
  // 冻住的前缀 + 原样接上的新尾部：打标留在前缀里，msg_4 未被打标。
  if (first.messages.length !== 4) throw new Error(`length=${first.messages.length}`);
  if (first.messages[0].parts[0].text !== "§1§ first question") {
    throw new Error("the frozen prefix lost its §N§ tag");
  }
  if (first.messages[3].parts[0].text !== "third question") {
    throw new Error(`tail was rewritten: ${first.messages[3].parts[0].text}`);
  }
  lkgSlot.resetLkgSlotsForTest();
});

test("b3 a model change drops the slot instead of replaying another model's bytes", () => {
  lkgSlot.resetLkgSlotsForTest();
  const input = [
    lkgMessage("msg_1", "user", "first question", 1000),
    lkgMessage("msg_2", "assistant", "an answer", 2000),
    lkgMessage("msg_3", "user", "second question", 3000),
  ];
  lkgReplay.captureLkgSlot({
    sessionId: LKG_SESSION,
    input,
    output: lkgPass(input),
    modelKey: "zcode/glm-4.6",
    providerKey: "zcode",
    capturedAt: 4000,
  });
  const nextPass = [...input, lkgMessage("msg_4", "user", "third question", 5000)];
  const result = lkgReplay.replayLkg({
    sessionId: LKG_SESSION,
    messages: nextPass,
    modelKey: "zcode/glm-5.3",
    providerKey: "zcode",
  });
  if (result.ok || result.reason !== "lkg_model_mismatch") {
    throw new Error(`expected lkg_model_mismatch, got ${JSON.stringify(result.reason)}`);
  }
  if (lkgSlot.getSlot(LKG_SESSION) !== undefined) {
    throw new Error("a model mismatch must drop the slot, not leave it replayable");
  }
  lkgSlot.resetLkgSlotsForTest();
});

// --- b4: the first-pass usage reset across two processes (S24-fix) ------------
//
// Upstream's reset assumes "one process = one session", so the first pass of a
// process treats the persisted percentage as stale and zeroes it. ZCode CLI is
// "one process = one prompt": the first pass is EVERY pass, so an unfixed reset
// wipes the accumulated reading on every turn — scheduler defers forever, and
// `[dropped §N§]` / the historian never fire (MVP report §3, T-M2/T-M3/T-M6).
//
// These cases drive the REAL `createTransform` against a real sqlite store, once
// per "process", with a real `contextUsageMap` seeded the way the host recorder's
// `prime()` seeds it. The control case (no `hostProcessLifetime`) proves the
// assertions below are not vacuous: without the fix, that one still resets.

const b4DbDir = mkdtempSync(join(REPO, "node_modules", ".cache", "magic-context-s24fix-"));
process.env.MAGIC_CONTEXT_DB_DIR = b4DbDir;
process.env.MAGIC_CONTEXT_LOG_PATH = join(b4DbDir, "magic-context.log");

const storageDb = await load("features/magic-context/storage-db.js");
const storageMeta = await load("features/magic-context/storage-meta.js");
const taggerModule = await load("features/magic-context/tagger.js");
const schedulerModule = await load("features/magic-context/scheduler.js");
const transformModule = await load("hooks/magic-context/transform.js");

const b4Db = storageDb.openDatabase();
if (!b4Db) throw new Error("openDatabase() failed for the b4 store");
const B4_SESSION = "ses_s24fix_two_processes";
const B4_PCT = 42.5;
const B4_TOKENS = 85_000;

/** OpenCode 形状的一轮 messages；只需 `findSessionId` 能认出 session。 */
function b4Messages(userText) {
  return [
    {
      info: {
        id: "msg_b4_1",
        role: "user",
        sessionID: B4_SESSION,
        time: { created: 1000 },
        synthetic: false,
      },
      parts: [{ type: "text", text: userText }],
    },
  ];
}

/**
 * One "process": a fresh `createTransform` (so its `loadedSessions` is empty,
 * exactly like a new CLI process) plus a `contextUsageMap` primed from the
 * persisted store the way the host recorder's `prime()` primes it.
 */
function b4Process({ hostProcessLifetime }) {
  const contextUsageMap = new Map();
  const persisted = storageMeta.loadPersistedUsage(b4Db, B4_SESSION);
  if (persisted) {
    contextUsageMap.set(B4_SESSION, {
      usage: persisted.usage,
      updatedAt: persisted.updatedAt,
      lastResponseTime: persisted.updatedAt,
      hasUsageTokens: true,
    });
  }
  const deps = {
    db: b4Db,
    tagger: taggerModule.createTagger(),
    scheduler: schedulerModule.createScheduler({
      cacheTtl: schedulerModule.parseCacheTtl("5m"),
      executeThresholdPercentage: 65,
    }),
    contextUsageMap,
    clearReasoningAge: 50,
    historyRefreshSessions: new Set(),
    pendingMaterializationSessions: new Set(),
    lastHeuristicsTurnId: new Map(),
    commitSeenLastPass: new Map(),
    ...(hostProcessLifetime === undefined ? {} : { hostProcessLifetime }),
  };
  return { transform: transformModule.createTransform(deps), contextUsageMap };
}

/** transform 的 pass 在这个最小装配下会在后半段停住；那不影响被断言的那一段。 */
async function b4RunPass(transform, userText) {
  const output = { messages: b4Messages(userText) };
  try {
    await transform({}, output);
  } catch {
    // Deliberate: the assertions are about session_meta / the usage map, both of
    // which are settled before the later stages this minimal deps graph cannot
    // serve. A pass that ran to completion is fine too.
  }
}

function b4ReadPersistedPct() {
  const row = b4Db
    .prepare(
      "SELECT last_context_percentage AS pct, last_input_tokens AS tokens FROM session_meta WHERE session_id = ?",
    )
    .get(B4_SESSION);
  return row ?? { pct: 0, tokens: 0 };
}

/** 宿主 recorder 的落库那一半：`model_complete` → `updateSessionMeta`。 */
function b4HostRecorderWritesUsage(at) {
  storageMeta.updateSessionMeta(b4Db, B4_SESSION, {
    lastContextPercentage: B4_PCT,
    lastInputTokens: B4_TOKENS,
    lastResponseTime: at,
    lastObservedModelKey: "zcode/glm-5.3",
    lastUsageContextLimit: 200_000,
  });
}

test("b4 process 2 keeps the persisted usage (one-process-per-turn)", async () => {
  // ── 进程 1 ────────────────────────────────────────────────────────────────
  const first = b4Process({ hostProcessLifetime: "one-process-per-turn" });
  await b4RunPass(first.transform, "turn one");
  b4HostRecorderWritesUsage(1_800_000_000_000);
  const seeded = b4ReadPersistedPct();
  if (seeded.pct !== B4_PCT) {
    throw new Error(`the host recorder did not persist usage: ${JSON.stringify(seeded)}`);
  }

  // ── 进程 2（新进程 = 空 loadedSessions，prime 带回上一轮读数）──────────────
  const second = b4Process({ hostProcessLifetime: "one-process-per-turn" });
  const primed = second.contextUsageMap.get(B4_SESSION);
  if (!primed || primed.usage.percentage !== B4_PCT) {
    throw new Error(`prime() did not carry the reading: ${JSON.stringify(primed)}`);
  }
  await b4RunPass(second.transform, "turn two");

  const after = b4ReadPersistedPct();
  if (after.pct !== B4_PCT || after.tokens !== B4_TOKENS) {
    throw new Error(
      `the second process reset the accumulated usage: ${JSON.stringify(after)} ` +
        `(expected ${B4_PCT}% / ${B4_TOKENS} tokens)`,
    );
  }
  // 内存条目也不能被删：删了它，`loadContextUsage` 就回表读到已被清零的 meta。
  const live = second.contextUsageMap.get(B4_SESSION);
  if (!live || live.usage.percentage !== B4_PCT) {
    throw new Error(`the primed in-memory reading was dropped: ${JSON.stringify(live)}`);
  }
});

test("b4 a host that does not declare its process model keeps upstream's reset", async () => {
  // 对照组：没有 `hostProcessLifetime` 时行为必须与上游逐字相同（清零）。
  // 少了这一条，上面那条可能因为「压根没跑到那段代码」而空过。
  b4HostRecorderWritesUsage(1_800_000_000_001);
  const upstream = b4Process({ hostProcessLifetime: undefined });
  await b4RunPass(upstream.transform, "turn three");
  const after = b4ReadPersistedPct();
  if (after.pct !== 0 || after.tokens !== 0) {
    throw new Error(`upstream's first-pass reset no longer fires: ${JSON.stringify(after)}`);
  }
});

// --- b5: edit-resend 后同位置消息被替换，旧 source 不得覆盖新正文 ---
//
// v1.0.29 真机根因：MC 的 tag 身份是位置（host 投影的 `mc<ordinal>`），
// `source_contents[tagId]` 保存打 tag 前的原文。编辑重发（rewind）会让同一位置
// 换成另一条消息；旧实现无条件用持久 source 覆盖，模型因此始终读到被编辑掉的
// 那条（用户症状：编辑后发出去的还是历史消息）。

const tagMessagesB5 = await load("hooks/magic-context/tag-messages.js");
const B5_SESSION = "ses_edit_resend_same_position";
// 宿主投影给消息的 id：位置身份，rewind 前后不变——正是 bug 的触发条件。
const B5_MESSAGE_ID = "mc1";

function b5Message(text) {
  return [
    {
      info: { id: B5_MESSAGE_ID, role: "user", sessionID: B5_SESSION, time: { created: 1000 } },
      parts: [{ type: "text", text }],
    },
  ];
}

test("b5 edit-resend refreshes source_content instead of replaying the stale text", () => {
  const tagger = taggerModule.createTagger();
  const first = b5Message("123");
  tagMessagesB5.tagMessages(B5_SESSION, first, tagger, b4Db);
  const firstText = first[0].parts[0].text;
  if (!/^§\d+§ 123$/u.test(firstText)) {
    throw new Error(`unexpected first-pass wire text: ${firstText}`);
  }

  // 同一位置（同 mc id）被编辑重发换成新正文；旧实现会回放 "123"。
  const edited = b5Message("789");
  tagMessagesB5.tagMessages(B5_SESSION, edited, tagger, b4Db);
  const editedText = edited[0].parts[0].text;
  if (!/^§\d+§ 789$/u.test(editedText)) {
    throw new Error(`stale source content replayed: ${editedText}`);
  }

  // 对照：内容没变时仍复用同一 tag 与同一正文（修复不得破坏跨 pass 稳定性）。
  const stable = b5Message("789");
  tagMessagesB5.tagMessages(B5_SESSION, stable, tagger, b4Db);
  const stableText = stable[0].parts[0].text;
  if (stableText !== editedText) {
    throw new Error(`stable content changed across passes: ${stableText} !== ${editedText}`);
  }
});

// --- g: system prompt guard（magic-context-system-prompt-guard，Step 8 收口） ---
//
// spec §六 的 T-G4–T-G16（T-G1/G2/G3 在 test-ctx-tools.mjs，T-G9/T-G15 在
// smoke-storage.mjs）。全部用例驱动真实持久层：复用 b4 已打开的临时库
// （MAGIC_CONTEXT_DB_DIR），每个用例独立 session id，不碰用户真实库。
// 关注点不是「函数可调用」，而是「system 段在每条清扫路径上都不改变 wire 字节」。

const storage = await load("features/magic-context/storage.js");
const storageTags = await load("features/magic-context/storage-tags.js");
const tagMessagesModule = await load("hooks/magic-context/tag-messages.js");
const sentinelModule = await load("hooks/magic-context/sentinel.js");
const stripContentModule = await load("hooks/magic-context/strip-content.js");
const heuristicModule = await load("hooks/magic-context/heuristic-cleanup.js");
const cavemanCleanupModule = await load("hooks/magic-context/caveman-cleanup.js");
const executeFlushModule = await load("hooks/magic-context/execute-flush.js");
const cloneStorageModule = await load("features/magic-context/storage-clone.js");

const {
  getTagById,
  insertTag,
  markWhitespaceAssistantTagInert,
  stampTagMessageRole,
  updateCavemanDepth,
  updateTagStatus,
} = storageTags;
const { getActiveTagsBySession, getPendingOps, queuePendingOp, saveSourceContent } = storage;

/** OpenCode 形状的单条消息：`info.role` 是 strip/heuristic/caveman 的判据面。 */
function guardMessage(id, role, text) {
  return {
    info: { id, role, sessionID: "ses_guard_fixture" },
    parts: [{ type: "text", text }],
  };
}

/**
 * 最小 TagTarget：只实现 message/getContent/setContent/textPrefix。
 * `content` 由闭包持有，断言直接读它，才能看出防线是否真的改了 wire 字节。
 */
function guardTarget(role, text, tagNumber) {
  let content = text;
  return {
    message: guardMessage(`msg_guard_target_${tagNumber}`, role, text),
    textPrefix: `${SECTION}${tagNumber}${SECTION} `,
    getContent: () => content,
    setContent: (next) => {
      if (content === next) return false;
      content = next;
      return true;
    },
  };
}

/** 记录 system 行的 caveman_depth（oqfix/3：三入口豁免后档位必须原地不动）。 */
function guardCavemanDepths(sessionId, tagNumbers) {
  return new Map(
    tagNumbers.map((tagNumber) => [
      tagNumber,
      getTagById(b4Db, sessionId, tagNumber)?.cavemanDepth,
    ]),
  );
}

function assertGuardCavemanDepthsUnchanged(sessionId, before, label) {
  for (const [tagNumber, depth] of before) {
    const after = getTagById(b4Db, sessionId, tagNumber)?.cavemanDepth;
    if (after !== depth) {
      throw new Error(
        `${label} changed system tag ${tagNumber} caveman_depth ${depth} -> ${after}`,
      );
    }
  }
}

test("T-G4 applyPendingOperations keeps a system tag active and drains its pending op", () => {
  const sessionId = "ses_tg4_apply_column";
  insertTag(b4Db, sessionId, "msg_tg4:p0", "message", 16, 1);
  stampTagMessageRole(b4Db, sessionId, 1, "system");
  queuePendingOp(b4Db, sessionId, 1, "drop");
  // target 的 role 故意是 assistant：命中只能来自持久列，证明列判据独立生效。
  const target = guardTarget("assistant", "system prompt body", 1);

  const mutated = applyOps.applyPendingOperations(
    sessionId,
    b4Db,
    new Map([[1, target]]),
    new Set(),
  );

  if (mutated) throw new Error("the protected drop reported a wire mutation");
  if (target.getContent() !== "system prompt body") {
    throw new Error(`target content changed: ${JSON.stringify(target.getContent())}`);
  }
  if (getTagById(b4Db, sessionId, 1)?.status !== "active")
    throw new Error("the system tag left active");
  if (getPendingOps(b4Db, sessionId).length !== 0)
    throw new Error("the rejected pending op was left in the queue");
});

test("T-G5 the in-memory target role guards rows whose message_role is still NULL", () => {
  const sessionId = "ses_tg5_apply_target_role";
  // 列保持 NULL：升级过渡期（首个 tagMessages pass 回填前）的真实形态。
  insertTag(b4Db, sessionId, "msg_tg5:p0", "message", 16, 1);
  queuePendingOp(b4Db, sessionId, 1, "drop");
  const target = guardTarget("system", "system prompt body", 1);

  const mutated = applyOps.applyPendingOperations(
    sessionId,
    b4Db,
    new Map([[1, target]]),
    new Set(),
  );

  if (mutated) throw new Error("the protected drop reported a wire mutation");
  if (target.getContent() !== "system prompt body") {
    throw new Error(`target content changed: ${JSON.stringify(target.getContent())}`);
  }
  if (getTagById(b4Db, sessionId, 1)?.status !== "active")
    throw new Error("the system tag left active");
  if (getPendingOps(b4Db, sessionId).length !== 0)
    throw new Error("the rejected pending op was left in the queue");
});

test("T-G6 applyFlushedStatuses heals a dropped system tag back to active", () => {
  const sessionId = "ses_tg6_replay_heal";
  insertTag(b4Db, sessionId, "msg_tg6_sys:p0", "message", 16, 1);
  stampTagMessageRole(b4Db, sessionId, 1, "system");
  updateTagStatus(b4Db, sessionId, 1, "dropped");
  insertTag(b4Db, sessionId, "msg_tg6_user:p0", "message", 16, 2);
  updateTagStatus(b4Db, sessionId, 2, "dropped");

  const systemTarget = guardTarget("assistant", "system prompt body", 1);
  const controlTarget = guardTarget("user", "old user text", 2);
  const mutated = applyOps.applyFlushedStatuses(
    sessionId,
    b4Db,
    new Map([
      [1, systemTarget],
      [2, controlTarget],
    ]),
  );

  // 对照组证明本 pass 的 replay 真的在跑，而不是整条路径空转。
  if (!mutated) throw new Error("the non-system control did not mutate");
  if (getTagById(b4Db, sessionId, 1)?.status !== "active")
    throw new Error("the dropped system tag was not healed");
  if (systemTarget.getContent() !== "system prompt body") {
    throw new Error(`system wire was rewritten: ${JSON.stringify(systemTarget.getContent())}`);
  }
  if (getTagById(b4Db, sessionId, 2)?.status !== "dropped")
    throw new Error("the non-system control left dropped");
  if (controlTarget.getContent() !== dropped(2)) {
    throw new Error(
      `control did not replay its placeholder: ${JSON.stringify(controlTarget.getContent())}`,
    );
  }
});

test("T-G7 marker-only system messages survive dropped-placeholder stripping", () => {
  const marker = dropped(9);
  const system = guardMessage("msg_tg7_sys", "system", marker);
  const assistant = guardMessage("msg_tg7_asst", "assistant", marker);

  const result = stripContentModule.stripDroppedPlaceholderMessages([system, assistant]);

  if (result.stripped !== 1) throw new Error(`stripped=${result.stripped}`);
  if (system.parts.length !== 1 || system.parts[0].text !== marker) {
    throw new Error(`system message was neutralized: ${JSON.stringify(system.parts)}`);
  }
  if (result.sentineledIds.includes("msg_tg7_sys")) {
    throw new Error(`system id was sentineled: ${JSON.stringify(result.sentineledIds)}`);
  }
  if (assistant.parts[0].text !== "[dropped]") {
    throw new Error(`assistant control was not neutralized: ${JSON.stringify(assistant.parts)}`);
  }
});

test("T-G8 replaySentinelByMessageIds skips system ids but still counts them as seen", () => {
  const system = guardMessage("msg_tg8_sys", "system", "system prompt body");
  const assistant = guardMessage("msg_tg8_asst", "assistant", "an answer");
  const ids = new Set(["msg_tg8_sys", "msg_tg8_asst"]);

  const result = sentinelModule.replaySentinelByMessageIds([system, assistant], ids);

  if (result.replayed !== 1) throw new Error(`replayed=${result.replayed}`);
  // system 计入 seen：frozen set 里的 id 若在 wire 上，就不该报 missing。
  if (result.missingIds.length !== 0) {
    throw new Error(`unexpected missing ids: ${JSON.stringify(result.missingIds)}`);
  }
  if (system.parts[0].text !== "system prompt body") {
    throw new Error(`system message was neutralized: ${JSON.stringify(system.parts)}`);
  }
  if (assistant.parts[0].text !== "[dropped]") {
    throw new Error(`assistant control was not neutralized: ${JSON.stringify(assistant.parts)}`);
  }
});

test("T-G10 heuristic routine leaves a fully injected system message alone", () => {
  const sessionId = "ses_tg10_heuristic";
  const injected = "<system-reminder>todo reminder</system-reminder>";
  insertTag(b4Db, sessionId, "msg_tg10_sys:p0", "message", injected.length, 1);
  stampTagMessageRole(b4Db, sessionId, 1, "system");
  insertTag(b4Db, sessionId, "msg_tg10_user:p0", "message", injected.length, 2);
  stampTagMessageRole(b4Db, sessionId, 2, "user");

  const systemTarget = guardTarget("system", injected, 1);
  const userTarget = guardTarget("user", injected, 2);
  const result = heuristicModule.applyHeuristicCleanup(
    sessionId,
    b4Db,
    new Map([
      [1, systemTarget],
      [2, userTarget],
    ]),
    new Map(),
    { protectedTagNumbers: new Set(), protectedCutoff: null, routine: true },
  );

  if (result.droppedInjections !== 1) {
    throw new Error(
      `droppedInjections=${result.droppedInjections} (expected only the user control)`,
    );
  }
  if (systemTarget.getContent() !== injected) {
    throw new Error(`system content was stripped: ${JSON.stringify(systemTarget.getContent())}`);
  }
  if (getTagById(b4Db, sessionId, 1)?.status !== "active")
    throw new Error("the system tag was dropped");
  if (userTarget.getContent() !== dropped(2)) {
    throw new Error(`user control was not dropped: ${JSON.stringify(userTarget.getContent())}`);
  }
  if (getTagById(b4Db, sessionId, 2)?.status !== "dropped")
    throw new Error("the user control stayed active");
});

test("T-G11 tagMessages backfills message_role on existing content-id tags", () => {
  // 2026-11-26 trim-integrity 起入站 system 行只沿用自身 message_role='system'
  // 的位置命中 tag；角色为空的存量行按 spec 问题三墓碑化换号（不再被 stamp 纠正
  // ——NULL 行可能是无关对话的 tag，沿用会把对话原文换成 system prompt）。
  // 本用例夹具随之预置 role='system'，断言的「沿用 system tag」语义不变。
  // 依据：docs/iterations/magic-context-trim-integrity/spec.md:133-136（NULL-role
  // 存量行列为漂移误命中情形、沿用判据收紧为 message_role==='system'）。
  // ① 生产路径：tagMessages 前先 initFromDb（transform.ts 同款），resolver 经
  //    contentId 精确命中已有的 message_id='msg:...:p0' 行。
  const productionSession = "ses_tg11_production";
  insertTag(b4Db, productionSession, "msg_tg11a:p0", "message", 16, 1);
  stampTagMessageRole(b4Db, productionSession, 1, "system");
  const productionTagger = taggerModule.createTagger();
  productionTagger.initFromDb(productionSession, b4Db);
  const productionMessages = [guardMessage("msg_tg11a", "system", "system prompt body")];
  tagMessagesModule.tagMessages(productionSession, productionMessages, productionTagger, b4Db);

  if (getTagById(b4Db, productionSession, 1)?.messageRole !== "system") {
    throw new Error("the existing tag was not stamped on the initFromDb path");
  }
  if (productionMessages[0].parts[0].text !== `${SECTION}1${SECTION} system prompt body`) {
    throw new Error(
      `the existing tag was not reused: ${JSON.stringify(productionMessages[0].parts[0].text)}`,
    );
  }

  // ② 冷 tagger：不 initFromDb，assignTag 的 dbExistingLookup 收养同一行。
  const coldSession = "ses_tg11_cold";
  insertTag(b4Db, coldSession, "msg_tg11b:p0", "message", 16, 1);
  stampTagMessageRole(b4Db, coldSession, 1, "system");
  const coldTagger = taggerModule.createTagger();
  const coldMessages = [guardMessage("msg_tg11b", "system", "system prompt body")];
  tagMessagesModule.tagMessages(coldSession, coldMessages, coldTagger, b4Db);

  if (getTagById(b4Db, coldSession, 1)?.messageRole !== "system") {
    throw new Error("the adopted existing tag was not stamped on the cold path");
  }
  if (coldMessages[0].parts[0].text !== `${SECTION}1${SECTION} system prompt body`) {
    throw new Error(
      `cold adoption did not reuse tag 1: ${JSON.stringify(coldMessages[0].parts[0].text)}`,
    );
  }
  if (storage.getTagsBySession(b4Db, coldSession).length !== 1) {
    throw new Error("the cold path allocated a second tag instead of adopting the row");
  }
});

test("T-G12 caveman skips system tags in eligibility, rules-switch and replay", () => {
  const original = "The user is just really very happy that this simple thing works well for them.";
  const cavemanConfig = { enabled: true, minChars: 10, protectedCutoff: null };

  // ① eligibility：列判据与 target 兜底判据各自命中；非 system 对照组正常压缩。
  const eligibilitySession = "ses_tg12_eligibility";
  insertTag(b4Db, eligibilitySession, "msg_tg12a:p0", "message", original.length, 1);
  stampTagMessageRole(b4Db, eligibilitySession, 1, "system");
  insertTag(b4Db, eligibilitySession, "msg_tg12a:p1", "message", original.length, 2);
  insertTag(b4Db, eligibilitySession, "msg_tg12a:p2", "message", original.length, 3);
  stampTagMessageRole(b4Db, eligibilitySession, 3, "user");
  for (const tagNumber of [1, 2, 3]) {
    saveSourceContent(b4Db, eligibilitySession, tagNumber, original);
  }
  const eligibilityByColumn = guardTarget("assistant", original, 1);
  const eligibilityByTarget = guardTarget("system", original, 2);
  const eligibilityControl = guardTarget("user", original, 3);
  const eligibilityDepths = guardCavemanDepths(eligibilitySession, [1, 2]);
  const eligibilityResult = cavemanCleanupModule.applyCavemanCleanup(
    eligibilitySession,
    b4Db,
    new Map([
      [1, eligibilityByColumn],
      [2, eligibilityByTarget],
      [3, eligibilityControl],
    ]),
    getActiveTagsBySession(b4Db, eligibilitySession),
    cavemanConfig,
  );

  if (eligibilityResult.compressedToUltra !== 1) {
    throw new Error(
      `eligibility compressed ${eligibilityResult.compressedToUltra} tags (expected only the user control)`,
    );
  }
  if (eligibilityByColumn.getContent() !== original)
    throw new Error("eligibility compressed a system tag matched by message_role");
  if (eligibilityByTarget.getContent() !== original)
    throw new Error("eligibility compressed a system tag matched by target.message.info.role");
  if (eligibilityControl.getContent() === original)
    throw new Error("the non-system control was not compressed");
  assertGuardCavemanDepthsUnchanged(eligibilitySession, eligibilityDepths, "eligibility");

  // ② rules-switch：已压缩 system 行不在重写清单；普通行按新规则重写。
  const switchSession = "ses_tg12_rules_switch";
  insertTag(b4Db, switchSession, "msg_tg12b:p0", "message", original.length, 1);
  stampTagMessageRole(b4Db, switchSession, 1, "system");
  updateCavemanDepth(b4Db, switchSession, 1, 1);
  insertTag(b4Db, switchSession, "msg_tg12b:p1", "message", original.length, 2);
  updateCavemanDepth(b4Db, switchSession, 2, 1);
  insertTag(b4Db, switchSession, "msg_tg12b:p2", "message", original.length, 3);
  stampTagMessageRole(b4Db, switchSession, 3, "user");
  updateCavemanDepth(b4Db, switchSession, 3, 3);
  for (const tagNumber of [1, 2, 3]) {
    saveSourceContent(b4Db, switchSession, tagNumber, original);
  }
  const switchByColumn = guardTarget("assistant", original, 1);
  const switchByTarget = guardTarget("system", original, 2);
  const switchControl = guardTarget("user", original, 3);
  const switchDepths = guardCavemanDepths(switchSession, [1, 2]);
  const switchResult = cavemanCleanupModule.applyCavemanCleanup(
    switchSession,
    b4Db,
    new Map([
      [1, switchByColumn],
      [2, switchByTarget],
      [3, switchControl],
    ]),
    getActiveTagsBySession(b4Db, switchSession),
    cavemanConfig,
  );

  if (switchResult.mutatedTextTags !== 1) {
    throw new Error(
      `rules-switch rewrote ${switchResult.mutatedTextTags} tags (expected only the control)`,
    );
  }
  if (switchByColumn.getContent() !== original)
    throw new Error("rules-switch rewrote a system tag matched by message_role");
  if (switchByTarget.getContent() !== original)
    throw new Error("rules-switch rewrote a system tag matched by target.message.info.role");
  if (switchControl.getContent() === original)
    throw new Error("the non-system control was not rewritten");
  assertGuardCavemanDepthsUnchanged(switchSession, switchDepths, "rules-switch");

  // ③ replay：已压缩 system 行不重放压缩字节；普通行照常重放。
  const replaySession = "ses_tg12_replay";
  insertTag(b4Db, replaySession, "msg_tg12c:p0", "message", original.length, 1);
  stampTagMessageRole(b4Db, replaySession, 1, "system");
  updateCavemanDepth(b4Db, replaySession, 1, 2);
  insertTag(b4Db, replaySession, "msg_tg12c:p1", "message", original.length, 2);
  updateCavemanDepth(b4Db, replaySession, 2, 2);
  insertTag(b4Db, replaySession, "msg_tg12c:p2", "message", original.length, 3);
  stampTagMessageRole(b4Db, replaySession, 3, "user");
  updateCavemanDepth(b4Db, replaySession, 3, 2);
  for (const tagNumber of [1, 2, 3]) {
    saveSourceContent(b4Db, replaySession, tagNumber, original);
  }
  const replayByColumn = guardTarget("assistant", original, 1);
  const replayByTarget = guardTarget("system", original, 2);
  const replayControl = guardTarget("user", original, 3);
  const replayDepths = guardCavemanDepths(replaySession, [1, 2]);
  const replayed = cavemanCleanupModule.replayCavemanCompression(
    replaySession,
    b4Db,
    new Map([
      [1, replayByColumn],
      [2, replayByTarget],
      [3, replayControl],
    ]),
    getActiveTagsBySession(b4Db, replaySession),
  );

  if (replayed !== 1) throw new Error(`replayed=${replayed} (expected only the control)`);
  if (replayByColumn.getContent() !== original)
    throw new Error("replay rewrote a system tag matched by message_role");
  if (replayByTarget.getContent() !== original)
    throw new Error("replay rewrote a system tag matched by target.message.info.role");
  if (replayControl.getContent() === original) {
    throw new Error("the non-system control was not replayed");
  }
  assertGuardCavemanDepthsUnchanged(replaySession, replayDepths, "replay");
});

test("T-G13 stripSystemInjectedMessages never neutralizes a system message", () => {
  const injected = "<system-reminder>todo reminder</system-reminder>";
  const system = guardMessage("msg_tg13_sys", "system", injected);
  const assistant = guardMessage("msg_tg13_asst", "assistant", injected);

  // protectedTailStart 放到数组末尾：两条都在可中和区间内。
  const result = stripContentModule.stripSystemInjectedMessages([system, assistant], 2);

  if (result.stripped !== 1) throw new Error(`stripped=${result.stripped}`);
  if (system.parts.length !== 1 || system.parts[0].text !== injected) {
    throw new Error(`system message was neutralized: ${JSON.stringify(system.parts)}`);
  }
  if (result.sentineledIds.includes("msg_tg13_sys")) {
    throw new Error(`system id was sentineled: ${JSON.stringify(result.sentineledIds)}`);
  }
  if (assistant.parts[0].text !== "[dropped]") {
    throw new Error(`assistant control was not neutralized: ${JSON.stringify(assistant.parts)}`);
  }
});

test("T-G14 executeFlush skips pending ops that target a system tag", () => {
  const sessionId = "ses_tg14_flush";
  insertTag(b4Db, sessionId, "msg_tg14_sys:p0", "message", 16, 1);
  stampTagMessageRole(b4Db, sessionId, 1, "system");
  insertTag(b4Db, sessionId, "msg_tg14_user:p0", "message", 16, 2);
  stampTagMessageRole(b4Db, sessionId, 2, "user");
  queuePendingOp(b4Db, sessionId, 1, "drop");
  queuePendingOp(b4Db, sessionId, 2, "drop");

  const message = executeFlushModule.executeFlush(b4Db, sessionId);

  if (!/^Flushed: 1 dropped\. Changes take effect on next message\.$/.test(message)) {
    throw new Error(`unexpected flush result: ${JSON.stringify(message)}`);
  }
  if (getTagById(b4Db, sessionId, 1)?.status !== "active")
    throw new Error("executeFlush dropped the system tag");
  // system op 留队，交给 applyPendingOperations 的 system_protected 语义处理。
  const remaining = getPendingOps(b4Db, sessionId).map((op) => op.tagId);
  if (remaining.length !== 1 || remaining[0] !== 1) {
    throw new Error(`remaining pending ops: ${JSON.stringify(remaining)}`);
  }
  if (getTagById(b4Db, sessionId, 2)?.status !== "dropped")
    throw new Error("the non-system control was not dropped");
});

test("T-G14b executeFlush reports 0 dropped for an all-system queue", () => {
  const sessionId = "ses_tg14_flush_system_only";
  insertTag(b4Db, sessionId, "msg_tg14b_sys:p0", "message", 16, 1);
  stampTagMessageRole(b4Db, sessionId, 1, "system");
  queuePendingOp(b4Db, sessionId, 1, "drop");

  const message = executeFlushModule.executeFlush(b4Db, sessionId);

  // 守卫前该路径不可达：parts 为空会输出 `Flushed: . Changes ...`。文案必须始终带计数。
  if (message !== "Flushed: 0 dropped. Changes take effect on next message.") {
    throw new Error(`unexpected flush result: ${JSON.stringify(message)}`);
  }
  if (getTagById(b4Db, sessionId, 1)?.status !== "active")
    throw new Error("executeFlush changed the system tag status");
  const remaining = getPendingOps(b4Db, sessionId).map((op) => op.tagId);
  if (remaining.length !== 1 || remaining[0] !== 1) {
    throw new Error(`remaining pending ops: ${JSON.stringify(remaining)}`);
  }
});

test("T-G16 stampTagMessageRole is a no-op on the second pass for system and null roles", () => {
  const sessionId = "ses_tg16_stamp";

  insertTag(b4Db, sessionId, "msg_tg16_sys:p0", "message", 16, 1);
  const first = stampTagMessageRole(b4Db, sessionId, 1, "system");
  const second = stampTagMessageRole(b4Db, sessionId, 1, "system");
  if (first !== 1) throw new Error(`first stamp changed ${first} rows (expected 1)`);
  if (second !== 0) throw new Error(`second stamp changed ${second} rows (expected 0)`);
  if (getTagById(b4Db, sessionId, 1)?.messageRole !== "system") {
    throw new Error("the stamped role drifted");
  }

  // role=null：初始 NULL 与目标 role 相同，IS NOT 比较应让两次都是 0 行。
  insertTag(b4Db, sessionId, "msg_tg16_null:p0", "message", 16, 2);
  const nullFirst = stampTagMessageRole(b4Db, sessionId, 2, null);
  const nullSecond = stampTagMessageRole(b4Db, sessionId, 2, null);
  if (nullFirst !== 0) throw new Error(`first null stamp changed ${nullFirst} rows`);
  if (nullSecond !== 0) throw new Error(`second null stamp changed ${nullSecond} rows`);
  if (getTagById(b4Db, sessionId, 2)?.messageRole !== null) {
    throw new Error("the null role drifted");
  }
});

test("oqfix/4 storage-clone copies message_role with every other tag column", () => {
  const sourceSession = "ses_oqfix4_clone_source";
  const destinationSession = "ses_oqfix4_clone_destination";
  // 克隆 INSERT 的 18 列（含 session_id）；逐列写入可区分值，任一列丢失或被
  // 改写都会让下面的逐列对比变红。message_role 是本 fork 车道新增列。
  const cloneColumns = [
    "session_id",
    "message_id",
    "type",
    "status",
    "byte_size",
    "tag_number",
    "harness",
    "entry_fingerprint",
    "token_count",
    "input_token_count",
    "reasoning_token_count",
    "reasoning_byte_size",
    "drop_mode",
    "tool_name",
    "input_byte_size",
    "caveman_depth",
    "tool_owner_message_id",
    "message_role",
  ];
  if (cloneColumns.length !== 18)
    throw new Error(`clone contract covers ${cloneColumns.length} columns`);
  const projection = cloneColumns.join(", ");

  insertTag(b4Db, sourceSession, "msg_oqfix4_src:p0", "file", 4096, 1);
  b4Db
    .prepare(
      `UPDATE tags
          SET message_id = ?, type = ?, status = ?, byte_size = ?, tag_number = ?,
              harness = ?, entry_fingerprint = ?, token_count = ?, input_token_count = ?,
              reasoning_token_count = ?, reasoning_byte_size = ?, drop_mode = ?, tool_name = ?,
              input_byte_size = ?, caveman_depth = ?, tool_owner_message_id = ?, message_role = ?
        WHERE session_id = ? AND tag_number = ?`,
    )
    .run(
      "msg_oqfix4_src:p0",
      "file",
      "active",
      4096,
      1,
      "pi",
      "fingerprint-oqfix4",
      77,
      11,
      5,
      19,
      "edit_marker_stripped",
      "read",
      3000,
      2,
      null,
      "system",
      sourceSession,
      1,
    );

  const sourceRow = b4Db
    .prepare(`SELECT ${projection} FROM tags WHERE session_id = ? AND tag_number = 1`)
    .get(sourceSession);
  if (!sourceRow) throw new Error("the source tag row was not written");

  const result = cloneStorageModule.copySessionStateForClone(
    b4Db,
    sourceSession,
    destinationSession,
    {
      resolveBoundaryOrdinal: () => 0,
      includeTag: () => true,
      includeMessageId: () => true,
      selectPendingPiMarker: () => null,
    },
  );
  if (result.kind !== "migrated" || result.tagsCopied !== 1) {
    throw new Error(`clone result: ${JSON.stringify(result)}`);
  }

  const clonedRow = b4Db
    .prepare(`SELECT ${projection} FROM tags WHERE session_id = ? AND tag_number = 1`)
    .get(destinationSession);
  if (!clonedRow) throw new Error("the clone did not copy the tag row");
  if (clonedRow.message_role !== "system") {
    throw new Error(`message_role was not copied: ${JSON.stringify(clonedRow.message_role)}`);
  }
  const expected = { ...sourceRow, session_id: destinationSession };
  if (JSON.stringify(clonedRow) !== JSON.stringify(expected)) {
    throw new Error(
      `cloned tag columns drifted:\n  expected=${JSON.stringify(expected)}\n  actual  =${JSON.stringify(clonedRow)}`,
    );
  }
});

// --- b5b: tag 坐标重启后漂移（trim-integrity 问题三，spec T-T*） --------------
//
// tag 身份是位置字符串 `mc<N>:p<下标>`，重启后 context 前缀长度变化会让整个窗口
// 平移，位置命中不再比对内容。这一组用例驱动真实持久层（复用 b4 的临时库，每个
// 用例独立 session id，不碰用户真实库），覆盖：
//   T-T1  漂移保号（平移后三条消息沿用 pass 1 的 tag 号，幂等）；
//   T-T3  墓碑化（位置命中的 part 换新号，S(T)/status 不动，message_id 变墓碑键）；
//   T-T4a 编辑重发退化桶（原文不在入站 → 沿用并覆盖，与 b5 同形）；
//   T-T4b 样板多候选（不认领、不漂移，确定性退化）；
//   T-T6  无存量原文（无法判定 → 与修复前一致）；
//   T-T7  认领候选过滤逐项（dropped / compacted / system / NULL / file）；
//   T-T8  同消息双文本片段（漂移屏蔽 scoped fallback，兄弟 part 不被抢占）；
//   T-T9  入站 system 行专门规则（非 system 旧 tag 墓碑化拿新号；system 旧 tag 沿用）。
// 既有 b5（T-T2）保持不变：同位置换内容、旧原文不在入站、新文本反查无命中 →
// 沿用原号并覆盖原文。
//
// 预置 tag 的号手动指定；「新分配」断言写成 ∉ 预置号集合，不与 allocateTag 的
// counter/dbMax 细节耦合（tagger.ts 的分配循环每次取 max(内存, DB max)+1）。

const b5bSource = (sessionId, tagNumber) =>
  storage.getSourceContents(b4Db, sessionId, [tagNumber]).get(tagNumber);

const b5bWireTag = (text) => {
  const m = /^§(\d+)§ /u.exec(text);
  if (!m) throw new Error(`wire has no §N§ prefix: ${JSON.stringify(text)}`);
  return Number(m[1]);
};

/** OpenCode 形状的消息；texts 依次成为该消息的多个 text part。 */
function b5bMessage(sessionId, id, role, ...texts) {
  return {
    info: { id, role, sessionID: sessionId, time: { created: 1000 } },
    parts: texts.map((text) => ({ type: "text", text })),
  };
}

test("b5b T-T1 漂移保号：平移后三条消息沿用 pass 1 的 tag 号", () => {
  // v2 手算（spec 问题三 (b′)）：pass 1 是全新会话，source_contents 为空 → 候选集
  // {0}、score(0)=0 → argmax=0，(a) 类，走 v1 正常分配。pass 2：候选集 {0,+1}
  // ——A@mc2:p0 的唯一持有者 tag1@mc1:p0、B@mc3:p0 的 tag2@mc2:p0、C@mc4:p0 的
  // tag3@mc3:p0 各给出 +1；score(+1)=3（A/B/C 在 mc1/mc2/mc3 上原文相等）、
  // score(0)=0 → d*=+1 平移成立 → 本用例属 (b) 类，平移相符分支接管：三个 part
  // 全部平移相符（按位置找回 tag1/2/3，号与原文不变、status 不动），结果与 v1
  // 内容认领路径的断言逐项相容 →「双路径相容」，原断言保留不变。pass 3：三个
  // 持有者已被重绑到入站同位键（mc2/mc3/mc4），候选集退化为 {0}，score(0)=3 但
  // d*=0 → v1 精确命中沿用，逐字节相同。
  const sessionId = "ses_tt1_drift_keep_number";
  const tagger = taggerModule.createTagger();
  const mkPass = (ids) =>
    ids.map((id, i) =>
      b5bMessage(
        sessionId,
        id,
        "user",
        ...["alpha-text", "beta-text", "gamma-text"].slice(i, i + 1),
      ),
    );

  const pass1 = mkPass(["mc1", "mc2", "mc3"]);
  tagMessagesB5.tagMessages(sessionId, pass1, tagger, b4Db);
  const firstTags = pass1.map((m) => b5bWireTag(m.parts[0].text));
  if (JSON.stringify(firstTags) !== JSON.stringify([1, 2, 3])) {
    throw new Error(`unexpected pass-1 tags: ${JSON.stringify(firstTags)}`);
  }

  // pass 2：同样三条消息平移到 mc2..mc4（模拟重启后前缀增长）。内容认领（v1）
  // 与平移相符（v2，双路径相容）都让唯一文本的编号保持稳定——含落在没有位置
  // 命中的 mc4 上的第三条。
  const pass2 = mkPass(["mc2", "mc3", "mc4"]);
  tagMessagesB5.tagMessages(sessionId, pass2, tagger, b4Db);
  const secondTags = pass2.map((m) => b5bWireTag(m.parts[0].text));
  if (JSON.stringify(secondTags) !== JSON.stringify(firstTags)) {
    throw new Error(
      `drifted tags changed across restart: ${JSON.stringify(secondTags)} !== ${JSON.stringify(firstTags)}`,
    );
  }
  const sources = secondTags.map((n) => b5bSource(sessionId, n));
  if (JSON.stringify(sources) !== JSON.stringify(["alpha-text", "beta-text", "gamma-text"])) {
    throw new Error(`source_contents drifted: ${JSON.stringify(sources)}`);
  }

  // pass 3：重复 pass 2，结果逐字节相同（幂等）。
  const pass3 = mkPass(["mc2", "mc3", "mc4"]);
  tagMessagesB5.tagMessages(sessionId, pass3, tagger, b4Db);
  const pass2Wire = pass2.map((m) => m.parts[0].text);
  const pass3Wire = pass3.map((m) => m.parts[0].text);
  if (JSON.stringify(pass3Wire) !== JSON.stringify(pass2Wire)) {
    throw new Error(
      `third pass is not byte-identical: ${JSON.stringify(pass3Wire)} !== ${JSON.stringify(pass2Wire)}`,
    );
  }
});

test("b5b T-T3 漂移墓碑化：位置命中的 part 换新号，S(T) 与 status 不动", () => {
  // v2 手算（spec 问题三 (b′)）：候选集 {0, +1}——P@mc2:p0 的唯一持有者
  // tag1@mc1:p0 给出 +1（X 的反查无持有者、不产候选）；score(+1)=1（P 在
  // mc1:p0 上对齐 tag1）、score(0)=0 → 最高分 1 < 3 → d = 0，留在 v1 分支 →
  // (a) 类，断言不变。
  const sessionId = "ses_tt3_drift_tombstone";
  // 预置 T：tag 1 @mc1:p0，原文 P，dropped（原主人已被折叠）。
  insertTag(b4Db, sessionId, "mc1:p0", "message", 16, 1);
  saveSourceContent(b4Db, sessionId, 1, "drift-original-P");
  updateTagStatus(b4Db, sessionId, 1, "dropped");
  // mc2:p0 预置 active tag 2（无存量原文）：P 所在 part 位置命中的「别的 tag」。
  insertTag(b4Db, sessionId, "mc2:p0", "message", 16, 2);

  const tagger = taggerModule.createTagger();
  const messages = [
    // X ≠ P，反查无候选；P 的主人（tag 1）已被裁出窗口之外 → 漂移成立。
    b5bMessage(sessionId, "mc1", "user", "drift-new-X"),
    b5bMessage(sessionId, "mc2", "user", "drift-original-P"),
  ];
  tagMessagesB5.tagMessages(sessionId, messages, tagger, b4Db);

  const xTag = b5bWireTag(messages[0].parts[0].text);
  if (xTag === 1) throw new Error(`X reused the drifted tag: ${xTag}`);
  if (b5bSource(sessionId, 1) !== "drift-original-P") {
    throw new Error(`S(T) was overwritten: ${JSON.stringify(b5bSource(sessionId, 1))}`);
  }
  const t1 = getTagById(b4Db, sessionId, 1);
  if (t1?.messageId !== "__mc_drifted__:1") {
    throw new Error(`tombstone key missing: ${JSON.stringify(t1?.messageId)}`);
  }
  if (t1?.status !== "dropped") {
    throw new Error(`tombstoning changed status: ${JSON.stringify(t1?.status)}`);
  }
  const row1 = storageTags.listTagRowsBySession(b4Db, sessionId).find((row) => row.tagNumber === 1);
  if (row1?.messageId !== "__mc_drifted__:1" || row1?.status !== "dropped") {
    throw new Error(`listTagRowsBySession disagrees: ${JSON.stringify(row1)}`);
  }
});

test("b5b T-T4a 退化为现状（编辑重发桶）：原文不在入站时沿用并覆盖", () => {
  // v2 手算（spec 问题三 (b′)）：X 无存量原文（反查无持有者、不产候选），候选集
  // {0}；score(0)=0（X 在原位对齐 tag1 但 S(tag1)=P ≠ X）→ argmax=0，(a) 类，
  // 留在 v1 分支，断言不变。
  const sessionId = "ses_tt4a_edit_resend_fallback";
  // 夹具用非 mc1 的位置（mc2:p0）。
  insertTag(b4Db, sessionId, "mc2:p0", "message", 16, 1);
  saveSourceContent(b4Db, sessionId, 1, "resend-original-P");
  const tagger = taggerModule.createTagger();
  const messages = [b5bMessage(sessionId, "mc2", "user", "resend-edited-X")];
  tagMessagesB5.tagMessages(sessionId, messages, tagger, b4Db);
  if (b5bWireTag(messages[0].parts[0].text) !== 1) {
    throw new Error(`edit-resend did not reuse tag 1: ${messages[0].parts[0].text}`);
  }
  if (b5bSource(sessionId, 1) !== "resend-edited-X") {
    throw new Error(`source was not overwritten: ${JSON.stringify(b5bSource(sessionId, 1))}`);
  }
  if (getTagById(b4Db, sessionId, 1)?.messageId !== "mc2:p0") {
    throw new Error(
      `edit-resend path must not tombstone: ${getTagById(b4Db, sessionId, 1)?.messageId}`,
    );
  }
});

test("b5b T-T4b 样板多候选：不认领、不漂移，确定性退化", () => {
  // v2 手算（spec 问题三 (b′)）：S 的持有者 {tag3, tag4}、P 的持有者 {tag1, tag2}
  // 都多于一个，均不产候选 → 候选集 {0}；score(0)=0（两个 S part 原位对齐的是
  // 原文 P 的 tag，P part 原位无 tag）→ argmax=0，(a) 类，留在 v1 分支，断言不变。
  const sessionId = "ses_tt4b_boilerplate_multi";
  insertTag(b4Db, sessionId, "mc1:p0", "message", 16, 1);
  saveSourceContent(b4Db, sessionId, 1, "boiler-P");
  insertTag(b4Db, sessionId, "mc2:p0", "message", 16, 2);
  saveSourceContent(b4Db, sessionId, 2, "boiler-P");
  insertTag(b4Db, sessionId, "mc7:p0", "message", 16, 3);
  saveSourceContent(b4Db, sessionId, 3, "boiler-S");
  insertTag(b4Db, sessionId, "mc8:p0", "message", 16, 4);
  saveSourceContent(b4Db, sessionId, 4, "boiler-S");

  const tagger = taggerModule.createTagger();
  const mkRun = () => [
    b5bMessage(sessionId, "mc1", "user", "boiler-S"),
    b5bMessage(sessionId, "mc2", "user", "boiler-S"),
    b5bMessage(sessionId, "mc3", "user", "boiler-P"), // mc3 上没有任何 tag
  ];
  const run1 = mkRun();
  tagMessagesB5.tagMessages(sessionId, run1, tagger, b4Db);
  const tags1 = run1.map((m) => b5bWireTag(m.parts[0].text));
  // S 的两个 part 各自位置命中原文为 P 的 tag1/tag2：sourceIdx[S] 有两个候选 →
  // 不认领；sourceIdx[P] 不唯一 → 不走漂移；落入编辑重发桶沿用原号。
  if (tags1[0] !== 1 || tags1[1] !== 2) {
    throw new Error(`boilerplate S parts moved: ${JSON.stringify(tags1)}`);
  }
  if (getTagById(b4Db, sessionId, 1)?.messageId !== "mc1:p0") {
    throw new Error(`tag 1 was tombstoned: ${getTagById(b4Db, sessionId, 1)?.messageId}`);
  }
  if (getTagById(b4Db, sessionId, 2)?.messageId !== "mc2:p0") {
    throw new Error(`tag 2 was tombstoned: ${getTagById(b4Db, sessionId, 2)?.messageId}`);
  }
  // mc3 的 P part 认领不成立（多候选）→ 正常分配新号。
  if ([1, 2, 3, 4].includes(tags1[2])) {
    throw new Error(`mc3 P part did not get a fresh tag: ${tags1[2]}`);
  }
  // 整段结果确定：跑两遍逐字节相同。
  const run2 = mkRun();
  tagMessagesB5.tagMessages(sessionId, run2, tagger, b4Db);
  const run1Wire = run1.map((m) => m.parts[0].text);
  const run2Wire = run2.map((m) => m.parts[0].text);
  if (JSON.stringify(run2Wire) !== JSON.stringify(run1Wire)) {
    throw new Error(
      `result is not deterministic: ${JSON.stringify(run2Wire)} !== ${JSON.stringify(run1Wire)}`,
    );
  }
});

test("b5b T-T6 无存量原文：无法判定，行为与修复前一致", () => {
  // v2 手算（spec 问题三 (b′)）：X 无存量原文 → 候选集 {0}；score(0)=0（tag1
  // 没有原文可对齐）→ argmax=0，(a) 类，留在 v1 分支，断言不变。
  const sessionId = "ses_tt6_no_source";
  insertTag(b4Db, sessionId, "mc2:p0", "message", 16, 1); // 不写 source_contents
  const tagger = taggerModule.createTagger();
  const messages = [b5bMessage(sessionId, "mc2", "user", "nosource-X")];
  tagMessagesB5.tagMessages(sessionId, messages, tagger, b4Db);
  if (b5bWireTag(messages[0].parts[0].text) !== 1) {
    throw new Error(`tag without source was not reused: ${messages[0].parts[0].text}`);
  }
  if (b5bSource(sessionId, 1) !== "nosource-X") {
    throw new Error(`first write did not land: ${JSON.stringify(b5bSource(sessionId, 1))}`);
  }
  if (getTagById(b4Db, sessionId, 1)?.messageId !== "mc2:p0") {
    throw new Error(
      `no-source path must not tombstone: ${getTagById(b4Db, sessionId, 1)?.messageId}`,
    );
  }
});

test("b5b T-T7 唯一候选不满足认领条件时不认领（逐项过滤）", () => {
  // v2 手算（spec 问题三 (b′)）：message 型候选场景里 X@mc1:p0 的唯一持有者
  // R@mc9:p0 给出候选 d = 1 − 9 = −8；score(−8)=1（X 在 mc9:p0 上对齐 R）、
  // score(0)=0 → 最高分 1 < 3 → d = 0，留在 v1 分支 → (a) 类，断言不变。
  // type=file 场景：候选采集要求持有者 type='message' 且 message_id 匹配
  // ^mc(\d+):p(\d+)$——file 键（mc9:file0）不是位置键、file 持有者不产候选，
  // 候选集 {0}、score(0)=0 → 同样 (a) 类。这正是「不能照搬 /^mc(\d+)/」口径
  // 的守护点。
  const scenarios = [
    {
      id: "dropped",
      label: "status=dropped",
      status: "dropped",
      mutate: (s) => updateTagStatus(b4Db, s, 2, "dropped"),
    },
    {
      id: "compacted",
      label: "status=compacted",
      status: "compacted",
      mutate: (s) => updateTagStatus(b4Db, s, 2, "compacted"),
    },
    {
      id: "role_system",
      label: "role=system",
      status: "active",
      mutate: (s) => stampTagMessageRole(b4Db, s, 2, "system"),
    },
    // insertTag 不写 message_role → NULL（v10000 升级前的存量行同形）。
    { id: "role_null", label: "role=NULL", status: "active", mutate: () => {} },
    { id: "type_file", label: "type=file", status: "active", file: true, mutate: () => {} },
  ];
  for (const sc of scenarios) {
    const sessionId = `ses_tt7_${sc.id}`;
    // T：tag 1 @mc1:p0，原文 P（active）。R：tag 2 持有 X 的原文，但过滤不通过。
    insertTag(b4Db, sessionId, "mc1:p0", "message", 16, 1);
    saveSourceContent(b4Db, sessionId, 1, "claim-original-P");
    const candidateId = sc.file ? "mc9:file0" : "mc9:p0";
    insertTag(b4Db, sessionId, candidateId, sc.file ? "file" : "message", 16, 2);
    saveSourceContent(b4Db, sessionId, 2, "claim-candidate-X");
    sc.mutate(sessionId);

    const tagger = taggerModule.createTagger();
    const messages = [b5bMessage(sessionId, "mc1", "user", "claim-candidate-X")];
    tagMessagesB5.tagMessages(sessionId, messages, tagger, b4Db);

    // X 所在 part 按其余规则处置：P 不在入站 → 漂移不成立 → 编辑重发 → 沿用
    // tag1 并覆盖原文；R 的 message_id、status、原文均不变。
    if (b5bWireTag(messages[0].parts[0].text) !== 1) {
      throw new Error(`[${sc.label}] X part did not reuse T: ${messages[0].parts[0].text}`);
    }
    if (b5bSource(sessionId, 1) !== "claim-candidate-X") {
      throw new Error(
        `[${sc.label}] T source was not overwritten: ${JSON.stringify(b5bSource(sessionId, 1))}`,
      );
    }
    const r = getTagById(b4Db, sessionId, 2);
    if (r?.messageId !== candidateId) {
      throw new Error(`[${sc.label}] candidate was re-keyed: ${JSON.stringify(r?.messageId)}`);
    }
    if (r?.status !== sc.status) {
      throw new Error(`[${sc.label}] candidate status changed: ${JSON.stringify(r?.status)}`);
    }
    if (b5bSource(sessionId, 2) !== "claim-candidate-X") {
      throw new Error(
        `[${sc.label}] candidate source changed: ${JSON.stringify(b5bSource(sessionId, 2))}`,
      );
    }
  }
});

test("b5b T-T8 同消息双文本片段：漂移屏蔽 scoped fallback，兄弟 part 不被抢占", () => {
  // v2 手算（spec 问题三 (b′)）：候选集 {0, +1, +3}——X0@mc2:p0 的唯一持有者
  // tag1@mc1:p0 给出 +1，X1@mc2:p1 的 tag2@mc1:p1 给出 +1，P@mc5:p0 的唯一持有
  // 者 tag3@mc2:p0 给出 +3；score(+1)=2（X0、X1 在 mc1 上原文相等）、
  // score(+3)=1（P 在 mc2:p0 上对齐 tag3）、score(0)=0，最高分 2 < 3 →
  // d = 0，留在 v1 分支 → 本用例属 (a) 类（argmax ≠ 0 但最高分 < 3，v1 断言
  // 不变）。v1 夹具曾把 P 放在 mc3：P@mc3:p0 的 tag3@mc2:p0 恰好给出 +1，凑成
  // score(+1)=3 被扳进平移相符分支（p0 会保回 tag1 的号）——v2 修订把它挪到
  // mc5（保留在入站、只挪出平移对齐位；不能删——P 不在入站的话 v1 漂移判据
  // 不成立，p0 会落编辑重发桶收编 tag3 并覆盖 P）。平移相符分支对同消息双片段
  // 的覆盖由 T-T11 承担。
  const sessionId = "ses_tt8_sibling_parts";
  const tagger = taggerModule.createTagger();
  // pass 1：一条 assistant 消息两个 text part，各拿 tag 1、2。
  const pass1 = [b5bMessage(sessionId, "mc1", "assistant", "sibling-X0", "sibling-X1")];
  tagMessagesB5.tagMessages(sessionId, pass1, tagger, b4Db);
  if (b5bWireTag(pass1[0].parts[0].text) !== 1 || b5bWireTag(pass1[0].parts[1].text) !== 2) {
    throw new Error(
      `unexpected pass-1 tags: ${pass1[0].parts[0].text} / ${pass1[0].parts[1].text}`,
    );
  }
  // X0 的原主转 dropped：认领不成立（内容回到窗口但原 tag 已 dropped → 拿新号）。
  updateTagStatus(b4Db, sessionId, 1, "dropped");
  // 预置 tagT=3 @mc2:p0（原文 P，role=user）：平移后 mc2:p0 位置命中的它者。
  insertTag(b4Db, sessionId, "mc2:p0", "message", 16, 3);
  saveSourceContent(b4Db, sessionId, 3, "sibling-P");
  stampTagMessageRole(b4Db, sessionId, 3, "user");

  // pass 2：消息平移到 mc2；P 的 part 放在 mc5（v2 修订，见上方手算）。
  const mkPass2 = () => [
    b5bMessage(sessionId, "mc2", "assistant", "sibling-X0", "sibling-X1"),
    b5bMessage(sessionId, "mc5", "user", "sibling-P"),
  ];
  const pass2 = mkPass2();
  tagMessagesB5.tagMessages(sessionId, pass2, tagger, b4Db);

  // p0 判为漂移：拿新号（不是 1/2/3 中的任何一个）。
  const p0Tag = b5bWireTag(pass2[0].parts[0].text);
  if (p0Tag === 1 || p0Tag === 2 || p0Tag === 3) {
    throw new Error(`p0 did not get a fresh tag: ${p0Tag}`);
  }
  // 兄弟 p1 的 tag 号与原文 X1 不变（没有被 p0 经 scoped fallback 抢占）。
  if (b5bWireTag(pass2[0].parts[1].text) !== 2) {
    throw new Error(`sibling p1 lost its tag: ${pass2[0].parts[1].text}`);
  }
  if (b5bSource(sessionId, 2) !== "sibling-X1") {
    throw new Error(
      `sibling p1 source was overwritten: ${JSON.stringify(b5bSource(sessionId, 2))}`,
    );
  }
  // P 未被覆盖；P 的主人（tagT=3）被 mc5:p0 经含墓碑键的围栏认领回去。
  if (b5bSource(sessionId, 3) !== "sibling-P") {
    throw new Error(`P was overwritten: ${JSON.stringify(b5bSource(sessionId, 3))}`);
  }
  if (b5bWireTag(pass2[1].parts[0].text) !== 3) {
    throw new Error(`P's owner was not reclaimed: ${pass2[1].parts[0].text}`);
  }
  // 再跑一遍同样输入，结果逐字节相同（d* 仍为 0：X0 第二轮反查已多候选，候选集
  // 只有 {0}，score(0)=3 但 d*=0 → v1 精确命中沿用）。
  const pass2Again = mkPass2();
  tagMessagesB5.tagMessages(sessionId, pass2Again, tagger, b4Db);
  const firstWire = pass2.map((m) => m.parts.map((p) => p.text));
  const secondWire = pass2Again.map((m) => m.parts.map((p) => p.text));
  if (JSON.stringify(secondWire) !== JSON.stringify(firstWire)) {
    throw new Error(
      `second run is not byte-identical: ${JSON.stringify(secondWire)} !== ${JSON.stringify(firstWire)}`,
    );
  }
});

test("b5b T-T9 入站 system 行：非 system 旧 tag 墓碑化拿新号；system 旧 tag 沿用", () => {
  // v2 手算（spec 问题三 (b′)）：候选采集与计分都排除 role=system 的入站 part
  // （与「system 行不进平移层」同口径）→ 候选集 {0}、score(0)=0 → argmax=0，
  // (a) 类，留在 v1 分支，断言不变。
  // 主组：T=tag1（dropped、role=user、原文 P）@mc1:p0；入站 mc1 是 system 消息
  // （文本 X = system prompt，P 不在入站里）。
  const sessionId = "ses_tt9_system_drift";
  insertTag(b4Db, sessionId, "mc1:p0", "message", 16, 1);
  saveSourceContent(b4Db, sessionId, 1, "sysdrift-P");
  updateTagStatus(b4Db, sessionId, 1, "dropped");
  stampTagMessageRole(b4Db, sessionId, 1, "user");
  const tagger = taggerModule.createTagger();
  const messages = [b5bMessage(sessionId, "mc1", "system", "sysdrift-system-prompt")];
  tagMessagesB5.tagMessages(sessionId, messages, tagger, b4Db);

  const t1 = getTagById(b4Db, sessionId, 1);
  if (b5bSource(sessionId, 1) !== "sysdrift-P") {
    throw new Error(`system row overwrote S(T): ${JSON.stringify(b5bSource(sessionId, 1))}`);
  }
  if (t1?.status !== "dropped" || t1?.messageRole !== "user") {
    throw new Error(`T status/role changed: ${JSON.stringify(t1)}`);
  }
  if (t1?.messageId !== "__mc_drifted__:1") {
    throw new Error(`T was not tombstoned: ${JSON.stringify(t1?.messageId)}`);
  }
  const sysTag = b5bWireTag(messages[0].parts[0].text);
  if (sysTag === 1) throw new Error(`system row reused the foreign tag: ${sysTag}`);
  if (getTagById(b4Db, sessionId, sysTag)?.messageRole !== "system") {
    throw new Error(
      `new system tag was not stamped: ${JSON.stringify(getTagById(b4Db, sessionId, sysTag)?.messageRole)}`,
    );
  }

  // 对照组：T 的 message_role = 'system' → 沿用 T 并覆盖原文（system 槽位换内容
  // 的正常情形）。
  const ctlSession = "ses_tt9_system_keep";
  insertTag(b4Db, ctlSession, "mc1:p0", "message", 16, 1);
  saveSourceContent(b4Db, ctlSession, 1, "syskeep-P");
  stampTagMessageRole(b4Db, ctlSession, 1, "system");
  const ctlTagger = taggerModule.createTagger();
  const ctlMessages = [b5bMessage(ctlSession, "mc1", "system", "syskeep-new-prompt")];
  tagMessagesB5.tagMessages(ctlSession, ctlMessages, ctlTagger, b4Db);
  if (b5bWireTag(ctlMessages[0].parts[0].text) !== 1) {
    throw new Error(`control did not reuse the system tag: ${ctlMessages[0].parts[0].text}`);
  }
  if (b5bSource(ctlSession, 1) !== "syskeep-new-prompt") {
    throw new Error(
      `control source was not overwritten: ${JSON.stringify(b5bSource(ctlSession, 1))}`,
    );
  }
  if (getTagById(b4Db, ctlSession, 1)?.messageId !== "mc1:p0") {
    throw new Error(`control must not tombstone: ${getTagById(b4Db, ctlSession, 1)?.messageId}`);
  }
});

test("b5b T-T10 入站 system 行落在 NULL-role 存量 tag 上：墓碑化换号", () => {
  // v2 手算（spec 问题三 (b′)）：与 T-T9 同口径——候选采集与计分排除 system part
  // → 候选集 {0}、score(0)=0 → argmax=0，(a) 类，留在 v1 分支，断言不变。
  // T-T9 的 NULL-role 补充（spec 问题三专门规则的明确要求）：NULL-role 存量行
  // （v10000 升级前的行、provider 未给 role 的行）可能是无关对话的 tag，system
  // 行沿用它会把对话原文换成 system prompt——必须墓碑化换号而不是沿用回填。
  // 依据：docs/iterations/magic-context-trim-integrity/spec.md:133-136。
  const sessionId = "ses_tt10_system_null_role";
  // 预置 T：tag 1 @mc1:p0，原文 P，status=active，message_role=NULL（insertTag 不写 role）。
  insertTag(b4Db, sessionId, "mc1:p0", "message", 16, 1);
  saveSourceContent(b4Db, sessionId, 1, "nulldrift-P");
  const tagger = taggerModule.createTagger();
  const messages = [b5bMessage(sessionId, "mc1", "system", "nulldrift-system-prompt")];
  tagMessagesB5.tagMessages(sessionId, messages, tagger, b4Db);

  // T 被墓碑化：键换墓碑、status 不变、role 保持 NULL、原文未被改写。
  const t1 = getTagById(b4Db, sessionId, 1);
  if (t1?.messageId !== "__mc_drifted__:1") {
    throw new Error(`NULL-role tag was not tombstoned: ${JSON.stringify(t1?.messageId)}`);
  }
  if (t1?.status !== "active") {
    throw new Error(`tombstoning changed status: ${JSON.stringify(t1?.status)}`);
  }
  if (t1?.messageRole !== null) {
    throw new Error(`tombstoning changed message_role: ${JSON.stringify(t1?.messageRole)}`);
  }
  if (b5bSource(sessionId, 1) !== "nulldrift-P") {
    throw new Error(
      `NULL-role tag source was overwritten: ${JSON.stringify(b5bSource(sessionId, 1))}`,
    );
  }
  // system 行拿到新号，且其 message_role='system'。
  const sysTag = b5bWireTag(messages[0].parts[0].text);
  if (sysTag === 1) throw new Error(`system row reused the NULL-role tag: ${sysTag}`);
  if (getTagById(b4Db, sessionId, sysTag)?.messageRole !== "system") {
    throw new Error(
      `new system tag was not stamped: ${JSON.stringify(getTagById(b4Db, sessionId, sysTag)?.messageRole)}`,
    );
  }
});

test("b5b T-T11 整体平移层：d* = −1 时按位置找回真身，样板与窗口外老 tag 都保号", () => {
  // v2 核心用例（spec 问题三 (b′) 与 T-T11 夹具表，10 个预置文本 tag 全部
  // type='message'、message_role='user'）。夹具必须含主人已被裁出窗口的老 tag
  // （tag1 的 U）与重复样板（P/S 各两个、其中两个 dropped）——真实数据上原文被
  // 改写的机制正是「位置命中主人不在窗口的老 tag + 认领失败（样板）→ 编辑重发
  // 桶」，纯均匀平移的夹具 v1 自己就能兜住，不构成区分度；区分点是 U 与四个
  // 样板 part（B、C、D、D2、E 在 v1 下也会被内容认领判对）。
  //
  // v2 手算：入站对话 mc10..mc18 依次为 P、B、P、C、S、S、{D,D2}、E、NEW，整体
  // 平移 d = −1（上一代在 mc<p+1>）。候选集 {0, −1}（B@mc11→tag3@mc12:p0、
  // C@mc13→tag5@mc14:p0、D@mc16:p0→tag8@mc17:p0、D2@mc16:p1→tag9@mc17:p1、
  // E@mc17→tag10@mc18:p0 各给 −1；P/S 的持有者多于一个不产候选、SYS 是 system
  // part 被排除、NEW 无存量原文）；score(−1)=9（mc10..mc17 的 9 个 part 在
  // mc11..mc18 上逐一原文相等）；score(0)=1、score(+1)=1——score(0) 逐 part 核对
  // 后唯一原位相符的是 mc15:S 对 tag6（shift-S）；mc16:p1 在 posIdx 没有键、
  // mc17:p0 原位是 tag8 的 shift-D（E≠D），都不计入；score(+1) 唯一相符的是
  // mc12:P 对 mc11:p0 的 tag2（shift-P），判定不变：d* = −1（9 是唯一最
  // 大且 ≥ 3）→ 本用例属 (b) 类，被平移相符接管，断言按 v2 语义逐项给出。
  const sessionId = "ses_tt11_shift_layer";
  const preset = [
    [1, "mc10:p0", "shift-U", "active"],
    [2, "mc11:p0", "shift-P", "active"],
    [3, "mc12:p0", "shift-B", "active"],
    [4, "mc13:p0", "shift-P", "dropped"],
    [5, "mc14:p0", "shift-C", "active"],
    [6, "mc15:p0", "shift-S", "active"],
    [7, "mc16:p0", "shift-S", "dropped"],
    [8, "mc17:p0", "shift-D", "active"],
    [9, "mc17:p1", "shift-D2", "active"],
    [10, "mc18:p0", "shift-E", "active"],
  ];
  for (const [tagNumber, messageId, source, status] of preset) {
    insertTag(b4Db, sessionId, messageId, "message", source.length, tagNumber);
    saveSourceContent(b4Db, sessionId, tagNumber, source);
    stampTagMessageRole(b4Db, sessionId, tagNumber, "user");
    if (status !== "active") updateTagStatus(b4Db, sessionId, tagNumber, status);
  }

  const mkPass = () => [
    b5bMessage(sessionId, "mc1", "system", "shift-SYS"),
    b5bMessage(sessionId, "mc10", "user", "shift-P"),
    b5bMessage(sessionId, "mc11", "user", "shift-B"),
    b5bMessage(sessionId, "mc12", "user", "shift-P"),
    b5bMessage(sessionId, "mc13", "user", "shift-C"),
    b5bMessage(sessionId, "mc14", "user", "shift-S"),
    b5bMessage(sessionId, "mc15", "user", "shift-S"),
    b5bMessage(sessionId, "mc16", "user", "shift-D", "shift-D2"),
    b5bMessage(sessionId, "mc17", "user", "shift-E"),
    b5bMessage(sessionId, "mc18", "user", "shift-NEW"),
  ];
  const pass1 = mkPass();
  tagMessagesB5.tagMessages(sessionId, pass1, taggerModule.createTagger(), b4Db);

  // (2) mc10..mc17 的 9 个 part 的 tag 号与真身逐一相同：P、S 四个样板 part 按
  // 位置而非唯一性找回 tag2/4/6/7，双片段的两个 part 都回到 8、9。
  const expectedNumbers = [2, 3, 4, 5, 6, 7, 8, 9, 10];
  const actualNumbers = pass1.slice(1, 9).flatMap((m) => m.parts.map((p) => b5bWireTag(p.text)));
  if (JSON.stringify(actualNumbers) !== JSON.stringify(expectedNumbers)) {
    throw new Error(
      `shifted parts did not land on their owners: ${JSON.stringify(actualNumbers)} !== ${JSON.stringify(expectedNumbers)}`,
    );
  }
  // 平移相符不改 status：dropped 的主人平移后仍是 dropped。
  if (getTagById(b4Db, sessionId, 4)?.status !== "dropped") {
    throw new Error(
      `tag 4 status changed: ${JSON.stringify(getTagById(b4Db, sessionId, 4)?.status)}`,
    );
  }
  if (getTagById(b4Db, sessionId, 7)?.status !== "dropped") {
    throw new Error(
      `tag 7 status changed: ${JSON.stringify(getTagById(b4Db, sessionId, 7)?.status)}`,
    );
  }

  const sysTag = b5bWireTag(pass1[0].parts[0].text);
  const newTag = b5bWireTag(pass1[9].parts[0].text);
  if ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].includes(sysTag)) {
    throw new Error(`SYS did not get a fresh tag: ${sysTag}`);
  }
  // (3) mc18 的 NEW 平移落空（posIdx[mc19:p0] 为空），拿到不在 {1..10} 里的新号。
  if ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].includes(newTag)) {
    throw new Error(`NEW did not get a fresh tag: ${newTag}`);
  }

  // (1) 预置的 10 行 source_contents 逐字节不变——尤其是 tag1 的 U（v1 在同一
  // 夹具上会把它改写成 P）；新增的行只允许是 SYS 与 NEW 两个新号各一行。
  const sourceRows = b4Db
    .prepare("SELECT tag_id, content FROM source_contents WHERE session_id = ? ORDER BY tag_id")
    .all(sessionId);
  if (sourceRows.length !== 12) {
    throw new Error(
      `source_contents row count drifted: ${sourceRows.length} (expected 12 = 10 preset + SYS + NEW)`,
    );
  }
  for (const [tagNumber, , source] of preset) {
    const row = sourceRows.find((r) => r.tag_id === tagNumber);
    if (!row) throw new Error(`preset tag ${tagNumber} lost its source row`);
    if (row.content !== source) {
      throw new Error(
        `preset tag ${tagNumber} source was rewritten: ${JSON.stringify(row.content)} !== ${JSON.stringify(source)}`,
      );
    }
  }
  const sysRow = sourceRows.find((r) => r.tag_id === sysTag);
  if (!sysRow || sysRow.content !== "shift-SYS") {
    throw new Error(`SYS source row wrong: ${JSON.stringify(sysRow)}`);
  }
  const newRow = sourceRows.find((r) => r.tag_id === newTag);
  if (!newRow || newRow.content !== "shift-NEW") {
    throw new Error(`NEW source row wrong: ${JSON.stringify(newRow)}`);
  }
  const strayRows = sourceRows.filter(
    (r) => ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, sysTag, newTag].includes(r.tag_id),
  );
  if (strayRows.length > 0) {
    throw new Error(`unexpected extra source rows: ${JSON.stringify(strayRows)}`);
  }

  // (4) 再跑一遍同样输入，结果逐字节相同：第一轮后持有者已重绑到入站同位键，
  // 候选集退化为 {0}、score(0)=10 但 d*=0 → v1 精确命中沿用。
  const pass2 = mkPass();
  tagMessagesB5.tagMessages(sessionId, pass2, taggerModule.createTagger(), b4Db);
  const firstWire = pass1.map((m) => m.parts.map((p) => p.text));
  const secondWire = pass2.map((m) => m.parts.map((p) => p.text));
  if (JSON.stringify(secondWire) !== JSON.stringify(firstWire)) {
    throw new Error(
      `second run is not byte-identical: ${JSON.stringify(secondWire)} !== ${JSON.stringify(firstWire)}`,
    );
  }
});

test("b5b T-T12 system 行落上 inert 绑定：墓碑化后无条件解绑，system 行拿新号", () => {
  // CR-3（trim-integrity）：system-assign 分支原本只墓碑化位置上的旧 tag M，不
  // 解绑 contentId 的内存绑定。可达入口是内存快路径——pass 开头的 inert 重放
  // （tag-messages.ts 把 inert 行的 contentId bindTag 进内存）会先把 mc1:p0 绑到
  // inert 行 N，随后 system 行走 assignTag 时内存快路径直接返回 N，system prompt
  // 被 replaceSourceContent 写进 N 的原文。修复：墓碑化之后无条件 unbind(c)，
  // 与漂移分支同款。区分度：补 unbind 之前 system 行拿到 N、N 出现 source 行。
  const sessionId = "ses_tt12_system_inert_unbind";
  // pass 1：预置 inert 行 N（tag 2，指纹位置 mc1:p0）；入站 mc1 是只有空白 text
  // part 的 assistant 消息 → wire 重放 §2§，同时让 tagger 内存把 mc1:p0 绑到 N。
  insertTag(b4Db, sessionId, "mc1:p0", "message", 16, 2);
  markWhitespaceAssistantTagInert(b4Db, sessionId, 2, "mc1:p0");
  const tagger = taggerModule.createTagger();
  const pass1 = [b5bMessage(sessionId, "mc1", "assistant", "   ")];
  tagMessagesB5.tagMessages(sessionId, pass1, tagger, b4Db);
  if (b5bWireTag(pass1[0].parts[0].text) !== 2) {
    throw new Error(`pass 1 did not replay the inert tag 2: ${pass1[0].parts[0].text}`);
  }

  // pass 2：同一 tagger、同一库。预置旧 tag M（tag 1 < N，role=user）挂在
  // mc1:p0；入站 mc1 换成 role=system 的非空消息 → system-assign（墓碑化 M）。
  insertTag(b4Db, sessionId, "mc1:p0", "message", 16, 1);
  stampTagMessageRole(b4Db, sessionId, 1, "user");
  const pass2 = [b5bMessage(sessionId, "mc1", "system", "tt12-system-prompt")];
  tagMessagesB5.tagMessages(sessionId, pass2, tagger, b4Db);

  // system 行拿到不在 {M, N} 里的新号：未修复时内存快路径把它绑回 N=2。
  const sysTag = b5bWireTag(pass2[0].parts[0].text);
  if (sysTag === 1 || sysTag === 2) {
    throw new Error(`system row reused a stale in-memory binding: ${sysTag}`);
  }
  // M 已墓碑化。
  if (getTagById(b4Db, sessionId, 1)?.messageId !== "__mc_drifted__:1") {
    throw new Error(
      `M was not tombstoned: ${JSON.stringify(getTagById(b4Db, sessionId, 1)?.messageId)}`,
    );
  }
  // N（inert 行）原样：没有 source_contents 行、entry_fingerprint 与 status 不动
  // ——system prompt 不得写进 inert 行的原文。
  if (b5bSource(sessionId, 2) !== undefined) {
    throw new Error(
      `inert row N grew a source_contents row: ${JSON.stringify(b5bSource(sessionId, 2))}`,
    );
  }
  const inertRow = getTagById(b4Db, sessionId, 2);
  if (inertRow?.status !== "compacted") {
    throw new Error(`inert row status changed: ${JSON.stringify(inertRow?.status)}`);
  }
  // getTagById 的 TagEntry 不含指纹字段（toTagEntry 未映射 entry_fingerprint），
  // 指纹经 listTagRowsBySession 的行对象断言（T-T3 同款）。
  const inertRowFull = storageTags
    .listTagRowsBySession(b4Db, sessionId)
    .find((row) => row.tagNumber === 2);
  if (inertRowFull?.entryFingerprint !== "mc:whitespace-assistant:mc1:p0") {
    throw new Error(
      `inert row fingerprint changed: ${JSON.stringify(inertRowFull?.entryFingerprint)}`,
    );
  }
});

test("b5b T-T13 user 消息的空白 text part 不参与平移层", () => {
  // CR-10（trim-integrity）：计划循环里空白判断原本排在平移分支之后，而主循环的
  // 空白豁免只对 assistant 生效（whitespaceOnlyAssistant 要求 role=assistant），
  // 平移成立时 user 消息的空白 part 会消费平移计划、被判成平移落空（墓碑化位置
  // 上的旧号）或平移不符。修复：空白判断挪到 system 规则之后、平移分支之前。
  // 区分度：修复前 mc5:p0 的空白 part 墓碑化 tag4 并拿新号；修复后沿用位置命中。
  const sessionId = "ses_tt13_blank_user_part";
  // 预置：A/B/C 三个唯一原文专供平移候选与计分（唯一持有者各给 d=+1）；tag4
  // 挂在空白 part 的位置 mc5:p0 上（原文 W，与空白正文不同）。
  const preset = [
    [1, "mc1:p0", "tt13-A"],
    [2, "mc2:p0", "tt13-B"],
    [3, "mc3:p0", "tt13-C"],
    [4, "mc5:p0", "tt13-W"],
  ];
  for (const [tagNumber, messageId, source] of preset) {
    insertTag(b4Db, sessionId, messageId, "message", source.length, tagNumber);
    saveSourceContent(b4Db, sessionId, tagNumber, source);
    stampTagMessageRole(b4Db, sessionId, tagNumber, "user");
  }
  const tagger = taggerModule.createTagger();
  const messages = [
    b5bMessage(sessionId, "mc2", "user", "tt13-A"),
    b5bMessage(sessionId, "mc3", "user", "tt13-B"),
    b5bMessage(sessionId, "mc4", "user", "tt13-C"),
    // 空白 part 的宿主消息：两个 text part——p0 位置命中 tag4（沿用其号），
    // p1 位置无命中（新分配）。
    b5bMessage(sessionId, "mc5", "user", "   ", "   "),
  ];
  tagMessagesB5.tagMessages(sessionId, messages, tagger, b4Db);

  // 平移 d*=+1 成立（score(+1)=3 ≥ 3 且唯一最大）：三个带正文的 part 按位置
  // 找回 tag1/2/3——证明夹具确实进入了平移相符分支。
  const shifted = messages.slice(0, 3).map((m) => b5bWireTag(m.parts[0].text));
  if (JSON.stringify(shifted) !== JSON.stringify([1, 2, 3])) {
    throw new Error(`the shift layer did not land on the owners: ${JSON.stringify(shifted)}`);
  }
  // 空白 part p0 沿用其位置命中的既有号 4。
  const blankKept = b5bWireTag(messages[3].parts[0].text);
  if (blankKept !== 4) {
    throw new Error(`the blank part did not keep the position-hit tag 4: ${blankKept}`);
  }
  // 空白 part p1 位置无命中 → 新分配（∉ 预置号集合）。
  const blankFresh = b5bWireTag(messages[3].parts[1].text);
  if ([1, 2, 3, 4].includes(blankFresh)) {
    throw new Error(`the position-miss blank part did not get a fresh tag: ${blankFresh}`);
  }
  // 空白 part 位置上的旧 tag 没有被墓碑化。
  if (getTagById(b4Db, sessionId, 4)?.messageId !== "mc5:p0") {
    throw new Error(
      `tag 4 was tombstoned by the blank part: ${JSON.stringify(getTagById(b4Db, sessionId, 4)?.messageId)}`,
    );
  }
});

// --- b5b T-T5（ctx_expand 读侧，trim-integrity 问题三） ----------------------
//
// spec T-T5：tag 模式的 ctx_expand 在该 tag 有存量原文时按现有包装格式返回存量
// 原文（而不是按位置 id 读当前条目——重启平移后位置读会取到错位的消息）；没有
// 存量原文时回落现有位置读。落点依据 spec 测试策略「T-T* 落在
// test-transform.mjs」。renderItemByTag 的位置读默认读 OpenCode 的 session DB，
// 包内临时库没有 session 数据；这里用 setRawMessageProvider 注册最小 provider
// （接口只要求 readMessages(): RawMessage[]），让「回落位置读」的正路径也可断言。
const ctxExpandRender = await load("tools/ctx-expand/render.js");
const readSessionChunkModule = await load("hooks/magic-context/read-session-chunk.js");

test("b5b T-T5 ctx_expand tag 模式：有存量原文按包装格式返回，无存量原文回落位置读", () => {
  const sessionId = "ses_tt5_expand_source_read";
  // ① 有存量原文：返回 `  [text]\n<原文>`（renderPartFull 的现有包装格式，不带
  //    §N§），且不依赖任何 raw session 数据。
  insertTag(b4Db, sessionId, "mc1:p0", "message", 16, 1);
  saveSourceContent(b4Db, sessionId, 1, "expand-stored-source");
  const stored = ctxExpandRender.renderItemByTag(b4Db, sessionId, 1);
  if (stored !== "  [text]\nexpand-stored-source") {
    throw new Error(`stored-source render format drifted: ${JSON.stringify(stored)}`);
  }

  // ② 无存量原文：回落位置读。tag 2 @mc2:p0 无 source_contents；provider 提供
  //    位置上的消息，回落读必须拿到 mc2 的 part 文本（该 tag 自己的位置），
  //    而不是其他 tag 的存量原文。
  insertTag(b4Db, sessionId, "mc2:p0", "message", 16, 2);
  const unregisterProvider = readSessionChunkModule.setRawMessageProvider(sessionId, {
    readMessages: () => [
      { id: "mc1", role: "user", ordinal: 1, parts: [{ type: "text", text: "position-mc1-body" }] },
      { id: "mc2", role: "user", ordinal: 2, parts: [{ type: "text", text: "position-mc2-body" }] },
    ],
  });
  try {
    const fallback = ctxExpandRender.renderItemByTag(b4Db, sessionId, 2);
    if (fallback !== "  [text]\nposition-mc2-body") {
      throw new Error(`fallback did not read the tag's own position: ${JSON.stringify(fallback)}`);
    }
    if (fallback.includes("expand-stored-source")) {
      throw new Error("fallback leaked another tag's stored source");
    }
  } finally {
    unregisterProvider();
  }
});

// --- T-S7：裁前缀保留 system 段的退化输入（trim-integrity 问题一） ----------
//
// 经导出的 injectM0M1 的 preparedPrefix 路径驱动（不为测试新增导出）。夹具把
// preparedTrimBoundaryId 指向开头 system 段内（裁剪点落在 system 段内，现实中
// 不可达、属防御）：S3（id-lookup 兜底）与 S4（source-order）两条分支都必须
// 拒绝裁剪并返回 prefixTrimStatus="refused"，且 messages 不被裁剪——随后的
// fail-closed 判定（超窗即 MC-H04）在 transform 层照常生效，不在本用例范围。
// isPartialCompartmentEnd 对无 compartments 行的会话恒 false，所以 S3 分支的
// 实际移出条数 = cutoffIndex + 1。
const injectCompartmentsModule = await load("hooks/magic-context/inject-compartments.js");

test("T-S7 退化输入：裁剪点落在 system 段内时拒绝裁剪（prefixTrimStatus=refused）", () => {
  const sessionId = "ses_ts7_degenerate";
  const makeMessages = () => [
    {
      info: { id: "mc1", role: "system", sessionID: sessionId },
      parts: [{ type: "text", text: "system prompt line one" }],
    },
    {
      info: { id: "mc2", role: "system", sessionID: sessionId },
      parts: [{ type: "text", text: "system prompt line two" }],
    },
    {
      info: { id: "mc3", role: "user", sessionID: sessionId },
      parts: [{ type: "text", text: "user message" }],
    },
  ];
  // preparedMessages 会被 structuredClone 后 unshift 到最前（injectM0M1 的既有
  // 行为，与本用例无关）；给一条最小 synthetic head 即可。
  const head = [
    { info: { role: "user" }, parts: [{ type: "text", text: "m[0]/m[1] head", synthetic: true }] },
  ];
  const preparedPrefix = {
    injected: true,
    prependedMessageCount: 0,
    m0RematerializedThisPass: false,
    materializationContentionRetryExhausted: true,
    decision: { value: false, reason: "cache_hit" },
    m0Bytes: null,
    m1Text: null,
    preparedMessages: head,
    preparedTrimBoundaryId: "mc1",
  };
  const baseOptions = {
    db: b4Db,
    sessionId,
    state: { sessionId, cachedM0Bytes: null, cachedM1Bytes: null },
    compactionOff: false,
    isCacheBustingPass: false,
  };
  // 「不裁剪」的统一断言：system 段两条原对象仍在（引用相等证明没有被重建），
  // 数组 = head(1) + 原三条，user 行未丢。
  const assertNotTrimmed = (messages, systemRefs, label) => {
    if (messages.length !== 4) {
      throw new Error(`${label}: messages were trimmed (${messages.length} !== 4)`);
    }
    const systems = messages.filter((message) => message.info.role === "system");
    if (systems.length !== 2 || systems[0] !== systemRefs[0] || systems[1] !== systemRefs[1]) {
      throw new Error(`${label}: the leading system run did not survive intact`);
    }
    if (!messages.includes(systemRefs[2])) {
      throw new Error(`${label}: the non-system rows were dropped`);
    }
  };

  // ① S3 分支：不带 prefixTrimSourceOrder，走 findBoundaryIndex 兜底切片。
  const s3Messages = makeMessages();
  const s3SystemRefs = [...s3Messages];
  const s3 = injectCompartmentsModule.injectM0M1({
    ...baseOptions,
    messages: s3Messages,
    preparedPrefix,
  });
  if (s3.prefixTrimStatus !== "refused") {
    throw new Error(`S3 branch: prefixTrimStatus=${s3.prefixTrimStatus} (expected "refused")`);
  }
  assertNotTrimmed(s3Messages, s3SystemRefs, "S3 branch");

  // ② S4 分支：带 prefixTrimSourceOrder，boundaryPosition(0) 落在豁免段 k=2 内。
  const s4Messages = makeMessages();
  const s4SystemRefs = [...s4Messages];
  const s4 = injectCompartmentsModule.injectM0M1({
    ...baseOptions,
    messages: s4Messages,
    prefixTrimSourceOrder: injectCompartmentsModule.capturePrefixTrimSourceOrder(s4Messages),
    preparedPrefix,
  });
  if (s4.prefixTrimStatus !== "refused") {
    throw new Error(`S4 branch: prefixTrimStatus=${s4.prefixTrimStatus} (expected "refused")`);
  }
  assertNotTrimmed(s4Messages, s4SystemRefs, "S4 branch");
});

// --- T-S9：S3/S4 的 applied 路径保留开头 system 段（trim-integrity 问题一） ----
//
// T-S7 只覆盖退化输入（裁剪点落在 system 段内 → refused）；「裁剪边界在 system
// 段之后、applied 生效时开头 system 段以同一引用保留在头部」没有任何用例——与
// 上轮「system 段被裁、超窗拒发」缺陷同族的回归护栏。夹具：system 段 k=2
// （mc1、mc2）+ mc3（裁剪边界，非 system）+ mc4，preparedTrimBoundaryId=mc3。

test("T-S9 applied 路径：S3/S4 裁剪后开头 system 段以同一引用保留在头部", () => {
  const sessionId = "ses_ts9_applied_system_run";
  const makeMessages = () => [
    {
      info: { id: "mc1", role: "system", sessionID: sessionId },
      parts: [{ type: "text", text: "system prompt line one" }],
    },
    {
      info: { id: "mc2", role: "system", sessionID: sessionId },
      parts: [{ type: "text", text: "system prompt line two" }],
    },
    {
      info: { id: "mc3", role: "user", sessionID: sessionId },
      parts: [{ type: "text", text: "user message" }],
    },
    {
      info: { id: "mc4", role: "user", sessionID: sessionId },
      parts: [{ type: "text", text: "second user message" }],
    },
  ];
  // preparedMessages 会被 structuredClone 后 unshift 到最前（T-S7 同款）。
  const head = [
    { info: { role: "user" }, parts: [{ type: "text", text: "m[0]/m[1] head", synthetic: true }] },
  ];
  const preparedPrefix = {
    injected: true,
    prependedMessageCount: 0,
    m0RematerializedThisPass: false,
    materializationContentionRetryExhausted: true,
    decision: { value: false, reason: "cache_hit" },
    m0Bytes: null,
    m1Text: null,
    preparedMessages: head,
    preparedTrimBoundaryId: "mc3",
  };
  const baseOptions = {
    db: b4Db,
    sessionId,
    state: { sessionId, cachedM0Bytes: null, cachedM1Bytes: null },
    compactionOff: false,
    isCacheBustingPass: false,
  };
  // 「applied 且 system 段保留」的统一断言：数组 = head(1) + mc1 + mc2 + mc4，
  // 两条 system 行以同一引用保留在头部（引用相等证明没有被重建），裁剪边界
  // mc3 被裁掉，mc4 保留。
  const assertAppliedKeepsSystemRun = (messages, refs, label) => {
    if (messages.length !== 4) {
      throw new Error(
        `${label}: messages.length=${messages.length} (expected 4 = head + 2 system + mc4)`,
      );
    }
    if (messages[1] !== refs.mc1 || messages[2] !== refs.mc2) {
      throw new Error(`${label}: the leading system run did not survive with the same references`);
    }
    if (messages.some((message) => message === refs.mc3)) {
      throw new Error(`${label}: mc3 (the trim boundary) survived the trim`);
    }
    if (!messages.includes(refs.mc4)) {
      throw new Error(`${label}: mc4 was dropped by the trim`);
    }
  };

  // ① S4 分支（source-order）：带 capturePrefixTrimSourceOrder。
  const s4Messages = makeMessages();
  const s4Refs = { mc1: s4Messages[0], mc2: s4Messages[1], mc3: s4Messages[2], mc4: s4Messages[3] };
  const s4 = injectCompartmentsModule.injectM0M1({
    ...baseOptions,
    messages: s4Messages,
    prefixTrimSourceOrder: injectCompartmentsModule.capturePrefixTrimSourceOrder(s4Messages),
    preparedPrefix,
  });
  if (s4.prefixTrimStatus !== "applied") {
    throw new Error(`S4 branch: prefixTrimStatus=${s4.prefixTrimStatus} (expected "applied")`);
  }
  assertAppliedKeepsSystemRun(s4Messages, s4Refs, "S4 branch");

  // ② S3 分支（id-lookup 兜底）：不带 sourceOrder，同一夹具同一形态。
  const s3Messages = makeMessages();
  const s3Refs = { mc1: s3Messages[0], mc2: s3Messages[1], mc3: s3Messages[2], mc4: s3Messages[3] };
  const s3 = injectCompartmentsModule.injectM0M1({
    ...baseOptions,
    messages: s3Messages,
    preparedPrefix,
  });
  if (s3.prefixTrimStatus !== "applied") {
    throw new Error(`S3 branch: prefixTrimStatus=${s3.prefixTrimStatus} (expected "applied")`);
  }
  assertAppliedKeepsSystemRun(s3Messages, s3Refs, "S3 branch");
});

// --- T-S10：裁前缀只裁对话，宿主附加上下文行与 system 段一并保留 -------------
//
// ZCode 把 skills 列表、日期、环境信息投影成 role "user" + syntheticHead + 带 id
// 的附件行，紧跟 system 段、排在第一条对话消息之前。裁前缀只应裁对话：夹具
// system k=2（mc1、mc2）+ 附件 mc3（syntheticHead）+ mc4（裁剪边界，对话）+ mc5。
// 断言裁后 = head + mc1 + mc2 + mc3 + mc5，前三条以同一引用保留在头部。

test("T-S10 裁前缀只裁对话：开头 system 段与宿主附加上下文行（syntheticHead + id）都保留", () => {
  const sessionId = "ses_ts10_head_context_run";
  const makeMessages = () => [
    {
      info: { id: "mc1", role: "system", sessionID: sessionId },
      parts: [{ type: "text", text: "system prompt line one" }],
    },
    {
      info: { id: "mc2", role: "system", sessionID: sessionId },
      parts: [{ type: "text", text: "system prompt line two" }],
    },
    {
      // 宿主附件投影的形状（host/types.ts）：role "user" + syntheticHead + 带 id。
      info: { id: "mc3", role: "user", syntheticHead: true, sessionID: sessionId },
      parts: [
        {
          type: "text",
          text: "The following skills are available for use with the Skill tool: ...",
        },
      ],
    },
    {
      info: { id: "mc4", role: "user", sessionID: sessionId },
      parts: [{ type: "text", text: "first user message (trim boundary)" }],
    },
    {
      info: { id: "mc5", role: "user", sessionID: sessionId },
      parts: [{ type: "text", text: "second user message" }],
    },
  ];
  const head = [
    { info: { role: "user" }, parts: [{ type: "text", text: "m[0]/m[1] head", synthetic: true }] },
  ];
  const preparedPrefix = {
    injected: true,
    prependedMessageCount: 0,
    m0RematerializedThisPass: false,
    materializationContentionRetryExhausted: true,
    decision: { value: false, reason: "cache_hit" },
    m0Bytes: null,
    m1Text: null,
    preparedMessages: head,
    preparedTrimBoundaryId: "mc4",
  };
  const baseOptions = {
    db: b4Db,
    sessionId,
    state: { sessionId, cachedM0Bytes: null, cachedM1Bytes: null },
    compactionOff: false,
    isCacheBustingPass: false,
  };
  const assertAppliedKeepsHeadContext = (messages, refs, label) => {
    if (messages.length !== 5) {
      throw new Error(
        `${label}: messages.length=${messages.length} (expected 5 = head + 2 system + attachment + mc5)`,
      );
    }
    if (messages[1] !== refs.mc1 || messages[2] !== refs.mc2 || messages[3] !== refs.mc3) {
      throw new Error(
        `${label}: the leading host-context run (system + syntheticHead attachment) did not survive with the same references`,
      );
    }
    if (messages.some((message) => message === refs.mc4)) {
      throw new Error(`${label}: mc4 (the trim boundary) survived the trim`);
    }
    if (!messages.includes(refs.mc5)) {
      throw new Error(`${label}: mc5 was dropped by the trim`);
    }
  };

  // ① S4 分支（source-order）。
  const s4Messages = makeMessages();
  const s4Refs = {
    mc1: s4Messages[0],
    mc2: s4Messages[1],
    mc3: s4Messages[2],
    mc4: s4Messages[3],
    mc5: s4Messages[4],
  };
  const s4 = injectCompartmentsModule.injectM0M1({
    ...baseOptions,
    messages: s4Messages,
    prefixTrimSourceOrder: injectCompartmentsModule.capturePrefixTrimSourceOrder(s4Messages),
    preparedPrefix,
  });
  if (s4.prefixTrimStatus !== "applied") {
    throw new Error(`S4 branch: prefixTrimStatus=${s4.prefixTrimStatus} (expected "applied")`);
  }
  assertAppliedKeepsHeadContext(s4Messages, s4Refs, "S4 branch");

  // ② S3 分支（id-lookup 兜底）。
  const s3Messages = makeMessages();
  const s3Refs = {
    mc1: s3Messages[0],
    mc2: s3Messages[1],
    mc3: s3Messages[2],
    mc4: s3Messages[3],
    mc5: s3Messages[4],
  };
  const s3 = injectCompartmentsModule.injectM0M1({
    ...baseOptions,
    messages: s3Messages,
    preparedPrefix,
  });
  if (s3.prefixTrimStatus !== "applied") {
    throw new Error(`S3 branch: prefixTrimStatus=${s3.prefixTrimStatus} (expected "applied")`);
  }
  assertAppliedKeepsHeadContext(s3Messages, s3Refs, "S3 branch");
});

// Windows 宿主（杀软/索引器）可能在测试退出后仍短暂持有编译缓存目录的句柄，
// EPERM 清理失败不应把全绿的测试判成失败；残留目录由下次运行复用前清掉。
function bestEffortRmSync(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EBUSY" || error.code === "ENOTEMPTY")) {
      console.log(`  note  cleanup deferred (${error.code}): ${path}`);
    } else {
      throw error;
    }
  }
}
// --- b6: source_contents 恒 pristine，注入剥离改为每 pass 幂等重放 ----------
//
// 方案 A（cr-20261027-v1030 CR-1）：heuristic 不再把剥离结果写回
// source_contents。source 只存宿主原文——这是 caveman（"compression always
// starts from the pristine original"）与 tagMessages（source ≠ 入站 ⇒ 重指）
// 两条契约的共同前提。剥离改由 replaySystemInjectionStrips 每 pass 重放，
// 覆盖 defer / non-routine pass（那些 pass 根本不跑 heuristic）。

const replayModule = await load("hooks/magic-context/system-injection-replay.js");
const B6_INJECTED = "hello\n\n<system-reminder>todo reminder</system-reminder>";
const B6_ONLY_INJECTED = "<system-reminder>only reminder</system-reminder>";

function b6Messages(sessionId, messageId, text) {
  return [
    {
      info: { id: messageId, role: "user", sessionID: sessionId, time: { created: 1000 } },
      parts: [{ type: "text", text }],
    },
  ];
}

function b6TagNumber(wireText) {
  const match = /^§(\d+)§ /u.exec(wireText);
  if (!match) throw new Error(`no tag prefix on the wire: ${JSON.stringify(wireText)}`);
  return Number(match[1]);
}

function b6Target(messages, tagNumber, options = {}) {
  const part = messages[0].parts[0];
  return {
    message: messages[0],
    textPrefix: `§${tagNumber}§ `,
    getContent: () => part.text,
    setContent: (next) => {
      if (part.text === next) return false;
      part.text = next;
      return true;
    },
    ...(options.drop ? { drop: options.drop } : {}),
  };
}

function b6Source(sessionId, tagNumber) {
  return storage.getSourceContents(b4Db, sessionId, [tagNumber]).get(tagNumber);
}

test("b6 routine strip leaves source_contents pristine (no derived write-back)", () => {
  const sessionId = "ses_b6_routine";
  const messages = b6Messages(sessionId, "mc_b6_routine", B6_INJECTED);
  tagMessagesB5.tagMessages(sessionId, messages, taggerModule.createTagger(), b4Db);
  const tagNumber = b6TagNumber(messages[0].parts[0].text);

  const result = heuristicModule.applyHeuristicCleanup(
    sessionId,
    b4Db,
    new Map([[tagNumber, b6Target(messages, tagNumber)]]),
    new Map(),
    { protectedTagNumbers: new Set(), protectedCutoff: null, routine: true },
  );

  if (result.droppedInjections !== 1) {
    throw new Error(`droppedInjections=${result.droppedInjections} (expected 1)`);
  }
  const wire = messages[0].parts[0].text;
  if (!/^§\d+§ hello$/u.test(wire)) throw new Error(`wire was not stripped: ${wire}`);
  // 反向验证：把 `replaceSourceContent(strippedSource)` 加回去，这条立刻红。
  if (b6Source(sessionId, tagNumber) !== B6_INJECTED) {
    throw new Error(
      `source_contents is no longer pristine: ${JSON.stringify(b6Source(sessionId, tagNumber))}`,
    );
  }
  // caveman replay 的输入契约（"always from the pristine original"）由此继承：
  // 同一条 tag 在 heuristic 跑完后仍能读到带注入的原始正文。
});

test("b6 non-routine pass is covered by replaySystemInjectionStrips", () => {
  const sessionId = "ses_b6_replay";
  const messages = b6Messages(sessionId, "mc_b6_replay", B6_INJECTED);
  tagMessagesB5.tagMessages(sessionId, messages, taggerModule.createTagger(), b4Db);
  const tagNumber = b6TagNumber(messages[0].parts[0].text);
  const tag = storageTags.getTagById(b4Db, sessionId, tagNumber);
  const target = b6Target(messages, tagNumber);

  // 宿主每 pass 从 DB 重建消息：入站仍是 pristine，这一轮 heuristic 不跑。
  const replayed = replayModule.replaySystemInjectionStrips(
    new Map([[tagNumber, target]]),
    [tag],
    null,
  );
  if (replayed !== 1) throw new Error(`replay returned ${replayed} (expected 1)`);
  const wire = messages[0].parts[0].text;
  if (!/^§\d+§ hello$/u.test(wire)) throw new Error(`replay did not strip: ${wire}`);
  if (b6Source(sessionId, tagNumber) !== B6_INJECTED) {
    throw new Error("replay must not rewrite source_contents");
  }

  // 幂等：再跑一次既不改 wire，也不报 strip。
  const before = messages[0].parts[0].text;
  if (replayModule.replaySystemInjectionStrips(new Map([[tagNumber, target]]), [tag], null) !== 0) {
    throw new Error("second replay was not a no-op");
  }
  if (messages[0].parts[0].text !== before) throw new Error("second replay changed the wire");
});

test("b6 replay leaves an edited message alone (rewind keeps working)", () => {
  const sessionId = "ses_b6_edit";
  const tagger = taggerModule.createTagger();
  const first = b6Messages(sessionId, "mc_b6_edit", B6_INJECTED);
  tagMessagesB5.tagMessages(sessionId, first, tagger, b4Db);
  const tagNumber = b6TagNumber(first[0].parts[0].text);
  const tag = storageTags.getTagById(b4Db, sessionId, tagNumber);

  // 编辑重发：同一位置换成新正文。
  const edited = b6Messages(sessionId, "mc_b6_edit", "world");
  tagMessagesB5.tagMessages(sessionId, edited, tagger, b4Db);
  if (!/^§\d+§ world$/u.test(edited[0].parts[0].text)) {
    throw new Error(`edit-resend replayed a stale body: ${edited[0].parts[0].text}`);
  }
  if (b6Source(sessionId, tagNumber) !== "world") {
    throw new Error(`source was not corrected: ${JSON.stringify(b6Source(sessionId, tagNumber))}`);
  }

  // replay 不得把旧正文或旧派生文本带回 wire。
  replayModule.replaySystemInjectionStrips(
    new Map([[tagNumber, b6Target(edited, tagNumber)]]),
    [tag],
    null,
  );
  if (edited[0].parts[0].text !== `§${tagNumber}§ world`) {
    throw new Error(`replay disturbed the edited wire: ${edited[0].parts[0].text}`);
  }
});

test("b6 drop keeps source pristine and replay never emits an empty part", () => {
  // ① routine pass：整段只有注入 → heuristic 落 dropped，但 source 仍是原文。
  const dropSession = "ses_b6_drop";
  const dropMessages = b6Messages(dropSession, "mc_b6_drop", B6_ONLY_INJECTED);
  tagMessagesB5.tagMessages(dropSession, dropMessages, taggerModule.createTagger(), b4Db);
  const dropTag = b6TagNumber(dropMessages[0].parts[0].text);
  heuristicModule.applyHeuristicCleanup(
    dropSession,
    b4Db,
    new Map([[dropTag, b6Target(dropMessages, dropTag, { drop: () => "absent" })]]),
    new Map(),
    { protectedTagNumbers: new Set(), protectedCutoff: null, routine: true },
  );
  if (dropMessages[0].parts[0].text !== dropped(dropTag)) {
    throw new Error(`drop placeholder missing: ${dropMessages[0].parts[0].text}`);
  }
  if (storageTags.getTagById(b4Db, dropSession, dropTag)?.status !== "dropped") {
    throw new Error("the tag was not marked dropped");
  }
  if (b6Source(dropSession, dropTag) !== B6_ONLY_INJECTED) {
    throw new Error("drop must not rewrite source_contents to an empty string");
  }

  // ② non-routine pass：replay 遇到同样的整段注入必须原样放过——不能写出空串
  //    或裸 `§N§`，也不能替 heuristic 做 drop。
  const replaySession = "ses_b6_replay_empty";
  const replayMessages = b6Messages(replaySession, "mc_b6_replay_empty", B6_ONLY_INJECTED);
  tagMessagesB5.tagMessages(replaySession, replayMessages, taggerModule.createTagger(), b4Db);
  const replayTag = b6TagNumber(replayMessages[0].parts[0].text);
  const before = replayMessages[0].parts[0].text;
  const replayed = replayModule.replaySystemInjectionStrips(
    new Map([[replayTag, b6Target(replayMessages, replayTag)]]),
    [storageTags.getTagById(b4Db, replaySession, replayTag)],
    null,
  );
  if (replayed !== 0) {
    throw new Error(`replay claimed ${replayed} strips on a whole-injection part`);
  }
  if (replayMessages[0].parts[0].text !== before) {
    throw new Error(`replay rewrote a whole-injection part: ${replayMessages[0].parts[0].text}`);
  }
  if (storageTags.getTagById(b4Db, replaySession, replayTag)?.status !== "active") {
    throw new Error("replay must not drop tags");
  }
});

// --- T-M4 / T-M5: magic-context-tool-media-roundtrip -------------------------
//
// 工具结果的媒体块正投影到 tool part 的 `state.attachments`（base64 在
// `attachments[].url`）与 `state.mediaLayout`（原块浅拷贝，dataUrl 置 null）。
// T-M4 锚定既有打标/计费行为；T-M5 钉 drop 清空与 LKG 输入指纹占位。
// 依据：docs/iterations/magic-context-tool-media-roundtrip/spec.md「测试用例」。

const TM_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const TM_PNG_URL = `data:image/png;base64,${TM_PNG_BASE64}`;
// 超过 LKG 占位阈值（1024）的 data URL：合法 PNG base64 末尾填充而成。
// `estimateImageTokensFromDataUrl` 只解码前 512 字符读 IHDR，尾部填充不影响估 token。
const tmLongDataUrl = (fill) => `data:image/png;base64,${TM_PNG_BASE64}${fill.repeat(1200)}`;

function tmImageLayout() {
  return [
    {
      attachment: 0,
      block: {
        type: "image",
        mediaType: "image/png",
        dataUrl: null,
        source: { id: "read-image", placeholder: "Read image" },
      },
    },
  ];
}

/** ZCode 形态的一轮：assistant 上的调用 + user 消息上的结果 part（各带 `attachments`）。 */
function tmToolMessages(sessionId, results) {
  const assistant = {
    info: { id: "msg_tm_asst", role: "assistant", sessionID: sessionId, time: { created: 1000 } },
    parts: results
      .map((result, index) =>
        result === null
          ? null
          : {
              type: "tool",
              callID: `call_tm_${index}`,
              tool: "Read",
              state: { status: "running", input: { filePath: `shot-${index}.png` } },
            },
      )
      .filter(Boolean),
  };
  const user = {
    info: { id: "msg_tm_tool", role: "user", sessionID: sessionId, time: { created: 2000 } },
    parts: results.map((result, index) => ({
      type: "tool",
      callID: `call_tm_${index}`,
      tool: "Read",
      state: {
        status: "completed",
        output: result.text,
        ...(result.withImage
          ? {
              attachments: [{ mime: "image/png", url: TM_PNG_URL }],
              mediaLayout: tmImageLayout(),
            }
          : {}),
      },
    })),
  };
  return [assistant, user];
}

/** 单条承载工具结果（带一张图）的 user 消息。 */
function tmResultMessage(sessionId, url) {
  return {
    info: { id: "msg_tm_tool", role: "user", sessionID: sessionId, time: { created: 2000 } },
    parts: [
      {
        type: "tool",
        callID: "call_tm_0",
        tool: "Read",
        state: {
          status: "completed",
          output: "shot",
          attachments: [{ mime: "image/png", url }],
          mediaLayout: tmImageLayout(),
        },
      },
    ],
  };
}

function tmTagNumber(wireText) {
  const match = /^§(\d+)§ /u.exec(wireText);
  if (!match) throw new Error(`no tag prefix on the wire: ${JSON.stringify(wireText)}`);
  return Number(match[1]);
}

test("T-M4 打标保留 attachments / mediaLayout，图片计 token，base64 不进 tags 与 source_contents", () => {
  const sessionId = "ses_tm4_tag";
  const messages = tmToolMessages(sessionId, [{ text: "shot", withImage: true }, { text: "shot" }]);
  const before = messages[1].parts.map((part) => ({
    attachments: JSON.stringify(part.state.attachments),
    mediaLayout: JSON.stringify(part.state.mediaLayout),
  }));
  tagMessagesModule.tagMessages(sessionId, messages, taggerModule.createTagger(), b4Db);
  const withImageTag = tmTagNumber(messages[1].parts[0].state.output);
  const plainTag = tmTagNumber(messages[1].parts[1].state.output);
  const [withImage, plain] = messages[1].parts;

  if (withImage.state.output !== `${SECTION}${withImageTag}${SECTION} shot`) {
    throw new Error(`image result was not tagged: ${JSON.stringify(withImage.state.output)}`);
  }
  if (JSON.stringify(withImage.state.attachments) !== before[0].attachments) {
    throw new Error("tagging rewrote attachments");
  }
  if (JSON.stringify(withImage.state.mediaLayout) !== before[0].mediaLayout) {
    throw new Error("tagging rewrote mediaLayout");
  }
  if ("attachments" in plain.state || "mediaLayout" in plain.state) {
    throw new Error("the no-attachment control grew media keys");
  }

  const withTokens = getTagById(b4Db, sessionId, withImageTag)?.tokenCount;
  const plainTokens = getTagById(b4Db, sessionId, plainTag)?.tokenCount;
  if (typeof withTokens !== "number" || typeof plainTokens !== "number") {
    throw new Error(`token_count missing: with=${withTokens} plain=${plainTokens}`);
  }
  if (!(withTokens > plainTokens)) {
    throw new Error(`image result must cost more: with=${withTokens} plain=${plainTokens}`);
  }

  const tagsRows = b4Db.prepare("SELECT * FROM tags WHERE session_id = ?").all(sessionId);
  const sourceRows = b4Db
    .prepare("SELECT * FROM source_contents WHERE session_id = ?")
    .all(sessionId);
  if (tagsRows.length < 2) throw new Error(`tags rows=${tagsRows.length}`);
  for (const [table, rows] of [
    ["tags", tagsRows],
    ["source_contents", sourceRows],
  ]) {
    const dumped = JSON.stringify(rows);
    if (dumped.includes(TM_PNG_BASE64.slice(0, 64))) {
      throw new Error(`${table} leaked the image base64`);
    }
    if (/[A-Za-z0-9+/]{200,}/u.test(dumped)) {
      throw new Error(`${table} holds a long base64 run`);
    }
  }
});

test("T-M5 drop 清空 attachments；LKG 输入指纹对长 data URL 占位，jsonPrefix 保留完整媒体", () => {
  // ① 真实 drop 路径：带附件的 tool part 走 skeletonStripped。
  {
    const sessionId = "ses_tm5_drop";
    const messages = tmToolMessages(sessionId, [{ text: "shot", withImage: true }]);
    const part = messages[1].parts[0];
    const originalOutput = part.state.output;
    const originalAttachments = JSON.stringify(part.state.attachments);
    const compositeKey = `msg_tm_tool\u0000call_tm_0`;
    const index = new Map([
      [
        compositeKey,
        {
          occurrences: [{ message: messages[1], part, kind: "result" }],
          hasResult: true,
        },
      ],
    ]);
    const batch = new toolDropTarget.ToolMutationBatch(messages);
    const target = toolDropTarget.createToolDropTarget(compositeKey, [], index, batch, 7);
    const outcome = applyOps.applyNewToolDrop(target, { inWindow: true });
    if (outcome.mode !== "skeleton_stripped" || outcome.result !== "truncated") {
      throw new Error(`drop outcome=${JSON.stringify(outcome)}`);
    }
    const served = messages[1].parts[0];
    if (served.state.output !== dropped(7)) {
      throw new Error(`dropped output=${JSON.stringify(served.state.output)}`);
    }
    if (JSON.stringify(served.state.attachments) !== "[]") {
      throw new Error(`attachments survived the drop: ${JSON.stringify(served.state.attachments)}`);
    }
    // 宿主原 part 不被 drop 改写（clamp 作用于 clone）。
    if (
      part.state.output !== originalOutput ||
      JSON.stringify(part.state.attachments) !== originalAttachments
    ) {
      throw new Error("drop mutated the host part in place");
    }
  }

  // ② LKG 输入指纹。
  const urlA = tmLongDataUrl("A");
  const urlB = tmLongDataUrl("B");
  if (!(urlA.length > 1024)) throw new Error("fixture must exceed the 1024 placeholder threshold");
  const digestOf = (url) => {
    const fields = lkgSlot.lkgContentFields(tmResultMessage("ses_tm5_digest", url));
    if (!fields) throw new Error("lkgContentFields returned null");
    return { fields, digest: lkgSlot.lkgContentDigestFromFields(fields) };
  };
  const a1 = digestOf(urlA);
  const a2 = digestOf(urlA);
  const b = digestOf(urlB);
  if (a1.digest !== a2.digest) throw new Error("same image produced different digests");
  if (a1.digest === b.digest) throw new Error("two different images produced the same digest");

  const leaked = a1.fields.filter(
    (field) => typeof field === "string" && field.startsWith("data:image") && field.length > 1024,
  );
  if (leaked.length > 0) {
    throw new Error(
      `fingerprint fields carry ${leaked.length} raw data URL(s), longest ${leaked.reduce((m, s) => Math.max(m, s.length), 0)} chars`,
    );
  }

  // ≤1024 的 `data:` 字符串不占位、原样进 fields。
  const shortFields = lkgSlot.lkgContentFields(TM_PNG_URL);
  if (!shortFields.includes(TM_PNG_URL)) {
    throw new Error("a short data: string must stay verbatim in the fields");
  }

  // jsonPrefix 是重放输出，必须仍带完整 dataUrl。
  const lkgSession = "ses_tm5_lkg_input";
  const input = [
    lkgMessage("msg_tm5_1", "user", "look at this", 1000),
    lkgMessage("msg_tm5_2", "assistant", "reading", 2000),
    tmResultMessage(lkgSession, urlA),
  ];
  const built = lkgReplay.buildLkgPrefix(input, lkgPass(input));
  if (!built) throw new Error("buildLkgPrefix refused a well-formed pass");
  const replayed = JSON.parse(built.jsonPrefix);
  const replayedUrl = replayed[2]?.parts?.[0]?.state?.attachments?.[0]?.url;
  if (replayedUrl !== urlA) {
    throw new Error(
      `jsonPrefix lost the media: ${typeof replayedUrl === "string" ? `${replayedUrl.length} chars` : JSON.stringify(replayedUrl)}`,
    );
  }
});

test("T-M7 锚定已知限制：持久化 skeleton_real / edit_marker 回放不 strip，存量被 drop 的媒体仍随条目上路", () => {
  // 锚定既有行为 / 已知限制（MF-1），不是期望行为。修复前已被 ctx_reduce 丢弃并持久化为
  // drop_mode = skeleton_real / edit_marker 的带媒体工具结果，每 pass 经
  // apply-operations.ts 的回放分支调 target.skeletonReal() / target.editMarker()（不带
  // strip；legacy 转换走 renderConvertedToolSkeletons 同理），attachments 原样保留，
  // 反投影还原成 [{text: "[dropped §N§]"}, image]。修复后新产生的 drop 在
  // hasAttachments() 为真时走 stripped 变体（T-M5 ① 钉住），不会复现。
  const sessionId = "ses_tm7_replay";
  const messages = tmToolMessages(sessionId, [{ text: "shot", withImage: true }]);
  const part = messages[1].parts[0];
  const originalAttachments = JSON.stringify(part.state.attachments);
  const compositeKey = `msg_tm_tool\u0000call_tm_0`;
  const index = new Map([
    [
      compositeKey,
      { occurrences: [{ message: messages[1], part, kind: "result" }], hasResult: true },
    ],
  ]);
  const tagNumber = 7;
  const makeTarget = () =>
    toolDropTarget.createToolDropTarget(
      compositeKey,
      [],
      index,
      new toolDropTarget.ToolMutationBatch(messages),
      tagNumber,
    );

  // ① skeleton_real 回放（apply-operations.ts 的 `tag.dropMode === "skeleton_real"` 分支）。
  {
    const target = makeTarget();
    if (target.skeletonReal() !== "truncated") throw new Error("skeletonReal did not truncate");
    const served = messages[1].parts[0];
    if (served.state.output !== dropped(tagNumber)) {
      throw new Error(`skeleton replay output=${JSON.stringify(served.state.output)}`);
    }
    if (JSON.stringify(served.state.attachments) !== originalAttachments) {
      throw new Error(
        "skeletonReal() stripped attachments: the known limitation changed, update this test and the spec risk table",
      );
    }
  }

  // ② legacy 转换当 pass 的渲染（renderConvertedToolSkeletons 的 skeleton_real 臂）。
  {
    const target = makeTarget();
    const mutated = applyOps.renderConvertedToolSkeletons(
      new Map([[tagNumber, target]]),
      new Map([[tagNumber, "skeleton_real"]]),
    );
    if (!mutated) throw new Error("renderConvertedToolSkeletons did not mutate");
    const served = messages[1].parts[0];
    if (
      JSON.stringify({ output: served.state.output, attachments: served.state.attachments }) !==
      JSON.stringify({ output: dropped(tagNumber), attachments: JSON.parse(originalAttachments) })
    ) {
      throw new Error("legacy conversion render diverged from the skeleton_real replay");
    }
  }

  // ③ edit_marker 回放（`tag.dropMode === "edit_marker"` 分支）同理。
  {
    const target = makeTarget();
    if (target.editMarker() !== "truncated") throw new Error("editMarker did not truncate");
    const served = messages[1].parts[0];
    if (served.state.output !== dropped(tagNumber)) {
      throw new Error(`edit-marker replay output=${JSON.stringify(served.state.output)}`);
    }
    if (JSON.stringify(served.state.attachments) !== originalAttachments) {
      throw new Error(
        "editMarker() stripped attachments: the known limitation changed, update this test and the spec risk table",
      );
    }
  }

  // ③ 对照：stripped 变体确实清空 attachments（修复后新 drop 走的那条）。
  {
    const target = makeTarget();
    if (target.hasAttachments() !== true) throw new Error("hasAttachments() must see the media");
    if (target.skeletonStripped() !== "truncated")
      throw new Error("skeletonStripped did not truncate");
    const served = messages[1].parts[0];
    if (
      served.state.output !== dropped(tagNumber) ||
      JSON.stringify(served.state.attachments) !== "[]"
    ) {
      throw new Error("skeletonStripped() must empty attachments");
    }
  }

  // 宿主原 part 不被任何回放改写。
  if (
    JSON.stringify(part.state.attachments) !== originalAttachments ||
    part.state.output !== "shot"
  ) {
    throw new Error("replay mutated the host part in place");
  }
});

// --- run -------------------------------------------------------------------
//
// FORK（magic-context-trim-integrity CR-12）：执行循环原先注册在 b6 系列**之前**
// ——带顶层 await 的循环在此暂停模块执行，b6 四条用例随后才 push 进 cases，永不
// 被执行（末尾打印的 cases.length 却把它们计入，「PASS — N cases」失真）。循环
// 必须位于全部用例注册之后、bestEffortRmSync 清理之前：用例直接读写 b4Db 这个
// 临时库，清理先跑的话执行时库已被删（Windows 上常因文件被占用删不掉才碰巧能跑）。

let failures = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${error && error.message}`);
  }
}

bestEffortRmSync(root);
bestEffortRmSync(b4DbDir);

console.log("");
if (failures === 0) {
  console.log(`TRANSFORM TESTS PASS — ${cases.length} cases, 0 failures`);
} else {
  console.log(`TRANSFORM TESTS FAIL — ${cases.length} cases, ${failures} failure(s)`);
  process.exitCode = 1;
}
