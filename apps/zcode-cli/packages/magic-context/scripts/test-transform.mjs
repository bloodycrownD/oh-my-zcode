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
 * The port cannot be exercised from `dist/` here: the sibling `src/host/` layer is
 * still in flight, and a package build would compile it too. Instead this script
 * stages `src/core/**` plus the two upstream files the b1/b2 graph reaches but the
 * fork deliberately does not port (`dropped-input-guard`, `dreamer/token-budget`),
 * compiles just that graph with `tsc` into a temp dir, and runs `node:test`
 * against the emitted JavaScript.
 *
 * Exits 0 on success, 1 on any failed assertion or build error.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const REF = "D:/Dev/Js/oh-my-zcode/.reference/magic-context/packages/plugin/src/";

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

// Upstream modules the b1/b2 import graph reaches that this fork does not port.
// `dropped-input-guard` is a dreamer-guard; `dreamer/**` is on the spec's
// 「明确不搬」list, but the guard itself is a pure predicate and is staged here
// only so `tool-drop-target` can be loaded. Neither is part of the shipped port.
const OVERLAY = [
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
  for (const rel of OVERLAY) {
    let text = readFileSync(join(REF, rel), "utf8").replace(/\r\n/g, "\n");
    // Same NodeNext `.js` rebase the port driver applies.
    text = text.replace(
      /((?:^|[\s;])import\s+(?:type\s+)?(?:[^'";]*?\sfrom\s*)?)['"](\.[^'"]*)['"]/g,
      (whole, head, spec) => {
        if (spec.endsWith(".js")) return whole;
        return head + '"' + spec + '.js"';
      },
    );
    const dest = join(src, rel);
    writeFileSync(dest, text);
  }
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
const deriveBudgets = await load("hooks/magic-context/derive-budgets.js");
const tokenizerCalibration = await load("hooks/magic-context/tokenizer-calibration.js");
const decayCurve = await load("hooks/magic-context/decay-curve.js");
const formatting = await load("hooks/magic-context/read-session-formatting.js");

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

rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

console.log("");
if (failures === 0) {
  console.log(`TRANSFORM TESTS PASS — ${cases.length} cases, 0 failures`);
} else {
  console.log(`TRANSFORM TESTS FAIL — ${cases.length} cases, ${failures} failure(s)`);
  process.exitCode = 1;
}
