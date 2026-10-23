/**
 * i18n 键级合并核心：白名单挑拣 + 值冲突仲裁 + 死键清除。
 */

import {
  BRAND_RE,
  inWhitelist,
  isDroppedKey,
  isDroppedOmz,
  isKeepOmz,
  rewriteBrand,
} from "./config.mjs";

/**
 * 单 locale 合并。
 * canAdopt：上游独有键采纳守卫（跨 locale 交集——上游单侧键不采，保 zh/en parity）。
 * 返回 merged（有序键值对）+ 明细（added/kept/changed/conflictKeptOmz/dropped/
 * upstreamOnlyKeptOut/singleSidedSkipped/brandRewrites），全部供断言与报告消费。
 */
export function mergeOne({ omzEntries, upstreamEntries, canAdopt }) {
  const resultMap = new Map();
  const order = [];
  const dropped = [];
  for (const [k, v] of omzEntries) {
    if (isDroppedOmz(k) || isDroppedKey(k)) {
      dropped.push(k);
      continue;
    }
    resultMap.set(k, v);
    order.push(k);
  }

  const added = []; // 上游独有白名单键（采纳）
  const upstreamOnlyKeptOut = []; // 上游独有但不在白名单（死桶，不进）
  const singleSidedSkipped = []; // 上游单侧键（仅 zh 或仅 en 有），不采以保 parity
  const kept = []; // 双方都有且值相同
  const changed = []; // 值冲突且采上游（含品牌改写后）
  const conflictKeptOmz = []; // 值冲突但保 omz（轨迹桶）
  const brandRewrites = []; // [key, 上游原值, 改写后值]

  for (const [k, upstreamValue] of upstreamEntries) {
    if (!resultMap.has(k)) {
      if (isDroppedKey(k)) {
        dropped.push(k);
        continue;
      }
      if (inWhitelist(k)) {
        if (!canAdopt(k)) {
          singleSidedSkipped.push(k);
          continue;
        }
        const next = rewriteBrand(upstreamValue);
        if (next !== upstreamValue) brandRewrites.push([k, upstreamValue, next]);
        resultMap.set(k, next);
        order.push(k);
        added.push(k);
      } else {
        upstreamOnlyKeptOut.push(k);
      }
      continue;
    }
    const omzValue = resultMap.get(k);
    if (omzValue === upstreamValue) {
      kept.push(k);
      continue;
    }
    if (isKeepOmz(k)) {
      conflictKeptOmz.push(k);
      continue;
    }
    const next = rewriteBrand(upstreamValue);
    if (next !== upstreamValue) brandRewrites.push([k, upstreamValue, next]);
    resultMap.set(k, next);
    changed.push(k);
  }

  const merged = order.map((k) => [k, resultMap.get(k)]);
  return {
    merged,
    added,
    kept,
    changed,
    conflictKeptOmz,
    dropped,
    upstreamOnlyKeptOut,
    singleSidedSkipped,
    brandRewrites,
  };
}

/** 集合差：a − b（保持 a 的去重顺序）。 */
export function diffSet(a, b) {
  const bSet = b instanceof Set ? b : new Set(b);
  return [...new Set(a)].filter((k) => !bSet.has(k));
}

function topBucket(key) {
  const dot = key.indexOf(".");
  return dot < 0 ? key : key.slice(0, dot);
}

/** 按首段前缀桶计数，降序。 */
export function countByPrefix(keys) {
  const map = new Map();
  for (const k of keys) {
    const b = topBucket(k);
    map.set(b, (map.get(b) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** 值含品牌字样的条目。 */
export function brandResidue(entries) {
  return entries.filter(([, v]) => BRAND_RE.test(v));
}
