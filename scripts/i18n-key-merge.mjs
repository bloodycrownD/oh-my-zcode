#!/usr/bin/env node
/**
 * i18n 键级挑拣合并脚本（上游 v3.16 → omz）。
 *
 * 背景：omz 与上游 zh-CN/en-US 两份 locale 各自演化、无共同基线，
 * 禁止三方 merge-file（会重演 83 假阳性教训），故按 key 挑拣：
 *
 *   1. 白名单桶挑拣：上游独有键仅当命中白名单前缀才采纳（spec §phase-i18n）；
 *   2. 死桶键 0 进入：不在白名单的上游独有键（source-server/remote/营销等）一律不进；
 *   3. omz 独有键全量保留（动态全量枚举断言，不写死数字）；
 *   4. 双方值不同键逐键仲裁：默认采上游新文案，modelTrajectory.* 轨迹面板键保 omz；
 *   5. 采纳值品牌改写：zcode/ZCode 字样改写为 omz，采纳值内 0 残留；
 *   6. 顺手清 omz 侧 conversationShare.* 死键（rg 核实零引用后全量清除）；
 *   7. 产出仲裁表与四栏合并报告（scripts/i18n-key-merge/report.mjs）。
 *
 * 用法：
 *   node scripts/i18n-key-merge.mjs            # 执行合并：写 locale + 两份报告
 *   node scripts/i18n-key-merge.mjs --verify   # 只跑断言不写文件（幂等复算 == 在盘文件）
 *   node scripts/i18n-key-merge.mjs --analyze  # 只打印实测统计，不写任何文件
 *
 * 上游 locale 快照从 docs/iterations/upstream-v316-fullsync/cache/upstream-locales/
 * 读取（provenance 副本，防 .reference 快照漂移）。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BRAND_RE,
  LOCALES,
  inWhitelist,
  isDroppedKey,
  isDroppedOmz,
  isKeepOmz,
  paths,
} from "./i18n-key-merge/config.mjs";
import { countByPrefix, brandResidue, diffSet, mergeOne } from "./i18n-key-merge/merge.mjs";
import { parseLocale, serialize } from "./i18n-key-merge/parse.mjs";
import { writeReports } from "./i18n-key-merge/report.mjs";

const mode = process.argv.includes("--verify")
  ? "verify"
  : process.argv.includes("--analyze")
    ? "analyze"
    : "merge";

/** 读取并解析双侧四份文件；并计算上游 zh/en 键交集（单侧键不采）。 */
function loadAll() {
  const result = {};
  for (const { id, constName } of LOCALES) {
    const upstream = parseLocale(
      readFileSync(join(paths.upstreamDir, `${id}.ts`), "utf8"),
      `上游 ${id}`,
    );
    upstream.constName = constName;
    const omz = parseLocale(readFileSync(join(paths.omzDir, `${id}.ts`), "utf8"), `omz ${id}`);
    omz.constName = constName;
    result[id] = { upstream, omz };
  }
  const [a, b] = LOCALES.map(({ id }) => new Set(result[id].upstream.entries.map(([k]) => k)));
  result.upstreamCommonKeys = new Set([...a].filter((k) => b.has(k)));
  return result;
}

const data = loadAll();
const upstreamCommon = data.upstreamCommonKeys;
const merges = {};
for (const { id } of LOCALES) {
  merges[id] = mergeOne({
    omzEntries: data[id].omz.entries,
    upstreamEntries: data[id].upstream.entries,
    // 跨 locale 交集守卫：上游单侧键不采，保 zh/en 键集合 parity
    canAdopt: (k) => upstreamCommon.has(k),
  });
}

/** 基线未触碰键中的品牌残留（omz 既有产品面/协议字面量/受保护键值，仅登记不强改）。 */
const baselineBrandResidue = {};
for (const { id } of LOCALES) {
  const touched = new Set([...merges[id].added, ...merges[id].changed]);
  baselineBrandResidue[id] = merges[id].merged.filter(
    ([k, v]) => !touched.has(k) && BRAND_RE.test(v),
  );
}

/* ---------------- --analyze：只打印实测统计 ---------------- */
if (mode === "analyze") {
  for (const { id } of LOCALES) {
    const { upstream, omz } = data[id];
    const m = merges[id];
    const omzKeys = omz.entries.map(([k]) => k);
    const upKeys = upstream.entries.map(([k]) => k);
    const omzUnique = diffSet(omzKeys, upKeys);
    console.log(`\n===== ${id} =====`);
    console.log(
      `上游 ${upKeys.length} 键 / omz ${omzKeys.length} 键 / ` +
        `上游独有 ${upUniqueCount(upKeys, omzKeys)} / omz 独有 ${omzUnique.length} / 值冲突 ${m.changed.length + m.conflictKeptOmz.length}`,
    );
    console.log(`白名单采纳（added）: ${m.added.length}`, countByPrefix(m.added));
    console.log(`上游单侧键跳过: ${m.singleSidedSkipped.length}`, m.singleSidedSkipped);
    console.log(
      `死桶不进（keptOut）: ${m.upstreamOnlyKeptOut.length}`,
      countByPrefix(m.upstreamOnlyKeptOut),
    );
    console.log(`值相同 kept: ${m.kept.length}`);
    console.log(`冲突采上游 changed: ${m.changed.length}`);
    console.log(`冲突保 omz（轨迹）: ${m.conflictKeptOmz.length}`, m.conflictKeptOmz);
    console.log(`omz 死键清除 dropped: ${m.dropped.length}`);
    console.log(`品牌改写（采纳值内）: ${m.brandRewrites.length}`);
    for (const [k, before, after] of m.brandRewrites) {
      console.log(
        `  ${k}\n    上游: ${JSON.stringify(before)}\n    改后: ${JSON.stringify(after)}`,
      );
    }
    const touched = new Set([...m.added, ...m.changed]);
    const residueKept = brandResidue(m.merged.filter(([k]) => !touched.has(k)));
    console.log(`未触碰键中品牌残留（基线自带）: ${residueKept.length}`);
    for (const [k, v] of residueKept) console.log(`  ${k}: ${JSON.stringify(v)}`);
    const keyBrand = m.merged.filter(([k]) => BRAND_RE.test(k));
    console.log(
      `键名含品牌字样: ${keyBrand.length}`,
      keyBrand.map(([k]) => k),
    );
  }
  process.exit(0);
}

function upUniqueCount(upKeys, omzKeys) {
  return diffSet(upKeys, omzKeys).length;
}

/* ---------------- 断言（merge 与 verify 共用） ---------------- */

const failures = [];
function assert(cond, message) {
  if (!cond) failures.push(message);
  return cond;
}

for (const { id } of LOCALES) {
  const { omz, upstream } = data[id];
  const m = merges[id];
  const mergedKeys = new Set(m.merged.map(([k]) => k));
  const omzKeys = omz.entries.map(([k]) => k);
  const upKeys = upstream.entries.map(([k]) => k);
  const omzUnique = diffSet(omzKeys, upKeys).filter((k) => !isDroppedOmz(k));
  const tag = `[${id}]`;

  // A. omz 独有键全量保留（动态全量枚举；conversationShare 死键除外）
  const missingOmzUnique = omzUnique.filter((k) => !mergedKeys.has(k));
  assert(
    missingOmzUnique.length === 0,
    `${tag} omz 独有键丢失 ${missingOmzUnique.length} 个: ${missingOmzUnique.slice(0, 10).join(", ")}`,
  );

  // B. 死桶键 0 进入：所有新增键必须命中白名单
  const addedNotWhitelisted = m.added.filter((k) => !inWhitelist(k));
  assert(
    addedNotWhitelisted.length === 0,
    `${tag} 新增键未命中白名单 ${addedNotWhitelisted.length} 个: ${addedNotWhitelisted.slice(0, 10).join(", ")}`,
  );

  // C. 白名单桶键全进：上游独有 ∩ 白名单 ∩ 上游 zh/en 交集 ⊆ merged
  //    显式丢弃键（DROP_KEYS）不参与「必须采纳」断言——它们是 omz 侧已删、上游仍存的特例。
  const whitelistUpOnly = diffSet(upKeys, omzKeys).filter(
    (k) => inWhitelist(k) && upstreamCommon.has(k) && !isDroppedKey(k),
  );
  const missedWhitelist = whitelistUpOnly.filter((k) => !mergedKeys.has(k));
  assert(
    missedWhitelist.length === 0,
    `${tag} 白名单上游独有键未采纳 ${missedWhitelist.length} 个: ${missedWhitelist.slice(0, 10).join(", ")}`,
  );
  // C2. 单侧守卫正确性：被跳过的键必须全部不在上游交集内
  const badSingleSided = m.singleSidedSkipped.filter((k) => upstreamCommon.has(k));
  assert(
    badSingleSided.length === 0,
    `${tag} 单侧守卫误杀交集内键 ${badSingleSided.length} 个: ${badSingleSided.slice(0, 10).join(", ")}`,
  );

  // D. 采纳值（added+changed）内 0 处 zcode/ZCode（品牌改写后强断言）。
  //    基线未触碰键（modelTrajectory.empty 的「ZCode Agent」、.zcodeignore、
  //    x-zcode-bot-secret 等）是 omz 既有产品面/协议字面量或受保护键值，不在本
  //    次合并改写范围，仅在报告中登记（见 baselineBrandResidue / 仲裁表附录 C）。
  const touched = new Set([...m.added, ...m.changed]);
  const adoptedResidue = m.merged.filter(([k, v]) => touched.has(k) && BRAND_RE.test(v));
  assert(
    adoptedResidue.length === 0,
    `${tag} 采纳值内品牌残留 ${adoptedResidue.length} 处: ${adoptedResidue
      .slice(0, 5)
      .map(([k]) => k)
      .join(", ")}`,
  );

  // E. 轨迹面板键保护：modelTrajectory.* 全在且值不变
  const trajBaseline = omz.entries.filter(([k]) => isKeepOmz(k));
  const trajBroken = trajBaseline.filter(([k, v]) => lookupMerged(m.merged, k) !== v);
  assert(
    trajBroken.length === 0,
    `${tag} modelTrajectory.* 键被改 ${trajBroken.length} 个: ${trajBroken
      .slice(0, 5)
      .map(([k]) => k)
      .join(", ")}`,
  );

  // F. 基线键除死键外全在（值可换、键不可丢）
  const lostBaseline = omzKeys.filter((k) => !isDroppedOmz(k) && !mergedKeys.has(k));
  assert(
    lostBaseline.length === 0,
    `${tag} omz 基线键丢失 ${lostBaseline.length} 个: ${lostBaseline.slice(0, 10).join(", ")}`,
  );

  // G. 死键确已清除
  const survivedDead = m.dropped.filter((k) => mergedKeys.has(k));
  assert(
    survivedDead.length === 0,
    `${tag} conversationShare 死键未清干净: ${survivedDead.join(", ")}`,
  );
}

function lookupMerged(entries, key) {
  for (const [k, v] of entries) if (k === key) return v;
  return undefined;
}

// H. zh/en 合并后键集合一致（parity 门禁同口径）
{
  const zhKeys = new Set(merges["zh-CN"].merged.map(([k]) => k));
  const enKeys = new Set(merges["en-US"].merged.map(([k]) => k));
  const onlyZh = diffSet(zhKeys, enKeys);
  const onlyEn = diffSet(enKeys, zhKeys);
  assert(
    onlyZh.length === 0 && onlyEn.length === 0,
    `zh/en 键集合不一致：zh 多 ${onlyZh.length}（${onlyZh.slice(0, 5).join(", ")}），en 多 ${onlyEn.length}（${onlyEn.slice(0, 5).join(", ")}）`,
  );
}

/* ---------------- --verify：幂等复算 + 断言，不写文件 ---------------- */
if (mode === "verify") {
  // 幂等性：以「当前在盘（已合并）文件」为基线再合一次，结果必须与在盘完全一致。
  for (const { id } of LOCALES) {
    const baseline = data[id].omz.entries;
    const re = mergeOne({
      omzEntries: baseline,
      upstreamEntries: data[id].upstream.entries,
      canAdopt: (k) => upstreamCommon.has(k),
    });
    const same =
      re.merged.length === baseline.length &&
      re.merged.every(([k, v], i) => baseline[i][0] === k && baseline[i][1] === v);
    assert(
      same,
      `[${id}] --verify 幂等复算与在盘文件不一致（新增 ${re.added.length}/改动 ${re.changed.length}，键序或键值有漂移）`,
    );
  }
  if (failures.length > 0) {
    console.error(`i18n-merge --verify 失败（${failures.length} 项）：`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  for (const { id } of LOCALES) {
    const m = merges[id];
    console.log(
      `[${id}] verify 通过：${m.merged.length} 键（值冲突仲裁 ${m.changed.length + m.conflictKeptOmz.length}、品牌残留 0、死桶 0 进入、幂等复算一致）`,
    );
  }
  console.log("i18n-merge --verify 全部断言通过（未写任何文件）。");
  process.exit(0);
}

/* ---------------- merge：写 locale + 报告 ---------------- */

if (failures.length > 0) {
  console.error(`i18n-merge 断言失败（${failures.length} 项），未写文件：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

// 写 locale 文件（脚本整体重写，禁止手工 Edit）
for (const { id } of LOCALES) {
  const parsed = data[id].omz;
  const text = serialize(parsed, merges[id].merged);
  writeFileSync(join(paths.omzDir, `${id}.ts`), text, "utf8");
  // 回读校验：重解析后键值与计算结果逐键一致
  const reparsed = parseLocale(readFileSync(join(paths.omzDir, `${id}.ts`), "utf8"), `回读 ${id}`);
  const ok =
    reparsed.entries.length === merges[id].merged.length &&
    reparsed.entries.every(
      ([k, v], i) => merges[id].merged[i][0] === k && merges[id].merged[i][1] === v,
    );
  if (!ok) {
    console.error(`[${id}] 回读校验失败：写入内容与计算结果不一致，中止。`);
    process.exit(1);
  }
  console.log(`[${id}] 已写 ${join(paths.omzDir, `${id}.ts`)}（${merges[id].merged.length} 键）`);
}

writeReports({ data, merges, baselineBrandResidue, paths, locales: LOCALES });
console.log("i18n-merge 完成：locale 已合并，仲裁表与四栏报告已落盘。");
