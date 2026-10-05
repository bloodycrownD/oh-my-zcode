// conversationProjectionCore 的可测性地基用例（T-AP2 前置）。
// 硬约束：本文件与被测模块的传递依赖链零 `@/` 导入，只能用相对路径或 `@zcode/*`。
import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { mergeOlderRows } from "../src/v4/conversationProjectionCore.js";

/** 最小 userInput 行：mergeOlderRows 只读 rowId/turnId，构造足够即可。 */
function row(rowId: number, turnId = `turn-${rowId}`): ConversationRow {
  return {
    rowId,
    turnId,
    createdAt: 1,
    createdAtSeq: rowId,
    kind: "userInput",
    text: `row-${rowId}`,
    origin: "realUser",
  } as ConversationRow;
}

const ids = (rows: readonly ConversationRow[]): number[] => rows.map((item) => item.rowId);

test("只并入窗口首行之前的行并按 rowId 升序前插", () => {
  const merged = mergeOlderRows([row(10), row(11)], [row(8), row(9)]);
  assert.deepEqual(ids(merged ?? []), [8, 9, 10, 11]);
});

test("窗口内已存在的行不会被 fetched 重复引入", () => {
  // fetched 混入已在窗口内的 10 与窗口之后的 12：都不得进入结果。
  const merged = mergeOlderRows([row(10), row(11)], [row(9), row(10), row(12)]);
  assert.deepEqual(ids(merged ?? []), [9, 10, 11]);
});

test("无可并入行时返回 null，调用方据此不换 window 引用", () => {
  assert.equal(mergeOlderRows([row(10), row(11)], []), null);
  assert.equal(mergeOlderRows([row(10), row(11)], [row(10), row(11), row(12)]), null);
});

test("空窗口时 fetched 全部算更早行（firstRowId 退化为正无穷）", () => {
  assert.deepEqual(ids(mergeOlderRows([], [row(1), row(2)]) ?? []), [1, 2]);
  assert.equal(mergeOlderRows([], []), null);
});

test("合并结果保留 fetched 原始相对顺序与窗口原有行序", () => {
  const older = [row(3, "turn-b"), row(1, "turn-a")];
  const window = [row(5, "turn-c"), row(6, "turn-d")];
  const merged = mergeOlderRows(window, older);
  assert.deepEqual(ids(merged ?? []), [3, 1, 5, 6]);
  // 原窗口数组不被就地修改。
  assert.deepEqual(ids(window), [5, 6]);
});
