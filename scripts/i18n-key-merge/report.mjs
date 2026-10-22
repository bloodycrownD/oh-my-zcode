/**
 * i18n 合并报告落盘：逐键仲裁表（i18n-arbitration.md）与四栏合并报告
 * （cache/i18n-merge-report.md）。
 */

import { writeFileSync } from "node:fs";
import { inWhitelist } from "./config.mjs";
import { countByPrefix, diffSet } from "./merge.mjs";

function upsert(map, key, locale, tag) {
  if (!map.has(key)) map.set(key, {});
  map.get(key)[locale] = tag;
}

function resultMapGet(entries, key) {
  for (const [k, v] of entries) if (k === key) return v;
  return undefined;
}

/**
 * @param ctx { data, merges, baselineBrandResidue, paths, locales }
 */
export function writeReports({ data, merges, baselineBrandResidue, paths, locales }) {
  writeArbitrationReport({ data, merges, baselineBrandResidue, paths, locales });
  writeMergeReport({ data, merges, baselineBrandResidue, paths, locales });
}

function writeArbitrationReport({ data, merges, baselineBrandResidue, paths, locales }) {
  // 值冲突 union（zh/en），决策按前缀策略；表行标注各 locale 状态。
  const conflictUnion = new Map();
  for (const { id } of locales) {
    const m = merges[id];
    for (const k of m.changed) upsert(conflictUnion, k, id, "changed");
    for (const k of m.conflictKeptOmz) upsert(conflictUnion, k, id, "keptOmz");
  }
  for (const k of conflictUnion.keys()) {
    for (const { id } of locales) {
      if (!conflictUnion.get(k)[id]) {
        const omzV = resultMapGet(data[id].omz.entries, k);
        const upV = resultMapGet(data[id].upstream.entries, k);
        conflictUnion.get(k)[id] = omzV === upV ? "equal" : "unknown";
      }
    }
  }
  const keys = [...conflictUnion.keys()].sort((a, b) => a.localeCompare(b));

  const lines = [];
  lines.push("# i18n 逐键仲裁表（上游 v3.16 → omz）");
  lines.push("");
  lines.push("> 由 `scripts/i18n-key-merge.mjs` 自动生成；上游快照见 `cache/upstream-locales/`。");
  lines.push(
    `> 生成时间：${new Date().toISOString()}；omz 基线：合并前 \`packages/ui/src/i18n/locales/\`。`,
  );
  lines.push("");
  lines.push("仲裁规则（spec §phase-i18n + 实施补充）：");
  lines.push("");
  lines.push("1. 双方都有但值不同的键，默认**采上游新文案**；");
  lines.push("2. `modelTrajectory.*`（轨迹面板 omz 专属语义）**保 omz**；");
  lines.push(
    "3. 采纳值内 `zcode/ZCode` 品牌字样统一改写为 `omz`（产品名；路径字面量核对真实产品面后改写，见附录 C）；",
  );
  lines.push(
    "4. 上游独有键仅白名单桶采纳，且需上游 zh/en 双侧皆有（单侧键不采，保 parity 门禁）；死桶 0 进入（见合并报告，不在本表）；",
  );
  lines.push("5. omz `conversationShare.*` 死键全量清除（口径见附录 B）。");
  lines.push("");
  lines.push(`## 一、值冲突仲裁（zh/en union ${keys.length} 条，全覆盖）`);
  lines.push("");
  lines.push("| 键 | 决策 | 理由 |");
  lines.push("| --- | --- | --- |");
  let adoptCount = 0;
  let keepCount = 0;
  for (const k of keys) {
    const st = conflictUnion.get(k);
    const zhSt = st["zh-CN"];
    const enSt = st["en-US"];
    if (zhSt === "keptOmz" || enSt === "keptOmz") {
      keepCount++;
      lines.push(
        `| ${k} | 保 omz | 轨迹面板（modelTrajectory.*）omz 专属文案，上游新文案不适用（zh=${zhSt}/en=${enSt}） |`,
      );
    } else {
      adoptCount++;
      const brandTouched =
        merges["zh-CN"].brandRewrites.some(([bk]) => bk === k) ||
        merges["en-US"].brandRewrites.some(([bk]) => bk === k);
      lines.push(
        `| ${k} | 采上游 | 上游 v3.16 新文案${brandTouched ? "；含品牌字样已改写为 omz" : ""}（zh=${zhSt}/en=${enSt}） |`,
      );
    }
  }
  lines.push("");
  lines.push(`小计：采上游 ${adoptCount} 条，保 omz ${keepCount} 条。`);
  lines.push("");
  lines.push("## 二、上游独有但本迭代不采的关联键");
  lines.push("");
  lines.push("| 键 | 决策 | 理由 |");
  lines.push("| --- | --- | --- |");
  {
    let rows = 0;
    // 2a. 上游单侧键（仅 zh 或仅 en）：采了会破坏 zh/en parity 门禁
    const upEnKeys = new Set(data["en-US"].upstream.entries.map(([k]) => k));
    const singleSided = new Set([
      ...merges["zh-CN"].singleSidedSkipped,
      ...merges["en-US"].singleSidedSkipped,
    ]);
    for (const k of [...singleSided].sort()) {
      rows++;
      const side = upEnKeys.has(k) ? "仅 en" : "仅 zh";
      lines.push(
        `| ${k} | 不采 | 上游${side}单侧键（对方 locale 缺失），采入会打破 zh/en 键集合 parity 门禁；待后续迭代随 UI 移植时双侧补齐 |`,
      );
    }
    // 2b. 上游独有的轨迹扩展键
    const upOnlyTraj = diffSet(
      data["zh-CN"].upstream.entries.map(([k]) => k),
      data["zh-CN"].omz.entries.map(([k]) => k),
    ).filter((k) => !inWhitelist(k) && k.startsWith("modelTrajectory."));
    for (const k of upOnlyTraj) {
      rows++;
      lines.push(
        `| ${k} | 不采 | 上游轨迹「compact」扩展键，对应 UI 未随本迭代移植，保 omz 轨迹键集不变 |`,
      );
    }
    if (rows === 0) lines.push("| （无） | - | - |");
  }
  lines.push("");
  lines.push("## 附录 A：品牌改写清单（采纳值内 zcode/ZCode → omz）");
  lines.push("");
  const brandUnion = new Map();
  for (const { id } of locales) {
    for (const [k, before, after] of merges[id].brandRewrites) {
      if (!brandUnion.has(k)) brandUnion.set(k, {});
      brandUnion.get(k)[id] = { before, after };
    }
  }
  if (brandUnion.size === 0) {
    lines.push("（无——本批采纳值未检出品牌字样。）");
  } else {
    for (const [k, v] of brandUnion) {
      for (const { id } of locales) {
        const hit = v[id];
        if (!hit) continue;
        lines.push(
          `- \`${k}\`（${id}）：${JSON.stringify(hit.before)} → ${JSON.stringify(hit.after)}`,
        );
      }
    }
  }
  lines.push("");
  lines.push("## 附录 B：omz 死键清除（conversationShare.*）");
  lines.push("");
  {
    const droppedUnion = new Set([...merges["zh-CN"].dropped, ...merges["en-US"].dropped]);
    const upZhKeys = new Set(data["zh-CN"].upstream.entries.map(([k]) => k));
    const omzSharedDead = merges["zh-CN"].dropped.filter((k) => upZhKeys.has(k)).length;
    const omzUniqueDead = merges["zh-CN"].dropped.length - omzSharedDead;
    lines.push(
      `共 ${droppedUnion.size} 条全量清除（omz 独有 ${omzUniqueDead} + 与上游共享 ${omzSharedDead}）。口径说明：spec/任务写的「14 条」是探索报告按「omz 独有键」子集统计的数字；实测 omz 基线 conversationShare.* 共 ${merges["zh-CN"].dropped.length} 条，经 rg 全仓核实（packages/apps 排除 locales 与文档）零代码引用，均属会话分享功能退役后的死键，故全量清除（上游独有 conversationShare 键本就不在白名单，0 采入）。`,
    );
    lines.push("");
    for (const k of [...droppedUnion].sort()) lines.push(`- \`${k}\``);
  }
  lines.push("");
  lines.push("## 附录 C：基线未触碰键中的品牌残留（登记，不在本批改写范围）");
  lines.push("");
  lines.push(
    "以下键为 omz 基线自带值，含 `zcode/ZCode` 字样，属受保护键值（modelTrajectory.*）、协议字面量（`x-zcode-bot-secret`）、工作区文件名（`.zcodeignore`，协议层刻意保留旧产品名）或 omz 既有「ZCode Agent」文案；不属本批采纳值，未改写。键名含 zcode 的 34 个键为代码消费的标识符（`zcode.error.*`、`settings.zcodeInteractionBehavior*` 等），改名会破坏消费方，同样不动。",
  );
  lines.push("");
  for (const { id } of locales) {
    lines.push(`${id}（${baselineBrandResidue[id].length} 条）：`);
    lines.push("");
    for (const [k, v] of baselineBrandResidue[id]) lines.push(`- \`${k}\`：${JSON.stringify(v)}`);
    lines.push("");
  }
  writeFileSync(paths.arbitrationPath, lines.join("\n") + "\n", "utf8");
}

function writeMergeReport({ merges, baselineBrandResidue, paths, locales }) {
  const lines = [];
  lines.push("# i18n 键级合并报告（上游 v3.16 → omz）");
  lines.push("");
  lines.push(
    "> 由 `scripts/i18n-key-merge.mjs` 自动生成；复跑 `node scripts/i18n-key-merge.mjs --verify` 可只跑断言。",
  );
  lines.push(`> 生成时间：${new Date().toISOString()}。`);
  lines.push("");
  lines.push("## 四栏总表");
  lines.push("");
  lines.push("| 栏 | 定义 | zh-CN | en-US |");
  lines.push("| --- | --- | --- | --- |");
  const zh = merges["zh-CN"];
  const en = merges["en-US"];
  lines.push(`| added | 上游独有白名单键采纳 | ${zh.added.length} | ${en.added.length} |`);
  lines.push(`| kept | 双方都有且值相同 | ${zh.kept.length} | ${en.kept.length} |`);
  lines.push(
    `| changed | 值冲突采上游（含品牌改写） | ${zh.changed.length} | ${en.changed.length} |`,
  );
  lines.push(
    `| kept(omz) | 值冲突保 omz（轨迹桶） | ${zh.conflictKeptOmz.length} | ${en.conflictKeptOmz.length} |`,
  );
  lines.push(
    `| dropped | omz 死键清除（conversationShare.* 全量，见仲裁表附录 B 口径说明） | ${zh.dropped.length} | ${en.dropped.length} |`,
  );
  lines.push(`| 合并后总键数 | - | ${zh.merged.length} | ${en.merged.length} |`);
  lines.push("");
  for (const [id, m] of locales.map(({ id }) => [id, merges[id]])) {
    lines.push(`## ${id} 明细摘要`);
    lines.push("");
    lines.push(`### added（上游独有采纳 ${m.added.length}，按前缀桶）`);
    lines.push("");
    for (const [bucket, n] of countByPrefix(m.added)) lines.push(`- ${bucket}.*：${n}`);
    lines.push("");
    lines.push(`### 上游单侧键跳过（保 zh/en parity，${m.singleSidedSkipped.length}）`);
    lines.push("");
    for (const k of m.singleSidedSkipped) lines.push(`- \`${k}\``);
    if (m.singleSidedSkipped.length === 0) lines.push("（无）");
    lines.push("");
    lines.push(`### 上游独有不采（死桶 0 进入，共 ${m.upstreamOnlyKeptOut.length}，按前缀桶）`);
    lines.push("");
    for (const [bucket, n] of countByPrefix(m.upstreamOnlyKeptOut))
      lines.push(`- ${bucket}.*：${n}`);
    lines.push("");
    lines.push(`### changed（值冲突采上游 ${m.changed.length}）`);
    lines.push("");
    lines.push(`<details><summary>键清单（${m.changed.length}）</summary>`);
    lines.push("");
    for (const k of m.changed) lines.push(`- \`${k}\``);
    lines.push("");
    lines.push("</details>");
    lines.push("");
    lines.push(`### kept(omz)（值冲突保 omz ${m.conflictKeptOmz.length}）`);
    lines.push("");
    for (const k of m.conflictKeptOmz) lines.push(`- \`${k}\``);
    if (m.conflictKeptOmz.length === 0) lines.push("（无——轨迹桶键均为 omz 独有，无值冲突）");
    lines.push("");
    lines.push(`### dropped（死键清除 ${m.dropped.length}）`);
    lines.push("");
    for (const k of m.dropped) lines.push(`- \`${k}\``);
    lines.push("");
    lines.push(`### 品牌改写（采纳值内 ${m.brandRewrites.length} 处）`);
    lines.push("");
    for (const [k, before, after] of m.brandRewrites) {
      lines.push(`- \`${k}\`：${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    }
    if (m.brandRewrites.length === 0) lines.push("（无）");
    lines.push("");
    lines.push(`### 基线未触碰键中的品牌残留（登记不改，${baselineBrandResidue[id].length}）`);
    lines.push("");
    for (const [k, v] of baselineBrandResidue[id]) {
      lines.push(`- \`${k}\`：${JSON.stringify(v)}`);
    }
    if (baselineBrandResidue[id].length === 0) lines.push("（无）");
    lines.push("");
  }
  lines.push("## 断言口径（与脚本内置断言一致）");
  lines.push("");
  lines.push("1. omz 独有键（动态全量枚举，conversationShare.* 除外）合并后逐键存在；");
  lines.push("2. 白名单桶上游独有键（∩ 上游 zh/en 交集）全进；死桶键 0 进入（added ⊆ 白名单）；");
  lines.push(
    "3. 采纳值（added+changed）内 0 处 `zcode/ZCode`（强断言）；基线未触碰键中的既有残留与含品牌键名（代码标识符）仅登记不改，清单见仲裁表附录 C；",
  );
  lines.push("4. `modelTrajectory.*` 全在且值不变；");
  lines.push("5. zh/en 合并后键集合一致（check-i18n-parity 同口径）。");
  lines.push("");
  writeFileSync(paths.mergeReportPath, lines.join("\n") + "\n", "utf8");
}
