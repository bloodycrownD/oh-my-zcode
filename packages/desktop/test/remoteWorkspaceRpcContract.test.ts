import { describe, expect, it } from "vitest";
import {
  REMOTE_WORKSPACE_RPC_CHANNELS,
  assertRemoteWorkspaceRpcContract,
} from "../src/host/remoteWorkspaceRpcContract.js";

describe("RemoteWorkspaceRpcContract v1", () => {
  it("requires the complete R3 full-forward channel set", () => {
    expect(REMOTE_WORKSPACE_RPC_CHANNELS).toContain("genUiService");
    const contract = Object.fromEntries(
      REMOTE_WORKSPACE_RPC_CHANNELS.map((channel) => [channel, {}]),
    );
    expect(() => assertRemoteWorkspaceRpcContract(contract)).not.toThrow();
    delete contract.fileService;
    expect(() => assertRemoteWorkspaceRpcContract(contract)).toThrow(/fileService/u);
    // FORK：conversationShareService / oauthService / codingPlanSubscriptionService 已随
    // 会话分享、官方登录与 Coding Plan 订阅面删除，合同不再要求这三个 channel。
    expect(REMOTE_WORKSPACE_RPC_CHANNELS).not.toContain("oauthService");
    expect(REMOTE_WORKSPACE_RPC_CHANNELS).not.toContain("conversationShareService");
    expect(REMOTE_WORKSPACE_RPC_CHANNELS).not.toContain("codingPlanSubscriptionService");
  });
});
