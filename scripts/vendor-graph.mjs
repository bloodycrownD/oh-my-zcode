#!/usr/bin/env node
/**
 * vendor-graph —— 从「一个上游变动文件」出发，圈出可独立升级的文件范围。
 *
 * 背景：上游把整包同步压成一个 commit（v3.17.2 → v3.18.0 是 5099 个文件），没有 commit
 * 边界可以 cherry-pick。但两边同源，于是按文件算三方差异：
 *
 *   base   = 上游基线（默认 aac47556 = 1.0.x 所基于的那次 v3.15.1 同步）
 *   theirs = 目标上游版本（默认 b95ebaff = v3.18.0）
 *
 * 变化集 C = {文件 | base 与 theirs 内容不同}（含新增、删除）。
 * 范围 S 从 seed 出发，在 C 上做闭包：
 *   - 出边（它 import 谁）**传递闭包**：保证搬进来后依赖齐全 —— 这就是「文件存在 ≠ 能直接搬」的正解；
 *   - 入边（谁 import 它）可选一跳（`--incoming`）：上游若改了导出签名，直接调用点必须一起看；
 *     再往上会漫到整个 app，那部分交给 `tsc` 当 oracle 兜（见后续 vendor-wave）。
 *
 * 用法：
 *   node scripts/vendor-graph.mjs --seed <repo相对路径> [--seed ...] [--seed-dir <目录>]
 *                                 [--incoming] [--list] [--json out.json]
 *
 * 只读。theirs 侧需要一份 worktree：
 *   git worktree add ../omz-318 <theirs-sha> --detach
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};
const many = (name) => {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === `--${name}` && args[i + 1]) out.push(args[i + 1].replace(/\\/g, "/"));
  }
  return out;
};

const oursRoot = process.cwd();
const theirsRoot = flag("theirs-root", "D:/Dev/Js/omz-318").replace(/\\/g, "/");
const baseRef = flag("base", "aac47556");
const theirsRef = flag("theirs", "b95ebaff");
const withIncoming = args.includes("--incoming");
const jsonOut = flag("json", "");

const SOURCE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
const sh = (cmd) => execSync(cmd, { cwd: oursRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

if (!existsSync(theirsRoot)) {
  console.error(`目标树不存在：${theirsRoot}\n先建：git worktree add ${theirsRoot} ${theirsRef} --detach`);
  process.exit(2);
}

// ── 变化集 C ────────────────────────────────────────────────
const changed = new Map();
for (const line of sh(`git diff --name-status ${baseRef} ${theirsRef}`).split(/\r?\n/).filter(Boolean)) {
  const [code, ...rest] = line.split("\t");
  const file = rest[rest.length - 1].replace(/\\/g, "/");
  if (SOURCE.test(file)) changed.set(file, code[0]);
}

// ── 模块解析（相对 + @zcode/* 别名；外部依赖不参与闭包）────────
const EXT_PROBES = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".mjs", "/index.ts", "/index.tsx"];

const isFile = (root, rel) => {
  const abs = path.join(root, rel);
  return existsSync(abs) && statSync(abs).isFile();
};

function resolveSpecifier(fromRel, specifier, root) {
  const probe = (rel) => {
    if (isFile(root, rel)) return rel;
    for (const ext of EXT_PROBES) if (isFile(root, rel + ext)) return rel + ext;
    return null;
  };
  if (specifier.startsWith(".")) {
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
    return probe(joined) ?? probe(joined.replace(/\.js$/, ""));
  }
  const alias = /^@zcode\/([^/]+)(?:\/(.*))?$/.exec(specifier);
  if (alias) {
    const rel = `apps/zcode-cli/packages/${alias[1]}/src/${alias[2] ?? "index"}`;
    return probe(rel) ?? probe(rel.replace(/\.js$/, ""));
  }
  return null;
}

// ── import 抽取 ─────────────────────────────────────────────
const edgeCache = new Map();

function edgesOf(rel, root) {
  const key = `${root}\u0000${rel}`;
  const cached = edgeCache.get(key);
  if (cached) return cached;
  const abs = path.join(root, rel);
  if (!existsSync(abs) || !isFile(root, rel)) {
    edgeCache.set(key, []);
    return [];
  }
  const text = readFileSync(abs, "utf8");
  const specifiers = new Set();

  if (/\.(ts|tsx|mts|cts)$/.test(rel)) {
    const source = ts.createSourceFile(
      rel,
      text,
      ts.ScriptTarget.Latest,
      true,
      rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          specifiers.add(node.moduleSpecifier.text);
        }
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const expression = node.moduleReference.expression;
        if (ts.isStringLiteral(expression)) specifiers.add(expression.text);
      } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
        const [first] = node.arguments;
        const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
        if ((isDynamic || isRequire) && ts.isStringLiteralLike(first)) specifiers.add(first.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  } else {
    for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g)) {
      specifiers.add(match[1]);
    }
  }

  const resolved = [];
  for (const specifier of specifiers) {
    const target = resolveSpecifier(rel, specifier, root);
    if (target) resolved.push(target);
  }
  edgeCache.set(key, resolved);
  return resolved;
}

// ── seed 收集 ───────────────────────────────────────────────
const seeds = many("seed");
const seedDir = flag("seed-dir", "");
if (seedDir) {
  const walk = (rel) => {
    const abs = path.join(oursRoot, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isFile()) {
      if (SOURCE.test(rel)) seeds.push(rel);
      return;
    }
    for (const name of readdirSync(abs)) walk(`${rel}/${name}`);
  };
  walk(seedDir.replace(/\\/g, "/"));
}
if (seeds.length === 0) {
  console.error("缺 --seed 或 --seed-dir");
  process.exit(2);
}

// ── 闭包 ───────────────────────────────────────────────────
const scope = new Set();
const boundary = new Map();
const queue = [];

const consider = (rel) => {
  if (!changed.has(rel)) {
    if (!boundary.has(rel)) {
      boundary.set(rel, { inOurs: isFile(oursRoot, rel), inTheirs: isFile(theirsRoot, rel) });
    }
    return;
  }
  if (scope.has(rel)) return;
  scope.add(rel);
  queue.push(rel);
};

for (const seed of seeds) consider(seed);

while (queue.length) {
  const rel = queue.shift();
  for (const root of [theirsRoot, oursRoot]) {
    for (const target of edgesOf(rel, root)) consider(target);
  }
}

// 入边（可选）：一次性把 C 的 import 关系铺开，取一跳
if (withIncoming) {
  const reverse = new Map();
  for (const candidate of changed.keys()) {
    for (const root of [theirsRoot, oursRoot]) {
      for (const target of edgesOf(candidate, root)) {
        const list = reverse.get(target) ?? new Set();
        list.add(candidate);
        reverse.set(target, list);
      }
    }
  }
  for (const rel of [...scope]) {
    for (const importer of reverse.get(rel) ?? []) consider(importer);
  }
  // 新进来的节点也要补一次它们的出边
  while (queue.length) {
    const rel = queue.shift();
    for (const root of [theirsRoot, oursRoot]) {
      for (const target of edgesOf(rel, root)) consider(target);
    }
  }
}

// ── 报告 ───────────────────────────────────────────────────
const bucketOf = (rel) => {
  const cli = /^apps\/zcode-cli\/packages\/([^/]+)\//.exec(rel);
  if (cli) return `cli/${cli[1]}`;
  const pkg = /^packages\/([^/]+)\//.exec(rel);
  if (pkg) return `pkgs/${pkg[1]}`;
  return rel.split("/")[0];
};
const buckets = new Map();
for (const rel of scope) buckets.set(bucketOf(rel), (buckets.get(bucketOf(rel)) ?? 0) + 1);

const added = [...scope].filter((rel) => !isFile(oursRoot, rel));
const removed = [...scope].filter((rel) => !isFile(theirsRoot, rel));
const crossed = [...boundary.entries()].filter(([, v]) => v.inOurs !== v.inTheirs);

console.log(`base=${baseRef}  theirs=${theirsRef}  incoming=${withIncoming ? "on" : "off"}`);
console.log(
  `变化集 C：${changed.size} 个源文件（A=${[...changed.values()].filter((v) => v === "A").length} M=${[...changed.values()].filter((v) => v === "M").length} D=${[...changed.values()].filter((v) => v === "D").length}）`,
);
console.log(`seed：${seeds.length}`);
console.log(`\n范围 S：${scope.size} 个文件`);
for (const [key, count] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${key}`);
}
console.log(`\n新增（只在 theirs）：${added.length}`);
console.log(`删除（只在 ours）：${removed.length}`);
console.log(`边界（S 依赖但不在 C 内）：${boundary.size}`);

if (crossed.length) {
  console.log(`\n⚠ 边界里 ${crossed.length} 个文件只在一侧存在 —— 闭包可能被截断：`);
  for (const [rel, v] of crossed.slice(0, 10)) console.log(`   ${rel}  ours=${v.inOurs} theirs=${v.inTheirs}`);
}

if (args.includes("--list")) {
  console.log("\n明细：");
  for (const rel of [...scope].sort()) console.log(`  ${changed.get(rel)}  ${rel}`);
}

if (jsonOut) {
  writeFileSync(
    jsonOut,
    `${JSON.stringify(
      {
        base: baseRef,
        theirs: theirsRef,
        seeds,
        changedCount: changed.size,
        scope: [...scope].sort(),
        added,
        removed,
        boundary: [...boundary.keys()].sort(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n已写入 ${jsonOut}`);
}
