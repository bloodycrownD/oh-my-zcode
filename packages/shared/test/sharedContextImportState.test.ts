import { describe, expect, it } from "vitest";

import { sharedContextImportStateSchema } from "../src/zcode-protocol-v4/snapshot.js";

// FORK(upgrade-316)：分享导入已随官方端点删除；fork 的 sharedContextImportStateSchema 是
// 「存量日志只读」的宽松解析器（见 shared-context-import.ts 头注释）——只保证旧会话能读、
// 不再校验 shareUrl 形状或拒绝未知字段（没有消费方）。上游的 strict 校验断言不适用。

describe("shared context import state", () => {
  it("accepts the persisted handover lifecycle", () => {
    expect(
      sharedContextImportStateSchema.parse({
        contextId: "context-1",
        title: "分享标题",
        shareUrl: "https://zcode.z.ai/cn/share/code-1",
        status: "reserved",
      }),
    ).toEqual({
      contextId: "context-1",
      title: "分享标题",
      shareUrl: "https://zcode.z.ai/cn/share/code-1",
      status: "reserved",
    });
  });

  it.each(["pending", "attached", "discarded"] as const)("accepts %s status", (status) => {
    expect(
      sharedContextImportStateSchema.safeParse({
        contextId: "context-1",
        title: "分享标题",
        shareUrl: "https://zcode.z.ai/cn/share/code-1",
        status,
      }).success,
    ).toBe(true);
  });

  it("按 fork 宽松读语义：非 canonical shareUrl 与未知字段只被原样容忍，不再拒绝", () => {
    expect(
      sharedContextImportStateSchema.safeParse({
        contextId: "context-1",
        title: "分享标题",
        shareUrl: "https://share.example.com/share/code-1",
        status: "pending",
      }).success,
    ).toBe(true);
    expect(
      sharedContextImportStateSchema.safeParse({
        contextId: "context-1",
        title: "分享标题",
        shareUrl: "https://zcode.z.ai/cn/share/code-1",
        status: "pending",
        markdown: "must-not-cross-projection",
      }).success,
    ).toBe(true);
    // 非法枚举仍按 zod enum 拒绝：status 域是解析器仍持有的唯一约束。
    expect(
      sharedContextImportStateSchema.safeParse({
        contextId: "context-1",
        title: "分享标题",
        status: "bogus",
      }).success,
    ).toBe(false);
  });
});
