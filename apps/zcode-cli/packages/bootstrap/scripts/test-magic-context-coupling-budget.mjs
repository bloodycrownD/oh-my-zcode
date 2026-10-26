#!/usr/bin/env node
/**
 * magic-context-decoupling / phase-upgrade-surface / Step 15 — **宿主侧 MC 耦合散点预算**（IM7）。
 *
 * ============================================================================
 * 这个门禁要钉死什么
 * ============================================================================
 *
 * 「升级 magic-context 要看多少个接触点」是一个**会无声增长**的数：每加一处
 * `import type` / 窄子路径 / 调用期 `await import`，都能单独通过评审（每一处都理由充分），
 * 但下一次从 `.reference/magic-context` 重放上游时，要逐个判定的人工面就多一格。
 * 所以这个数必须有一道上限，且**只减不增**。
 *
 * 口径按 IM7 写死（不要在这里发明更聪明的统计）：
 *
 *   1. **所有导入行都算**——值导入、`import type`、`export … from`、
 *      `await import(…)`、`typeof import(…)`、`require(…)`，以及**窄子路径**
 *      （`@zcode/magic-context/host/config/schema` 等）。判据是「跟随上游升级要看几个
 *      接触点」，类型导入与窄子路径同样要跟着上游改，因此一视同仁。
 *   2. **按宿主包 + 面（src / scripts）分列**，每格与总数**分别**设上限。分列的意义是
 *      防止「删掉别处两处、在这里加三处」仍绿——那是净增长，不是「只减不增」。
 *      文件数**不计**：`app/magic-context/` 拆成几个文件是组织决定，不是行为契约。
 *   3. **MC 包自己不算**（`apps/zcode-cli/packages/magic-context/**` 是包内实现，
 *      它 import 自己不构成宿主耦合）。`docs/**` 也不在扫描面内。
 *
 * ============================================================================
 * 不要与口径③混算（spec「模块数口径（三段，互不混算）」）
 * ============================================================================
 *
 *   - **本脚本（IM7）**：有非零上限，问「升级时要看多少处」。
 *   - **口径③**（跨动态边界的静态运行时值导入 = 0）：恒为 0，问「关闭态会不会被一条
 *     静态边拉进 MC」。它由 `test-magic-context-zero-load.mjs` **动态证明**（子进程 +
 *     resolve hook 数真实解析），本脚本不重复实现第二份静态近似——两份判据会漂移。
 *     本脚本只对 IM4 单列的**核心例外**（core 的 ctx 工具调用期 `await import`）单独
 *     记数，因为那是 spec 明确要求「单列预算，不得混算」的那一类。
 *
 * ============================================================================
 * 上限取值纪律
 * ============================================================================
 *
 * 每个上限 = 本 spec 落地后的**实测值**（不是估数）。改上限只有两种正当理由：
 *
 *   a. 上游新增/删除真的需要宿主多接/少接一处 → 同批更新 `UPSTREAM-SYNC.md` 第 3 节
 *      的偏离点登记（rebase 点）与本文件的上限，并在提交信息里写明；
 *   b. 宿主侧收口（把散点收进 `app/magic-context/**`）→ 上限**跟着降**，本脚本变绿
 *      的同时预算更紧；只降不升，降了就不要再涨回去。
 *
 * 覆盖边界（与全仓源码形状守卫同口径）：只认**字面量**说明符 + 剥注释后的源码。
 * `const P = "@zcode/" + "magic-context"` 这类拼接、以及跨文件的再导出链不在此列，
 * 靠评审兜住（若将来确实需要，先改 spec 的口径，不要偷偷加 AST）。
 *
 * 运行：`pnpm --dir apps/zcode-cli/packages/bootstrap exec node --test scripts/test-magic-context-coupling-budget.mjs`
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

/** 扫描根：与 `test-magic-context-gate.mjs` 同一组（宿主代码全在这三棵树下）。 */
const SCAN_ROOTS = ["apps", "packages", "scripts"].map((dir) => join(REPO_ROOT, dir));
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"]);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".turbo",
  ".next",
  ".reference",
  ".zcode",
  "out",
]);

/** MC 包自己：它 import 自己不构成宿主耦合，整棵排除。 */
const MC_PACKAGE_PREFIX = `apps${sep}zcode-cli${sep}packages${sep}magic-context${sep}`;

/**
 * 剥注释后再数（与 `test-magic-context-gate.mjs` / `test-magic-context-config-narrow.mjs`
 * 的 `stripComments` 逐字同款）。本仓库的 FORK 注释里大量出现 `@zcode/magic-context`
 * 字面量——不剥注释，「写了句注释」就会被算成一处耦合点。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * 字面量说明符的**所有**形态（与 `test-magic-context-config-narrow.mjs` 的
 * `SPECIFIER_PATTERNS` 同款，ZL-3 教训：正则枚举式守卫会漏 `import x from` /
 * `export … from` / `import "x"` 三类）。
 *
 *   `from "x"`      → import / import type / export … from / export * as ns from
 *   `import("x")`   → 动态 import（含 await / typeof import）
 *   `require("x")`  → CommonJS / TS 的 `import x = require("x")`
 *   `import "x"`    → 副作用导入
 */
const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\b(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]/g,
  /\bimport\s*["']([^"']+)["']/g,
];

const MC_SPECIFIER = "@zcode/magic-context";

/** 一条说明符是否指向 MC 包（含全部窄子路径；正则口径 `^@zcode/magic-context(/|$)`）。 */
function isMagicContextSpecifier(specifier) {
  return specifier === MC_SPECIFIER || specifier.startsWith(`${MC_SPECIFIER}/`);
}

/**
 * 扫描面 = **git 跟踪的源文件**，不是工作树里的所有文件。
 *
 * 为什么必须这样（2026-10-26 实测）：本守卫原先走 `readdirSync` 遍历工作树，于是在
 * **主检出目录**里扫到了 `packages/desktop/bundled-agents/**`（`.gitignore:12` 的构建
 * 产物）与 `packages/desktop/mock-cdn/releases/**` 里的 minified `zcode.cjs`，一次报出
 * **84 处假散点**、把 `packages/other` 这一格从 0 顶到 84 并让门禁变红；而同一份提交在
 * 干净的 worktree 里（那些产物不存在）是绿的。**同一棵代码树换个检出状态就换结论**，
 * 这样的门禁不成立。
 *
 * 判据换成「git 跟踪的文件」后：构建产物、备份、本地 out 目录一律不在扫描面内，结论
 * 只取决于提交内容。代价是新建文件必须先 `git add` 才进扫描面——这是有意写死的契约
 * （未 add 的文件本来也提交不了），下面「扫描面自检」还额外断言「扫描面里没有 minified
 * 文件」，产物若哪天被跟踪进来同样会被这一条抓住。
 */
function listTrackedSourceFiles() {
  const output = execFileSync("git", ["ls-files", "-z", "--", "apps", "packages", "scripts"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.split("/").join(sep))
    .filter((entry) => {
      if (entry.split(sep).some((segment) => SKIP_DIRS.has(segment))) return false;
      const dot = entry.lastIndexOf(".");
      return dot >= 0 && SCAN_EXTENSIONS.has(entry.slice(dot));
    });
}

/**
 * minified / 单行生成物判据。源码不会出现超长单行；一旦出现，说明那是**生成物**而不是
 * 手写源码——它不参与本预算（里面的字符串由生成器产出，改的是生成器，不是这一行）。
 *
 * 本仓确有这种被跟踪的生成文件（`core/src/tool/handlers/generated/bash-command-registry.ts`，
 * 1.9MB / 10 行 / 单行 190 万字符），所以这里不能断言「一个都没有」；改为断言
 * 「被跳过的文件必须在路径上自报是生成物」，这样真正该抓的形态（构建产物悄悄进了 src/）
 * 仍然会红。
 */
const MINIFIED_LINE_THRESHOLD = 5000;

function isProbablyMinified(source) {
  let longest = 0;
  for (const line of source.split("\n")) {
    if (line.length > longest) longest = line.length;
    if (longest > MINIFIED_LINE_THRESHOLD) return true;
  }
  return false;
}

/** 「路径上自报是生成物」：`…/generated/…`、`….generated.ts`、`….min.js`。 */
function hasGeneratedMarker(relativePath) {
  return (
    /(^|\/)(generated|__generated__)\//.test(relativePath) ||
    /\.generated\.[cm]?[jt]sx?$/.test(relativePath) ||
    /\.min\.[cm]?js$/.test(relativePath)
  );
}


/**
 * 分列键：`<宿主包>/<面>`。面只有两种——`src`（生产代码）与 `scripts`（测试/脚本）。
 * 判法按路径段而不是正则猜：`…/packages/<pkg>/src/…` 或 `…/packages/<pkg>/scripts/…`；
 * 都不匹配的（如仓库根的 `scripts/*.mjs`）归到 `<顶层目录>/other`，同样是独立一格。
 */
function bucketOf(relativePath) {
  const segments = relativePath.split(sep);
  const srcIndex = segments.indexOf("src");
  const scriptsIndex = segments.indexOf("scripts");
  const surface = srcIndex >= 0 ? "src" : scriptsIndex >= 0 ? "scripts" : "other";
  const anchor = surface === "src" ? srcIndex : surface === "scripts" ? scriptsIndex : -1;
  const owner = anchor > 0 ? segments[anchor - 1] : segments[0];
  return `${owner}/${surface}`;
}

/** 一次性收集全仓的 MC 说明符命中（保留文件与说明符，便于失败时逐条打印）。 */
function collectHits() {
  const hits = [];
  const unmarkedGeneratedFiles = [];
  let scannedFiles = 0;
  const missingRoots = [];
  const presentRoots = [];
  for (const root of SCAN_ROOTS) {
    let isDirectory = false;
    try {
      isDirectory = statSync(root).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      missingRoots.push(root);
      continue;
    }
    presentRoots.push(root);
  }
  for (const relativePath of listTrackedSourceFiles()) {
    if (relativePath.startsWith(MC_PACKAGE_PREFIX)) continue;
    const rawSource = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    if (isProbablyMinified(rawSource)) {
      const normalized = relativePath.split(sep).join("/");
      if (!hasGeneratedMarker(normalized)) {
        unmarkedGeneratedFiles.push(normalized);
      }
      continue;
    }
    scannedFiles += 1;
    const source = stripComments(rawSource);
    for (const pattern of SPECIFIER_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        if (!isMagicContextSpecifier(match[1])) continue;
        hits.push({
          file: relativePath.split(sep).join("/"),
          specifier: match[1],
          bucket: bucketOf(relativePath),
        });
      }
    }
  }
  return { hits, scannedFiles, presentRoots, missingRoots, unmarkedGeneratedFiles };
}

const SCAN = collectHits();

/**
 * 分列上限 = **实测值**（含窄子路径、类型导入、动态导入；见文件头口径）。
 * 每一格都是 `count <= limit`，所以任何一格新增就红；跨格挪动不算净减。
 */
const BUCKET_LIMITS = {
  "adapters/scripts": 2, // test-magic-context-domain.mjs 两处 await import（直测包行为）
  "adapters/src": 1, // config/schema.ts 的窄子路径（W1）
  "bootstrap/scripts": 14, // 13 个 MC 行为测试的 barrel 加载 + test-e2e-live-all 的预载
  "bootstrap/src": 25, // 装配目录 6 文件 + 3 个装配单文件 + ctx-commands 10 + 协议 handler 6
  "cli/scripts": 1, // unplug 脚本的规则串（窄子路径锚点）
  "core/scripts": 3, // 三个 ctx 工具/分档测试的直测加载
  "core/src": 6, // ctx-context / ctx-memory / ctx-search 各 2（typeof import + 调用期 await import）
};

/**
 * 总数（= 各格之和）只作为诊断打印，**不设独立断言**：任何增长都会先在它所在的那一格
 * 撞上上限，总数断言永远不可能单独变红——一条「变异下不会红」的断言就是死断言。
 * 预算的判据只有一条：逐格 `count <= limit`（默认 0，所以新出现的包/面一律红）。
 */

/** 至少扫到这么多文件才算真的扫了全仓（本仓实测 4000+，M0 口径同款防「零扫描通过」）。 */
const MIN_SCANNED_FILES = 1000;

/**
 * 已知锚点：任何一条不在命中清单里，说明扫描面或收集器已跑偏——「预算没超」可能只是
 * 「什么都没扫到」。这四条覆盖四种形态（值导入 / 窄子路径 / 类型导入 / 调用期动态 import）。
 */
const ANCHOR_FILES = [
  "apps/zcode-cli/packages/bootstrap/src/app/magic-context/assembly.ts",
  "apps/zcode-cli/packages/adapters/src/config/schema.ts",
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/magic-context-memories.ts",
  "apps/zcode-cli/packages/core/src/tool/handlers/ctx-context.ts",
];

/** 逐格计数（诊断表与断言共用同一份数据，避免两套口径）。 */
function countByBucket() {
  const counts = new Map();
  for (const hit of SCAN.hits) counts.set(hit.bucket, (counts.get(hit.bucket) ?? 0) + 1);
  return counts;
}

test("扫描面自检：三个根存在 + 扫描规模下限 + 已知锚点命中（否则「没超预算」是假绿）", () => {
  assert.deepEqual(SCAN.missingRoots, [], `扫描根缺失：${SCAN.missingRoots.join(", ")}`);
  assert.equal(SCAN.presentRoots.length, SCAN_ROOTS.length, "三个扫描根必须都存在");
  assert.ok(
    SCAN.scannedFiles >= MIN_SCANNED_FILES,
    `扫描文件数 ${SCAN.scannedFiles} 低于下限 ${MIN_SCANNED_FILES}——扫描面已跑偏，` +
      "「预算没超」将退化成「什么都没扫到」",
  );
  // 产物混进扫描面会让这道预算彻底失真：minified bundle 里每一处字符串都算一处「散点」，
  // 一次就能把一个 0 上限的格子顶到几十（2026-10-26 实测 84 处）。两道防线：
  // ① 只扫 git 跟踪文件（防未跟踪产物）；② 生成物按 minified 判据跳过，且**跳过的必须
  // 在路径上自报是生成物**（防构建产物悄悄进 src/）。
  assert.deepEqual(
    SCAN.unmarkedGeneratedFiles,
    [],
    "扫描面里出现了未自报的 minified/单行生成物——产物被跟踪进源码树了：\n" +
      SCAN.unmarkedGeneratedFiles.map((file) => `  ${file}`).join("\n") +
      "\n（若确是生成物，请让它在路径上自报：`…/generated/…`、`*.generated.ts` 或 `*.min.js`）",
  );
  const scannedFiles = new Set(SCAN.hits.map((hit) => hit.file));
  for (const anchor of ANCHOR_FILES) {
    assert.ok(
      scannedFiles.has(anchor),
      `锚点 ${anchor} 未出现在命中清单里。它代表一种必须被数到的形态` +
        "（值导入 / 窄子路径 / 类型导入 / 调用期动态 import）——收集器或扫描面坏了",
    );
  }
});

test("IM7：宿主侧 MC 耦合散点逐格不超预算（只减不增）", () => {
  const counts = countByBucket();
  const lines = [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([bucket, count]) => `${bucket} = ${count}（上限 ${BUCKET_LIMITS[bucket] ?? 0}）`);
  console.log(`[IM7] 散点 ${SCAN.hits.length} 处 / ${counts.size} 格：\n  ${lines.join("\n  ")}`);

  const overBudget = [];
  for (const [bucket, count] of counts) {
    const limit = BUCKET_LIMITS[bucket] ?? 0;
    if (count > limit) {
      const offenders = SCAN.hits
        .filter((hit) => hit.bucket === bucket)
        .map((hit) => `  ${hit.file} → ${hit.specifier}`);
      overBudget.push(`${bucket}: ${count} > ${limit}\n${offenders.join("\n")}`);
    }
  }
  assert.deepEqual(
    overBudget,
    [],
    "以下分列的 MC 耦合散点超出预算（IM7：只减不增）：\n" +
      overBudget.join("\n") +
      "\n" +
      "正当增加只有一种：上游新增真的需要宿主多接一处 → 同批更新 UPSTREAM-SYNC.md 第 3 节" +
      "的偏离点登记与本文件的上限。\n" +
      "**注意：把散点搬进 `app/magic-context/**` 不会让这个数字下降**——该目录属于" +
      "`bootstrap/src` 这一格，它的导入行照样计数（上限 25 的注释就写着「装配目录 6 文件」）。" +
      "要降只能真的减少导入行（合并同一模块的多条导入、去掉不必要的类型导入），" +
      "或按 spec 变更口径先在 `docs/iterations/magic-context-decoupling/spec.md` 里改预算。",
  );
});

/**
 * P2-6：形状守卫——装配目录必须保持**拆分**。
 *
 * 预算按「导入行」计数，于是有一个反向激励：把 `app/magic-context/{ports,usage,
 * projection,settle,storage,assembly}.ts` 合回一个文件，`bootstrap/src` 就从 25 掉到
 * 约 20（每个被合并的文件少 1–3 条 `@zcode/magic-context` 导入），预算是「只减不增」
 * ——**合回单体反而更绿**。而 absent-event 的目录前缀 marker 与 plugin 的导出面对拍
 * 都不看文件数，三道门禁同时放过这个规避。
 *
 * 这条断言把「拆分」本身钉成形状：spec「最终项目结构」列出的 9 个文件必须逐个在场。
 * 用**精确集合**而不是「≥ 6 个」的下限——下限挡不住「9 合 2」（还剩 2 个，仍 < 6 会红，
 * 但「9 合 8」不红）；精确集合对任意两两合并都红，代价是将来要合法拆/并时**必须先改
 * spec 的目录清单再改这里**（spec 风险 8 的既定纪律）。
 */
const MC_FACADE_DIR = join(REPO_ROOT, "apps/zcode-cli/packages/bootstrap/src/app/magic-context");
const MC_FACADE_FILES = [
  "assembly.ts",
  "effective-enabled.ts",
  "index.ts",
  "ports.ts",
  "projection.ts",
  "settle.ts",
  "storage.ts",
  "types.ts",
  "usage.ts",
];

test("形状：装配目录保持 spec 的 9 文件拆分（否则合并即让预算假性变绿）", () => {
  const present = readdirSync(MC_FACADE_DIR)
    .filter((name) => name.endsWith(".ts"))
    .sort();
  assert.deepEqual(
    present,
    [...MC_FACADE_FILES].sort(),
    "`bootstrap/src/app/magic-context/` 的文件集合与 spec「最终项目结构」不一致：" +
      "把职责文件合回单体会减少 MC 导入行、让 IM7 预算假性变绿。" +
      "确需拆分/合并时，先改 spec 的目录清单（docs/iterations/magic-context-decoupling/spec.md" +
      " 的「最终项目结构」一节），再同步本清单与 BUCKET_LIMITS。",
  );
});

test("IM4 单列：core 的 ctx 工具调用期 await import 恰好 3 处（与 IM7 分开计）", () => {
  const runtimeImports = SCAN.hits.filter(
    (hit) => hit.bucket === "core/src" && hit.specifier === MC_SPECIFIER,
  );
  // 统计的是「core/src 下指向 barrel 的导入行」；其中类型位置（`typeof import(…)` /
  // `import type`）不产生运行期加载，但 IM7 口径一样数——这里只把**运行期值**那三处
  // 单列出来，避免与 IM7 混算（spec「模块数口径」段：两条问的不是同一件事）。
  const ctxHandlerFiles = runtimeImports
    .filter((hit) => hit.file.startsWith("apps/zcode-cli/packages/core/src/tool/handlers/ctx-"))
    .map((hit) => hit.file);
  assert.deepEqual(
    [...new Set(ctxHandlerFiles)].sort(),
    [
      "apps/zcode-cli/packages/core/src/tool/handlers/ctx-context.ts",
      "apps/zcode-cli/packages/core/src/tool/handlers/ctx-memory.ts",
      "apps/zcode-cli/packages/core/src/tool/handlers/ctx-search.ts",
    ],
    "IM4 例外必须恰好是 ctx-context / ctx-memory / ctx-search 三个 handler 的调用期 " +
      "`await import`（随 4 个 ctx_* 工具一起被摘除）。新增第四个文件等于给 core 开了" +
      "第二条反向依赖 MC 的口子，不在 spec 的例外清单里",
  );
});
