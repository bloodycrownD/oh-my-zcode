/**
 * T-SS1（backlog-sweep Step 11）：Source 设置面 renderer 服务注册表。
 * 移植上游 ui/test/sourceSettingsServiceStore.test.ts（vitest → node:test）。
 *
 * 运行：npx tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/sourceSettingsServiceStore.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { IServiceAccessor } from "@zcode/services";
import {
  ensureSourceSettingsServices,
  getSourceSettingsServices,
  registerSourceSettingsServices,
  subscribeSourceSettingsServices,
} from "../src/store/sourceSettingsServiceStore.js";

function createServices(name: string): IServiceAccessor {
  return { name } as unknown as IServiceAccessor;
}

test("T-SS1 迟到的旧 attachment close 不误删新一代 services", () => {
  const sourceServerId = "source-replacement";
  const servicesA = createServices("A");
  const servicesB = createServices("B");
  let disposeACount = 0;
  let disposeBCount = 0;

  const releaseA = registerSourceSettingsServices({
    sourceServerId,
    attachmentId: "attachment-a",
    services: servicesA,
    dispose: () => void (disposeACount += 1),
  });
  const releaseB = registerSourceSettingsServices({
    sourceServerId,
    attachmentId: "attachment-b",
    services: servicesB,
    dispose: () => void (disposeBCount += 1),
  });

  releaseA();

  assert.equal(getSourceSettingsServices(sourceServerId), servicesB);
  assert.equal(disposeACount, 1);
  assert.equal(disposeBCount, 0);

  releaseB();
  releaseB();

  assert.equal(getSourceSettingsServices(sourceServerId), undefined);
  assert.equal(disposeBCount, 1);
});

test("T-SS1 同一 Source 共享一次 in-flight admission，失败后可重试", async () => {
  const sourceServerId = "config-same";
  let reject!: (error: Error) => void;
  let requestCount = 0;
  const request = () => {
    requestCount += 1;
    return new Promise<{ attachmentId: string }>((_resolve, fail) => {
      reject = fail;
    });
  };

  const a = ensureSourceSettingsServices(sourceServerId, request);
  const b = ensureSourceSettingsServices(sourceServerId, request);
  assert.equal(a, b);
  assert.equal(requestCount, 1);

  reject(new Error("offline"));
  await assert.rejects(a, /offline/);

  let retryCount = 0;
  await ensureSourceSettingsServices(sourceServerId, async () => {
    retryCount += 1;
    return { attachmentId: "ready" };
  });
  assert.equal(retryCount, 1);
});

test("T-SS1 未选中 Source 时返回 undefined（调用方回落本机 scope，不抛错）", () => {
  assert.equal(getSourceSettingsServices(undefined), undefined);
  assert.equal(getSourceSettingsServices(""), undefined);
});

test("T-SS1 登记/释放都通知订阅者，退订后不再通知（端口迟到与释放的重算来源）", () => {
  const sourceServerId = "config-subscribe";
  const events: string[] = [];
  const unsubscribe = subscribeSourceSettingsServices(() => events.push("changed"));

  const services = createServices("subscribe");
  const release = registerSourceSettingsServices({
    sourceServerId,
    attachmentId: "attachment-subscribe",
    services,
    dispose: () => {},
  });
  assert.deepEqual(events, ["changed"], "端口登记必须通知（分区据此从锚点/不可用切到端口）");
  assert.equal(getSourceSettingsServices(sourceServerId), services);

  release();
  assert.deepEqual(events, ["changed", "changed"], "端口释放必须通知（分区据此回落）");
  assert.equal(getSourceSettingsServices(sourceServerId), undefined);

  unsubscribe();
  const releaseAfterUnsubscribe = registerSourceSettingsServices({
    sourceServerId,
    attachmentId: "attachment-subscribe-2",
    services: createServices("after-unsubscribe"),
    dispose: () => {},
  });
  assert.deepEqual(events, ["changed", "changed"], "退订后不得再收到通知");
  releaseAfterUnsubscribe();
});
