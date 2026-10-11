#!/usr/bin/env node
/**
 * Step 15 / T-MU1 + T-MU2（bugfix-batch-20261011，phase-mc-prompt-surface）：
 * mural 渲染链验收 —— D5 真身移植 + vision 判定源换 supportsImage。
 *
 * 钉死什么：
 *   T-MU1a — `modelKeyAcceptsImages` 的判定源：宿主注入的静态目录 probe
 *            （ModelInputFormatData.supportsImage 的等价面，包内只认注入值）。
 *            vision 模型 true / 非 vision false / 无键 false / 未注入 false；
 *            pi 原生前缀（openai-codex/…）先规范化再交给 probe（与上游
 *            「两个 harness 共用一个 vision 门」同向）。
 *   T-MU1b — **渲染真触发**：vision + enabled + cue 池过覆盖门时，
 *            `resolveMuralWire` 返回真 PNG（data URL 前缀 + PNG magic +
 *            IHDR 尺寸与 result.width/height 一致）、contentHash 为 64 hex，
 *            且 `mural_manifest` 落一行（model="deterministic"）。这是
 *            「壳缝时代恒 supportsVision:false」的直接反证。
 *   T-MU1c — 变更检测：同一 cue 池二次调用 `rerendered:false` 且 dataUrl 不变
 *            （文本哈希命中，跳过重编码）；cue 内容变化 → 新哈希 + 新 PNG。
 *   T-MU1d — 禁用（enabled=false）/ 无 vision / 未注入 probe / 无 modelKey
 *            四种情形**静默不渲染**：无 dataUrl，且 mural_manifest 一行都不写
 *            （证明渲染路径根本没跑，不是跑了再丢）。
 *   T-MU2  — 覆盖门：cued 数量 <15 且覆盖率 <50% 时 `hasMural:false` 且带
 *            skipReason；零 active memory 时 skipReason="no active memories"。
 *   T-MU2b — overflow 口径：budget=1 时预算trim 选中 ~0 条 ⇒ 全部进 overflow，
 *            40 条 cue 全渲染（证明壁画展示的正是 m0 注入丢掉的那批）。
 *   MU-X1  — 渲染确定性：同一 entry 列表两次 `renderMural` 逐字节相同
 *            （PNG 字节稳定性是「文本哈希 → 复用已存 PNG」这条快路径的前提）。
 *   MU-X2  — `resolveMural` 排序：category 序 → importance DESC → id ASC，
 *            stale cue（内容改过）被排除。
 *   MU-X3  — memory barrel 纪律：`memory/index.js` 出 `getMemoriesByProject`
 *            （resolve-mural 的闭包符号）且**不出** N1 embedding 面
 *            （embedding-cache / storage-memory-embeddings / embedding-failure）。
 *
 * 隔离：MAGIC_CONTEXT_DB_DIR / MAGIC_CONTEXT_LOG_PATH 显式指 OS 临时目录
 * （mkdtempSync(tmpdir())），绝不写真实 ~/.omz / ~/.zcode；进程退出即清理。
 *
 * dist 前置：从 dist/ 加载被测模块（同 test-memory-promotion.mjs 模式）；运行前
 * 必须 `pnpm --dir apps/zcode-cli/packages/magic-context build`（= tsc），dist
 * 缺失即快速失败。Requires Node >= 24 (node:sqlite)。Exits 0 全绿，1 否则。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const PKG_ROOT = fileURLToPath(new URL("../", import.meta.url));
const load = (rel) => import(pathToFileURL(join(PKG_ROOT, "dist", rel)).href);

// ── dist 前置：被测模块必须先构建 ────────────────────────────────────────
for (const rel of [
  "core/features/magic-context/mural/render-trigger.js",
  "core/features/magic-context/mural/resolve-mural.js",
  "core/features/magic-context/mural/render-mural.js",
  "core/features/magic-context/mural/storage-mural.js",
  "core/features/magic-context/mural/storage-mural-cues.js",
  "core/features/magic-context/memory/index.js",
  "core/features/magic-context/memory/storage-memory.js",
]) {
  try {
    statSync(join(PKG_ROOT, "dist", rel));
  } catch {
    throw new Error(
      `dist 前置缺失 ${rel} —— 先运行 pnpm --dir apps/zcode-cli/packages/magic-context build`,
    );
  }
}

// ── 隔离：DB 与日志都落在 OS 临时目录 ───────────────────────────────────
const dbDir = mkdtempSync(join(tmpdir(), "mc-mural-db-"));
process.env.MAGIC_CONTEXT_DB_DIR = dbDir;
process.env.MAGIC_CONTEXT_LOG_PATH = join(dbDir, "magic-context.log");

const { initializeMagicContextHost } = await load("host/harness.js");
initializeMagicContextHost();

const storage = await load("core/features/magic-context/storage.js");
const storageMemory = await load("core/features/magic-context/memory/storage-memory.js");
const muralCues = await load("core/features/magic-context/mural/storage-mural-cues.js");
const renderTrigger = await load("core/features/magic-context/mural/render-trigger.js");
const resolveMuralModule = await load("core/features/magic-context/mural/resolve-mural.js");
const renderMuralModule = await load("core/features/magic-context/mural/render-mural.js");
const storageMural = await load("core/features/magic-context/mural/storage-mural.js");
const memoryBarrel = await load("core/features/magic-context/memory/index.js");

const db = storage.openDatabase();
if (!db) throw new Error("openDatabase() failed — MAGIC_CONTEXT_DB_DIR 未生效？");

process.on("exit", () => {
  try {
    storage.closeDatabase();
  } catch {
    // A failed close must not mask the original failure.
  }
  try {
    rmSync(dbDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Windows EBUSY on a still-open handle is not a test failure.
  }
});

// ── 共享装置 ────────────────────────────────────────────────────────────

/** 覆盖门要 15 条 cued —— 40 条 ARCHITECTURE 记忆 + 40 条 hash-current cue。 */
const PROJECT = "git:mural-test";
const SEED_COUNT = 40;

function seedCuedMemories(count = SEED_COUNT, projectPath = PROJECT) {
  const ids = [];
  for (let index = 0; index < count; index++) {
    const content = `Architecture fact ${index}: source files and nested control flow are preserved.`;
    const memory = storageMemory.insertMemory(db, {
      projectPath,
      category: "ARCHITECTURE",
      content,
      sourceSessionId: "test",
    });
    storageMemory.setMemoryClassification(db, memory.id, { importance: index % 100 });
    muralCues.setMuralCue(
      db,
      projectPath,
      memory.id,
      `Fact ${index}: preserve the ordered control flow and Unicode α.`,
      muralCues.computeCueContentHash(content),
    );
    ids.push(memory.id);
  }
  return ids;
}

/** 从 data URL 解出 PNG 字节 + IHDR 尺寸。 */
function decodePng(dataUrl) {
  assert.ok(dataUrl.startsWith("data:image/png;base64,"), "dataUrl 必须是 PNG data URL");
  const bytes = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  assert.deepEqual([...bytes.subarray(0, 8)], signature, "PNG magic 不符——渲染路径没有产出真 PNG");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return { bytes, width, height };
}

const VISION_MODEL = "anthropic/claude-sonnet-4-5";
const NON_VISION_MODEL = "anthropic/claude-3-haiku";

/**
 * 宿主注入的静态目录 probe 等价面：只有 VISION_MODEL 返回 true。
 * （真宿主查 provider Registry 的 `inputFormat.supportsImage`；包内只认注入值。）
 */
function installVisionProbe(visionModel = VISION_MODEL) {
  renderTrigger.setMuralVisionProbe((modelKey) => modelKey === visionModel);
}

test("T-MU1a supportsImage 判定源：vision 真值 / 非 vision / 无键 / 未注入四态", () => {
  installVisionProbe();
  assert.equal(renderTrigger.modelKeyAcceptsImages(VISION_MODEL), true);
  assert.equal(renderTrigger.modelKeyAcceptsImages(NON_VISION_MODEL), false);
  assert.equal(renderTrigger.modelKeyAcceptsImages(undefined), false);
  // pi 原生前缀先规范化：probe 收到的必须是 canonical 键。
  const seen = [];
  renderTrigger.setMuralVisionProbe((modelKey) => {
    seen.push(modelKey);
    return modelKey === "openai/gpt-5";
  });
  assert.equal(renderTrigger.modelKeyAcceptsImages("openai-codex/gpt-5"), true);
  assert.deepEqual(seen, ["openai/gpt-5"]);
  // 未注入（清空）= 未知能力 = 不出图（上游 fail-closed 同向）。
  renderTrigger.setMuralVisionProbe(undefined);
  assert.equal(renderTrigger.modelKeyAcceptsImages(VISION_MODEL), false);
});

test("T-MU1b vision + enabled + cue 池 ⇒ 真渲染触发（PNG + manifest 落行）", () => {
  seedCuedMemories();
  installVisionProbe();
  const before = storageMural.getMural(db, PROJECT);
  assert.equal(before, null, "fixture 前 mural_manifest 应为空");

  const wire = renderTrigger.resolveMuralWire(db, PROJECT, VISION_MODEL, true, /* budget */ 1);
  assert.equal(wire.enabled, true);
  assert.equal(wire.supportsVision, true);
  assert.ok(typeof wire.dataUrl === "string" && wire.dataUrl.length > 0, "缺 dataUrl");
  assert.match(wire.contentHash ?? "", /^[0-9a-f]{64}$/, "contentHash 必须是 sha256 hex");

  const png = decodePng(wire.dataUrl);
  const stored = storageMural.getMural(db, PROJECT);
  assert.ok(stored, "渲染后 mural_manifest 必须落一行");
  assert.equal(stored.model, "deterministic");
  assert.equal(stored.contentHash, wire.contentHash);
  assert.equal(stored.width, png.width);
  assert.equal(stored.height, png.height);
  assert.deepEqual(
    [...stored.image.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    "落库的 image 必须是同一枚 PNG",
  );
  assert.equal(stored.memoryIds.length, SEED_COUNT, "budget=1 时 overflow 应含全部 40 条");
});

test("T-MU1c 变更检测：未变 rerendered=false 同字节；cue 变 ⇒ 新哈希新 PNG", () => {
  installVisionProbe();
  // 上一个用例已经渲染过同一池子（rerendered=false 的快路径）。先动一条 cue
  // 保证「必渲染」，再验同池不变，最后再动一条 cue 验重渲染。
  const changeCue = (cue) => {
    const row = db
      .prepare("SELECT id, content FROM memories WHERE project_path = ? ORDER BY id LIMIT 1")
      .get(PROJECT);
    muralCues.setMuralCue(db, PROJECT, row.id, cue, muralCues.computeCueContentHash(row.content));
  };
  changeCue("T-MU1c first revision cue");
  const first = renderTrigger.ensureMuralRendered(db, PROJECT, 1);
  assert.equal(first.rerendered, true, "cue 变化必须重渲染");

  const second = renderTrigger.ensureMuralRendered(db, PROJECT, 1);
  assert.equal(second.rerendered, false, "同一 cue 池不得重编码");
  assert.equal(second.dataUrl, first.dataUrl, "未变时 dataUrl 必须逐字节一致");

  changeCue("T-MU1c second revision cue with different words");
  const third = renderTrigger.ensureMuralRendered(db, PROJECT, 1);
  assert.equal(third.rerendered, true, "cue 再变化必须重渲染");
  assert.notEqual(third.contentHash, first.contentHash);
  assert.notEqual(third.dataUrl, first.dataUrl);
});

test("T-MU1d 禁用 / 无 vision / 未注入 / 无 modelKey：静默不渲染（manifest 不写）", () => {
  // 换一个从没渲染过的项目，四种情形一一验。
  const other = "git:mural-silent";
  seedCuedMemories(20, other);

  installVisionProbe();
  const disabled = renderTrigger.resolveMuralWire(db, other, VISION_MODEL, false, 1);
  assert.deepEqual(disabled, { enabled: false, supportsVision: false });
  assert.equal(storageMural.getMural(db, other), null, "enabled=false 不得渲染");

  // probe 仍认 VISION_MODEL，但**本轮的 modelKey 是非 vision 模型**——门必须拦下。
  const noVision = renderTrigger.resolveMuralWire(db, other, NON_VISION_MODEL, true, 1);
  assert.deepEqual(noVision, { enabled: true, supportsVision: false });
  assert.equal(storageMural.getMural(db, other), null, "非 vision 模型不得渲染");

  renderTrigger.setMuralVisionProbe(undefined);
  const noProbe = renderTrigger.resolveMuralWire(db, other, VISION_MODEL, true, 1);
  assert.deepEqual(noProbe, { enabled: true, supportsVision: false });
  assert.equal(storageMural.getMural(db, other), null, "未注入 probe 不得渲染");

  installVisionProbe();
  const noKey = renderTrigger.resolveMuralWire(db, other, undefined, true, 1);
  assert.deepEqual(noKey, { enabled: true, supportsVision: false });
  assert.equal(storageMural.getMural(db, other), null, "无 modelKey 不得渲染");

  const noProject = renderTrigger.resolveMuralWire(db, undefined, VISION_MODEL, true, 1);
  assert.deepEqual(noProject, { enabled: true, supportsVision: false });
});

test("T-MU2 覆盖门：cued 不足 ⇒ hasMural:false + skipReason（不抛错）", () => {
  const sparse = "git:mural-sparse";
  // 40 条 active，但只有 3 条带 hash-current cue：<15 且覆盖率 3/40 < 50%。
  const ids = seedCuedMemories(40, sparse);
  for (const id of ids.slice(3)) {
    muralCues.setMuralCue(db, sparse, id, "x", "stale-hash-not-matching-content");
  }
  installVisionProbe();
  const result = renderTrigger.ensureMuralRendered(db, sparse, 1);
  assert.equal(result.hasMural, false);
  assert.equal(result.rerendered, false);
  assert.match(result.skipReason ?? "", /3\/40/, "skipReason 必须说明覆盖度量");
  assert.equal(storageMural.getMural(db, sparse), null, "覆盖门未过不得写 manifest");

  const empty = renderTrigger.ensureMuralRendered(db, "git:mural-empty", 1);
  assert.equal(empty.hasMural, false);
  assert.equal(empty.skipReason, "no active memories");
});

test("MU-X1 渲染确定性：同一 entry 列表两次 renderMural 逐字节相同", () => {
  const entries = [
    {
      id: 1,
      category: "PROJECT_RULES",
      importance: 90,
      cue: "deterministic render keeps bytes stable",
    },
    { id: 2, category: "ARCHITECTURE", importance: 40, cue: "category bands order entries" },
  ];
  const first = renderMuralModule.renderMural(entries);
  const second = renderMuralModule.renderMural(entries);
  assert.equal(Buffer.from(first.png).equals(Buffer.from(second.png)), true);
  assert.equal(first.dataUrl, second.dataUrl);
  assert.equal(first.sha256Input, second.sha256Input);
  decodePng(first.dataUrl);
});

test("MU-X2 resolveMural 排序与 stale cue 排除", () => {
  const ordered = "git:mural-order";
  const ids = [];
  for (let index = 0; index < 4; index++) {
    const content = `Ordered fact ${index}.`;
    const memory = storageMemory.insertMemory(db, {
      projectPath: ordered,
      category: index % 2 === 0 ? "PROJECT_RULES" : "ARCHITECTURE",
      content,
      sourceSessionId: "test",
    });
    storageMemory.setMemoryClassification(db, memory.id, { importance: index * 10 });
    muralCues.setMuralCue(
      db,
      ordered,
      memory.id,
      `cue ${index}`,
      muralCues.computeCueContentHash(content),
    );
    ids.push(memory.id);
  }
  // 末条改内容不改 cue ⇒ hash 失配 ⇒ 必须被排除。
  db.prepare("UPDATE memories SET content = ? WHERE id = ?").run("Ordered fact 3 edited.", ids[3]);

  const entries = resolveMuralModule.resolveMural(db, ordered, 1);
  // PROJECT_RULES 带（id[0] imp0 / id[2] imp20）→ importance DESC：20 在前；
  // 随后 ARCHITECTURE 带（id[1] imp10）；id[3]（stale cue）整体排除。
  assert.deepEqual(
    entries.map((entry) => entry.id),
    [ids[2], ids[0], ids[1]],
    "category 序 → importance DESC → id ASC；stale cue 排除",
  );
  const coverage = resolveMuralModule.getMuralCoverage(db, ordered);
  assert.equal(coverage.activeMemoryCount, 4);
  assert.equal(coverage.cuedMemoryCount, 3, "stale cue 不计入覆盖");
});

test("MU-X3 memory barrel：闭包符号出、N1 embedding 面不出", () => {
  // resolve-mural 的导入闭包：getMemoriesByProject 必须经 barrel 可达。
  assert.equal(typeof memoryBarrel.getMemoriesByProject, "function");
  assert.equal(typeof memoryBarrel.promoteSessionFactsDurable, "function");
  assert.equal(typeof memoryBarrel.computeNormalizedHash, "function");
  // N1 embedding 面不得经 barrel 外泄（embedding 运行期终局不做）。
  for (const forbidden of [
    "loadAllEmbeddings",
    "saveEmbeddingIfHashMatches",
    "formatSynapseLaneDescriptor",
    "describeShadowBackfillWriteRefusal",
    "embedTextForProject",
  ]) {
    assert.equal(forbidden in memoryBarrel, false, `${forbidden} 不得出现在 memory barrel`);
  }
});
