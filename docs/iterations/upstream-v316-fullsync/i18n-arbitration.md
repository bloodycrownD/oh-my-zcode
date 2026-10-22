# i18n 逐键仲裁表（上游 v3.16 → omz）

> 由 `scripts/i18n-key-merge.mjs` 自动生成；上游快照见 `cache/upstream-locales/`。
> 生成时间：2026-10-22T11:59:54.336Z；omz 基线：合并前 `packages/ui/src/i18n/locales/`。

仲裁规则（spec §phase-i18n + 实施补充）：

1. 双方都有但值不同的键，默认**采上游新文案**；
2. `modelTrajectory.*`（轨迹面板 omz 专属语义）**保 omz**；
3. 采纳值内 `zcode/ZCode` 品牌字样统一改写为 `omz`（产品名；路径字面量核对真实产品面后改写，见附录 C）；
4. 上游独有键仅白名单桶采纳，且需上游 zh/en 双侧皆有（单侧键不采，保 parity 门禁）；死桶 0 进入（见合并报告，不在本表）；
5. omz `conversationShare.*` 死键全量清除（口径见附录 B）。

## 一、值冲突仲裁（zh/en union 138 条，全覆盖）

| 键 | 决策 | 理由 |
| --- | --- | --- |
| bots.allowedWorkspaces | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| bots.allowedWorkspaces.allDescription | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| bots.allowedWorkspaces.mode.all | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| bots.allowedWorkspaces.mode.selected | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| bots.allowedWorkspaces.selectedDescription | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| bots.description | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| bots.runtime.telegramLongPollingHandledElsewhere | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| bots.setup.guide.webhook.bind.1 | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| bots.setup.guide.webhook.create.1 | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| bots.setup.guide.weixin.create.2 | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| bots.setup.guide.weixin.create.3 | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| chat.backgroundResult.workflow.stall.cap | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| chat.changeSummary.rewindDialog.description | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=equal/en=changed） |
| chat.cuaReadiness.toolsNotLoaded | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| chat.cuaReadiness.toolsPreparing | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| chat.edit.resetConversationAndFiles.unavailable | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| chat.empty.workspaceSearchEmpty | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| chat.empty.workspaceSearchPlaceholder | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| chat.placeholder.newTask | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| chat.placeholder.newTaskMobile | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| chat.plan.removeMarker | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| chat.quota.mcp.codingPlanRequired | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| chat.quota.mcp.quotaExhausted | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| chat.toolbar.computerUse.tooltip.error | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| chat.toolbar.computerUse.tooltip.ready | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| chat.toolCall.workflow.run.concurrency.label | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| chat.toolCall.workflow.run.settings.limit | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| chat.toolCall.workflow.run.settings.limit.decrease | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| chat.toolCall.workflow.run.settings.limit.increase | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| chat.workflowLaunch.settings.limit | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| cuaPermission.modal.relaunchAppButton | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| cuaPermission.modal.relaunchAppHint | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| cuaPermission.ready.sessionValidationHint | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| cuaPermission.tools.untrustedRuntime | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| directoryBrowser.go | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| directoryBrowser.selectDir | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| directoryBrowser.title | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| docker.noContainers | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| docker.unavailable | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| feedback.submit.simple.logsHint | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| feedback.submit.template.section.copyErrorHeading | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| forceUpdate.title | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| login.description | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| login.title | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| logout.confirm.title | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| markdownImage.downloadSucceeded | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| occupationOnboarding.description | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=equal） |
| occupationOnboarding.modeDescription | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| offPeak.form.instructionsPlaceholder | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| offPeak.keepAwakeBanner | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| onboarding.agentsFile.confirmDescription | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| onboarding.dialog.title | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| onboarding.stepDescription.migration | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| onboarding.welcome.start | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| onboarding.welcome.title | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| remote.backToConnection | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| remote.connectingStepDescription | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| remote.connectingStepTitle | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| remote.minimize | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| remote.selectDirectoryDescription | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| remote.selectDirectoryTitle | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| remote.settingsStepTitle | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| remote.startConnection | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| remoteConnection.feedback | 采上游 | 上游 v3.16 新文案（zh=changed/en=equal） |
| resourceManager.appUsage | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| resourceManager.storage.categoryDescription.toolOutputs | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| resourceManager.storage.diskUsage | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| resourceManager.storage.summaryTotal | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.browser.desktopOnly | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.browser.import.adminConfirmDescription | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.browser.import.helperVerificationFailed | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.closeToTrayOnWindowsDescription | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| settings.commands.import.importing | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.commands.import.mode.copy.description | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.commands.import.mode.symlink.description | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.computerUse.disabledToast | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.dataBaseDirDescription | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.dataBaseDirForbiddenInstallDir | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.locale | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| settings.localeDescription | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| settings.mcp.failure.not_authenticated | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.mcp.host.activeDescription | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.mcp.statusOnlyUnsupported | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.mcpServers.import.importing | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.memory | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| settings.migration.sectionDescription | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.modelProvider.codingPlan.bigmodel.plan.lite.summary | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| settings.modelProvider.codingPlan.purchase.teamMemberNoticeDescription | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.modelProvider.codingPlan.zai.plan.lite.summary | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| settings.modelProvider.help.contextWindow | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.modelProvider.help.followRecommendedConfig | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.modelProvider.namePlaceholder | 采上游 | 上游 v3.16 新文案（zh=equal/en=changed） |
| settings.modelProvider.startPlan.compatibility | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.modelProvider.startPlan.highlight.trial.description | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.plugins.import.importing | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.plugins.import.mode.copy.description | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.plugins.import.mode.symlink.description | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.plugins.store.manageInstalled | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| settings.skills.import.importing | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.skills.import.mode.copy.description | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.skills.import.mode.symlink.description | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.taskAutoArchive | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| settings.taskAutoArchiveDaysDescription | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| settings.taskAutoArchiveDescription | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| settings.terminalFontFamilyDescription | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.usage.billingBanner.description | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.usage.entitlementServerMcpUsage | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settings.zcodeInteractionBehaviorDescription | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| settingsSync.action.finish | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=equal/en=changed） |
| settingsSync.discovery.helper | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| sidebar.usage.plan.mcp | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| sidebar.usage.plan.zcodeMcp | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| sidebar.usage.plan.zcodeMcpDescription | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| sidePane.openTab | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| ssh.assetInstallModeDescription | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| ssh.configAliasDescription | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| startup.global.error.lock_timeout | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| startup.global.error.startup_status_timeout | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| startup.global.error.transport_closed | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| startup.global.error.unsupported_runtime | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| startup.global.help | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| startup.global.servicesFailed | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| startup.global.silent | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| startup.global.starting_services | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| taskGroup.newTask | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| taskGroup.ungroup | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| titleBar.menu.help.about | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| webRemoteControl.description | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| welcome.title | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| workflows.hub.detail.script.note | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| workflows.hub.detail.whenToUse.help | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| workflows.hub.empty.hint | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| workspaceSidebar.unavailableLocalDirectory | 采上游 | 上游 v3.16 新文案；含品牌字样已改写为 omz（zh=changed/en=changed） |
| wsl.defaultDistro | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| wsl.detectedCount | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| wsl.loading | 采上游 | 上游 v3.16 新文案（zh=equal/en=changed） |
| wsl.noDistros | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |
| wsl.userDescription | 采上游 | 上游 v3.16 新文案（zh=changed/en=changed） |

小计：采上游 138 条，保 omz 0 条。

## 二、上游独有但本迭代不采的关联键

| 键 | 决策 | 理由 |
| --- | --- | --- |
| browser.permission.denyThisTime | 不采 | 上游仅 zh单侧键（对方 locale 缺失），采入会打破 zh/en 键集合 parity 门禁；待后续迭代随 UI 移植时双侧补齐 |
| settings.memory.viewer.disabled | 不采 | 上游仅 en单侧键（对方 locale 缺失），采入会打破 zh/en 键集合 parity 门禁；待后续迭代随 UI 移植时双侧补齐 |
| settings.plugins.marketplace.recommendTitle | 不采 | 上游仅 en单侧键（对方 locale 缺失），采入会打破 zh/en 键集合 parity 门禁；待后续迭代随 UI 移植时双侧补齐 |
| modelTrajectory.source.compact | 不采 | 上游轨迹「compact」扩展键，对应 UI 未随本迭代移植，保 omz 轨迹键集不变 |

## 附录 A：品牌改写清单（采纳值内 zcode/ZCode → omz）

- `project.browseHint`（zh-CN）："ZCode 可读取和编辑这些文件夹" → "omz 可读取和编辑这些文件夹"
- `project.browseHint`（en-US）："ZCode can read and edit these folders" → "omz can read and edit these folders"
- `project.trustFoldersDescription`（zh-CN）："ZCode 可在当前权限设置允许的范围内读取、编辑这些文件夹中的文件，并运行命令。请仅在你信任列出的所有文件夹时继续。" → "omz 可在当前权限设置允许的范围内读取、编辑这些文件夹中的文件，并运行命令。请仅在你信任列出的所有文件夹时继续。"
- `project.trustFoldersDescription`（en-US）："ZCode can read and edit files in these folders and run commands within your current permission settings. Continue only if you trust every folder listed." → "omz can read and edit files in these folders and run commands within your current permission settings. Continue only if you trust every folder listed."
- `occupationOnboarding.modeDescription`（zh-CN）："你希望 ZCode 如何呈现工作过程？" → "你希望 omz 如何呈现工作过程？"
- `occupationOnboarding.modeDescription`（en-US）："How would you like ZCode to show its work?" → "How would you like omz to show its work?"
- `occupationOnboarding.description`（zh-CN）："选择最接近你日常工作的一项，让 ZCode 更懂你的工作。" → "选择最接近你日常工作的一项，让 omz 更懂你的工作。"
- `startup.global.silent`（zh-CN）："正在启动 ZCode" → "正在启动 omz"
- `startup.global.silent`（en-US）："Starting ZCode" → "Starting omz"
- `startup.global.servicesFailed`（zh-CN）："本地数据准备已完成，但应用服务启动失败。请复制诊断信息，退出并重新打开 ZCode。" → "本地数据准备已完成，但应用服务启动失败。请复制诊断信息，退出并重新打开 omz。"
- `startup.global.servicesFailed`（en-US）："Local data is ready, but app services failed to start. Copy the diagnostics, then exit and reopen ZCode." → "Local data is ready, but app services failed to start. Copy the diagnostics, then exit and reopen omz."
- `startup.global.starting_services`（zh-CN）："正在启动 ZCode" → "正在启动 omz"
- `startup.global.starting_services`（en-US）："Starting ZCode" → "Starting omz"
- `startup.global.help`（zh-CN）："准备完成后将自动进入 ZCode。历史记录较多时可能需要较长时间，请保持应用运行。" → "准备完成后将自动进入 omz。历史记录较多时可能需要较长时间，请保持应用运行。"
- `startup.global.help`（en-US）："ZCode will open when preparation finishes. Large histories may take longer. Please keep the app running." → "omz will open when preparation finishes. Large histories may take longer. Please keep the app running."
- `startup.global.error.lock_timeout`（zh-CN）："等待数据库写锁超时。请检查其他 ZCode 或 CLI 进程是否仍在更新数据，待其完成后点击重试。" → "等待数据库写锁超时。请检查其他 omz 或 CLI 进程是否仍在更新数据，待其完成后点击重试。"
- `startup.global.error.lock_timeout`（en-US）："Waiting for the database write lock timed out. Another ZCode or CLI process may be updating data. Retry after it finishes." → "Waiting for the database write lock timed out. Another omz or CLI process may be updating data. Retry after it finishes."
- `startup.global.error.startup_status_timeout`（zh-CN）："未能收到启动状态。请退出并重新打开 ZCode；如果仍失败，请提供诊断信息。" → "未能收到启动状态。请退出并重新打开 omz；如果仍失败，请提供诊断信息。"
- `startup.global.error.startup_status_timeout`（en-US）："No startup status was received. Exit and reopen ZCode. If it fails again, provide the diagnostics to support." → "No startup status was received. Exit and reopen omz. If it fails again, provide the diagnostics to support."
- `startup.global.error.transport_closed`（zh-CN）："数据准备进程意外退出或连接中断。请退出并重新打开 ZCode，应用会重新检查迁移记录。" → "数据准备进程意外退出或连接中断。请退出并重新打开 omz，应用会重新检查迁移记录。"
- `startup.global.error.transport_closed`（en-US）："The preparation process exited or disconnected. Exit and reopen ZCode to check the migration records again." → "The preparation process exited or disconnected. Exit and reopen omz to check the migration records again."
- `startup.global.error.unsupported_runtime`（zh-CN）："当前配置的 Agent 不支持独立存储准备。请恢复配套的 Agent 后重新打开 ZCode。" → "当前配置的 Agent 不支持独立存储准备。请恢复配套的 Agent 后重新打开 omz。"
- `startup.global.error.unsupported_runtime`（en-US）："The configured Agent does not support storage preparation. Restore the bundled Agent, then reopen ZCode." → "The configured Agent does not support storage preparation. Restore the bundled Agent, then reopen omz."
- `settings.computerUse.disabledToast`（zh-CN）："电脑控制已关闭，已有对话需重启 ZCode 后生效。" → "电脑控制已关闭，已有对话需重启 omz 后生效。"
- `settings.computerUse.disabledToast`（en-US）："Computer Use is disabled. Existing conversations require a ZCode restart to take effect." → "Computer Use is disabled. Existing conversations require a omz restart to take effect."
- `bots.description`（zh-CN）："把外部聊天工具和 Webhook 接入 ZCode 机器人。" → "把外部聊天工具和 Webhook 接入 omz 机器人。"
- `bots.description`（en-US）："Connect external chats and webhooks to ZCode bots." → "Connect external chats and webhooks to omz bots."
- `bots.setup.guide.weixin.create.2`（zh-CN）："ZCode 会直接保存 iLink 返回的 bot_token；扫码后请在微信里向 Bot 发送任意消息完成会话激活。" → "omz 会直接保存 iLink 返回的 bot_token；扫码后请在微信里向 Bot 发送任意消息完成会话激活。"
- `bots.setup.guide.weixin.create.2`（en-US）："ZCode saves the bot_token returned by iLink automatically; after scanning, send any message to the bot in Weixin to activate the chat." → "omz saves the bot_token returned by iLink automatically; after scanning, send any message to the bot in Weixin to activate the chat."
- `bots.setup.guide.weixin.create.3`（zh-CN）："ZCode 内置 iLink 客户端，通过 `/ilink/bot/getupdates` 长轮询收消息，通过 `/ilink/bot/sendmessage` 回复。" → "omz 内置 iLink 客户端，通过 `/ilink/bot/getupdates` 长轮询收消息，通过 `/ilink/bot/sendmessage` 回复。"
- `bots.setup.guide.weixin.create.3`（en-US）："ZCode uses a built-in iLink client: `/ilink/bot/getupdates` for long polling and `/ilink/bot/sendmessage` for replies." → "omz uses a built-in iLink client: `/ilink/bot/getupdates` for long polling and `/ilink/bot/sendmessage` for replies."
- `bots.setup.guide.webhook.create.1`（zh-CN）："Webhook 模式不需要先在第三方平台创建原生机器人；你的系统只需要能向 ZCode 回调接口发消息。" → "Webhook 模式不需要先在第三方平台创建原生机器人；你的系统只需要能向 omz 回调接口发消息。"
- `bots.setup.guide.webhook.create.1`（en-US）："Webhook mode does not require a native bot in the third-party product; your integration only needs to POST messages to ZCode." → "Webhook mode does not require a native bot in the third-party product; your integration only needs to POST messages to omz."
- `bots.setup.guide.webhook.bind.1`（zh-CN）："向 ZCode 的 `/api/bots/webhook` 发送一条私聊消息回调。" → "向 omz 的 `/api/bots/webhook` 发送一条私聊消息回调。"
- `bots.setup.guide.webhook.bind.1`（en-US）："POST a private-message callback to ZCode's `/api/bots/webhook` endpoint." → "POST a private-message callback to omz's `/api/bots/webhook` endpoint."
- `bots.runtime.telegramLongPollingHandledElsewhere`（zh-CN）："Telegram 长轮询由另一个 ZCode 窗口处理。" → "Telegram 长轮询由另一个 omz 窗口处理。"
- `bots.runtime.telegramLongPollingHandledElsewhere`（en-US）："Telegram long polling is handled by another ZCode window." → "Telegram long polling is handled by another omz window."
- `welcome.title`（zh-CN）："Welcome to ZCode" → "Welcome to omz"
- `welcome.title`（en-US）："Welcome to ZCode" → "Welcome to omz"
- `login.title`（zh-CN）："欢迎来到 ZCode" → "欢迎来到 omz"
- `login.title`（en-US）："Welcome to ZCode" → "Welcome to omz"
- `login.description`（zh-CN）："连接账号，开始使用 ZCode" → "连接账号，开始使用 omz"
- `login.description`（en-US）："Connect your account to start using ZCode" → "Connect your account to start using omz"
- `logout.confirm.title`（zh-CN）："断开连接并重启 ZCode？" → "断开连接并重启 omz？"
- `logout.confirm.title`（en-US）："Disconnect and restart ZCode?" → "Disconnect and restart omz?"
- `titleBar.menu.help.about`（zh-CN）："关于 ZCode" → "关于 omz"
- `titleBar.menu.help.about`（en-US）："About ZCode" → "About omz"
- `forceUpdate.title`（zh-CN）："需要升级 ZCode 后继续使用" → "需要升级 omz 后继续使用"
- `forceUpdate.title`（en-US）："Update ZCode to continue" → "Update omz to continue"
- `workspaceSidebar.unavailableLocalDirectory`（zh-CN）："工作区目录不存在或无法访问，当前仅可查看历史记录。恢复该目录后重启 ZCode 即可继续使用。" → "工作区目录不存在或无法访问，当前仅可查看历史记录。恢复该目录后重启 omz 即可继续使用。"
- `workspaceSidebar.unavailableLocalDirectory`（en-US）："The workspace directory does not exist or cannot be accessed. You can only view history for now. Restore the directory and restart ZCode to continue." → "The workspace directory does not exist or cannot be accessed. You can only view history for now. Restore the directory and restart omz to continue."
- `ssh.assetInstallModeDescription`（zh-CN）："远端服务器下载可减少上传等待，但服务器需要能访问 ZCode CDN，并具备下载、解压和校验工具。" → "远端服务器下载可减少上传等待，但服务器需要能访问 omz CDN，并具备下载、解压和校验工具。"
- `ssh.assetInstallModeDescription`（en-US）："Remote server download reduces upload waiting, but the server must reach the ZCode CDN and have download, extract, and checksum tools." → "Remote server download reduces upload waiting, but the server must reach the omz CDN and have download, extract, and checksum tools."
- `settings.terminalFontFamilyDescription`（zh-CN）："留空时自动探测系统终端配置；填写后作为 ZCode 终端的字体覆盖。" → "留空时自动探测系统终端配置；填写后作为 omz 终端的字体覆盖。"
- `settings.terminalFontFamilyDescription`（en-US）："Leave blank to auto-detect system terminal settings; set a value to override the ZCode terminal font." → "Leave blank to auto-detect system terminal settings; set a value to override the omz terminal font."
- `settings.zcodeInteractionBehaviorDescription`（zh-CN）："在 ZCode 运行时将后续操作加入队列，或引导至下一轮工具调用后运行。" → "在 omz 运行时将后续操作加入队列，或引导至下一轮工具调用后运行。"
- `settings.zcodeInteractionBehaviorDescription`（en-US）："While ZCode is running, add follow-up actions to the queue or guide them to run after the next tool call." → "While omz is running, add follow-up actions to the queue or guide them to run after the next tool call."
- `settings.dataBaseDirDescription`（zh-CN）："应用数据的根目录（默认为用户主目录），修改后会将现有数据复制到新位置。路径后缀 .zcode/v2 不可更改。" → "应用数据的根目录（默认为用户主目录），修改后会将现有数据复制到新位置。路径后缀 .omz/v2 不可更改。"
- `settings.dataBaseDirDescription`（en-US）："Root directory for app data (defaults to user home directory). Existing data will be copied to the new location. The .zcode/v2 suffix cannot be changed." → "Root directory for app data (defaults to user home directory). Existing data will be copied to the new location. The .omz/v2 suffix cannot be changed."
- `settings.dataBaseDirForbiddenInstallDir`（zh-CN）："不能选择 ZCode 安装目录作为数据存储路径。请选择安装目录之外的文件夹。" → "不能选择 omz 安装目录作为数据存储路径。请选择安装目录之外的文件夹。"
- `settings.dataBaseDirForbiddenInstallDir`（en-US）："The data directory cannot be the ZCode installation folder on Windows. Choose a folder outside the app install location." → "The data directory cannot be the omz installation folder on Windows. Choose a folder outside the app install location."
- `settings.migration.sectionDescription`（zh-CN）："扫描本机 Claude Code 原生历史，可按 workspace 和时间范围筛选，再把选中的会话导入到对应的 ZCode 任务列表。" → "扫描本机 Claude Code 原生历史，可按 workspace 和时间范围筛选，再把选中的会话导入到对应的 omz 任务列表。"
- `settings.migration.sectionDescription`（en-US）："Scan native Claude Code history on this machine, optionally filter by workspace and activity window, then import the selected sessions into their matching ZCode task lists." → "Scan native Claude Code history on this machine, optionally filter by workspace and activity window, then import the selected sessions into their matching omz task lists."
- `resourceManager.storage.summaryTotal`（zh-CN）："ZCode 总占用" → "omz 总占用"
- `resourceManager.storage.summaryTotal`（en-US）："Total used by ZCode" → "Total used by omz"
- `resourceManager.storage.diskUsage`（zh-CN）："ZCode 占用 {used}" → "omz 占用 {used}"
- `resourceManager.storage.diskUsage`（en-US）："ZCode uses {used}" → "omz uses {used}"
- `settings.browser.desktopOnly`（zh-CN）："浏览器数据只能在 ZCode 桌面端管理。" → "浏览器数据只能在 omz 桌面端管理。"
- `settings.browser.desktopOnly`（en-US）："Browser data can only be managed in the ZCode desktop app." → "Browser data can only be managed in the omz desktop app."
- `settings.browser.import.helperVerificationFailed`（zh-CN）："ZCode 的 Windows 安全导入组件校验失败，Cookie 未导入。请重新安装或更新 ZCode。" → "omz 的 Windows 安全导入组件校验失败，Cookie 未导入。请重新安装或更新 omz。"
- `settings.browser.import.helperVerificationFailed`（en-US）："ZCode could not verify its Windows secure import component. Reinstall or update ZCode before importing cookies." → "omz could not verify its Windows secure import component. Reinstall or update omz before importing cookies."
- `settings.browser.import.adminConfirmDescription`（zh-CN）："Chrome 在 Windows 上使用 App-Bound 加密保护 Cookie。ZCode 将为本次导入请求管理员权限，临时启动系统服务，完成后立即删除。不会读取或导入 Chrome 密码。" → "Chrome 在 Windows 上使用 App-Bound 加密保护 Cookie。omz 将为本次导入请求管理员权限，临时启动系统服务，完成后立即删除。不会读取或导入 Chrome 密码。"
- `settings.browser.import.adminConfirmDescription`（en-US）："Chrome protects cookies with App-Bound encryption on Windows. For this import only, ZCode will request administrator access, start a temporary system service, and delete it immediately afterward. Chrome passwords are never read or imported." → "Chrome protects cookies with App-Bound encryption on Windows. For this import only, omz will request administrator access, start a temporary system service, and delete it immediately afterward. Chrome passwords are never read or imported."
- `settings.mcp.host.activeDescription`（zh-CN）："该 MCP 服务器由 ZCode 宿主为 {pluginName} 插件提供，运行时身份由宿主管理。" → "该 MCP 服务器由 omz 宿主为 {pluginName} 插件提供，运行时身份由宿主管理。"
- `settings.mcp.host.activeDescription`（en-US）："ZCode provides this MCP server for the {pluginName} plugin. Its runtime identity is managed by the host." → "omz provides this MCP server for the {pluginName} plugin. Its runtime identity is managed by the host."
- `settings.mcp.statusOnlyUnsupported`（zh-CN）："当前 ZCode Agent 不支持 OAuth 状态刷新。请升级或重启 ZCode，然后重新打开 MCP 设置进行完整刷新。" → "当前 omz Agent 不支持 OAuth 状态刷新。请升级或重启 omz，然后重新打开 MCP 设置进行完整刷新。"
- `settings.mcp.statusOnlyUnsupported`（en-US）："This ZCode Agent cannot refresh OAuth status. Upgrade or restart ZCode, then reopen MCP settings to run a full refresh." → "This omz Agent cannot refresh OAuth status. Upgrade or restart omz, then reopen MCP settings to run a full refresh."
- `settings.mcp.failure.not_authenticated`（zh-CN）："当前未登录，请先登录 ZCode。" → "当前未登录，请先登录 omz。"
- `settings.mcp.failure.not_authenticated`（en-US）："You are not signed in. Sign in to ZCode to use this MCP server." → "You are not signed in. Sign in to omz to use this MCP server."
- `settings.mcpServers.import.importing`（zh-CN）："正在导入 MCP 服务器到 ZCode" → "正在导入 MCP 服务器到 omz"
- `settings.mcpServers.import.importing`（en-US）："Importing MCP servers into ZCode" → "Importing MCP servers into omz"
- `settings.modelProvider.startPlan.highlight.trial.description`（zh-CN）："登录 ZCode 3.x 后开始计时。" → "登录 omz 3.x 后开始计时。"
- `settings.modelProvider.startPlan.highlight.trial.description`（en-US）："Timing starts after signing in to ZCode 3.x." → "Timing starts after signing in to omz 3.x."
- `settings.modelProvider.startPlan.compatibility`（zh-CN）："支持 BYOK、BYOA；Base URL、API Format 和 API Key 由 ZCode 自动维护，无需手动配置。" → "支持 BYOK、BYOA；Base URL、API Format 和 API Key 由 omz 自动维护，无需手动配置。"
- `settings.modelProvider.startPlan.compatibility`（en-US）："Supports BYOK and BYOA. Base URL, API format, and API Key are maintained by ZCode automatically." → "Supports BYOK and BYOA. Base URL, API format, and API Key are maintained by omz automatically."
- `settings.modelProvider.codingPlan.purchase.teamMemberNoticeDescription`（zh-CN）："请先在 BigModel 团队套餐管理页添加自己或其他成员，完成后即可在 ZCode 使用团队额度。" → "请先在 BigModel 团队套餐管理页添加自己或其他成员，完成后即可在 omz 使用团队额度。"
- `settings.modelProvider.codingPlan.purchase.teamMemberNoticeDescription`（en-US）："Add yourself or other members on the BigModel team plan management page. Once assigned, the team quota will be available in ZCode." → "Add yourself or other members on the BigModel team plan management page. Once assigned, the team quota will be available in omz."
- `settings.modelProvider.help.contextWindow`（zh-CN）："模型一次可处理的上下文容量，单位为 Token。ZCode 会据此管理上下文。\n请勿超过模型的实际上限。" → "模型一次可处理的上下文容量，单位为 Token。omz 会据此管理上下文。\n请勿超过模型的实际上限。"
- `settings.modelProvider.help.contextWindow`（en-US）："The context capacity the model can process at once, in tokens. ZCode uses this to manage context.\nDo not exceed the model's actual limit." → "The context capacity the model can process at once, in tokens. omz uses this to manage context.\nDo not exceed the model's actual limit."
- `settings.modelProvider.help.followRecommendedConfig`（zh-CN）："根据模型 ID、Base URL 和 API 格式，为您智能匹配推荐配置。ZCode 会持续更新推荐配置，并自动同步给您。\n如果手动修改某项配置，该项将转为手动管理，不再跟随推荐更新；其他配置仍由智能配置管理。" → "根据模型 ID、Base URL 和 API 格式，为您智能匹配推荐配置。omz 会持续更新推荐配置，并自动同步给您。\n如果手动修改某项配置，该项将转为手动管理，不再跟随推荐更新；其他配置仍由智能配置管理。"
- `settings.modelProvider.help.followRecommendedConfig`（en-US）："Matches recommended configuration using the model ID, Base URL, and API format. ZCode continually updates recommendations and automatically syncs them to you.\nWhen you manually change a setting, that setting becomes manually managed and stops following recommendation updates; other settings remain managed by smart configuration." → "Matches recommended configuration using the model ID, Base URL, and API format. omz continually updates recommendations and automatically syncs them to you.\nWhen you manually change a setting, that setting becomes manually managed and stops following recommendation updates; other settings remain managed by smart configuration."
- `settings.usage.billingBanner.description`（zh-CN）："连接 {provider} 账号后查询编程套餐权益，购买或配置后回到 ZCode 即可继续编码。" → "连接 {provider} 账号后查询编程套餐权益，购买或配置后回到 omz 即可继续编码。"
- `settings.usage.billingBanner.description`（en-US）："Connect your {provider} account to query Coding Plan entitlement, then keep coding in ZCode after purchase or setup." → "Connect your {provider} account to query Coding Plan entitlement, then keep coding in omz after purchase or setup."
- `settings.usage.entitlementServerMcpUsage`（zh-CN）："ZCode MCP" → "omz MCP"
- `settings.usage.entitlementServerMcpUsage`（en-US）："ZCode MCP" → "omz MCP"
- `sidebar.usage.plan.mcp`（zh-CN）："ZCode MCP" → "omz MCP"
- `sidebar.usage.plan.mcp`（en-US）："ZCode MCP" → "omz MCP"
- `sidebar.usage.plan.zcodeMcp`（zh-CN）："ZCode MCP" → "omz MCP"
- `sidebar.usage.plan.zcodeMcp`（en-US）："ZCode MCP" → "omz MCP"
- `sidebar.usage.plan.zcodeMcpDescription`（zh-CN）："ZCode 预置插件 MCP 每日合计额度" → "omz 预置插件 MCP 每日合计额度"
- `sidebar.usage.plan.zcodeMcpDescription`（en-US）："Daily aggregate quota for ZCode built-in plugin MCPs" → "Daily aggregate quota for omz built-in plugin MCPs"
- `settings.skills.import.mode.copy.description`（zh-CN）："将完整技能目录复制到 ZCode。外部 Agent 目录后续变更不会自动同步。" → "将完整技能目录复制到 omz。外部 Agent 目录后续变更不会自动同步。"
- `settings.skills.import.mode.copy.description`（en-US）："Copy the full skill directory into ZCode. Later changes in the external agent directory will not sync automatically." → "Copy the full skill directory into omz. Later changes in the external agent directory will not sync automatically."
- `settings.skills.import.mode.symlink.description`（zh-CN）："创建指向外部 Agent 技能目录的链接。ZCode 会跟随来源目录后续变更，但该技能依赖来源路径持续可用。" → "创建指向外部 Agent 技能目录的链接。omz 会跟随来源目录后续变更，但该技能依赖来源路径持续可用。"
- `settings.skills.import.mode.symlink.description`（en-US）："Create a directory link to the external agent skill. ZCode follows later source changes, but the skill depends on that source path remaining available." → "Create a directory link to the external agent skill. omz follows later source changes, but the skill depends on that source path remaining available."
- `settings.skills.import.importing`（zh-CN）："正在导入技能到 ZCode" → "正在导入技能到 omz"
- `settings.skills.import.importing`（en-US）："Importing skills into ZCode" → "Importing skills into omz"
- `settings.plugins.import.mode.copy.description`（zh-CN）："将完整插件目录复制到 ZCode，并注册到 plugins.dirs。外部 Agent 目录后续变更不会自动同步。" → "将完整插件目录复制到 omz，并注册到 plugins.dirs。外部 Agent 目录后续变更不会自动同步。"
- `settings.plugins.import.mode.copy.description`（en-US）："Copy the full plugin directory into ZCode and register it in plugins.dirs. Later changes in the external agent directory will not sync automatically." → "Copy the full plugin directory into omz and register it in plugins.dirs. Later changes in the external agent directory will not sync automatically."
- `settings.plugins.import.mode.symlink.description`（zh-CN）："创建指向外部 Agent 插件目录的链接，并注册到 plugins.dirs。ZCode 会跟随来源目录后续变更，但该插件依赖来源路径持续可用。" → "创建指向外部 Agent 插件目录的链接，并注册到 plugins.dirs。omz 会跟随来源目录后续变更，但该插件依赖来源路径持续可用。"
- `settings.plugins.import.mode.symlink.description`（en-US）："Create a directory link to the external agent plugin and register it in plugins.dirs. ZCode follows later source changes, but the plugin depends on that source path remaining available." → "Create a directory link to the external agent plugin and register it in plugins.dirs. omz follows later source changes, but the plugin depends on that source path remaining available."
- `settings.plugins.import.importing`（zh-CN）："正在导入插件到 ZCode" → "正在导入插件到 omz"
- `settings.plugins.import.importing`（en-US）："Importing plugins into ZCode" → "Importing plugins into omz"
- `settings.commands.import.mode.copy.description`（zh-CN）："将命令文件复制到 ZCode。外部 Agent 文件后续变更不会自动同步。" → "将命令文件复制到 omz。外部 Agent 文件后续变更不会自动同步。"
- `settings.commands.import.mode.copy.description`（en-US）："Copy the command file into ZCode. Later changes in the external agent file will not sync automatically." → "Copy the command file into omz. Later changes in the external agent file will not sync automatically."
- `settings.commands.import.mode.symlink.description`（zh-CN）："创建指向外部 Agent 命令文件的链接。ZCode 会跟随来源文件后续变更，但该命令依赖来源路径持续可用。" → "创建指向外部 Agent 命令文件的链接。omz 会跟随来源文件后续变更，但该命令依赖来源路径持续可用。"
- `settings.commands.import.mode.symlink.description`（en-US）："Create a file link to the external agent command. ZCode follows later source changes, but the command depends on that source path remaining available." → "Create a file link to the external agent command. omz follows later source changes, but the command depends on that source path remaining available."
- `settings.commands.import.importing`（zh-CN）："正在导入命令到 ZCode" → "正在导入命令到 omz"
- `settings.commands.import.importing`（en-US）："Importing commands into ZCode" → "Importing commands into omz"
- `settings.plugins.zcodeOnly`（zh-CN）："仅支持 ZCode Agent" → "仅支持 omz Agent"
- `settings.plugins.zcodeOnly`（en-US）："ZCode Agent only" → "omz Agent only"
- `settingsSync.discovery.helper`（zh-CN）："仅导入缺失项，不会覆盖当前 ZCode 中已存在的配置。" → "仅导入缺失项，不会覆盖当前 omz 中已存在的配置。"
- `settingsSync.discovery.helper`（en-US）："Only missing items will be imported and your current ZCode settings will not be overwritten." → "Only missing items will be imported and your current omz settings will not be overwritten."
- `onboarding.dialog.title`（zh-CN）："欢迎使用 ZCode" → "欢迎使用 omz"
- `onboarding.dialog.title`（en-US）："Welcome to ZCode" → "Welcome to omz"
- `onboarding.welcome.title`（zh-CN）："欢迎使用 ZCode" → "欢迎使用 omz"
- `onboarding.welcome.title`（en-US）："Welcome to ZCode" → "Welcome to omz"
- `onboarding.welcome.start`（zh-CN）："开始使用 ZCode" → "开始使用 omz"
- `onboarding.welcome.start`（en-US）："Start ZCode" → "Start omz"
- `onboarding.stepDescription.migration`（zh-CN）："开始迁移并等待 ZCode 完成导入。" → "开始迁移并等待 omz 完成导入。"
- `onboarding.stepDescription.migration`（en-US）："Start migration and wait while ZCode imports your selections." → "Start migration and wait while omz imports your selections."
- `onboarding.agentsFile.confirmDescription`（zh-CN）："将从 {source} 复制到 {target}。\n如果目标文件已存在，ZCode 默认 AGENTS 配置会被覆盖。" → "将从 {source} 复制到 {target}。\n如果目标文件已存在，omz 默认 AGENTS 配置会被覆盖。"
- `onboarding.agentsFile.confirmDescription`（en-US）："ZCode will copy {source} to {target}.\nIf the target file already exists, the ZCode default AGENTS configuration will be overwritten." → "omz will copy {source} to {target}.\nIf the target file already exists, the omz default AGENTS configuration will be overwritten."
- `chat.placeholder.newTask`（zh-CN）："向 ZCode 提问，使用 @ 添加上下文，使用 / 选择命令或能力" → "向 omz 提问，使用 @ 添加上下文，使用 / 选择命令或能力"
- `chat.placeholder.newTask`（en-US）："Ask ZCode anything, @ to add context, / for commands or capabilities" → "Ask omz anything, @ to add context, / for commands or capabilities"
- `chat.placeholder.newTaskMobile`（zh-CN）："向 ZCode 提问…" → "向 omz 提问…"
- `chat.placeholder.newTaskMobile`（en-US）："Ask ZCode anything…" → "Ask omz anything…"
- `chat.toolbar.computerUse.tooltip.ready`（zh-CN）："电脑操作已就绪 · 直接描述你想让 ZCode 做的事" → "电脑操作已就绪 · 直接描述你想让 omz 做的事"
- `chat.toolbar.computerUse.tooltip.ready`（en-US）："Computer Use ready — just describe what you want ZCode to do" → "Computer Use ready — just describe what you want omz to do"
- `chat.toolbar.computerUse.tooltip.error`（zh-CN）："电脑操作启用失败 · 重启 ZCode 应用后重试，或让 ZCode 排查日志" → "电脑操作启用失败 · 重启 omz 应用后重试，或让 omz 排查日志"
- `chat.toolbar.computerUse.tooltip.error`（en-US）："Computer Use enablement failed. Please restart ZCode app and retry, or ask ZCode to investigate the logs" → "Computer Use enablement failed. Please restart omz app and retry, or ask omz to investigate the logs"
- `workflows.hub.empty.hint`（zh-CN）："在对话里让 ZCode 设计工作流，跑通之后再让它保存到项目里。未打开的项目不会出现在这里。" → "在对话里让 omz 设计工作流，跑通之后再让它保存到项目里。未打开的项目不会出现在这里。"
- `workflows.hub.empty.hint`（en-US）："Design a workflow with ZCode in chat, then have it save the workflow to a project once it works. Projects that aren't open don't appear here." → "Design a workflow with omz in chat, then have it save the workflow to a project once it works. Projects that aren't open don't appear here."
- `workflows.hub.detail.whenToUse.help`（zh-CN）："给 ZCode 的路由提示：什么场景该选这个工作流。" → "给 omz 的路由提示：什么场景该选这个工作流。"
- `workflows.hub.detail.whenToUse.help`（en-US）："A routing hint for ZCode: when this workflow is the right pick." → "A routing hint for omz: when this workflow is the right pick."
- `workflows.hub.detail.script.note`（zh-CN）："脚本只读。要改脚本，在对话里让 ZCode 修订后另存一版。" → "脚本只读。要改脚本，在对话里让 omz 修订后另存一版。"
- `workflows.hub.detail.script.note`（en-US）："The script is read-only. To change it, revise it with ZCode in chat and save a new version." → "The script is read-only. To change it, revise it with omz in chat and save a new version."
- `chat.toolCall.workflow.saveRun.lead`（zh-CN）："让 ZCode 帮我提炼保存" → "让 omz 帮我提炼保存"
- `chat.toolCall.workflow.saveRun.lead`（en-US）："Let ZCode refine and save it" → "Let omz refine and save it"
- `chat.toolCall.workflow.saveRun.lead.hint`（zh-CN）："ZCode 会帮你提炼出可复用的工作流，再交你确认。" → "omz 会帮你提炼出可复用的工作流，再交你确认。"
- `chat.toolCall.workflow.saveRun.lead.hint`（en-US）："ZCode distills a reusable workflow for you, then asks you to confirm." → "omz distills a reusable workflow for you, then asks you to confirm."
- `chat.toolCall.workflow.saveRun.lead.sending`（zh-CN）："已交给 ZCode…" → "已交给 omz…"
- `chat.toolCall.workflow.saveRun.lead.sending`（en-US）："Handed to ZCode…" → "Handed to omz…"
- `chat.quota.mcp.quotaExhausted`（zh-CN）："ZCode MCP「{server}」今日额度已用完，明天自动恢复。" → "omz MCP「{server}」今日额度已用完，明天自动恢复。"
- `chat.quota.mcp.quotaExhausted`（en-US）："ZCode MCP \"{server}\" has used up today's quota. It resets tomorrow." → "omz MCP \"{server}\" has used up today's quota. It resets tomorrow."
- `chat.quota.mcp.codingPlanRequired`（zh-CN）："当前无 ZCode MCP「{server}」额度，请登录或开通 Coding Plan 使用。" → "当前无 omz MCP「{server}」额度，请登录或开通 Coding Plan 使用。"
- `chat.quota.mcp.codingPlanRequired`（en-US）："No ZCode MCP \"{server}\" quota. Sign in or get a Coding Plan to use it." → "No omz MCP \"{server}\" quota. Sign in or get a Coding Plan to use it."
- `resourceManager.appUsage`（zh-CN）："ZCode" → "omz"
- `resourceManager.appUsage`（en-US）："ZCode" → "omz"
- `feedback.submit.template.section.copyErrorHeading`（zh-CN）："ZCode 报错信息" → "omz 报错信息"
- `feedback.submit.template.section.copyErrorHeading`（en-US）："ZCode Error Info" → "omz Error Info"
- `offPeak.keepAwakeBanner`（zh-CN）："ZCode 运行会话时保持电脑唤醒。" → "omz 运行会话时保持电脑唤醒。"
- `offPeak.keepAwakeBanner`（en-US）："Keep your computer awake while ZCode is running a chat." → "Keep your computer awake while omz is running a chat."
- `offPeak.form.instructionsPlaceholder`（zh-CN）："描述希望 ZCode 在后台完成的工作、预期结果和约束，例如整理本周代码改动并生成站会摘要…" → "描述希望 omz 在后台完成的工作、预期结果和约束，例如整理本周代码改动并生成站会摘要…"
- `offPeak.form.instructionsPlaceholder`（en-US）："Describe a task ZCode can work on in the background, including the expected result and any constraints…" → "Describe a task omz can work on in the background, including the expected result and any constraints…"
- `chat.cuaReadiness.toolsNotLoaded`（zh-CN）："ZCode 电脑控制仍在准备中——工具尚未加载（已加载 {count} 个）。请先授予下方权限，Helper 就绪后工具会自动出现。" → "omz 电脑控制仍在准备中——工具尚未加载（已加载 {count} 个）。请先授予下方权限，Helper 就绪后工具会自动出现。"
- `chat.cuaReadiness.toolsNotLoaded`（en-US）："ZCode Computer Use is still preparing — its tools aren't loaded yet ({count} loaded). Grant the permissions below; tools appear once the helper is ready." → "omz Computer Use is still preparing — its tools aren't loaded yet ({count} loaded). Grant the permissions below; tools appear once the helper is ready."
- `chat.cuaReadiness.toolsPreparing`（zh-CN）："ZCode 电脑控制仍在准备中——工具尚未加载。请先授予下方权限，Helper 就绪后工具会自动出现。" → "omz 电脑控制仍在准备中——工具尚未加载。请先授予下方权限，Helper 就绪后工具会自动出现。"
- `chat.cuaReadiness.toolsPreparing`（en-US）："ZCode Computer Use is still preparing — its tools aren't loaded yet. Grant the permissions below; tools appear once the helper is ready." → "omz Computer Use is still preparing — its tools aren't loaded yet. Grant the permissions below; tools appear once the helper is ready."
- `cuaPermission.modal.relaunchAppButton`（zh-CN）："重启 ZCode" → "重启 omz"
- `cuaPermission.modal.relaunchAppButton`（en-US）："Restart ZCode" → "Restart omz"
- `cuaPermission.modal.relaunchAppHint`（zh-CN）："重启 Helper 后仍未生效？重启 ZCode 可彻底重载 Helper 进程。" → "重启 Helper 后仍未生效？重启 omz 可彻底重载 Helper 进程。"
- `cuaPermission.modal.relaunchAppHint`（en-US）："Still not working after restarting Helper? Restart ZCode to fully reload the Helper process." → "Still not working after restarting Helper? Restart omz to fully reload the Helper process."
- `cuaPermission.tools.untrustedRuntime`（zh-CN）："检测到电脑控制工具，但它们并非来自已校验的 ZCode 官方插件。请检查插件安装后重新验证。" → "检测到电脑控制工具，但它们并非来自已校验的 omz 官方插件。请检查插件安装后重新验证。"
- `cuaPermission.tools.untrustedRuntime`（en-US）："Computer Use tools were found, but they did not come from the verified ZCode plugin. Review the plugin installation, then check again." → "Computer Use tools were found, but they did not come from the verified omz plugin. Review the plugin installation, then check again."
- `cuaPermission.ready.sessionValidationHint`（zh-CN）："首个会话启动时，ZCode 会针对该会话精确验证电脑控制工具。" → "首个会话启动时，omz 会针对该会话精确验证电脑控制工具。"
- `cuaPermission.ready.sessionValidationHint`（en-US）："ZCode will verify the Computer Use tools against the exact session when your first session starts." → "omz will verify the Computer Use tools against the exact session when your first session starts."
- `project.connectAndBrowseHint`（en-US）："Device status: {status}. ZCode connects first." → "Device status: {status}. omz connects first."
- `chat.changeSummary.rewindDialog.description`（en-US）："ZCode checks current file content again before writing. If another process changed a file, no files will be written." → "omz checks current file content again before writing. If another process changed a file, no files will be written."
- `settingsSync.action.finish`（en-US）："Start using ZCode" → "Start using omz"

## 附录 B：omz 死键清除（conversationShare.*）

共 165 条全量清除（omz 独有 14 + 与上游共享 151）。口径说明：spec/任务写的「14 条」是探索报告按「omz 独有键」子集统计的数字；实测 omz 基线 conversationShare.* 共 165 条，经 rg 全仓核实（packages/apps 排除 locales 与文档）零代码引用，均属会话分享功能退役后的死键，故全量清除（上游独有 conversationShare 键本就不在白名单，0 采入）。

- `conversationShare.copyFailed`
- `conversationShare.copyLink`
- `conversationShare.copySucceeded`
- `conversationShare.disclosure.checkbox`
- `conversationShare.disclosure.description`
- `conversationShare.disclosure.scope.conversation`
- `conversationShare.disclosure.scope.generated`
- `conversationShare.disclosure.scope.note`
- `conversationShare.disclosure.scope.reviewLabel`
- `conversationShare.disclosure.scope.sensitive`
- `conversationShare.disclosure.scope.sensitiveLabel`
- `conversationShare.disclosure.scope.title`
- `conversationShare.disclosure.scope.tools`
- `conversationShare.disclosure.scope.trigger`
- `conversationShare.error.activeSubagent`
- `conversationShare.error.activeToolCall`
- `conversationShare.error.artifactChanged`
- `conversationShare.error.artifactExtensionMissing`
- `conversationShare.error.artifactManifest`
- `conversationShare.error.artifactNotAllowed`
- `conversationShare.error.artifactOutsideWorkspace`
- `conversationShare.error.artifactReadFailed`
- `conversationShare.error.artifactSizeLimit`
- `conversationShare.error.artifactTypeNotAllowed`
- `conversationShare.error.authenticationRequired`
- `conversationShare.error.connectionUnavailable`
- `conversationShare.error.disclosureRequired`
- `conversationShare.error.featureDisabled`
- `conversationShare.error.inlineToolImage`
- `conversationShare.error.inputAttachment`
- `conversationShare.error.invalidConversation`
- `conversationShare.error.invalidSelection`
- `conversationShare.error.limitExceeded`
- `conversationShare.error.missingProductTurn`
- `conversationShare.error.network`
- `conversationShare.error.noShareableContent`
- `conversationShare.error.payloadLimit`
- `conversationShare.error.rateLimited`
- `conversationShare.error.runningTurn`
- `conversationShare.error.safetyCheckTimeout`
- `conversationShare.error.streamingRow`
- `conversationShare.error.summary`
- `conversationShare.error.unsafeUrl`
- `conversationShare.error.unsupportedTimeline`
- `conversationShare.error.uploadFailed`
- `conversationShare.generatingLink`
- `conversationShare.import.committing`
- `conversationShare.import.complete`
- `conversationShare.import.dividerLabel`
- `conversationShare.import.downloading`
- `conversationShare.import.expired`
- `conversationShare.import.failed`
- `conversationShare.import.failedWithArtifact`
- `conversationShare.import.fallbackDefaultWorkspace`
- `conversationShare.import.fallbackRemoteWorkspace`
- `conversationShare.import.installing`
- `conversationShare.import.integrityFailed`
- `conversationShare.import.integrityFailedWithArtifact`
- `conversationShare.import.loginRequired`
- `conversationShare.import.notFound`
- `conversationShare.import.retry`
- `conversationShare.import.source`
- `conversationShare.issue.activeSubagent`
- `conversationShare.issue.activeToolCall`
- `conversationShare.issue.artifactChanged`
- `conversationShare.issue.artifactCountLimit`
- `conversationShare.issue.artifactExtensionMissing`
- `conversationShare.issue.artifactManifest`
- `conversationShare.issue.artifactOutsideWorkspace`
- `conversationShare.issue.artifactReadFailed`
- `conversationShare.issue.artifactSizeLimit`
- `conversationShare.issue.artifactTotalSizeLimit`
- `conversationShare.issue.artifactTypeNotAllowed`
- `conversationShare.issue.copyRequestId`
- `conversationShare.issue.deselectTurn`
- `conversationShare.issue.details`
- `conversationShare.issue.inlineToolImage`
- `conversationShare.issue.inputAttachment`
- `conversationShare.issue.inputAttachmentUnavailable`
- `conversationShare.issue.invalidConversation`
- `conversationShare.issue.invalidSelection`
- `conversationShare.issue.missingProductTurn`
- `conversationShare.issue.more`
- `conversationShare.issue.noShareableContent`
- `conversationShare.issue.payloadSizeLimit`
- `conversationShare.issue.requestId`
- `conversationShare.issue.requestIdLabel`
- `conversationShare.issue.requestIdMissing`
- `conversationShare.issue.retryPreflight`
- `conversationShare.issue.rowsLimit`
- `conversationShare.issue.runningTurn`
- `conversationShare.issue.staleConversation`
- `conversationShare.issue.streamingRow`
- `conversationShare.issue.unknown`
- `conversationShare.issue.unsafeUrl`
- `conversationShare.issue.unsupportedTimeline`
- `conversationShare.issue.uploadIncomplete`
- `conversationShare.openLink`
- `conversationShare.partial.back`
- `conversationShare.partial.cancel`
- `conversationShare.partial.confirm`
- `conversationShare.partial.confirmationTitle`
- `conversationShare.partial.continueWithSkips`
- `conversationShare.partial.deselectAll`
- `conversationShare.partial.empty`
- `conversationShare.partial.next`
- `conversationShare.partial.panelLabel`
- `conversationShare.partial.preflightBlocked`
- `conversationShare.partial.preflightChecking`
- `conversationShare.partial.preflightDeferred`
- `conversationShare.partial.preflightSkipped`
- `conversationShare.partial.publishing`
- `conversationShare.partial.selectAll`
- `conversationShare.partial.selectedSummary`
- `conversationShare.partial.selectionCount`
- `conversationShare.partial.selectionHint`
- `conversationShare.partial.selectionStageHint`
- `conversationShare.permission.linkEditor`
- `conversationShare.permission.linkEditorHint`
- `conversationShare.permission.linkEditorSummary`
- `conversationShare.permission.linkViewer`
- `conversationShare.permission.linkViewerHint`
- `conversationShare.permission.linkViewerSummary`
- `conversationShare.permission.private`
- `conversationShare.permission.privateHint`
- `conversationShare.permission.privateSummary`
- `conversationShare.permissionLabel`
- `conversationShare.phase.checking`
- `conversationShare.phase.checkingPending`
- `conversationShare.phase.collecting`
- `conversationShare.phase.collectingComplete`
- `conversationShare.phase.collectingPending`
- `conversationShare.phase.failed`
- `conversationShare.phase.uploading`
- `conversationShare.phase.uploadingActive`
- `conversationShare.phase.uploadingComplete`
- `conversationShare.phase.uploadingPending`
- `conversationShare.progress.checking`
- `conversationShare.progress.checkingFailed`
- `conversationShare.progress.collecting`
- `conversationShare.progress.collectingFailed`
- `conversationShare.progress.uploading`
- `conversationShare.progress.uploadingFailed`
- `conversationShare.publicWarning`
- `conversationShare.publish.failedDescription`
- `conversationShare.publish.failedFooter`
- `conversationShare.publish.failedTitle`
- `conversationShare.publish.footerMeta`
- `conversationShare.publish.retry`
- `conversationShare.publishFailed`
- `conversationShare.publishSucceeded`
- `conversationShare.publishSucceededWithSkips`
- `conversationShare.result.description`
- `conversationShare.result.dismiss`
- `conversationShare.result.openInBrowser`
- `conversationShare.result.title`
- `conversationShare.selection.reopen`
- `conversationShare.shareTitle`
- `conversationShare.trigger`
- `conversationShare.warning.artifactChangedSkipped`
- `conversationShare.warning.artifactSkipped`
- `conversationShare.warning.artifactTypeSkipped`
- `conversationShare.warning.inputAttachmentSkipped`
- `conversationShare.warning.inputAttachmentUnavailable`
- `conversationShare.warning.summary`

## 附录 C：基线未触碰键中的品牌残留（登记，不在本批改写范围）

以下键为 omz 基线自带值，含 `zcode/ZCode` 字样，属受保护键值（modelTrajectory.*）、协议字面量（`x-zcode-bot-secret`）、工作区文件名（`.zcodeignore`，协议层刻意保留旧产品名）或 omz 既有「ZCode Agent」文案；不属本批采纳值，未改写。键名含 zcode 的 34 个键为代码消费的标识符（`zcode.error.*`、`settings.zcodeInteractionBehavior*` 等），改名会破坏消费方，同样不动。

zh-CN（10 条）：

- `bots.setup.guide.webhook.bind.3`："如果配置了 secret，请同时在请求头里带上 `x-zcode-bot-secret`；绑定成功后再回到这里完成设置。"
- `modelTrajectory.empty`："暂无模型调用记录（仅 ZCode Agent 会落盘 model-io）"
- `settings.mcp.description`："管理 ZCode Agent 使用的 MCP 服务器配置。"
- `settings.subagents.description`："管理 ZCode Agent 运行时消费的用户级子智能体 Markdown 文件。"
- `settings.commands.description`："管理 ZCode Agent 的 .md 命令文件。命令可通过 /command-name 在聊天中调用。"
- `settings.commands.source.zcodeAgent`："ZCode Agent"
- `settings.workspaceFileSearch.description`："编辑 .zcodeignore 忽略规则（语法与 .gitignore 一致），控制工作区文件搜索的范围。保存后下次搜索生效。"
- `settings.workspaceFileSearch.templateHint`：".zcodeignore 尚未创建：下方为初始内容预览（.gitignore 拷贝 + 默认排除规则），保存后才会写入工作区。"
- `settings.workspaceFileSearch.revealHint`："保存后即可在工作区根目录找到 .zcodeignore"
- `settingsSync.agent.zcode`："ZCode Agent"

en-US（11 条）：

- `bots.setup.guide.webhook.bind.3`："If the bot uses a secret, also send `x-zcode-bot-secret`; then return here after the bind succeeds."
- `modelTrajectory.empty`："No model calls recorded (only ZCode Agent writes model-io)"
- `settings.mcp.description`："Manage MCP server configurations used by ZCode Agent."
- `settings.subagents.description`："Manage user-level subagent Markdown files consumed by ZCode Agent."
- `settings.commands.description`："Manage ZCode Agent .md command files. Commands can be invoked with /command-name in chat."
- `settings.commands.source.zcodeAgent`："ZCode Agent"
- `settings.workspaceFileSearch.description`："Edit .zcodeignore rules (gitignore syntax) that scope workspace file search. Takes effect on the next search after saving."
- `settings.workspaceFileSearch.templateHint`：".zcodeignore does not exist yet: the content below is the initial preview (.gitignore copy + default exclusions); it is written to the workspace only after saving."
- `settings.workspaceFileSearch.revealHint`："Save first; .zcodeignore lives at the workspace root"
- `settingsSync.agent.zcode`："ZCode Agent"
- `chat.slash.emptyUnavailable`："No slash commands have been broadcast for the current ZCode Agent session"

