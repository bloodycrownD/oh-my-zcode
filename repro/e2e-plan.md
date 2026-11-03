# E2E 复现与验收协议（模型选择器空显示）

## 阶段

1. **E2E 日志锚点**：不改逻辑，只在关键 render 处打点，拿到状态快照。
2. **多次复现**：同一操作路径至少 3 次成功复现，每次记录日志与 `data-*` 值。
3. **定死代码**：日志签名必须能唯一指向一条代码路径；指向不了就继续加探针，不修。
4. **修复**：只改被日志钉死的那条路径。
5. **修后回归**：同一 E2E 脚本 3 次全绿，且原单测/复现套件转绿。

## 必须记录的字段

在 `useDraftConfigControl` 的 render 与 `V4ComposerToolbar` 的 render 各打一条：

```json
{
  "phase": "draft-config",
  "workspacePath": "...",
  "sessionId": "new-task | sess_xxx",
  "initialization": "new-task | session | promotion",
  "draft.textLen": 0,
  "draft.mode": "build | yolo | plan | undefined",
  "draft.modelSelection": {
    "providerId": "...",
    "modelId": "...",
    "options": { "reasoningLevel": "..." }
  },
  "modelSelectionView.status": "ready | loading | unavailable | error",
  "view.effectiveSelection": null,
  "view.preferredSelection": null,
  "view.selectionIssue": null,
  "derived.effectiveSelection": null,
  "submissionReady": false
}
```

```json
{
  "phase": "model-toolbar",
  "modelMenuVisible": true,
  "modelSelectionState.status": "ready",
  "normalizedModelValue": "",
  "triggerLabel.fullLabel": "",
  "triggerLabel.modelLabel": "",
  "data-testid": "TID_V4_MODEL_CONFIG",
  "data-provider": "",
  "data-model": "",
  "data-mode": "build"
}
```

## 复现矩阵（每种至少 3 次）

| 变体 | 草稿状态                                                 | 期望观察                          |
| ---- | -------------------------------------------------------- | --------------------------------- |
| A    | `text=""`, `mode="build"`, 无 `modelSelection`           | 右下角模型名为空，`data-model=""` |
| B    | `text` 非空, `mode="build"`, 无 `modelSelection`，冷启动 | 同上，且刷新后仍空                |
| C    | `text` 非空, `mode="build"`, 有有效 `modelSelection`     | 对照：模型名正常                  |
| D    | 先切模式再切模型、清空正文、切会话                       | 记录状态如何进入 A/B              |

## 判定“定死”的条件

- 3 次复现的日志签名完全一致；
- 日志能明确指出是 `initializeNewTaskDraft` 未执行、还是 `effectiveSelection` 为空、还是 view 未 ready；
- 把该条件临时改对后，同一 E2E 脚本转绿（突变验证）。

## 修后回归

- 同一脚本 3 次全绿；
- `pnpm test:repro` 从 10 个失败用例转为 10/10 全绿；
- 正常路径（有有效选择）不出现回归。
