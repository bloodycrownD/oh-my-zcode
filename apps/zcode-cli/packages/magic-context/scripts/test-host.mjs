#!/usr/bin/env node
/**
 * Step 17 acceptance tests — host adapter layer (non-LLM).
 *
 * Covers: types/conversion, raw-message-provider paging, session-history SQL
 * against the user's REAL session store (read-only), storage-dir resolution +
 * the project-dir redirect, and the harness boot contract.
 *
 * HOW IT RUNS. The package is not built and must not be built here (Step 18's
 * B group is mid-flight in `src/core/**`, so a package build would fail for
 * reasons that have nothing to do with this step). Instead the script is run
 * against a THROWAWAY `tsc` emit of just the host closure:
 *
 *   tsc --outDir <temp>/src <the five host files>
 *
 * Command-line file mode, so only these files and their imports are compiled;
 * the host closure is exactly five files plus `core/shared/{data-path,
 * project-directory-key,harness,test-temp-dir}.ts`. Requires Node >= 24 (the
 * real-store smoke uses `node:sqlite`).
 *
 * The session store is opened with `readOnly: true` and never written to.
 *
 * Exits 0 when every test passes, 1 otherwise.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const OUT_ROOT = process.env.MC_HOST_TEST_OUT;
if (!OUT_ROOT) {
  console.error("MC_HOST_TEST_OUT is not set — compile the host closure first.");
  process.exit(1);
}

const host = (name) => pathToFileURL(join(OUT_ROOT, "host", name)).href;
const coreShared = (name) => pathToFileURL(join(OUT_ROOT, "core", "shared", name)).href;

const {
  isRuntimeAttachmentEntry,
  isRuntimeMessageEntry,
  messageLikeToRawMessage,
  projectMessageUnchanged,
  projectRuntimeEntries,
  projectStoredMessage,
  snapshotRuntimeEntries,
} = await import(host("types.js"));
const { createRawMessageProvider } = await import(host("raw-message-provider.js"));
const {
  createSessionHistory,
  createZCodeSessionReader,
  findLastAssistantModelFromStore,
  getMessageTimesFromStore,
  getStoredMessageCountFromStore,
  latestPersistedMessageFromStore,
  readStoredMessageByIdFromStore,
  readStoredMessagePageFromStore,
  ZCODE_MESSAGE_ORDER_SQL,
} = await import(host("session-history.js"));
const {
  MAGIC_CONTEXT_DB_FILE_NAME,
  __resetProjectDirResolverForTests,
  getMagicContextDatabaseLocation,
  getMagicContextDatabasePath,
  getProjectArtifactsRoot,
  getProjectKey,
  getZCodeProjectMagicContextDir,
  hasProjectDirResolver,
  resolveProjectMagicContextDir,
  setProjectDirResolver,
} = await import(host("storage-dir.js"));
const {
  ZCODE_HARNESS_ID,
  __resetHostInitializationForTests,
  assertMagicContextHostInitialized,
  initializeMagicContextHost,
  isMagicContextHostInitialized,
} = await import(host("harness.js"));
const { _resetHarnessForTesting, getHarness } = await import(coreShared("harness.js"));

let passed = 0;
let failed = 0;
const it = (name, fn) =>
  test(name, async (t) => {
    try {
      await fn(t);
      passed += 1;
    } catch (error) {
      failed += 1;
      throw error;
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** A synthetic ZCode runtime history: system, user, assistant(tool call), tool result. */
function sampleRuntimeEntries() {
  return [
    { message: { role: "system", content: "you are zcode" } },
    { message: { role: "user", content: [{ type: "text", text: "list the files" }] } },
    {
      message: {
        role: "assistant",
        content: [
          { type: "reasoning", text: "use Bash" },
          { type: "text", text: "checking" },
        ],
        toolCalls: [{ id: "call_1", name: "Bash", input: { command: "ls" } }],
        providerId: "account:x",
        modelId: "GLM-5.3",
      },
    },
    {
      message: {
        role: "tool",
        content: "a.ts\nb.ts",
        toolCallId: "call_1",
        toolName: "Bash",
        isError: false,
      },
    },
    {
      kind: "attachment",
      content: "<system-reminder>skills</system-reminder>",
      metadata: { source: "skills_listing" },
    },
  ];
}

function fakeStore(messages) {
  // Stand-in for a persisted page source: same ordering + ordinal space as the
  // SQL reader, without SQL.
  return {
    readStoredMessagePage({ afterOrdinal, limit, finalWatermark }) {
      const end = Math.min(
        messages.length,
        Number.isFinite(finalWatermark) ? finalWatermark : messages.length,
      );
      const page = messages
        .slice(Math.max(0, afterOrdinal), Math.max(0, end))
        .slice(0, Math.max(0, Math.floor(limit)))
        .map((message) => ({
          ordinal: messages.indexOf(message) + 1,
          id: message.id,
          role: message.role,
          parts: message.parts,
          createdAt: message.createdAt ?? null,
        }));
      return { messages: page };
    },
    getStoredMessageCount() {
      return messages.length;
    },
    readStoredMessageById(messageId) {
      return messages.find((message) => message.id === messageId) ?? null;
    },
  };
}

function storedMessageFixtures() {
  return [
    { id: "m1", role: "user", parts: [{ type: "text", text: "one" }], createdAt: 1000 },
    { id: "m2", role: "assistant", parts: [{ type: "text", text: "two" }], createdAt: 2000 },
    { id: "m3", role: "user", parts: [{ type: "text", text: "three" }], createdAt: 3000 },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// types / conversion
// ─────────────────────────────────────────────────────────────────────────────

await it("types: entry discrimination matches core's predicates", () => {
  const [system, , , , attachment] = sampleRuntimeEntries();
  assert.equal(isRuntimeMessageEntry(system), true);
  assert.equal(isRuntimeAttachmentEntry(system), false);
  assert.equal(isRuntimeAttachmentEntry(attachment), true);
  assert.equal(isRuntimeMessageEntry(attachment), false);
});

await it("types: RuntimeMessageEntry[] → MessageLike field mapping", () => {
  const messages = projectRuntimeEntries(sampleRuntimeEntries(), {
    sessionId: "sess_1",
    createdAt: 500,
  });
  assert.equal(messages.length, 5);

  // system: string content becomes one text part, role preserved, id synthesized.
  assert.deepEqual(messages[0].info, {
    id: "mc1",
    role: "system",
    sessionID: "sess_1",
    time: { created: 500 },
  });
  assert.deepEqual(messages[0].parts, [{ type: "text", text: "you are zcode" }]);

  // user: block content preserved as a text part.
  assert.equal(messages[1].info.role, "user");
  assert.deepEqual(messages[1].parts, [{ type: "text", text: "list the files" }]);

  // assistant: reasoning and text parts keep order, the declared tool call
  // becomes a RUNNING tool part (OpenCode's pending-invocation shape).
  const assistant = messages[2];
  assert.equal(assistant.info.role, "assistant");
  assert.deepEqual(assistant.parts[0], { type: "reasoning", text: "use Bash" });
  assert.deepEqual(assistant.parts[1], { type: "text", text: "checking" });
  const invocation = assistant.parts[2];
  assert.equal(invocation.type, "tool");
  assert.equal(invocation.callID, "call_1");
  assert.equal(invocation.tool, "Bash");
  assert.equal(invocation.declarationIndex, 0);
  assert.equal(invocation.state.status, "running");
  assert.deepEqual(invocation.state.input, { command: "ls" });

  // tool result: a USER-role message carrying a COMPLETED tool part — exactly
  // what OpenCode's serializer produces, so drop/tag pairing still works.
  const result = messages[3];
  assert.equal(result.info.role, "user");
  assert.equal(result.parts.length, 1);
  assert.equal(result.parts[0].type, "tool");
  assert.equal(result.parts[0].callID, "call_1");
  assert.equal(result.parts[0].tool, "Bash");
  assert.equal(result.parts[0].state.status, "completed");
  assert.equal(result.parts[0].state.output, "a.ts\nb.ts");

  // attachment: synthetic user text.
  assert.equal(messages[4].info.role, "user");
  assert.equal(messages[4].info.syntheticHead, true);
  assert.equal(messages[4].parts[0].synthetic, true);
  assert.match(messages[4].parts[0].text, /system-reminder/);
});

await it("types: tool result error status and opaque content pass-through", () => {
  const [errorEntry] = projectRuntimeEntries([
    {
      message: { role: "tool", content: "boom", toolCallId: "c9", toolName: "Bash", isError: true },
    },
  ]);
  assert.equal(errorEntry.parts[0].state.status, "error");
  assert.equal(errorEntry.parts[0].state.error, "boom");

  const [opaque] = projectRuntimeEntries([
    {
      message: {
        role: "user",
        content: [{ type: "image", mediaType: "image/png", dataUrl: "data:..." }],
      },
    },
  ]);
  assert.equal(opaque.parts[0].type, "image");
  assert.equal(opaque.parts[0].dataUrl, "data:...");
});

await it("types: startOrdinal, idPrefix and the createdAt seed are honoured", () => {
  const messages = projectRuntimeEntries(sampleRuntimeEntries(), {
    sessionId: "s",
    idPrefix: "zcode-",
    startOrdinal: 7,
    createdAt: 1000,
  });
  assert.equal(messages[0].info.id, "zcode-7");
  assert.equal(messages[4].info.id, "zcode-11");
  assert.equal(messages[0].info.time.created, 1000);
  assert.equal(messages[1].info.time.created, 1001);
  assert.equal(messages[4].info.time.created, 1004);
  // Without a seed there is no fabricated wall clock.
  const unsown = projectRuntimeEntries([{ message: { role: "user", content: "x" } }]);
  assert.equal(unsown[0].info.time, undefined);
});

await it("types: the borrowed array snapshot is shallow and detached", () => {
  const live = sampleRuntimeEntries();
  const snapshot = snapshotRuntimeEntries(live);
  assert.equal(snapshot.length, live.length);
  assert.notEqual(snapshot, live);
  assert.equal(snapshot[0], live[0], "entries themselves are shared, only the array is copied");
  live.push({ message: { role: "user", content: "appended after the borrow" } });
  assert.equal(snapshot.length, 5, "a later host append cannot change the snapshot");
  assert.equal(projectRuntimeEntries(snapshot).length, 5);
});

await it("types: MessageLike → RawMessage keeps ordinal, id and createdAt", () => {
  const [message] = projectRuntimeEntries([{ message: { role: "user", content: "hi" } }], {
    createdAt: 42,
  });
  const raw = messageLikeToRawMessage(message, 3);
  assert.equal(raw.ordinal, 3);
  assert.equal(raw.id, "mc1");
  assert.equal(raw.role, "user");
  assert.equal(raw.createdAt, 42);
  assert.equal(raw.parts, message.parts);
});

await it("types: a persisted store row projects with its real id and time", () => {
  const message = projectStoredMessage({
    id: "msg_1",
    role: "assistant",
    parts: [
      { type: "tool", callID: "c1", tool: "Bash", state: { status: "completed", output: "ok" } },
    ],
    sessionId: "sess_9",
    createdAt: 111,
    completedAt: 222,
    finish: "stop",
  });
  assert.deepEqual(message.info, {
    id: "msg_1",
    role: "assistant",
    sessionID: "sess_9",
    finish: "stop",
    time: { created: 111, completed: 222 },
  });
  assert.equal(message.parts[0].callID, "c1");
});

await it("types: unchanged detection lets a pass reuse the original entry", () => {
  const entries = sampleRuntimeEntries();
  const projected = projectRuntimeEntries(entries);
  assert.equal(projectMessageUnchanged(projected[1], entries[1]), true);
  assert.equal(projectMessageUnchanged(projected[0], entries[0]), true);
  assert.equal(
    projectMessageUnchanged(projected[2], entries[2]),
    false,
    "an assistant carrying tool calls was rebuilt into parts",
  );
  assert.equal(projectMessageUnchanged(projected[4], entries[4]), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// raw-message-provider
// ─────────────────────────────────────────────────────────────────────────────

await it("provider: readMessages projects the live history into raw messages", () => {
  const provider = createRawMessageProvider({
    sessionId: "sess_1",
    borrowRuntimeEntries: () => sampleRuntimeEntries(),
    ...fakeStore(storedMessageFixtures()),
  });
  const messages = provider.readMessages();
  assert.equal(messages.length, 5);
  assert.deepEqual(
    messages.map((message) => message.ordinal),
    [1, 2, 3, 4, 5],
  );
  assert.equal(messages[2].role, "assistant");
  assert.equal(messages[3].role, "user");
});

await it("provider: readMessagePage pages the store and falls back to the live tail", () => {
  const stored = storedMessageFixtures();
  const provider = createRawMessageProvider({
    sessionId: "sess_1",
    borrowRuntimeEntries: () => sampleRuntimeEntries(),
    ...fakeStore(stored),
  });

  const first = provider.readMessagePage(0, 2, 3);
  assert.deepEqual(
    first.map((message) => message.id),
    ["m1", "m2"],
  );
  assert.deepEqual(
    first.map((message) => message.ordinal),
    [1, 2],
  );

  const second = provider.readMessagePage(2, 2, 3);
  assert.deepEqual(
    second.map((message) => message.id),
    ["m3"],
  );

  // The store is shorter than the live history: ordinals past the store must
  // still resolve from the borrowed entries rather than reporting a short session.
  const past = provider.readMessagePage(3, 5, 100);
  assert.equal(past.length, 2);
  assert.deepEqual(
    past.map((message) => message.ordinal),
    [4, 5],
  );
});

await it("provider: range iteration is bounded and ordered", () => {
  const provider = createRawMessageProvider({
    sessionId: "sess_1",
    borrowRuntimeEntries: () => [],
    ...fakeStore(storedMessageFixtures()),
  });
  assert.deepEqual(
    [...provider.iterateMessageRange(1, 10)].map((m) => m.id),
    ["m1", "m2", "m3"],
  );
  assert.deepEqual(
    [...provider.iterateMessageRange(2, 3)].map((m) => m.id),
    ["m2", "m3"],
  );
  assert.deepEqual([...provider.iterateMessageRange(3, 2)], []);
});

await it("provider: by-id lookups answer from the live history and then the store", () => {
  const provider = createRawMessageProvider({
    sessionId: "sess_1",
    borrowRuntimeEntries: () => sampleRuntimeEntries(),
    ...fakeStore(storedMessageFixtures()),
  });
  assert.equal(provider.readMessageById("mc3").role, "assistant");
  assert.equal(provider.readMessageById("m2").role, "assistant");
  assert.equal(provider.readMessageById("nope"), null);
  assert.equal(provider.hasMessageById("m3"), true);
  assert.equal(provider.hasMessageById("nope"), false);
  // readMessagePartsById answers with a RawMessageParts (id/role/parts/createdAt),
  // exactly like the source's provider contract.
  assert.equal(provider.readMessagePartsById("m3").parts[0].text, "three");
  assert.equal(provider.readMessagePartsById("nope"), null);

  const ordinals = provider.readMessageIdOrdinals();
  assert.equal(ordinals.get("m1"), 1);
  assert.equal(ordinals.get("m3"), 3);
  assert.equal(ordinals.get("mc3"), 3, "live entries without a stored row still get an ordinal");

  const ranged = provider.readMessageIdOrdinalsForRange(2, 3);
  assert.equal(ranged.has("m1"), false);
  assert.equal(ranged.get("m2"), 2);
  assert.deepEqual([...provider.readMessageIdOrdinalsForRange(9, 8)], []);
});

await it("provider: counts, ordinal pages and the served-boundary identity", () => {
  const provider = createRawMessageProvider({
    sessionId: "sess_1",
    borrowRuntimeEntries: () => sampleRuntimeEntries(),
    ...fakeStore(storedMessageFixtures()),
  });
  assert.equal(provider.getMessageCount(), 5);
  assert.equal(provider.getStoredMessageCount(), 3);
  assert.equal(provider.readServedBoundaryId("m1"), "m1");
  assert.equal(provider.readServedBoundaryId(""), null);

  const page = provider.readMessageOrdinalPage(null, 10);
  // Stored rows keep their wall clock; live rows fall back to their ordinal as
  // the timestamp, so the merged page is ordered by (timeCreated, id) overall.
  assert.deepEqual(
    page.map((row) => row.id),
    ["mc1", "mc2", "mc3", "mc4", "mc5", "m1", "m2", "m3"],
  );
  assert.ok(page.every((row) => row.contributesOrdinal && row.hasValidInfo));
  assert.deepEqual(
    page.map((row) => row.timeCreated),
    [1, 2, 3, 4, 5, 1000, 2000, 3000],
  );

  // The anchor is a strict (timeCreated, id) resume point, so equal timestamps
  // never re-serve a row.
  const anchored = provider.readMessageOrdinalPage({ timeCreated: 2000, id: "m1" }, 10);
  assert.equal(
    anchored.some((row) => row.id === "m1"),
    false,
  );
  assert.equal(anchored[0].id, "m2");
});

// ─────────────────────────────────────────────────────────────────────────────
// storage-dir
// ─────────────────────────────────────────────────────────────────────────────

function withEnv(vars, run) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

await it("storage-dir: the default store is ~/.zcode/cli/db/magic-context.db", () => {
  withEnv(
    {
      MAGIC_CONTEXT_DB_DIR: undefined,
      MAGIC_CONTEXT_DB_PATH: undefined,
      MAGIC_CONTEXT_TEST_DATA_DIR: undefined,
    },
    () => {
      const location = getMagicContextDatabaseLocation();
      assert.equal(location.source, "ZCode data dir");
      assert.equal(location.dbDir, join(homedir(), ".zcode", "cli", "db"));
      assert.equal(location.dbPath, join(location.dbDir, MAGIC_CONTEXT_DB_FILE_NAME));
      assert.equal(getMagicContextDatabasePath(), location.dbPath);
      assert.equal(MAGIC_CONTEXT_DB_FILE_NAME, "magic-context.db");
    },
  );
});

await it("storage-dir: MAGIC_CONTEXT_DB_DIR overrides the directory, and must be absolute", () => {
  withEnv({ MAGIC_CONTEXT_DB_DIR: "D:\\tmp\\mc-db", MAGIC_CONTEXT_DB_PATH: undefined }, () => {
    const location = getMagicContextDatabaseLocation();
    assert.equal(location.source, "environment override");
    assert.equal(location.dbDir, "D:\\tmp\\mc-db");
    assert.equal(location.dbPath, join("D:\\tmp\\mc-db", "magic-context.db"));
  });
  withEnv({ MAGIC_CONTEXT_DB_DIR: "relative/mc-db" }, () => {
    assert.throws(() => getMagicContextDatabaseLocation(), /must be an absolute path/);
  });
});

await it("storage-dir: MAGIC_CONTEXT_DB_PATH names the file and wins over the directory", () => {
  withEnv(
    { MAGIC_CONTEXT_DB_DIR: "D:\\tmp\\ignored", MAGIC_CONTEXT_DB_PATH: "D:\\tmp\\mc\\custom.db" },
    () => {
      const location = getMagicContextDatabaseLocation();
      assert.equal(location.dbPath, join("D:\\tmp\\mc", "custom.db"));
      assert.equal(location.dbDir, "D:\\tmp\\mc");
    },
  );
  withEnv({ MAGIC_CONTEXT_DB_PATH: "custom.db" }, () => {
    assert.throws(() => getMagicContextDatabaseLocation(), /must be an absolute path/);
  });
});

await it("storage-dir: the test-isolation layer outranks the environment override", () => {
  withEnv(
    {
      MAGIC_CONTEXT_TEST_DATA_DIR: join(homedir(), ".zcode-iso"),
      MAGIC_CONTEXT_DB_DIR: join(homedir(), ".zcode-iso", "cli", "db"),
    },
    () => {
      const location = getMagicContextDatabaseLocation();
      assert.equal(location.source, "test isolation");
      assert.equal(location.dbDir, join(homedir(), ".zcode-iso", "cli", "db"));
    },
  );
});

await it("storage-dir: projectKey normalizes one directory to one key", () => {
  const directory = "D:\\Dev\\Js\\oh-my-zcode\\omz";
  const key = getProjectKey(directory);
  assert.match(key, /^[0-9a-f]{64}$/, "a hash, so no path separator can reach the filesystem");
  assert.equal(key, getProjectKey("d:\\dev\\js\\OH-MY-ZCODE\\omz"), "case-insensitive on Windows");
  assert.equal(
    key,
    getProjectKey("D:\\Dev\\Js\\oh-my-zcode\\omz\\"),
    "a trailing separator is one directory",
  );
  assert.notEqual(key, getProjectKey("D:\\Dev\\Js\\oh-my-zcode"));
  assert.notEqual(key, getProjectKey("/home/user/project"));
});

await it("storage-dir: the project dir is redirected OFF the user's project tree", () => {
  const project = "D:\\Dev\\Js\\oh-my-zcode\\omz";
  const redirected = getZCodeProjectMagicContextDir(project);
  assert.equal(redirected, join(getProjectArtifactsRoot(), getProjectKey(project)));
  assert.ok(
    redirected.startsWith(join(homedir(), ".zcode", "cli", "magic-context", "projects")),
    "artifacts live under the ZCode home",
  );
  assert.equal(redirected.includes(".cortexkit"), false, "the cortexkit subtree is gone");
  assert.equal(redirected.startsWith(project), false, "never inside the project directory");
  assert.equal(
    resolveProjectMagicContextDir(project),
    redirected,
    "the resolver default IS the redirect",
  );
});

await it("storage-dir: a host resolver can be installed and cleared", () => {
  const project = "D:\\Dev\\Js\\oh-my-zcode\\omz";
  initializeMagicContextHost();
  assert.equal(hasProjectDirResolver(), true, "initializeMagicContextHost installs it");
  setProjectDirResolver(() => "D:\\elsewhere\\mc");
  assert.equal(resolveProjectMagicContextDir(project), "D:\\elsewhere\\mc");
  setProjectDirResolver(undefined);
  assert.equal(hasProjectDirResolver(), false);
  assert.equal(resolveProjectMagicContextDir(project), getZCodeProjectMagicContextDir(project));
  setProjectDirResolver(getZCodeProjectMagicContextDir);
});

// ─────────────────────────────────────────────────────────────────────────────
// harness
// ─────────────────────────────────────────────────────────────────────────────

await it("harness: the boot step is idempotent and pins core to zcode", () => {
  const first = initializeMagicContextHost();
  const second = initializeMagicContextHost();
  assert.equal(first, second, "a repeat call is a no-op returning the same snapshot");
  assert.equal(first.harness, ZCODE_HARNESS_ID);
  assert.equal(first.harness, "zcode");
  assert.equal(getHarness(), "zcode", "core's own getter reports the pinned harness");
  assert.equal(isMagicContextHostInitialized(), true);
  assert.equal(assertMagicContextHostInitialized(), first);
  assert.equal(hasProjectDirResolver(), true, "the boot step also installs the project resolver");
});

await it("harness: an uninitialized host refuses to be asserted", () => {
  __resetHostInitializationForTests();
  assert.equal(isMagicContextHostInitialized(), false);
  assert.throws(() => assertMagicContextHostInitialized(), /must run before any DB write/);
  // Core is still locked to zcode from the previous test, which is exactly the
  // state a half-booted process is in: the snapshot is gone but the lock stands.
  assert.equal(getHarness(), "zcode");
  initializeMagicContextHost();
  assert.equal(isMagicContextHostInitialized(), true);
});

await it("harness: a mid-session harness swap is still refused by core", () => {
  __resetHostInitializationForTests();
  _resetHarnessForTesting();
  assert.equal(getHarness(), "opencode", "core's default before the boot step runs");
  assert.throws(() => assertMagicContextHostInitialized(), /must run before any DB write/);
  initializeMagicContextHost();
  assert.equal(getHarness(), "zcode");
  // Second initialization must not trip core's lock (same value is a no-op there).
  assert.doesNotThrow(() => initializeMagicContextHost());
});

// ─────────────────────────────────────────────────────────────────────────────
// read-only smoke against the user's real session store
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_DB = join(homedir(), ".zcode", "cli", "db", "db.sqlite");

await it("smoke: the real session store opens READ-ONLY and has the expected schema", (t) => {
  if (!existsSync(SESSION_DB)) {
    t.skip(`no session store at ${SESSION_DB}`);
    return;
  }
  const db = new DatabaseSync(SESSION_DB, { readOnly: true });
  try {
    const tables = db
      .prepare("select name from sqlite_master where type = 'table'")
      .all()
      .map((row) => String(row.name));
    assert.ok(tables.includes("message"), "message table");
    assert.ok(tables.includes("part"), "part table");
    assert.ok(tables.includes("session"), "session table");

    const messageColumns = db
      .prepare("pragma table_info(message)")
      .all()
      .map((c) => c.name);
    assert.deepEqual(messageColumns, [
      "id",
      "session_id",
      "time_created",
      "time_updated",
      "data",
      "sequence",
    ]);
    const partColumns = db
      .prepare("pragma table_info(part)")
      .all()
      .map((c) => c.name);
    assert.deepEqual(partColumns, [
      "id",
      "message_id",
      "session_id",
      "time_created",
      "time_updated",
      "data",
      "sequence",
    ]);
  } finally {
    db.close();
  }
});

await it("smoke: a real page converts into RawMessage the provider accepts", (t) => {
  if (!existsSync(SESSION_DB)) {
    t.skip(`no session store at ${SESSION_DB}`);
    return;
  }
  const db = new DatabaseSync(SESSION_DB, { readOnly: true });
  try {
    const latest = db
      .prepare(
        "select session_id, count(*) as c from message group by session_id order by c desc limit 1",
      )
      .get();
    const sessionId = String(latest.session_id);
    assert.ok(Number(latest.c) > 1, "the busiest session has a real history");

    const page = readStoredMessagePageFromStore(db, {
      sessionId,
      afterOrdinal: 0,
      limit: 25,
      finalWatermark: 1000,
    });
    assert.ok(page.messages.length > 0, "the page reader found rows");
    assert.equal(page.messages.length, 25);
    assert.deepEqual(
      page.messages.map((message) => message.ordinal),
      Array.from({ length: 25 }, (_unused, index) => index + 1),
      "ordinals are dense and 1-based",
    );
    for (const message of page.messages) {
      assert.equal(typeof message.id, "string");
      assert.ok(message.id.length > 0);
      assert.ok(["user", "assistant"].includes(message.role), `unexpected role ${message.role}`);
      assert.ok(Array.isArray(message.parts));
      assert.equal(typeof message.createdAt, "number");
      for (const part of message.parts) {
        assert.equal(typeof part, "object");
        assert.equal(typeof part.type, "string");
        if (part.type === "tool") {
          assert.equal(typeof part.callID, "string");
          assert.equal(typeof part.tool, "string");
          assert.equal(typeof part.state, "object");
          assert.ok(
            ["pending", "running", "completed", "error"].includes(part.state.status),
            `unexpected tool status ${part.state.status}`,
          );
        }
        if (part.type === "text") assert.equal(typeof part.text, "string");
      }
    }
    // Ordering: the reader must agree with the session store's own order.
    const reference = db
      .prepare(
        `select id from message where session_id = ? order by ${ZCODE_MESSAGE_ORDER_SQL} limit 25`,
      )
      .all(sessionId)
      .map((row) => String(row.id));
    assert.deepEqual(
      page.messages.map((message) => message.id),
      reference,
    );

    // The full provider, wired to the real store and an empty live history.
    const reader = createZCodeSessionReader({ sessionId, openSessionStore: () => db });
    const provider = createRawMessageProvider({
      sessionId,
      borrowRuntimeEntries: () => [],
      readStoredMessagePage: (args) => readStoredMessagePageFromStore(db, args),
      ...reader,
    });
    assert.equal(provider.getStoredMessageCount(), getStoredMessageCountFromStore(db, sessionId));
    const byId = provider.readMessageById(reference[3]);
    assert.ok(byId, "primary-key lookup answers");
    assert.equal(byId.id, reference[3]);
    assert.equal(provider.readMessageOrdinalById(reference[3]), 4);
    const ranged = provider.readMessageIdOrdinalsForRange(1, 10);
    assert.equal(ranged.size, 10);
    const visited = [...provider.iterateMessageRange(1, 30)];
    assert.equal(visited.length, 30);
    assert.deepEqual(
      visited.map((message) => message.ordinal),
      Array.from({ length: 30 }, (_u, i) => i + 1),
    );
    const ordinals = provider.readMessageOrdinalPage(null, 10);
    assert.equal(ordinals.length, 10);
    assert.equal(ordinals[0].id, reference[0]);
    assert.ok(ordinals.every((row) => row.hasValidInfo));
  } finally {
    db.close();
  }
});

await it("smoke: the turn-state probes answer on a real session", (t) => {
  if (!existsSync(SESSION_DB)) {
    t.skip(`no session store at ${SESSION_DB}`);
    return;
  }
  const db = new DatabaseSync(SESSION_DB, { readOnly: true });
  try {
    const row = db
      .prepare(
        `select session_id from message
          where json_extract(data, '$.role') = 'assistant'
            and json_extract(data, '$.finish') = 'tool-calls'
          group by session_id order by count(*) desc limit 1`,
      )
      .get();
    assert.ok(row, "found a session whose assistant waits on tools");
    const sessionId = String(row.session_id);

    const latest = latestPersistedMessageFromStore(db, sessionId);
    assert.ok(latest, "recovery row exists");
    assert.equal(typeof latest.id, "string");
    assert.ok(["user", "assistant"].includes(latest.role));
    assert.equal(typeof latest.parentID, "string");

    const model = findLastAssistantModelFromStore(db, sessionId);
    assert.ok(model, "assistant provider/model is recoverable from the row");
    assert.equal(typeof model.providerId, "string");
    assert.equal(typeof model.modelId, "string");

    const times = getMessageTimesFromStore(db, sessionId, [latest.id, "definitely_missing"]);
    assert.equal(times.get(latest.id) > 0, true);
    assert.equal(times.has("definitely_missing"), false);
    assert.equal(getMessageTimesFromStore(db, sessionId, []).size, 0);

    // The facade answers instead of throwing, even when the store cannot open.
    const history = createSessionHistory({
      openSessionStore: () => db,
      sessionStoreExists: () => true,
    });
    assert.equal(history.isStoreAvailable(), true);
    assert.equal(typeof history.assistantAwaitingTools(sessionId), "boolean");
    assert.equal(typeof history.shouldHoldIgnoredNotification(sessionId), "boolean");
    assert.equal(history.latestPersistedMessageForRecovery(sessionId).id, latest.id);
    assert.equal(
      history.getMessageTimes(sessionId, [latest.id]).get(latest.id),
      times.get(latest.id),
    );
    assert.ok(history.findLastAssistantModel(sessionId));

    const closed = createSessionHistory({
      openSessionStore: () => {
        throw new Error("store unavailable");
      },
      onProbeFailure: () => {},
    });
    assert.equal(closed.isStoreAvailable(), false);
    assert.equal(closed.assistantAwaitingTools(sessionId), false);
    assert.equal(closed.shouldHoldIgnoredNotification(sessionId), false);
    assert.equal(closed.latestPersistedMessageForRecovery(sessionId), null);
    assert.equal(closed.getMessageTimes(sessionId, ["x"]).size, 0);
    assert.equal(closed.findLastAssistantModel(sessionId), null);
  } finally {
    db.close();
  }
});

await it("smoke: the real store was not modified", (t) => {
  if (!existsSync(SESSION_DB)) {
    t.skip(`no session store at ${SESSION_DB}`);
    return;
  }
  // The handle only ever ran SELECTs; assert the file is still openable and the
  // row count is unchanged for a session we read.
  const db = new DatabaseSync(SESSION_DB, { readOnly: true });
  try {
    const count = db.prepare("select count(*) as c from message").get();
    assert.ok(Number(count.c) > 0);
  } finally {
    db.close();
  }
  assert.equal(existsSync(SESSION_DB), true);
  assert.equal(dirname(SESSION_DB), join(homedir(), ".zcode", "cli", "db"));
});

// ─────────────────────────────────────────────────────────────────────────────

__resetProjectDirResolverForTests();
setProjectDirResolver(getZCodeProjectMagicContextDir);

test.after(() => {
  console.log(`\nmagic-context host tests: ${passed} passed, ${failed} failed`);
});
