#!/usr/bin/env node
// test:v4-perf 的 runner：命令链已超出 Windows cmd 8191 字符上限，改为脚本顺序执行。
// 逐条执行、失败即停；任意一条非零退出码即整体失败（等价于原 && 链）。
import { spawnSync } from "node:child_process";

const COMMANDS = [
  "tsx --test packages/ui/test/conversationProjectionCore.test.ts packages/ui/test/conversationTurnNavigatorDirectory.test.ts packages/ui/test/conversationTurnNavigatorHelpers.test.ts packages/ui/test/conversationTurnRenderUnits.test.ts packages/ui/test/perfProbe.test.ts packages/ui/test/shikiTokensCacheLru.test.ts packages/ui/test/conversationStatusPanelControlWorkFallback.test.ts packages/ui/test/timelineRowHeightCache.test.ts packages/ui/test/chatPromptEditorSubmitValue.test.ts packages/ui/test/subagentDirectoryCancel.test.ts packages/ui/test/storageCategoryCleanableGate.test.ts packages/ui/test/askQuestionDisplayAnswers.test.ts packages/ui/test/modelTrajectoryTurns.test.ts packages/ui/test/modelTrajectoryToolJoin.test.ts packages/ui/test/modelTrajectoryTurnCounts.test.ts packages/ui/test/modelTrajectoryClamp.test.ts packages/ui/test/modelTrajectoryRetry.test.ts packages/shared/test/uiLocaleContract.test.ts packages/shared/test/apply.test.ts packages/shared/test/previewText.test.ts packages/shared/test/sessionContentProfileIndex.test.ts packages/shared/test/workflowRunsSeatBorn.test.ts packages/services/test/zcodeProtocolClientDispose.test.ts packages/services/test/zcodeStdioTransportFraming.test.ts packages/services/test/zcodeAgentProcessManagerCleanup.test.ts packages/services/test/zcodeTaskServiceAdapterStreamFallback.test.ts packages/services/test/subagentsServiceIoErrors.test.ts packages/services/test/runtimeProcessEnvShell.test.ts packages/services/test/nonCliAcpRetirement.test.ts packages/services/test/importedClaudeRecovery.test.ts packages/services/test/modelTrajectoryHead.test.ts packages/services/test/buildUiLocaleSpawnEnv.test.ts packages/desktop/scripts/test-deep-link-terminator.mjs packages/desktop/scripts/test-window-close-tray.mjs apps/zcode-cli/packages/dynamic-workflow/scripts/test-scheduler-recorded-asks.mjs apps/zcode-cli/packages/cli/test/runUiLocale.test.ts packages/ui/test/modelTrajectoryWireFilter.test.ts packages/ui/test/projectSidebarVirtualProject.test.ts",
  "tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/projectSidebarP41.test.ts",
  "tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/projectSidebarP42.test.ts",
  "npx tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/toolSearchRendererDispatch.test.ts",
  "tsx --test packages/ui/test/magicContextPromptSurfaceOverrides.test.ts",
  "pnpm --dir apps/zcode-cli/packages/bootstrap run test:turn-directory",
  "pnpm --dir apps/zcode-cli/packages/bootstrap run test:edit-retry-model",
  "pnpm --dir apps/zcode-cli/packages/bootstrap run test:ask-question-projection",
  "pnpm --dir apps/zcode-cli/packages/core run test:ask-question-display",
  "pnpm --dir apps/zcode-cli/packages/core run test:subagent-sync-dispatch",
  "pnpm --dir apps/zcode-cli/packages/core run test:subagent-notification-resume-hint",
  "pnpm --dir apps/zcode-cli/packages/core run test:error-payload-agentid-projection",
  "pnpm --dir apps/zcode-cli/packages/core run test:send-message-terminal-resume",
  "pnpm --dir apps/zcode-cli/packages/core run test:e2e-subagent-resume",
  "pnpm --dir apps/zcode-cli/packages/core run test:session-persistence-dedupe",
  "pnpm --dir apps/zcode-cli/packages/core run test:tool-media-stop-signal",
  "pnpm --dir apps/zcode-cli/packages/core run test:subagent-cache-breakpoints",
  "pnpm --dir apps/zcode-cli/packages/core run test:ctx-tool-descriptions",
  "pnpm --dir apps/zcode-cli/packages/core run test:toolsearch-smoke",
  "pnpm --dir apps/zcode-cli --filter \"@zcode/bootstrap...\" build",
  "pnpm --dir apps/zcode-cli/packages/core run test:workflow-report-count",
  "pnpm --dir apps/zcode-cli/packages/adapters run test:network-status-crash",
  "pnpm --dir apps/zcode-cli/packages/adapters run test:tool-result-cache-control",
  "pnpm --dir apps/zcode-cli/packages/adapters run test:magic-context-boundaries",
  "pnpm --dir apps/zcode-cli/packages/adapters run test:runner-debug-head",
  "pnpm --dir apps/zcode-cli/packages/bootstrap run test:publisher-buffer-clamp",
  "pnpm --dir apps/zcode-cli/packages/bootstrap run test:model-request-slim",
  "pnpm --dir apps/zcode-cli/packages/bootstrap run test:dwf-read-narrowing",
  "pnpm --dir apps/zcode-cli/packages/bootstrap run test:dwf-journal-contract",
  "pnpm --dir apps/zcode-cli/packages/bootstrap run test:mc-section-zh",
  "pnpm --dir apps/zcode-cli/packages/bootstrap run test:model-live",
  "pnpm --dir apps/zcode-cli/packages/bootstrap run test:subagent-live-model",
  "pnpm --dir apps/zcode-cli/packages/bootstrap run test:prompt-surface-toolset-hash",
  "tsx --tsconfig packages/ui/tsconfig.json --test apps/zcode-cli/packages/bootstrap/scripts/test-attachment-preview-text-plain.mjs",
  "node --import ./packages/ui/test/helpers/setup-ui-component-test.mjs --test packages/ui/test/modelConfigSelect-composer.test.ts",
  "pnpm --dir apps/zcode-cli/packages/core run test:session-hydrator-assembly",
  "node --import tsx --test apps/zcode-cli/packages/bootstrap/scripts/test-held-queue-routing.mjs",
  "node --import ./packages/ui/test/helpers/setup-ui-component-test.mjs --test packages/ui/test/composerHeldQueueGuard.test.ts",
  "node --import tsx --test packages/shared/test/sqliteMigrationsRunner.test.ts",
  "node --import tsx --test packages/services/test/tasksMigrationsUpgrade.test.ts",
    "node --import tsx --test packages/services/test/taskRunningReconcile.test.ts",
  "node --import tsx --test packages/services/test/projectStorageRepository.test.ts",
  "node --import tsx --test packages/services/test/taskMembershipQuery.test.ts",
  "node --import tsx --test packages/shared/test/sourceServerContracts.test.ts",
  "node --import tsx --test packages/zcode-server-cli/test/daemonCommandRegistry.test.ts",
  "node --import tsx --test packages/desktop/test/serverRemoteConnectionShape.test.ts packages/desktop/test/windowRemoteConnectionRegistryRecovery.test.ts",
  "node --import tsx --test packages/services/test/remoteSchemaMigrations.test.ts",
  "npx tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/remoteWorkspaceProjection.test.ts packages/ui/test/remoteWorkspaceReconnected.test.ts packages/ui/test/composerDraftTaskGroup.test.ts packages/ui/test/projectSidebarRemoteSeams.test.ts packages/ui/test/projectSidebarRemoteBackfill.test.ts packages/ui/test/projectSidebarSkeleton.test.ts",
  "node --import tsx --test packages/desktop/test/connectMainChainSwitch.test.ts packages/services/test/remoteProjectsService.test.ts packages/services/test/remoteProjectsMigration.test.ts packages/ui/test/u5u6SurvivorsShape.test.ts packages/desktop/test/unreadBadgeMaxSemantics.test.ts packages/desktop/test/fileApplicationsSelector.test.ts packages/desktop/test/editorSelectionPersist.test.ts packages/desktop/test/inlineImageResult.test.ts",
  "node --import ./packages/ui/test/helpers/setup-ui-component-test.mjs --test packages/ui/test/composerMentionPillParse.test.ts packages/ui/test/composerMentionPillFill.test.ts packages/ui/test/modelProviderNameDialog.test.ts packages/ui/test/modelProviderCardActions.test.ts packages/ui/test/remoteProjectPickerChain.test.ts packages/ui/test/sourceServerUpdateNotifications.test.ts",
  "node --import tsx --test packages/services/test/localUsageEvidence.test.ts",
  "node --import tsx --test packages/services/test/sourceServerManagement.test.ts",
  "node --import ./packages/ui/test/helpers/setup-ui-component-test.mjs --test packages/ui/test/sidePaneFullView.test.ts",
  "node --import ./packages/ui/test/helpers/setup-ui-component-test.mjs --test packages/ui/test/sourceServerPanelShape.test.ts",
  "node --import tsx --test packages/server/test/pathTraversal.test.ts",
  "node --import tsx --test packages/services/test/legacyDbUpgrade.test.ts",
  "node --import tsx --test packages/services/test/sourceServerReleaseResolver.test.ts packages/services/test/sourceSettingsServiceCollection.test.ts",
  "node --import ./packages/ui/test/helpers/setup-ui-component-test.mjs --test packages/ui/test/remoteConnectionProgressWiring.test.ts",
  "npx tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/settingsSourceWorkspace.test.ts packages/ui/test/sourceSettingsServiceStore.test.ts",
  "npx tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/settingsSourceAttachmentRetry.test.ts",
  "npx tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/mcpDirectoryServiceOwnership.test.ts",
  "pnpm --dir apps/zcode-cli/packages/bootstrap run test:tool-reference-roundtrip",
  "node --import tsx --test packages/desktop/test/sourceSettingsAttachmentChannel.test.ts",
  "pnpm --dir apps/zcode-cli/packages/bootstrap run test:mc-zero-load",
  "pnpm --dir apps/zcode-cli/packages/adapters run test:magic-context-config-lazy",
  "pnpm --dir apps/zcode-cli/packages/magic-context run test:tool-reference-projection",
  "pnpm --dir apps/zcode-cli/packages/magic-context run test:tool-reference-governance",
];

for (const [index, command] of COMMANDS.entries()) {
  const label = `[${index + 1}/${COMMANDS.length}] ${command}`;
  console.log(`\n=== ${label}`);
  const result = spawnSync(command, { shell: true, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n=== FAILED: ${command} (exit ${result.status ?? "signal"})`);
    process.exit(result.status ?? 1);
  }
}

console.log(`\n=== ALL ${COMMANDS.length} COMMANDS PASSED`);
