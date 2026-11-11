#!/usr/bin/env node
/**
 * vendor-scope —— 盘范围（只读）。文件级 + 符号级合一：
 *
 *   S = 向下（文件闭包，theirs 侧）        ：搬进来后 import 都在
 *     ∪ 向上（只跟「签名变了」的符号，传递） ：签名没变的实现改动不往上翻
 *
 * 向上的传递规则：调用方只有「自己也因为这次升级改了导出签名」时才继续往上翻，
 * 否则停在该调用方（它自己改 import/适配就完了）。
 *
 * 产出：每个文件进 S 的理由（依赖了谁 / 引用了哪个变了的签名）+ 边界。
 * 用法：
 *   node scripts/vendor-scope.mjs --seed <路径> [--seed-dir <目录>] [--json out.json] [--list]
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};
const many = (name) => {
  const out = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === `--${name}` && args[i + 1]) out.push(args[i + 1].replace(/\\/g, "/"));
  return out;
};

const oursRoot = process.cwd();
const baseRoot = flag("base-root", "D:/Dev/Js/omz-base").replace(/\\/g, "/");
const theirsRoot = flag("theirs-root", "D:/Dev/Js/omz-318").replace(/\\/g, "/");
const baseRef = flag("base", "aac47556");
const theirsRef = flag("theirs", "b95ebaff");
const jsonOut = flag("json", "");

const sh = (cmd) => execSync(cmd, { cwd: oursRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const isFile = (root, rel) => {
  const abs = path.join(root, rel);
  return existsSync(abs) && statSync(abs).isFile();
};
const norm = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();

// ── 变化集 ─────────────────────────────────────────────────
const changed = new Set(
  sh(`git diff --name-only ${baseRef} ${theirsRef}`)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((f) => f.replace(/\\/g, "/"))
    .filter((f) => /\.(ts|tsx)$/.test(f)),
);

// ── 模块解析 ───────────────────────────────────────────────
function resolveRel(root, fromRel, specifier) {
  const probe = (rel) => {
    if (isFile(root, rel)) return rel;
    for (const ext of [".ts", ".tsx", ".d.ts", "/index.ts", ".ts/index.ts"]) {
      if (isFile(root, rel + ext)) return rel + ext;
    }
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

function parse(root, rel) {
  const abs = path.join(root, rel);
  if (!isFile(root, rel)) return null;
  return ts.createSourceFile(rel, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

// ── 符号签名（base vs theirs）──────────────────────────────
// 签名存「结构」而不是整段文本：
//   members（interface/type/class）→ Map<成员名, 成员签名>，顺序无关；
//     兼容判定 = base 的成员在 theirs 里都还在且没变（theirs 新增成员不算 breaking）。
//   fn  → 参数表 + 返回类型；兼容判定 = base 参数都还在且类型没变，theirs 只允许多「尾部可选参」。
//   其他 → 文本。
function memberSig(node) {
  if (ts.isMethodSignature(node) || ts.isMethodDeclaration(node) || ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) {
    return norm(node.getText());
  }
  if (ts.isIndexSignatureDeclaration(node)) return norm(node.getText());
  return null;
}
function memberName(node) {
  if (ts.isMethodSignature(node) || ts.isMethodDeclaration(node) || ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) {
    return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : node.name.getText();
  }
  if (ts.isIndexSignatureDeclaration(node)) return "[index]";
  return null;
}

/** interface/type alias 的成员签名（顺序无关）。 */
function typeShape(node) {
  const members = new Map();
  const collect = (n) => {
    if (ts.isInterfaceDeclaration(n) || ts.isTypeLiteralNode(n)) {
      for (const member of n.members) {
        const name = memberName(member);
        const sig = memberSig(member);
        if (name && sig) members.set(name, sig);
      }
    } else if (ts.isIntersectionTypeNode(n)) {
      n.types.forEach(collect);
    } else if (ts.isParenthesizedTypeNode(n)) {
      collect(n.type);
    }
  };
  collect(node.type ?? node);
  return { kind: "members", members };
}

const shapeCache = new Map();
function shapeOf(root, rel, name) {
  const key = `${root}\u0000${rel}\u0000${name}`;
  if (shapeCache.has(key)) return shapeCache.get(key);
  let shape = null;
  const source = parse(root, rel);
  if (source) {
    for (const statement of source.statements) {
      const exported = (ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export) !== 0;
      if (!exported) continue;
      const isTarget =
        (ts.isInterfaceDeclaration(statement) && statement.name.text === name) ||
        (ts.isTypeAliasDeclaration(statement) && statement.name.text === name) ||
        (ts.isClassDeclaration(statement) && statement.name?.text === name) ||
        (ts.isFunctionDeclaration(statement) && statement.name?.text === name);
      if (!isTarget) continue;
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) shape = typeShape(statement);
      else if (ts.isClassDeclaration(statement)) {
        const members = new Map();
        for (const member of statement.members) {
          const memberNameText = memberName(member);
          const sig = memberSig(member);
          if (memberNameText && sig) members.set(memberNameText, sig);
        }
        shape = { kind: "members", members };
      } else if (ts.isFunctionDeclaration(statement)) {
        shape = {
          kind: "fn",
          params: statement.parameters.map((p) => ({
            name: p.name.getText(),
            optional: !!p.questionToken || !!p.initializer,
            type: p.type ? norm(p.type.getText()) : "",
          })),
          returns: statement.type ? norm(statement.type.getText()) : "",
        };
      }
      break;
    }
  }
  shapeCache.set(key, shape);
  return shape;
}

/** 结构化兼容判定：base 的表面在 theirs 里是否原样保留（允许纯新增）。 */
function compatible(baseShape, theirsShape) {
  if (!baseShape || !theirsShape) return baseShape === theirsShape;
  if (baseShape.kind !== theirsShape.kind) return false;
  if (baseShape.kind === "members") {
    for (const [name, sig] of baseShape.members) {
      const theirsSig = theirsShape.members.get(name);
      if (theirsSig !== sig) return false; // 删了或变了
    }
    return true; // theirs 多出来的成员 = 纯新增，不算 breaking
  }
  if (baseShape.kind === "fn") {
    if (baseShape.returns !== theirsShape.returns) return false;
    if (baseShape.params.length > theirsShape.params.length) return false;
    for (let i = 0; i < baseShape.params.length; i += 1) {
      const a = baseShape.params[i];
      const b = theirsShape.params[i];
      if (a.type !== b.type) return false;
      if (!a.optional && b.optional) return false; // 原必选变可选会让旧调用缺参
      if (a.name !== b.name && a.type === "") return false;
    }
    return true; // theirs 尾部多可选参 = 兼容
  }
  return false;
}

const sigCache = new Map();
function exportsOf(root, rel) {
  const key = `${root}\u0000${rel}`;
  if (sigCache.has(key)) return sigCache.get(key);
  const out = new Map();
  const source = parse(root, rel);
  if (source) {
    const hasExport = (node) => (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement)) {
        const specifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "";
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) out.set(element.name.text, `reexport ${element.name.text} <- ${specifier}`);
        } else if (!statement.exportClause) out.set(`*from:${specifier}`, "export-star");
        continue;
      }
      if (!hasExport(statement)) continue;
      const name = ts.isFunctionDeclaration(statement) ? statement.name?.text
        : ts.isClassDeclaration(statement) ? statement.name?.text
        : ts.isInterfaceDeclaration(statement) ? statement.name.text
        : ts.isTypeAliasDeclaration(statement) ? statement.name.text
        : ts.isEnumDeclaration(statement) ? statement.name.text
        : null;
      if (name) {
        const bodyless =
          ts.isFunctionDeclaration(statement) && statement.body
            ? statement.getText().slice(0, statement.body.getStart() - statement.getStart())
            : ts.isClassDeclaration(statement)
              ? statement.members.map((m) => (ts.isMethodDeclaration(m) && m.body ? m.getText().slice(0, m.body.getStart() - m.getStart()) : m.getText())).join(";")
              : statement.getText();
        out.set(name, norm(bodyless));
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) continue;
          const typeText = declaration.type ? norm(declaration.type.getText()) : "";
          const init = declaration.initializer;
          let shape = "";
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
            shape = norm(init.getText().slice(0, init.body.getStart() - init.getStart())) + (typeText ? "" : " => [inferred]");
          } else if (init) {
            shape = typeText ? "" : `init:${ts.SyntaxKind[init.kind]}`;
          }
          out.set(declaration.name.text, norm(`${typeText} ${shape}`) || "opaque");
        }
      }
    }
  }
  sigCache.set(key, out);
  return out;
}

const breakingCache = new Map();
function breakingSymbols(rel) {
  if (breakingCache.has(rel)) return breakingCache.get(rel);
  const base = exportsOf(baseRoot, rel);
  const theirs = exportsOf(theirsRoot, rel);
  const set = new Set();
  for (const name of new Set([...base.keys(), ...theirs.keys()])) {
    const b = base.get(name);
    const t = theirs.get(name);
    if (b === undefined || t === undefined) {
      // 新增/删除。纯新增的「类型/函数」对旧调用方其实不 breaking，只有删除才是。
      if (b === undefined && t !== undefined && !/^reexport/.test(t) && name !== "default") {
        continue; // additive：没有旧调用方会引用它
      }
      set.add(name);
      continue;
    }
    if (b === t) continue; // 文本签名一致（re-export 指向也没变）
    // 文本变了 → 尝试结构化判定（interface/type/class/fn）
    const baseShape = shapeOf(baseRoot, rel, name);
    const theirsShape = shapeOf(theirsRoot, rel, name);
    if (baseShape && theirsShape && compatible(baseShape, theirsShape)) continue;
    if (/^reexport/.test(b) && /^reexport/.test(t)) {
      set.add(name); // re-export 指向变了，来源处的签名在各自文件里判
      continue;
    }
    set.add(name);
  }
  breakingCache.set(rel, set);
  return set;
}

// ── barrel 展开：符号 → 真实来源文件 ────────────────────────
const barrelCache = new Map();
function barrelOrigin(root, rel) {
  const key = `${root}\u0000${rel}`;
  if (barrelCache.has(key)) return barrelCache.get(key);
  const named = new Map();
  const stars = [];
  const source = parse(root, rel);
  if (source) {
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) named.set(element.name.text, specifier);
      } else if (!statement.exportClause) stars.push(specifier);
    }
  }
  const value = { named, stars };
  barrelCache.set(key, value);
  return value;
}

function symbolOrigin(root, fromRel, specifier, name, depth = 0) {
  const target = resolveRel(root, fromRel, specifier);
  if (!target) return null;
  if (!/\/index\.(ts|tsx)$/.test(target)) return target;
  if (depth > 3) return null;
  const { named, stars } = barrelOrigin(root, target);
  const viaNamed = named.get(name);
  if (viaNamed) return symbolOrigin(root, target, viaNamed, name, depth + 1);
  for (const star of stars) {
    const origin = symbolOrigin(root, target, star, name, depth + 1);
    if (origin) return origin;
  }
  return null;
}

// ── 全量一遍：正向依赖 + 反向「符号级」引用索引 ──────────────
const forward = new Map();
const reverse = new Map(); // file -> Map(importer -> Set(引用的符号))
{
  let done = 0;
  for (const rel of changed) {
    done += 1;
    if (done % 1500 === 0) console.error(`  索引 ${done}/${changed.size}`);
    const source = parse(theirsRoot, rel);
    if (!source) continue;
    const deps = new Set();
    const record = (target, name) => {
      const map = reverse.get(target) ?? new Map();
      const set = map.get(rel) ?? new Set();
      set.add(name);
      map.set(rel, set);
      reverse.set(target, map);
    };
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      const direct = resolveRel(theirsRoot, rel, specifier);
      if (direct) deps.add(direct);
      const clause = statement.importClause;
      const names = [];
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) names.push(element.propertyName?.text ?? element.name.text);
      }
      if (clause?.name) names.push("default");
      for (const name of names) {
        const origin = direct && !/\/index\.(ts|tsx)$/.test(direct) ? direct : symbolOrigin(theirsRoot, rel, specifier, name);
        if (origin) {
          deps.add(origin);
          record(origin, name);
        }
      }
      // namespace import：保守记录 barrel 的 export-star 目标
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings) && direct && /\/index\.(ts|tsx)$/.test(direct)) {
        for (const star of barrelOrigin(theirsRoot, direct).stars) {
          const origin = symbolOrigin(theirsRoot, direct, star, "*");
          if (origin) {
            deps.add(origin);
            record(origin, "*");
          }
        }
      }
    }
    forward.set(rel, deps);
  }
}

// ── 闭包 ───────────────────────────────────────────────────
const seeds = many("seed");
const seedDir = flag("seed-dir", "");
if (seedDir) {
  const walk = (rel) => {
    if (!existsSync(path.join(oursRoot, rel))) return;
    if (statSync(path.join(oursRoot, rel)).isFile()) {
      if (/\.(ts|tsx)$/.test(rel)) seeds.push(rel);
      return;
    }
    for (const name of execSync(`dir /b "${path.join(oursRoot, rel).replace(/\//g, "\\")}"`, { encoding: "utf8" }).split(/\r?\n/).filter(Boolean)) walk(`${rel}/${name}`);
  };
  walk(seedDir.replace(/\\/g, "/"));
}

const scope = new Map(); // file -> reason
const queue = [];
const enqueue = (rel, reason) => {
  if (!changed.has(rel) || scope.has(rel)) return;
  scope.set(rel, reason);
  queue.push(rel);
};
for (const seed of seeds) enqueue(seed, "seed");

while (queue.length) {
  const rel = queue.shift();
  // 向下：theirs 版本的依赖
  for (const dep of forward.get(rel) ?? []) {
    if (changed.has(dep)) enqueue(dep, `依赖 ← ${rel}`);
  }
  // 向上：谁引用了本文件里「签名变了」的符号
  const breaking = breakingSymbols(rel);
  if (breaking.size === 0) continue;
  for (const [importer, names] of reverse.get(rel) ?? []) {
    const touched = [...names].filter((name) => breaking.has(name));
    if (touched.length > 0) enqueue(importer, `引用变了签名 [${touched.slice(0, 3).join(",")}${touched.length > 3 ? "…" : ""}] ← ${rel}`);
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
for (const rel of scope.keys()) buckets.set(bucketOf(rel), (buckets.get(bucketOf(rel)) ?? 0) + 1);

const added = [...scope.keys()].filter((rel) => !isFile(oursRoot, rel));
const removed = [...scope.keys()].filter((rel) => !isFile(theirsRoot, rel));
const upward = [...scope.entries()].filter(([, reason]) => reason.startsWith("引用变了签名"));

console.log(`base=${baseRef} theirs=${theirsRef}  变化集=${changed.size}`);
console.log(`seed：${seeds.join(", ")}`);
console.log(`\n范围 S：${scope.size} 个文件（向上翻进来的：${upward.length}）`);
for (const [key, count] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(4)}  ${key}`);
console.log(`新增（theirs 有 ours 无）：${added.length}   删除：${removed.length}`);

if (args.includes("--list")) {
  console.log("\n明细：");
  for (const [rel, reason] of [...scope.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${rel.replace("apps/zcode-cli/packages/", "cli/")}\n      ↳ ${reason}`);
  }
}

if (jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify({ seeds, scope: [...scope.entries()], added, removed }, null, 2)}\n`);
  console.log(`\n已写入 ${jsonOut}`);
}
