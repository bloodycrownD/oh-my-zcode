# CR Fix Spec: 双分支合并 + 合并暴露修复（diff 模式单轮）

## 元信息
- repo：D:\Dev\Js\oh-my-zcode\omz（main）
- base_sha：ba7c240 / head_sha：2be607a（已 push origin/main）
- 评审范围：4 提交 = 1dbe627（merge official-endpoints）+ 339bafc（merge desktop-long-session-perf，3 文件 7 块人工裁决）+ 3968844（bootstrap title 可选链）+ 2be607a（agent env 随附 Built-in 基线）
- mode：diff（小范围单轮，readonly 子代理评审）
- review_round：1 / dag_version：1
- 状态：**fix-spec-ready（无必须修复项）**

## Must-fix

无。评审结论=**通过**（P0=P1=P2=0，无 open spec_deviations）。

### 裁决保真核验摘要（评审子代理逐块验证）
- TurnGroup：official 删 OffPeakTurnCards 落地、perf 的 WorkingDurationText 存活 ✓
- Timeline：删 liveNowMs 全局 tick+分享布局同步落地；增量缓存/turn rail/jumpLoading 存活；rail 条件随 hideTurnNavigator 移除收窄 ✓
- SessionPane：分享机器整删；isDraft/sessionLeaseReady/timelineSnapshot 保留 perf 上提位；sessionPhase={sessionRenderPhase} 单源；shareSelection/handleLoadAllOlder 已删 ✓
- 已删标识符全局 grep 零残留（liveNowMs 仅存于 WorkingDurationText 局部 tick=设计如此）✓
- sessionPhase 链路完整：SessionPane:539→:3656→Timeline props:369→renderUnits build:463 同源 ✓
- 2be607a 行为矩阵：桌面 agent bundled/active 角色正确；standalone 行为不变；zcodeBuiltinRemote 仍仅 standalone（不违反远端下发冻结）；双 host 形态基线路径有效；services 显式覆盖 env 阻断外部污染 ✓
- 3968844：`source?.title?.trim()` 与后续比较逻辑自洽 ✓
- 注释修正与现状一致 ✓

## Spec deviations
- none

## Open questions / 待拍板
- none

## 已豁免（用户确认不修）
- 无

## 合并后 QA（manual_user，不阻塞）
- jump 跳转实机点验（E2E 隐藏窗口 harness 限制未能断言；代码与已验证分支同）
- B-1 双 pane 滚动 / E-3 truncated 提示 / J-2 窄会话无 48px 空档（沿用主 cr-fix-spec 的 manual QA 清单）

## K 节建议（下游执行时闭合，非阻塞）
- G 建议（可选）：2be607a 补「旧 schema Active 缓存+随包基线」集成测试；3968844 补 seedSharedContextImport title=undefined 单测

## Fix-Spec Closure

| 项 | 状态 |
|---|---|
| fix-spec-ready | **yes（无必须修复项）** |
| fix_spec_path | docs/iterations/desktop-long-session-perf/cr-fix-spec-merge.md |
| dag_version / review_round | 1 / 1 |
| P0 / P1 / P2（已写入 fix-spec） | 0 / 0 / 0 |
| 未写入的开放 must-fix | 0 |
| spec_deviations | none |
| C-orch | ✅（env 交接编排已核） |
| C 类合并后 QA | jump 实机 + 主 fix-spec manual 清单 |
