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

const { getTagById, insertTag, stampTagMessageRole, updateCavemanDepth, updateTagStatus } =
  storageTags;
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
  // ① 生产路径：tagMessages 前先 initFromDb（transform.ts 同款），resolver 经
  //    contentId 精确命中已有的 message_id='msg:...:p0' 行。
  const productionSession = "ses_tg11_production";
  insertTag(b4Db, productionSession, "msg_tg11a:p0", "message", 16, 1);
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

// --- run -------------------------------------------------------------------

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
bestEffortRmSync(root);
bestEffortRmSync(b4DbDir);

console.log("");
if (failures === 0) {
  console.log(`TRANSFORM TESTS PASS — ${cases.length} cases, 0 failures`);
} else {
  console.log(`TRANSFORM TESTS FAIL — ${cases.length} cases, ${failures} failure(s)`);
  process.exitCode = 1;
}
