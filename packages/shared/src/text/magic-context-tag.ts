// Magic Context `§N§` 标签的剥离工具（落库边界与消费端共用）。
//
// 语义逐字对齐上游
// `.reference/magic-context/packages/plugin/src/hooks/magic-context/tag-content-primitives.ts`：
//   - stripMagicContextTagPrefix   ← 上游 stripTagPrefix（同文件 L115-130）
//   - stripMagicContextTagNotation ← 上游 stripPersistedAssistantText（同文件 L95-104，
//                                    由上游 text-complete.ts:27-35 在持久化边界调用）
//   - hasMagicContextTagNotation   ← 本仓新增的只读探测（上游无对应物）
//
// 为什么不能只在存储层直接丢掉标签：MC 的 § 打标是它自己的消息身份与提示词缓存锚
// （transform 每轮按 tag id 重新打标），运行期必须原样保留；需要剥掉的只是模型把
// 「每条回复以 §N§ 开头」这条提示词要求抄进正文后产生的**可见前缀**。因此剥离放在
// 两个边界：①落库前（新数据不再写入可见前缀）；②消费端读取时（历史库已有的前缀在
// 展示/复制/搜索/预览时剥掉，不回刷历史库）。
//
// 正则逐字保留上游形态，不要「优化」：畸形 hybrid（`§15298">§`）与悬空（`§103012$`）
// 形态都带精度守卫，改动会吃掉正常正文（例如章节引用 `§5.1`、裸前导数字 `99 files`）。

// 良构标签前缀：一个或多个 `§N§`，token 之间允许空白。
const TAG_PREFIX_REGEX = /^(?:§\d+§\s*)+/;

// 畸形 hybrid 前缀修复（仅前缀；全局形态见 MALFORMED_TAG_GLOBAL_REGEX）。
//
// 模型偶尔会在 assistant 文本开头写出乱码式标签引用，生产观察到的形态：
//
//   §15298">§15298§ hello...  ← 同一编号出现两次，中间插入 `">`
//   §15298">§ hello...        ← 只有半边，没有闭合数字
//   §15298">§ §15298§ hello   ← 半边残桩后跟一个正常标签
//
// 根因是 `§N§` 格式与旧渲染分隔标签里的带引号序号/日期属性发生了 token 级混淆。
// 当前 <session-history> 字节用 `## N-M · date · title` 标题，但已缓存的 m0 在下一次
// 自然折叠前保持字节不变，所以这段修复必须继续接受旧格式教出来的畸形前缀。
//
// 该正则让 stripMagicContextTagPrefix 在下一次打标之前清掉畸形前缀；否则
// `/^(?:§\d+§\s*)+/` 匹配不到、畸形前缀原地留下，又在其前面打一个新 `§N§ `，
// 形成双标签并在此后每次 transform 中被强化。
const MALFORMED_TAG_PREFIX_REGEX = /^(?:§\d+">§(?:\d+§)?\s*)+/;

// 悬空开标签：`§` + 数字但没有第二个 `§` 闭合——模型开了我们的标签格式后自己编了个
// 闭合符（或干脆丢掉）。观察到的闭合符都是标点/符号/非 ASCII（`§103012$`、`§11865ҩ`、
// `§42">` 残桩），从不是字母，所以最多消费一个非单词字符作为闭合符。锚定我们自己的
// `§\d+` 开头（而不是同形字表——`§` 没有有意义的易混字符集，换一个模型就会换一个杂字符）
// 才是可靠信号：正常内容不会用 `§` + 数字开头一个 token。没有这条，stray-`§` 那一步
// 只剥 `§`，把数字 + 闭合符孤零零留在文本里（`§103012$` → `103012$`）。
//
// 执行顺序在完整对与 `">` hybrid 之后（此时良构 `§N§` 与 `§N">§` 已清掉），
// 在 stray-`§` 之前。
//
// 两条精度守卫，避免误伤真实内容：
//   - `(?!\.\d)` —— `§` + 数字 + 小数（`§5.1` 是章节引用）不算悬空标签，
//     留给 stray-`§` 那一步（`§5.1` → `5.1`）。
//   - 闭合符排除 `\w` 与 `.` —— 不吃后面的字母（`§42important` → `important`）
//     或句号；空白被排除，所以空格后的正文保留（`§42 files` → ` files`）。
const DANGLING_TAG_GLOBAL_REGEX = /\u00a7\d+(?!\.\d)[^\s\u00a7\w.]?/g;
// 前缀变体不要在没有重建门禁的情况下改动：上游的 tool 输出/text part 每轮都从宿主文本
// 重新打前缀（不落盘、无 epoch），改剥离规则会改变部署后第一次普通 pass 的字节，
// 并从该块起击穿提示词缓存。它确实会吃掉开头的章节引用（`§5 of the contract` →
// `of the contract`），修这个问题只影响观感，且只在已经在重建的 pass 上才安全。
const DANGLING_TAG_PREFIX_REGEX = /^(?:\u00a7\d+(?!\.\d)[^\s\u00a7\w.]?\s*)+/;

/** 良构前导 `§N§` 对（持久化边界只剥开头，对应上游 stripWellFormedLeadingTagPrefix）。 */
const WELL_FORMED_LEADING_TAG_PREFIX_REGEX = /^(\u00a7\d+\u00a7\s*)+/;

/** 任意位置的良构 `§N§` 对（持久化残余清理）。 */
const COMPLETE_TAG_PAIR_GLOBAL_REGEX = /\u00a7\d+\u00a7/g;

/** 任意位置的畸形标签/XML hybrid 形态（持久化残余清理）。 */
const MALFORMED_TAG_GLOBAL_REGEX = /\u00a7\d+">(?:\u00a7(?:\d+\u00a7)?)?/g;

/** 完整对/畸形形态清掉后残留的孤立 `§`（仅持久化清理）。 */
const STRAY_SECTION_CHAR_REGEX = /\u00a7/g;

/**
 * 只剥文本开头的 `§` 形态 MC 标签，对应上游 `stripTagPrefix`（L115-130）。
 *
 * 不剥裸前导数字——它们可能是合法用户内容（`99 files`、`2024 roadmap`、编号列表）。
 * 支持正常 `§N§` 叠加、畸形 hybrid `§N">§`、悬空 `§N$`；最多迭代 8 轮以覆盖
 * 「剥完一层又露出下一层」的叠加形态。
 */
export function stripMagicContextTagPrefix(value: string): string {
  let stripped = value;
  for (let pass = 0; pass < 8; pass++) {
    const prev = stripped;
    stripped = stripped.replace(MALFORMED_TAG_PREFIX_REGEX, "");
    stripped = stripped.replace(TAG_PREFIX_REGEX, "");
    // 悬空开标签放在最后：良构 `§N§` 必须先被 TAG_PREFIX_REGEX 消费，否则这里会剥掉
    // `§N` 而把闭合 `§` 孤立出来（`§42§ hi` → `§ hi`）。在这里识别它，才能阻止下一轮
    // 打标在抄来的 `§N$` 前面再补一个 `§M§`，避免每轮在上下文里复合强化。
    stripped = stripped.replace(DANGLING_TAG_PREFIX_REGEX, "");
    if (stripped === prev) break;
  }
  return stripped;
}

/**
 * 助手文本完整剥离，对应上游 `stripPersistedAssistantText`（L95-104）。
 *
 * 顺序：前导良构 → 全局 `§N§` 对 → 畸形 hybrid → 悬空 `§N<closer?>` → 残余 `§` → trim。
 * 只剥 `§` 形态标签，绝不剥裸前导数字（`99 files`、`2024 roadmap`、`1. do this` 原样保留）。
 */
export function stripMagicContextTagNotation(value: string): string {
  let text = value.replace(WELL_FORMED_LEADING_TAG_PREFIX_REGEX, "");
  text = text.replace(COMPLETE_TAG_PAIR_GLOBAL_REGEX, "");
  text = text.replace(MALFORMED_TAG_GLOBAL_REGEX, "");
  // 先清悬空 `§N$` / `§Nҩ`（自编闭合符），再清 stray-`§`，
  // 让数字 + 闭合符作为整体移除，而不是被孤立出来。
  text = text.replace(DANGLING_TAG_GLOBAL_REGEX, "");
  text = text.replace(STRAY_SECTION_CHAR_REGEX, "");
  return text.trim();
}

/**
 * 文本是否含 MC 标签记法（判定标准与 {@link stripMagicContextTagNotation} 同源：
 * 剥完是否与原文去首尾空白后不同）。
 */
export function hasMagicContextTagNotation(value: string): boolean {
  return stripMagicContextTagNotation(value) !== value.trim();
}
