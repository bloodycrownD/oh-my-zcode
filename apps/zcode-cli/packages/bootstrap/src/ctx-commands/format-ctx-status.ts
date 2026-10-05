// `/ctx-status` 的排版（Step 30 / D-13）。
//
// 刻意与 `ctx-command.ts` 分文件：渲染是**宿主特有**的纯排版，同一份快照将来还要
// 喂给桌面面板（那里要的是结构化字段），所以它只依赖快照类型、不碰库。

/**
 * Step 30 / D-13 的 `/ctx-status` 渲染器。
 *
 * **查询语义一个字没动**：数据仍然全部来自 `readMagicContextStatusSnapshot`，这里只
 * 重新排版。
 *
 * 排版上做的四件事：
 *   1. **分节带标题**：`BUDGET` / `COMPARTMENTS` / `TAGS` 三段各自成块，值对齐在同一
 *      列上——旧版每行一个 `label: value`，数字列随 label 长度漂移，扫不出量级。
 *   2. **千分位**：`1,234,567` 比 `1234567` 好读一个数量级（token 数动辄七位）。
 *   3. **未知值统一 `-`**：与包侧同义，但收在一处产出，不再散在模板字符串里。
 *   4. **读不出来时一句话说清**：不再把一段失败文案混进正常布局。
 *
 * 导出仅供同包 `run-ctx-command.ts` 调用，随它经 `@zcode/bootstrap/ctx-commands` 对外；
 * 排版断言直接打在这份实现上。
 */
export function formatCtxStatus(
  snapshot: Awaited<
    ReturnType<typeof import("@zcode/magic-context").readMagicContextStatusSnapshot>
  >,
): string {
  if (!snapshot) return "Magic Context status unavailable for this session.";

  const sections = [
    section("BUDGET", [
      ["protected floor", formatNumber(snapshot.protectedTokensFloor)],
      ["last context usage", `${formatNumber(snapshot.contextPercentage)}%`],
      ["last input tokens", formatNumber(snapshot.lastInputTokens)],
    ]),
    section("COMPARTMENTS", [
      ["count", formatNumber(snapshot.compartmentCount)],
      ["last compacted message", formatNumber(snapshot.lastCompartmentEndMessage)],
      ["pending operations", formatNumber(snapshot.pendingOps)],
    ]),
    section("TAGS", [
      ["active", tagBucket(snapshot.tags.active)],
      ["dropped", tagBucket(snapshot.tags.dropped)],
      ["compacted", tagBucket(snapshot.tags.compacted)],
    ]),
  ];
  // 段间空一行：TUI 里 `/ctx-status` 常连着好几轮输出，没有分隔就会糊成一块。
  return ["Magic Context status", `session  ${snapshot.sessionId}`, "", sections.join("\n\n")].join(
    "\n",
  );
}

/** 一段：`TITLE` + `label  value`，label 补齐到同一列宽。 */
function section(title: string, entries: readonly (readonly [string, string])[]): string {
  const width = Math.max(...entries.map(([label]) => label.length));
  return [title, ...entries.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)].join(
    "\n",
  );
}

function tagBucket(bucket: { count: number; tokens: number }): string {
  return `${formatNumber(bucket.count)} (${formatNumber(bucket.tokens)} tokens)`;
}

/** 未知 = `-`（`null` / `NaN` / `undefined` 一律同义，不再让 `null` 打印成 "null"）。 */
function formatNumber(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return Math.trunc(value).toLocaleString("en-US");
}
