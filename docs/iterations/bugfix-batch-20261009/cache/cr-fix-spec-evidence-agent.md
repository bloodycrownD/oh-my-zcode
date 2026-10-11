# CR Fix-Spec 证据包：① agent 域——主代理手工审查（兜底）

- 审查对象：`docs/iterations/bugfix-batch-20261009/cr-fix-spec.md`
- 仓库：`D:\Dev\Js\oh-my-zcode\omz`；sha：5a35027；轮次：spec-check r1
- 取证方式：evidence 代理 provider 故障（原始+重派均亡，未留包）。锚点事实采用两源交叉：① code-review-loop wave-2 review-full 已对同批锚点逐文件核对（20 处抽查 18 准确，偏差均在 ⑥/e2e-R-1 且已由 r1 修订校正）；② 主代理对本域独有风险点（测试组号/用例数/sendText 覆盖缺口）手工复核。标注：**部分为二手交叉+定点手工**，judge 可按需抽验。
- 规则：git 只读；未修改任何代码/spec。

## agent/G-1（P1）sendText pin 零测试

- `session-flow.ts:200-203`（`:203` `modelSelectionPinned: payload.modelSelection !== undefined`）——review-full 已核对准确。
- **主代理手工复核（本域关键增量）**：`bootstrap/scripts/test-edit-retry-model.mjs` 现有 12 例，组号占用 A1/B1-B3/C1-C3/D1-D5：
  - D 组覆盖 sendGoalCommand（D1/D2）、createSession firstInput（D3/D4）、legacy session/send（D5）——**sendText 确无任何用例**，spec「五路径只测四条」准确。
  - 组号 **E、F 空闲**——spec 的「增 E 组两例」（G-1）与「增 F 组两例」（G-2）无编号冲突。
  - 「12+2 例全绿」口径与现状（12）自洽。
- 结论：**无问题**。

## agent/G-2（P2）pin 不持久化/不进 queue 提升无测试

- `input-intent-persistence.ts:32-35`、`input-intent.ts:118-119`——review-full 已核对准确；F 组空闲（见上）。**无问题**。

## agent/B-1（P2）mapper 过滤零观测

- `session-mapper.ts:146-151`（`:150` filter，无计数无日志）——wave-1 + review-full 双重核对准确；`server-operations.ts:3411` 唯一调用点传 logger 可行。**无问题**。

## agent/C-1（P2）默认模型回落三处重复

- `create-app.ts:576-580`、`runtime-config.ts:285-289`、`session-facade.ts:505-507`——review-full 已核对准确（含 entrypoint accessor 透传）。**无问题**。

## e2e/R-3（P2）mapMessagePart 无 default 根治

- `message-mapper.ts:63-158`（switch :69-158 无 default，未知 type → undefined）——review-full + wave-1 双重核对准确。**无问题**。

## ① 域可疑点汇总
无新增（锚点与可行性均有双重核对背书；E/F 组号经主代理直接复核无冲突）。
