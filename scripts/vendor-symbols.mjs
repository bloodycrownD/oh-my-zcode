#!/usr/bin/env node
/**
 * vendor-symbols —— 函数级（导出符号级）差异分析：区分「只改实现」和「改了签名」。
 *
 * 动机：文件级依赖闭包在主干上会炸成一个 1793 文件的巨块，因为「A import B」这种边太粗。
 * 真正决定「要不要往上翻」的是**导出符号的签名有没有变**：
 *
 *   - 实现变了、签名没变   → 调用方无感，**不需要向上传播**（这是收窄范围的关键）
 *   - 签名变了 / 符号新增/删除 → 调用方可能炸，需要把「引用了这个符号的文件」拉进来
 *
 * 三棵树：
 *   base   = 上游基线（默认 D:/Dev/Js/omz-base @ aac47556）
 *   theirs = 目标版本（默认 D:/Dev/Js/omz-318 @ b95ebaff）
 *   ours   = 当前工作树（1.0.x）
 *
 * 用法：
 *   node scripts/vendor-symbols.mjs --file <repo相对路径> [--importers] [--list-importers]
 *
 * 只读。
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};

const oursRoot = process.cwd();
const baseRoot = flag("base-root", "D:/Dev/Js/omz-base").replace(/\\/g, "/");
const theirsRoot = flag("theirs-root", "D:/Dev/Js/omz-318").replace(/\\/g, "/");
const baseRef = flag("base", "aac47556");
const theirsRef = flag("theirs", "b95ebaff");
const file = flag("file", "");
const verbose = args.includes("--verbose");

if (!file) {
  console.error("缺 --file <repo相对路径>");
  process.exit(2);
}

const norm = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();

/** 取一个声明「签名部分」的文本：函数去掉 body，类去掉方法体。 */
function signatureText(node) {
  const start = node.getStart();
  if (ts.isFunctionDeclaration(node) && node.body) {
    return norm(node.getText().slice(0, node.body.getStart() - start));
  }
  if (ts.isMethodDeclaration(node) && node.body) {
    return norm(node.getText().slice(0, node.body.getStart() - node.getStart()));
  }
  if (ts.isVariableStatement(node)) {
    const parts = [];
    for (const declaration of node.declarationList.declarations) {
      const name = declaration.name.getText();
      const typeText = declaration.type ? norm(declaration.type.getText()) : "";
      const init = declaration.initializer;
      let initShape = "";
      if (init) {
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          const head = init.getText().slice(0, init.body.getStart() - init.getStart());
          initShape = norm(head) + (typeText ? "" : " => [inferred]");
        } else {
          initShape = typeText ? "" : `= init:${ts.SyntaxKind[init.kind]}`;
        }
      }
      parts.push(`${name}${typeText ? `: ${typeText}` : ""} ${initShape}`.trim());
    }
    return norm(parts.join("; "));
  }
  if (ts.isClassDeclaration(node)) {
    const members = (node.members ?? [])
      .filter((member) => !ts.isConstructorDeclaration(member))
      .map((member) => {
        if (ts.isMethodDeclaration(member) && member.body) {
          return norm(member.getText().slice(0, member.body.getStart() - member.getStart()));
        }
        if (ts.isPropertyDeclaration(member)) {
          return norm(member.getText().replace(/=\s*[\s\S]*$/, ""));
        }
        return norm(member.getText());
      });
    return norm(members.join("; "));
  }
  // interface / type / enum：整段都是表面
  return norm(node.getText());
}

function exportedSymbols(root, rel) {
  const abs = path.join(root, rel);
  const out = new Map();
  if (!existsSync(abs)) return out;
  const text = readFileSync(abs, "utf8");
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

  const hasExport = (node) =>
    (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0 ||
    (node.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "";
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          out.set(element.name.text, { kind: "re-export", signature: `${element.name.text} <- ${specifier}` });
        }
      } else {
        out.set(`*from:${specifier}`, { kind: "export-star", signature: specifier });
      }
      continue;
    }
    if (!hasExport(statement)) continue;

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      out.set(statement.name.text, { kind: "function", signature: signatureText(statement) });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          out.set(declaration.name.text, { kind: "const", signature: signatureText(statement) });
        }
      }
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      out.set(statement.name.text, { kind: "class", signature: signatureText(statement) });
    } else if (ts.isInterfaceDeclaration(statement)) {
      out.set(statement.name.text, { kind: "interface", signature: signatureText(statement) });
    } else if (ts.isTypeAliasDeclaration(statement)) {
      out.set(statement.name.text, { kind: "type", signature: signatureText(statement) });
    } else if (ts.isEnumDeclaration(statement)) {
      out.set(statement.name.text, { kind: "enum", signature: signatureText(statement) });
    }
  }
  // export default
  for (const statement of source.statements) {
    if (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      out.set("default", { kind: "default", signature: signatureText(statement) });
    }
  }
  return out;
}

const baseSymbols = exportedSymbols(baseRoot, file);
const theirsSymbols = exportedSymbols(theirsRoot, file);
const oursSymbols = exportedSymbols(oursRoot, file);

const names = [...new Set([...baseSymbols.keys(), ...theirsSymbols.keys()])].sort();
const statuses = [];
for (const name of names) {
  const base = baseSymbols.get(name);
  const theirs = theirsSymbols.get(name);
  const ours = oursSymbols.get(name);
  const status = !base ? "added" : !theirs ? "removed" : base.signature === theirs.signature ? "impl-only" : "signature-changed";
  const oursStatus = !ours ? "缺" : !theirs ? "应删" : ours.signature === theirs.signature ? "已一致" : "有差异";
  statuses.push({ name, status, kind: theirs?.kind ?? base?.kind ?? "?", base, theirs, oursStatus });
}

const breaking = statuses.filter((item) => item.status !== "impl-only");
const implOnly = statuses.filter((item) => item.status === "impl-only");

console.log(`文件：${file}`);
console.log(`导出符号：base=${baseSymbols.size} theirs=${theirsSymbols.size} ours=${oursSymbols.size}`);
console.log(`签名变了/新增/删除（要向上看）：${breaking.length}`);
console.log(`只改实现（签名未变，不需向上）：${implOnly.length}\n`);

const kindIcon = { added: "＋", removed: "－", "signature-changed": "≠", "impl-only": "＝" };
for (const item of statuses) {
  const oursMark = item.oursStatus === "已一致" ? "" : `  [ours:${item.oursStatus}]`;
  console.log(`  ${kindIcon[item.status] ?? "?"} ${item.name.padEnd(34)} ${item.status.padEnd(18)} ${item.kind}${oursMark}`);
  if (verbose && item.status === "signature-changed") {
    console.log(`      base  : ${(item.base?.signature ?? "").slice(0, 160)}`);
    console.log(`      theirs: ${(item.theirs?.signature ?? "").slice(0, 160)}`);
  }
}

// ── 谁 import 了这个文件（可选，扫全量变动集）──────────────────
// 注意：绝大多数消费者是从包根（`@zcode/adapters`）导入的，真正的 re-export 发生在
// `src/index.ts`。所以必须把 barrel 当透明层：consumer → barrel → 本文件。
const barrelMapCache = new Map();
function barrelReexports(root, rel) {
  const key = `${root}\u0000${rel}`;
  const cached = barrelMapCache.get(key);
  if (cached) return cached;
  const map = { named: new Map(), stars: [] };
  const abs = path.join(root, rel);
  if (existsSync(abs)) {
    const source = ts.createSourceFile(rel, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const exported = element.name.text;
          const local = element.propertyName?.text ?? element.name.text;
          map.named.set(exported, { local, specifier });
        }
      } else if (!statement.exportClause) {
        map.stars.push(specifier);
      }
    }
  }
  barrelMapCache.set(key, map);
  return map;
}

function resolveRel(fromRel, specifier, root) {
  const probe = (rel) => {
    if (existsSync(path.join(root, rel)) && statSync(path.join(root, rel)).isFile()) return rel;
    for (const ext of [".ts", ".tsx", ".d.ts", "/index.ts"]) {
      if (existsSync(path.join(root, rel + ext)) && statSync(path.join(root, rel + ext)).isFile()) return rel + ext;
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

/** consumer 从 target 导入的名字里，哪些其实来自我们的 file（穿过一层 barrel）。 */
function namesFromOurFile(root, targetRel, names) {
  if (targetRel === file) return names;
  if (!/\/index\.(ts|tsx)$/.test(targetRel)) return [];
  const map = barrelReexports(root, targetRel);
  const viaStar = map.stars.some((specifier) => resolveRel(targetRel, specifier, root) === file);
  const out = [];
  for (const name of names) {
    const named = map.named.get(name);
    if (named && resolveRel(targetRel, named.specifier, root) === file) {
      out.push(name);
    } else if (!named && viaStar) {
      out.push(name); // export * 透传：保守计入
    }
  }
  return out;
}

if (args.includes("--importers")) {
  const changedFiles = execSync(`git diff --name-only ${baseRef} ${theirsRef}`, {
    cwd: oursRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
    .split(/\r?\n/)
    .filter((entry) => /\.(ts|tsx)$/.test(entry));

  const breakingNames = new Set(breaking.map((item) => item.name));
  const hits = [];
  let scanned = 0;

  for (const candidate of changedFiles) {
    scanned += 1;
    if (scanned % 1500 === 0) console.error(`  已扫描 ${scanned}/${changedFiles.length}`);
    const abs = path.join(theirsRoot, candidate);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    const source = ts.createSourceFile(candidate, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!ts.isStringLiteral(specifier)) continue;
      const target = resolveRel(candidate, specifier.text, theirsRoot);
      if (!target) continue;
      const clause = statement.importClause;
      const importedNames = [];
      let namespaceImport = false;
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) importedNames.push(element.propertyName?.text ?? element.name.text);
      }
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) namespaceImport = true;
      if (clause?.name) importedNames.push("default");

      const direct = target === file ? importedNames : [];
      const throughBarrel = namesFromOurFile(theirsRoot, target, importedNames);
      const fromUs = [...new Set([...direct, ...throughBarrel])];
      if (fromUs.length === 0 && !namespaceImport) continue;
      if (namespaceImport && target !== file && !namesFromOurFile(theirsRoot, target, ["__probe__"]).length) {
        // 命名空间导入无法判定具体符号，只在 barrel 确实转出本文件时保守计入
        const map = barrelReexports(theirsRoot, target);
        const viaStar = map.stars.some((s) => resolveRel(target, s, theirsRoot) === file);
        if (!viaStar) continue;
      }
      const touched = fromUs.filter((name) => breakingNames.has(name));
      hits.push({ importer: candidate, names: fromUs, touched });
    }
  }

  const relevant = hits.filter((hit) => hit.touched.length > 0);
  console.log(`\n引用本文件的变动文件：${hits.length} 个（扫描 ${scanned} 个）`);
  console.log(`其中引用了「签名变了」的符号：${relevant.length} 个`);
  for (const hit of relevant.slice(0, 40)) {
    console.log(`  ${hit.importer.replace("apps/zcode-cli/packages/", "cli/")}  ← ${hit.touched.join(", ")}`);
  }
}
