#!/usr/bin/env node
/**
 * Step 20 acceptance tests — historian executor + scheduler.
 *
 * Covers the fork-authored surface of Step 20:
 *  - `host/hidden-completion-executor.ts` (the D-6 side-car executor): the
 *    four-stage contract (open/attempt/collect/close), refusal classification,
 *    the timeout budget, and the `preserveProviderStreamBoundaries` hard
 *    constraint via a NEGATIVE typecheck.
 *  - `core/features/magic-context/historian-scheduler.ts`: notifyTurnSuccess /
 *    drain / shutdown.
 *
 * The upstream-verbatim compartment runner (compartment-runner*.ts) is not
 * exercised here by design: its end-to-end "compartments land in the DB"
 * acceptance is Step 24's job (T-M6) with the real bootstrap wiring; mocking
 * the full CompartmentRunnerDeps fixture would test the mock, not the runner.
 *
 * Requires Node >= 24 and a prior `pnpm build` (imports `dist/`).
 * Exits 0 when every test passes, 1 otherwise.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const PKG_ROOT = fileURLToPath(new URL("../", import.meta.url));
const dist = (p) => pathToFileURL(join(PKG_ROOT, "dist", p)).href;

const { createHiddenCompletionExecutor, toTokenTotals } = await import(
  dist("host/hidden-completion-executor.js")
);
const { HiddenCompletionRefusal } = await import(
  dist("core/hooks/magic-context/compartment-runner-types.js")
);
const { initializeMagicContextHost } = await import(dist("host/harness.js"));
const { createHistorianScheduler } = await import(
  dist("core/features/magic-context/historian-scheduler.js")
);

initializeMagicContextHost();

/** A run identity the executor will accept. */
function makeRun(overrides = {}) {
  return {
    agent: "historian",
    kind: "historian",
    system: "system prompt",
    model: { providerID: "p", modelID: "m" },
    timeoutMs: 5_000,
    title: "test run",
    directory: "/tmp/project",
    ...overrides,
  };
}

/** A PromptArgs carrying a single synthetic text part, as the runner builds. */
function makePrompt(text) {
  return {
    path: { id: "prompt-1" },
    body: { parts: [{ type: "text", text, synthetic: true }] },
  };
}

/** Side-car mock: resolves `text` after `delayMs`, rejects on abort. */
function okSidecar(text, delayMs = 0) {
  return async (request, options) => {
    assert.equal(options.preserveProviderStreamBoundaries, true, "options must carry the flag");
    if (delayMs > 0) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        request.abortSignal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error(`aborted: ${request.abortSignal.reason?.message ?? ""}`.trim()));
        });
      });
    }
    return { text, usage: { inputTokens: 10, outputTokens: 5 } };
  };
}

test("capabilities report the fork harness and honest tool support", () => {
  const executor = createHiddenCompletionExecutor({ sidecarModelCall: okSidecar("x") });
  assert.equal(executor.capabilities.harness, "zcode");
  assert.equal(executor.capabilities.tools, false);
  const withTools = createHiddenCompletionExecutor({
    sidecarModelCall: okSidecar("x"),
    supportsTools: true,
  });
  assert.equal(withTools.capabilities.tools, true);
});

test("open without a sidecar call refuses with terminal unsupported_transport", async () => {
  const executor = createHiddenCompletionExecutor({});
  await assert.rejects(
    executor.open(makeRun()),
    (e) => e instanceof HiddenCompletionRefusal && e.code === "unsupported_transport" && e.terminal,
  );
});

test("open without any model refuses with terminal hidden_model_unsupported", async () => {
  const executor = createHiddenCompletionExecutor({ sidecarModelCall: okSidecar("x") });
  await assert.rejects(
    executor.open(makeRun({ model: undefined, configuredModels: undefined })),
    (e) =>
      e instanceof HiddenCompletionRefusal && e.code === "hidden_model_unsupported" && e.terminal,
  );
});

test("open for a non-historian agent on a tools-less transport refuses", async () => {
  const executor = createHiddenCompletionExecutor({ sidecarModelCall: okSidecar("x") });
  await assert.rejects(
    executor.open(makeRun({ agent: "other-agent", kind: "dreamer-task" })),
    (e) => e instanceof HiddenCompletionRefusal && e.code === "hidden_tools_unsupported",
  );
});

test("attempt → collect returns the settled text with normalised usage", async () => {
  const executor = createHiddenCompletionExecutor({ sidecarModelCall: okSidecar("SUMMARY") });
  const handle = await executor.open(makeRun());
  let settled = false;
  try {
    await executor.attempt(handle, makePrompt("the prompt"));
    const completion = await executor.collect(handle, 1);
    settled = true;
    assert.equal(completion.text, "SUMMARY");
    assert.equal(completion.usage.total, 15);
    assert.equal(completion.usage.input, 10);
    assert.equal(completion.lengthCapped, false);
  } finally {
    await executor.close(handle, {
      promptSettled: settled,
      privacySensitive: false,
      context: "test",
      log: () => {},
    });
  }
});

test("collect before attempt refuses without sending anything", async () => {
  const executor = createHiddenCompletionExecutor({ sidecarModelCall: okSidecar("x") });
  const handle = await executor.open(makeRun());
  await assert.rejects(
    executor.collect(handle, 1),
    (e) => e instanceof HiddenCompletionRefusal && e.code === "hidden_prompt_unrecognized",
  );
  await executor.close(handle, {
    promptSettled: false,
    privacySensitive: false,
    context: "t",
    log: () => {},
  });
});

test("a second attempt on the same handle is refused — never re-send", async () => {
  const executor = createHiddenCompletionExecutor({ sidecarModelCall: okSidecar("x") });
  const handle = await executor.open(makeRun());
  try {
    await executor.attempt(handle, makePrompt("first"));
    await assert.rejects(executor.attempt(handle, makePrompt("second")), /refusing to re-send/);
  } finally {
    await executor.close(handle, {
      promptSettled: true,
      privacySensitive: false,
      context: "t",
      log: () => {},
    });
  }
});

test("attempt with no text part refuses as hidden_prompt_unrecognized", async () => {
  const executor = createHiddenCompletionExecutor({ sidecarModelCall: okSidecar("x") });
  const handle = await executor.open(makeRun());
  try {
    await assert.rejects(
      executor.attempt(handle, { path: { id: "p" }, body: { parts: [] } }),
      (e) => e instanceof HiddenCompletionRefusal && e.code === "hidden_prompt_unrecognized",
    );
  } finally {
    await executor.close(handle, {
      promptSettled: false,
      privacySensitive: false,
      context: "t",
      log: () => {},
    });
  }
});

test("the executor's own timeout budget aborts a hung provider call", async () => {
  const executor = createHiddenCompletionExecutor({ sidecarModelCall: okSidecar("late", 60_000) });
  const handle = await executor.open(makeRun({ timeoutMs: 80 }));
  try {
    await executor.attempt(handle, makePrompt("p"));
    await assert.rejects(executor.collect(handle, 1), /aborted/);
  } finally {
    await executor.close(handle, {
      promptSettled: false,
      privacySensitive: false,
      context: "t",
      log: () => {},
    });
  }
});

test("provider setup error codes map to a terminal hidden_model_unsupported refusal", async () => {
  const failing = async () => {
    const err = new Error("model is gone");
    err.code = "model_not_found";
    throw err;
  };
  const executor = createHiddenCompletionExecutor({ sidecarModelCall: failing });
  const handle = await executor.open(makeRun());
  try {
    await executor.attempt(handle, makePrompt("p"));
    await assert.rejects(
      executor.collect(handle, 1),
      (e) =>
        e instanceof HiddenCompletionRefusal && e.code === "hidden_model_unsupported" && e.terminal,
    );
  } finally {
    await executor.close(handle, {
      promptSettled: false,
      privacySensitive: false,
      context: "t",
      log: () => {},
    });
  }
});

test("close(null) is safe and close on an unsettled run aborts the request", async () => {
  const executor = createHiddenCompletionExecutor({ sidecarModelCall: okSidecar("x", 60_000) });
  await executor.close(null, {
    promptSettled: false,
    privacySensitive: false,
    context: "t",
    log: () => {},
  });

  let observedAbort = false;
  const hanging = async (request) => {
    await new Promise((resolve, reject) => {
      request.abortSignal.addEventListener("abort", () => {
        observedAbort = true;
        reject(new Error("aborted by close"));
      });
      setTimeout(resolve, 60_000);
    });
    return { text: "never" };
  };
  const exec2 = createHiddenCompletionExecutor({ sidecarModelCall: hanging });
  const handle = await exec2.open(makeRun({ timeoutMs: 60_000 }));
  await exec2.attempt(handle, makePrompt("p"));
  const collected = executor.collect; // sanity: different instance untouched
  void collected;
  await exec2.close(handle, {
    promptSettled: false,
    privacySensitive: false,
    context: "t",
    log: () => {},
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(observedAbort, true, "close must abort the in-flight request");
});

test("an external shutdown signal aborts every live run slot (MF-03)", async () => {
  // The provider call that must be unwound when the host/session shuts down. It is
  // deliberately NOT the executor's own timeout: the budget here is 60s, so an abort
  // can only have come from `externalSignal`.
  const observed = [];
  const hanging = async (request) => {
    observed.push(request.abortSignal);
    return await new Promise((_resolve, reject) => {
      request.abortSignal.addEventListener("abort", () => reject(new Error("aborted by host")), {
        once: true,
      });
      setTimeout(() => reject(new Error("executor timeout budget")), 60_000);
    });
  };

  const hostShutdown = new AbortController();
  const executor = createHiddenCompletionExecutor({
    sidecarModelCall: hanging,
    externalSignal: hostShutdown.signal,
  });
  const handle = await executor.open(makeRun({ timeoutMs: 60_000 }));
  await executor.attempt(handle, makePrompt("p"));
  assert.equal(observed[0].aborted, false, "precondition: the request is still in flight");

  hostShutdown.abort(new Error("historian scheduler shut down"));
  await assert.rejects(executor.collect(handle, 1), /aborted by host/);
  assert.equal(observed[0].aborted, true, "the provider request must be aborted, not abandoned");

  await executor.close(handle, {
    promptSettled: false,
    privacySensitive: false,
    context: "t",
    log: () => {},
  });
});

test("a run opened after the external signal already aborted never reaches the provider", async () => {
  // The race this covers: host shutdown lands between the scheduler firing a pass and
  // that pass reaching `open`. Without the pre-check the run would register a slot and
  // send a prompt on a session that is already gone.
  const hostShutdown = new AbortController();
  hostShutdown.abort(new Error("closed"));
  let sent = false;
  const executor = createHiddenCompletionExecutor({
    sidecarModelCall: async (request) => {
      sent = true;
      return { text: "should never happen", abortSignal: request.abortSignal };
    },
    externalSignal: hostShutdown.signal,
  });
  const handle = await executor.open(makeRun());
  await assert.rejects(
    () => executor.attempt(handle, makePrompt("p")),
    /aborted before its prompt/,
  );
  assert.equal(sent, false, "an already-aborted host signal must not send a prompt");
  await executor.close(handle, {
    promptSettled: false,
    privacySensitive: false,
    context: "t",
    log: () => {},
  });
});

test("toTokenTotals sums the parts when the provider omitted a total", () => {
  const totals = toTokenTotals({
    text: "x",
    usage: {
      inputTokens: 100,
      outputTokens: 40,
      reasoningTokens: 10,
      cacheReadTokens: 5,
      cacheWriteTokens: 5,
    },
  });
  assert.equal(totals.total, 160);
  assert.equal(toTokenTotals({ text: "x", usage: { totalTokens: 7 } }).total, 7);
  assert.equal(toTokenTotals({ text: "x" }).total, 0);
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

test("notifyTurnSuccess fires runSession in the background and drain settles it", async () => {
  const calls = [];
  const scheduler = createHistorianScheduler({
    runSession: async (sessionId) => {
      calls.push(sessionId);
      await new Promise((r) => setTimeout(r, 30));
      return "success";
    },
    drainTimeoutMs: 5_000,
  });
  scheduler.notifyTurnSuccess({ sessionId: "s1" });
  assert.ok(calls.length <= 1, "notify is fire-and-forget, the run starts async");
  await scheduler.drain();
  assert.deepEqual(calls, ["s1"]);
  assert.equal(scheduler.getLastStatus("s1"), "success");
  assert.equal(scheduler.hasPendingWork(), false);
  scheduler.shutdown();
});

test("rapid duplicate notifies do not run the session twice concurrently", async () => {
  let running = 0;
  let maxConcurrent = 0;
  const calls = [];
  const scheduler = createHistorianScheduler({
    runSession: async (sessionId) => {
      calls.push(sessionId);
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 80));
      running -= 1;
      return "success";
    },
    drainTimeoutMs: 5_000,
  });
  scheduler.notifyTurnSuccess({ sessionId: "s2" });
  scheduler.notifyTurnSuccess({ sessionId: "s2" });
  scheduler.notifyTurnSuccess({ sessionId: "s2" });
  await scheduler.drain();
  assert.equal(maxConcurrent, 1, "a session must never have two concurrent runs");
  assert.ok(
    calls.length >= 1 && calls.length <= 3,
    `queued/deduped as designed, got ${calls.length}`,
  );
  assert.equal(scheduler.hasPendingWork(), false);
  scheduler.shutdown();
});

test("shutdown stops the scheduler and drain still resolves", async () => {
  const scheduler = createHistorianScheduler({
    runSession: async () => "success",
    drainTimeoutMs: 5_000,
  });
  scheduler.shutdown();
  scheduler.notifyTurnSuccess({ sessionId: "s3" });
  await scheduler.drain();
  assert.equal(scheduler.hasPendingWork(), false);
});

// ---------------------------------------------------------------------------
// The hard constraint — NEGATIVE typecheck.
// A fragment that omits / falsifies `preserveProviderStreamBoundaries` must
// fail to compile. Run tsc against it and require the failure.
// ---------------------------------------------------------------------------

test("SidecarModelCallOptions rejects a missing or false stream-boundary flag (compile-time)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-historian-neg-"));
  try {
    const tscBin = join(PKG_ROOT, "../../../..", "node_modules/typescript/bin/tsc");
    const dts = join(PKG_ROOT, "dist/host/hidden-completion-executor.d.ts").replaceAll("\\", "/");
    const fragment = join(dir, "neg.ts");
    writeFileSync(
      fragment,
      [
        `import type { SidecarModelCallOptions } from "${dts.replace(/\.d\.ts$/, ".js")}";`,
        `const missing: SidecarModelCallOptions = {};`,
        `const falsified: SidecarModelCallOptions = { preserveProviderStreamBoundaries: false };`,
        `void missing; void falsified;`,
      ].join("\n"),
      "utf8",
    );
    let stderr = "";
    let failed = false;
    try {
      execFileSync(
        process.execPath,
        [
          tscBin,
          "--ignoreConfig",
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--target",
          "es2022",
          fragment,
        ],
        { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
      );
    } catch (err) {
      failed = true;
      // tsc reports diagnostics on stdout; only crashes land on stderr.
      stderr = String(err.stdout ?? "") + String(err.stderr ?? "");
    }
    assert.ok(failed, "the negative fragment must NOT compile");
    assert.match(stderr, /preserveProviderStreamBoundaries/, "the error must name the flag");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
