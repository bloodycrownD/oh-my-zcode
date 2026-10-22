interface WorkspaceTabIdentityLike {
  workspacePath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
}

interface WorkspaceTabMatchOptions {
  remoteSessionId?: string;
  workspaceIdentity?: string;
  /** Host stable identity 换代前的 route identity；rekey 时允许按旧 identity 命中同一 tab。 */
  previousWorkspaceIdentity?: string;
}

function hasRemoteTabIdentity(tab: WorkspaceTabIdentityLike): boolean {
  return Boolean(tab.workspaceIdentity || tab.remoteSessionId);
}

function isLocalWorkspaceTab(tab: WorkspaceTabIdentityLike): boolean {
  return !hasRemoteTabIdentity(tab);
}

export function isSameWorkspaceTab(
  tab: WorkspaceTabIdentityLike,
  workspacePath: string,
  options?: WorkspaceTabMatchOptions,
): boolean {
  if (tab.workspacePath !== workspacePath) {
    return false;
  }

  if (options?.workspaceIdentity) {
    return (
      tab.workspaceIdentity === options.workspaceIdentity ||
      (Boolean(options.previousWorkspaceIdentity) &&
        tab.workspaceIdentity === options.previousWorkspaceIdentity)
    );
  }

  if (options?.remoteSessionId) {
    return tab.remoteSessionId === options.remoteSessionId;
  }

  return isLocalWorkspaceTab(tab);
}
