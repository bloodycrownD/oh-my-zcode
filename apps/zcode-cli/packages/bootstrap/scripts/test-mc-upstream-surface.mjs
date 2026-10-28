#!/usr/bin/env node
/**
 * magic-context 上游接触面门禁（只减不增）。
 *
 * ============================================================================
 * 这个门禁钉死什么
 * ============================================================================
 *
 * 跟随 ZCode 上游升级时，真正的成本不是「MC 包本身要适配」，而是
 * **我们改动了多少个上游本来就有的文件**——每一个这样的文件都是一处潜在冲突，
 * 且上游恰好也改了它的时候，冲突只能人工逐段解。
 *
 * 所以这个数必须有一道上限，且**只减不增**。
 *
 * 与 `test-magic-context-coupling-budget.mjs`（B 分支未合入）的口径差异，务必分清：
 *   - 那边数的是「宿主 import MC 的**行数**」；
 *   - 这边数的是「**上游既有文件里出现 MC 符号的文件数**」。
 * 后者才是升级冲突面：一个上游文件里加一行注册（不新增 import）也会冲突，
 * 而那行 import 计数捕捉不到；反之 fork 自己的新文件 import MC 一百次也不冲突。
 *
 * ============================================================================
 * 判据
 * ============================================================================
 *
 * 1. 基准树 = `baseline/v3.14.3`（上游快照导入点，已推到 origin，CI 需 fetch-depth: 0）。
 * 2. 候选集 = 「基准树里存在」∧「当前仍被 git 跟踪」的文件（删除的不算）。
 * 3. 污染 = 候选集里文件内容命中 MC 符号（见 SYMBOL_RE）。**注释也算**：
 *    上游改到同一段注释一样冲突，宁严不松。
 * 4. 与基线清单 `mc-upstream-surface.baseline.json` 比对：
 *      - 出现清单之外的文件 → **红**（新增污染）
 *      - 清单内文件消失 → 绿，但会提示把基线降下来（只减不增）
 * 5. 有旧、无新 → 绿。
 *
 * ============================================================================
 * 用法
 * ============================================================================
 *
 *   node scripts/test-mc-upstream-surface.mjs            # 校验（默认）
 *   node scripts/test-mc-upstream-surface.mjs --update    # 重写基线（仅在合法降低后）
 *
 * 环境无 git 或基准 tag 缺失时**显式 skip**（TAP `# SKIP`），不静默通过。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const BASELINE_REF = "baseline/v3.14.3";
const BASELINE_FILE = join(REPO_ROOT, "apps/zcode-cli/packages/bootstrap/scripts/mc-upstream-surface.baseline.json");

/** 代码与契约文件才参与扫描；文档/资源不计（它们不进 merge 冲突面）。 */
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".json"]);

/** MC 符号。含注释——见文件头判据 3。 */
const SYMBOL_RE = /@zcode\/magic-context|MagicContext|magicContext|magic-context/;

const UPDATE = process.argv.includes("--update");

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function listTree(ref) {
  const out = git(["ls-tree", "-r", "--name-only", ref]);
  return out.split(/\r?\n/).filter(Boolean);
}

function listTracked() {
  const out = git(["ls-files"]);
  return new Set(out.split(/\r?\n/).filter(Boolean));
}

function hasCodeExtension(file) {
  const dot = file.lastIndexOf(".");
  return dot >= 0 && CODE_EXTENSIONS.has(file.slice(dot));
}

function scan() {
  const upstream = listTree(BASELINE_REF).filter(hasCodeExtension);
  const tracked = listTracked();
  const touching = [];

  for (const file of upstream) {
    if (!tracked.has(file)) continue;
    let content;
    try {
      content = readFileSync(join(REPO_ROOT, file), "utf8");
    } catch {
      continue;
    }
    if (SYMBOL_RE.test(content)) touching.push(file);
  }

  touching.sort();
  return touching;
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  } catch {
    return null;
  }
}

test("magic-context 上游接触面只减不增", (t) => {
  let touching;
  try {
    touching = scan();
  } catch (error) {
    t.skip(`${BASELINE_REF} 不可用（浅克隆或缺 tag，CI 需 fetch-depth: 0）：${error.message.split("\n")[0]}`);
    return;
  }

  if (UPDATE) {
    writeFileSync(
      BASELINE_FILE,
      `${JSON.stringify({ baselineRef: BASELINE_REF, limit: touching.length, files: touching }, null, 2)}\n`,
      "utf8",
    );
    console.log(`基线已重写：${touching.length} 个文件 → ${BASELINE_FILE}`);
    return;
  }

  const baseline = readBaseline();
  assert.ok(baseline, `缺少基线文件 ${BASELINE_FILE}；先跑 --update`);

  const known = new Set(baseline.files);
  const current = new Set(touching);

  const added = touching.filter((file) => !known.has(file));
  const removed = baseline.files.filter((file) => !current.has(file));

  if (added.length > 0) {
    assert.fail(
      [
        `新增 ${added.length} 个上游文件出现 magic-context 符号（上限 ${baseline.limit}，当前 ${touching.length}）：`,
        ...added.map((file) => `  + ${file}`),
        "",
        "处理方式（二选一）：",
        "  1. 优先：把那处接线搬到 fork 自己的文件里（例如 bootstrap/src/app/magic-context/**、core/src/**/magic-context-*.ts），",
        "     上游文件只留一行调用或一个可选字段——这样它就不会再是冲突面；",
        "  2. 确实必须改上游文件：接受上限上涨，改本文件的 baseline（limit + 新文件）并在提交信息里写明理由。",
        "",
        "基线口径：数的是「上游既有文件里出现 MC 符号的文件数」，不是 import 次数。",
      ].join("\n"),
    );
  }

  assert.ok(
    touching.length <= baseline.limit,
    `上游接触面 ${touching.length} 超过上限 ${baseline.limit}（清单未变但总量超了，请检查基线文件）`,
  );

  if (removed.length > 0) {
    console.log(
      [
        `接触面已下降 ${removed.length} 个（${baseline.limit} → ${touching.length}）。`,
        "请跑一次 `--update` 把基线降下来（只减不增，降了就不要涨回去）：",
        ...removed.map((file) => `  - ${file}`),
      ].join("\n"),
    );
  }

  console.log(`上游接触面：${touching.length} / 上限 ${baseline.limit}（基准 ${baseline.baselineRef}）`);
});
