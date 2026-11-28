# CR Fix Spec: magic-context-tool-media-roundtrip

## 元信息

- repo：D:\Dev\Js\oh-my-zcode（分支 `fix/magic-context-tool-media-roundtrip`）
- base_sha / head_sha：`1a4db83b` / `92603773`
- prd_path：未提供（以 spec 为准）
- spec_path：`docs/iterations/magic-context-tool-media-roundtrip/spec.md`
- review_round / dag_version：2 / 2（round 2 为 review-final 认证轮）
- 状态：fix-spec-ready（用户已确认执行；2026-11-29 已按本 fix-spec 完成）

## 评审结论摘要

- 首轮（round 1）：review-scope-a（magic-context 包侧）、review-scope-b（bootstrap / adapters / e2e 宿主侧）、review-global 同波次、互盲、只读。三者均 scope-ready / 全局建议 yes；P0 = P1 = 0。
- 三位审查者各自实跑了测试：test-transform 75/75、test-host 34/34、bootstrap T-H 5/5、adapters T-A1 5/5、e2e 7 PASS，以及既有回归 fork-inherit 11/11、mural-media-blocks 5/5、bootstrap test:magic-context 23/23。
- 实现代码无需改动；must-fix 全部是文档登记与注释层面的 P2。

## Must-fix（按 P0 → P1 → P2）

### review-scope-a/A-1 [P2] spec 第 71 行与第 78 行对「无媒体但含非 text 块」的规定自相矛盾

- 维度：A
- 文件：`docs/iterations/magic-context-tool-media-roundtrip/spec.md:71`
- 问题：第 71 行写「没有媒体块的工具结果：不写 `attachments`、不写 `mediaLayout`，投影形状与今天逐字节相同」；第 78 行写「其余块（resource_link、无 dataUrl 的 image/video、带非空 text 的 file…）不进 attachments，只在 layout 里保留浅拷贝，往返仍逐字节等值」，T-M2 的 layoutOnly 矩阵（spec.md:169）按第 78 行断言。两条对「无媒体但含非 text 块」给出相反规定。实现（`apps/zcode-cli/packages/magic-context/src/host/types.ts:434-439`，`hasNonTextBlock` 置位即写 layout）走的是第 78 行一侧，这是正确的一侧（Read PDF 带提取文本是常见真实条目，按第 71 行字面会把它反投影回字符串，违背设计目标 2）。
- 改法：把第 71 行收窄为「**纯文本结果（字符串，或全部为 text 块）：不写 `attachments`、不写 `mediaLayout`，投影形状与今天逐字节相同**」。纯文档改动，不动代码。
- 验收/测试：通读 spec 第 60–80 行不再有互斥表述；`node apps/zcode-cli/packages/magic-context/scripts/test-host.mjs` 中 T-M2 layoutOnly 组保持通过（不受影响，作为回归确认）。
- 来源：review-scope-a / round 1

### review-global/C-doc-1 [P2] e2e 脚本未登记进最终项目结构树与变更点清单

- 维度：A / C-orch
- 文件：`docs/iterations/magic-context-tool-media-roundtrip/spec.md:119-136`（最终项目结构树）、`:140-150`（变更点清单）
- 问题：后补交付物 `docs/iterations/magic-context-tool-media-roundtrip/e2e/e2e-tool-media.mjs`（提交 0bb3d41b）只出现在测试策略章节（spec.md:197-201），结构树与变更点清单都没有它，测试矩阵与交付清单一一对应有缺口。
- 改法：结构树补一行 `e2e/e2e-tool-media.mjs`；变更点清单补一行「e2e-tool-media.mjs — 新增 — 不调模型的真实链路 e2e（T-E1~T-E3）」，阶段列写 Step 8。
- 验收/测试：spec 内 `e2e-tool-media.mjs` 出现在结构树、变更点清单、测试策略三处。
- 来源：review-global / round 1

### review-global/C-doc-2 [P2] test-host.mjs 里两个含义不同的「T-M6」撞号

- 维度：C（命名）
- 文件：`apps/zcode-cli/packages/magic-context/scripts/test-host.mjs:516`（旧迭代 S24-fix2 的 "The T-M6 root cause" 注释）、`:1180`（本迭代新 T-M6）
- 问题：同文件两个 T-M6 含义不同，后读者易混淆。
- 改法：给本迭代的 T-M6 用例标题与注释加上迭代归属，例如改为「T-M6（tool-media-roundtrip）toolResultContentOf 宿主层断言」，旧注释不动。
- 验收/测试：`node apps/zcode-cli/packages/magic-context/scripts/test-host.mjs` 34/34 通过；`grep -n "T-M6" test-host.mjs` 两处都能一眼分清归属。
- 来源：review-global / round 1

## Spec deviations

- none（open）。`src/index.ts:682-683` 额外导出 `ToolResultAttachment`、`ToolResultMediaLayoutItem`，超出 spec 变更点清单所列，属加性、良性（二者被 `ToolLikePart.state` 引用），在 K 节顺手补登记。

## Open questions / 待拍板

不阻塞，由用户决定是否处理：

1. 带非空 `text` 的 image / `video/*` file 块：按现行判据会收进 attachments，其文本既并入 output 又留在媒体块上；当 output 被改写（加 §N§ 前缀 / drop）时该文本可能双渲染。现实生产方（read.ts / node_repl / MCP）不在媒体块上带 text，pdf 臂已排除带文本情形。是否把「text 非空」从 image/video 臂也排除，属产品口径，未认定。
2. `apps/zcode-cli/packages/bootstrap/scripts/test-tool-result-media-roundtrip.mjs:92-100` 的 `readImageBlock` 注释说与 core read.ts `formatReadImageOutput` 同形，但 fixture 的 source 只有两键（真实为 `id, kind, mimeType, placeholder, sizeBytes` 五键）。不影响结论，只是注释精度；K 节给出顺手校正步骤。
3. e2e `:311-312` harness fallback `?? "opencode"` 几乎是死分支（实际取到 `zcode`），无行为影响，可不改。

## 已豁免（用户确认不修）

- 无。

## 合并后 QA（manual_user）

- 不阻塞。Step 8 桌面真机验收已于 2026-11-29 完成（会话 sess_089aa497：glm-5.4 Read PNG 后 model-io 的 tool_result 带 image 块、模型直接描述画面），记录见 spec Step 8 执行记录。
- 若合并后想在日常使用中复核：用 glm-5.4 让模型 Read 一张图并描述，再查 `~/.omz/cli/debug/model-io-<sessionId>.jsonl` 中该 tool_result 是否带 image 块。不要用 GLM-5.3 判断（bigmodel 通道会把它转成托管文件并引导模型走 analyze_image）。

## K 节建议（下游执行时闭合）

1. **提交卫生**：`apps/zcode-cli/packages/bootstrap/src/app/magic-context-turn-transform.ts:2154-2164` 夹带一个与本迭代无关的 `logger.warn` 纯格式重排（oxfmt 副产品，语义等价）。两种处置任选其一并在提交说明里注明：(a) 还原为 BASE 形态以保持 diff 最小；(b) 保留，因为它是仓库格式化门禁（oxfmt）的产物，还原后 `fmt:check` 可能报该文件。执行者先跑 `pnpm exec oxfmt --check <该文件>` 判定——若还原后检查失败则选 (b)。
2. **注释精度**：`test-tool-result-media-roundtrip.mjs:92-100` 的 `readImageBlock` fixture 注释改为如实描述（source 只保留 `id, placeholder` 两键的简化形状），或把 fixture 补成五键真实形状。
3. **变更点清单补全**：spec 变更点清单补一行「`src/index.ts` — 导出 `toolResultContentOf`、`ZCodeToolResultContent`、`ToolResultAttachment`、`ToolResultMediaLayoutItem`」。
4. **风险表归因措辞**：spec:111 / :211 把「fork 继承锚点区分度下降（纯图片结果 output 为空）」列为本改动的风险；全局审查核对认为纯图片 output="" 是改前既有形态、非本次回归。建议把该行措辞改为「改前已存在的形态，本改动不改善也不恶化」。
5. 收尾门禁（执行 fix-spec 后由下游跑）：`node scripts/test-host.mjs`（34/34）、`pnpm exec oxfmt --check` 对改动文件、`pnpm lint` 不高于基线 179 warnings / 0 errors、改动文件 LF 行尾。

## Fix-Spec Closure

| 项 | 状态 |
|---|---|
| fix-spec-ready | yes |
| fix_spec_path | `docs/iterations/magic-context-tool-media-roundtrip/cr-fix-spec.md` |
| dag_version / review_round | 2 / 2 |
| review-global 每轮参与 | yes |
| 末轮 review-final | 通过（在本次 spec-fix 落盘之后派出，建议 fix-spec-ready: yes） |
| P0 / P1 / P2（已写入 fix-spec） | 0 / 0 / 3 |
| 未写入的开放 must-fix | 0 |
| spec_deviations | none |
| C-orch | ✅ 还原入口唯一、判据与 contracts 同构、core 消费点无遗漏 |
| C 类合并后 QA | 见上，不阻塞 |
