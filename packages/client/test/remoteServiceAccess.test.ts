import { describe, expect, it, vi } from "vitest";
import type { IChannel, IChannelClient } from "@zcode/rpc";
import { ISourceServerManagementService } from "@zcode/services";
import { RemoteServiceAccess } from "../src/remoteServiceAccess.js";

const channel: IChannel = {
  call: vi.fn(),
  listen: vi.fn(),
};

// FORK：client-config 独立频道（IClientConfigService / clientConfigService）未随 fork
// 采纳——fork 的 RemoteServiceAccess 不暴露该代理，上游的独立频道 RPC 用例不再回归。

describe("RemoteServiceAccess optional channels", () => {
  it("does not construct a Source management proxy for scopes that do not publish it", () => {
    const getChannel = vi.fn(() => channel);
    const services = new RemoteServiceAccess({ getChannel } as IChannelClient, {
      sourceServerManagementService: false,
    });

    expect(services.sourceServerManagementService).toBeUndefined();
    expect(getChannel).not.toHaveBeenCalledWith(ISourceServerManagementService.channelName);
  });
});

it("MRO02：窗口目录只由显式能力创建，原工作区 project 频道保留", async () => {
  const calls: string[] = [];
  const getChannel = vi.fn((name: string) => ({
    call: async () => {
      calls.push(name);
      return name === "window-project-changes" ? { version: 1 } : { projects: [], tasks: [] };
    },
    listen: vi.fn(),
  }));
  const legacy = new RemoteServiceAccess({ getChannel });
  expect(legacy.windowProjectDirectory).toBeUndefined();
  expect(getChannel).not.toHaveBeenCalledWith("window-project");
  const services = new RemoteServiceAccess({ getChannel }, { windowProjectDirectory: true });
  expect(services.windowProjectDirectory).toBeDefined();
  await services.windowProjectDirectory!.changesService.getCapabilities();
  await services.windowProjectDirectory!.projectService.readTree();
  await services.projectService.readTree();
  expect(calls).toEqual(["window-project-changes", "window-project", "project"]);
});
