// 照搬上游 v3.16.2 remote-connection-flow/contract.ts 的类型子集（取 :28-33 的 onSelectProject 签名）。
// omz 现状：上游把整个向导编排收进 remote-connection-flow/index.ts（2185L），
// omz 仍保有 SSHDialog + RemoteConnectionDialogContent 的向导壳族（拍板 A），
// 因此本文件只收敛 Picker 真链需要的四参签名，不引入上游 flow 编排。
// 四参语义：前三个与旧签名一致；第四个 workspacePurpose 决定 owner 分支——
// "project" 交 Root 的 Picker（不建 tab），"conversation" 保持旧链（连上即开 tab）。

export type RemoteConnectionWorkspacePurpose = "project" | "conversation";

/** 向导选目录完成后的提交入口；未传 workspacePurpose 时按旧行为（conversation）处理。 */
export type SelectRemoteProjectHandler = (
  sessionId: string,
  path: string,
  localWorkspacePath?: string,
  workspacePurpose?: RemoteConnectionWorkspacePurpose,
) => Promise<void>;

/**
 * 未显式传值时按 "conversation" 兜底：ChatEmptyState 等旧挂载点的行为不能因契约扩展而改变。
 * 只认两个字面量；其它来源（如 app-shell 既有 preparedWorkspaceIdentity 调用面透传的 identity 串）
 * 一律落回 conversation，避免把身份键误当 purpose。
 */
export function normalizeRemoteConnectionWorkspacePurpose(
  value: string | undefined,
): RemoteConnectionWorkspacePurpose {
  return value === "project" ? "project" : "conversation";
}
