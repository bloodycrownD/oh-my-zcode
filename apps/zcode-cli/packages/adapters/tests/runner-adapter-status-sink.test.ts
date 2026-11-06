import { describe, expect, it, vi } from "vitest";
import {
  createModelId,
  createModelProviderId,
  runWithModelInvocationContext,
  type ModelNetworkStatusEvent,
  type ModelRequestFailedStatusEvent,
  type ModelStatusSink,
} from "@zcode/contracts";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelInputFormatConfig,
  ModelOptionSpecsConfig,
  ModelOutputFormatConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  type RegistryModelConfig,
  type RegistryProviderConfig,
} from "@zcode/provider";
import { AiSdkModelAdapter } from "../src/model/runner.js";
import type { AiSdkModelRuntime } from "../src/model/runner-runtime.js";

const PROVIDER_ID = "openai";
const MODEL_ID = "gpt-5.6-sol";
const MESSAGES = [{ content: "hello", role: "user" as const }];

function createProviderConfig(): RegistryProviderConfig {
  return new ProviderConfig({
    access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
    api: new ProviderApiConfig({
      type: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    }),
    builtinModelIds: [MODEL_ID],
    enabled: true,
    id: PROVIDER_ID,
    personalModelIds: [],
    name: "OpenAI",
    visibility: "visible",
  }) as RegistryProviderConfig;
}

function createModelConfig(): RegistryModelConfig {
  return new ModelConfig({
    enabled: true,

    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: 1_050_000,
      inputFormat: new ModelInputFormatConfig({
        supportsText: true,
        supportsImage: true,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: true,
      }),
      outputFormat: new ModelOutputFormatConfig({ supportsText: true }),
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: {
        values: ["none", "low", "medium", "high", "xhigh", "max"],
        map: '{"reasoning":{"effort":reasoningLevel}}',
      },
      maxOutputTokens: {
        max: 128_000,
        map: '{"max_output_tokens":maxOutputTokens}',
      },
    }),
  }) as RegistryModelConfig;
}

function createSucceedingRuntime(): AiSdkModelRuntime {
  return {
    async generateText() {
      return {
        finishReason: "stop",
        text: "done",
        totalUsage: {},
        usage: {},
      } as never;
    },
    streamText() {
      throw new Error("not used");
    },
  };
}

function createFailingRuntime(error: Error): AiSdkModelRuntime {
  return {
    async generateText() {
      throw error;
    },
    streamText() {
      throw new Error("not used");
    },
  };
}

function createAdapter(
  input: {
    runtime?: AiSdkModelRuntime;
    statusSink?: ModelStatusSink;
  } = {},
): AiSdkModelAdapter {
  return new AiSdkModelAdapter({
    runtime: input.runtime ?? createSucceedingRuntime(),
    // 单次尝试：失败用例不进入退避 sleep，断言只针对一次请求的投递。
    retry: { maxAttempts: 1 },
    ...(input.statusSink ? { statusSink: input.statusSink } : {}),
  });
}

function createModel(adapter: AiSdkModelAdapter) {
  return adapter.createModel({
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
    providerConfig: createProviderConfig(),
    modelConfig: createModelConfig(),
    options: { maxOutputTokens: 128_000, reasoningLevel: "max" },
  });
}

function createStartedEvent(): ModelNetworkStatusEvent {
  return {
    attempt: 1,
    maxAttempts: 1,
    modelId: createModelId(MODEL_ID),
    providerId: createModelProviderId(PROVIDER_ID),
    requestId: "request-1",
    timestamp: "2026-11-05T00:00:00.000Z",
    traceId: "trace-1" as never,
    transport: "http",
    type: "model_request_started",
  };
}

function createFailedEvent(): ModelRequestFailedStatusEvent {
  return {
    ...createStartedEvent(),
    message: "Provider request failed.",
    reason: "unknown",
    retryable: false,
    type: "model_request_failed",
  };
}

type RecordingSink = ModelStatusSink & {
  readonly events: ModelNetworkStatusEvent[];
  readonly failures: Array<{ event: ModelRequestFailedStatusEvent; error: unknown }>;
};

function createRecordingSink(): RecordingSink {
  const events: ModelNetworkStatusEvent[] = [];
  const failures: Array<{ event: ModelRequestFailedStatusEvent; error: unknown }> = [];
  return {
    events,
    failures,
    publish(event) {
      events.push(event);
    },
    publishFailure(event, error) {
      failures.push({ error, event });
    },
  };
}

/**
 * adapter 对外只暴露 `publish` 行为，合成出口的抛错语义（部分失败抛原始异常、
 * 全失败抛 AggregateError）会被 `runner-status` 吞成一条 warn，从模型主链路观测不到。
 * 因此直接读私有出口断言契约——它是 `addStatusSink` 唯一的产品面。
 */
function adapterStatusSink(adapter: AiSdkModelAdapter): ModelStatusSink {
  const internal = adapter as unknown as { statusSink?: ModelStatusSink };
  const sink = internal.statusSink;
  if (!sink) throw new Error("adapter 未配置 statusSink");
  return sink;
}

async function captureRejection(run: () => Promise<void> | void): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("期望投递失败，但实际成功完成");
}

describe("AiSdkModelAdapter addStatusSink", () => {
  it("两个 sink 都收齐同一批状态事件", async () => {
    const first = createRecordingSink();
    const second = createRecordingSink();
    const adapter = createAdapter({ statusSink: first });
    adapter.addStatusSink(second);

    await createModel(adapter).generateText({ messages: MESSAGES });

    expect(first.events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_completed",
    ]);
    expect(second.events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_completed",
    ]);
    // 同一批事件是同一个对象，不各自拷贝一份。
    expect(second.events[0]).toBe(first.events[0]);
    expect(second.events[1]).toBe(first.events[1]);
  });

  it("一个 sink 抛错时，另一个 sink 仍收齐事件且模型调用不受影响", async () => {
    const brokenError = new Error("sink A unavailable");
    const broken: ModelStatusSink = {
      publish() {
        throw brokenError;
      },
    };
    const healthy = createRecordingSink();
    const adapter = createAdapter({ statusSink: broken });
    adapter.addStatusSink(healthy);

    await expect(createModel(adapter).generateText({ messages: MESSAGES })).resolves.toMatchObject({
      text: "done",
    });
    expect(healthy.events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_completed",
    ]);
  });

  it("publishFailure 优先交给实现它的 sink，只实现 publish 的 sink 降级收事件", async () => {
    const rawError = Object.assign(new Error("socket reset by peer"), { code: "ECONNRESET" });
    const firstPublish = vi.fn();
    const firstPublishFailure = vi.fn();
    const first: ModelStatusSink = {
      publish: firstPublish,
      publishFailure: firstPublishFailure,
    };
    // `publish` 是必填成员：只实现 publish 的 sink 代表所有不消费原始异常的出口。
    const secondEvents: ModelNetworkStatusEvent[] = [];
    const second: ModelStatusSink = {
      publish(event) {
        secondEvents.push(event);
      },
    };
    const adapter = createAdapter({
      runtime: createFailingRuntime(rawError),
      statusSink: first,
    });
    adapter.addStatusSink(second);

    await expect(createModel(adapter).generateText({ messages: MESSAGES })).rejects.toBeInstanceOf(
      Error,
    );

    expect(firstPublishFailure).toHaveBeenCalledTimes(1);
    const [failureEvent, forwardedError] = firstPublishFailure.mock.calls[0] as [
      ModelRequestFailedStatusEvent,
      unknown,
    ];
    expect(failureEvent.type).toBe("model_request_failed");
    // 原始异常逐字透传，不是被适配器包装后的错误。
    expect(forwardedError).toBe(rawError);
    // sink A 的 publish 只收到 started（失败事件走 publishFailure，没有二次降级）。
    expect(firstPublish.mock.calls).toEqual([
      [expect.objectContaining({ type: "model_request_started" })],
    ]);
    expect(secondEvents.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
    ]);
    expect(secondEvents[1]).toBe(failureEvent);
  });

  it("部分失败抛原始异常，全部失败抛 AggregateError", async () => {
    const firstError = new Error("first sink down");
    const secondError = new Error("second sink down");
    const event = createStartedEvent();

    const broken: ModelStatusSink = {
      publish() {
        throw firstError;
      },
    };
    const healthy = createRecordingSink();
    const partialAdapter = createAdapter({ statusSink: broken });
    partialAdapter.addStatusSink(healthy);
    const partialSink = adapterStatusSink(partialAdapter);

    // 部分失败：其余 sink 已收到事件，向调用方抛第一个原始异常。
    await expect(partialSink.publish(event)).rejects.toBe(firstError);
    expect(healthy.events).toEqual([event]);

    const alsoBroken: ModelStatusSink = {
      publish() {
        throw secondError;
      },
    };
    const allFailedAdapter = createAdapter({ statusSink: broken });
    allFailedAdapter.addStatusSink(alsoBroken);
    const allFailedSink = adapterStatusSink(allFailedAdapter);

    const failure = await captureRejection(() => allFailedSink.publish(event));
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([firstError, secondError]);
  });

  it("publishFailure 的失败同样逐 sink 隔离，全失败时用 AggregateError 汇总", async () => {
    const firstError = new Error("first failure sink down");
    const secondError = new Error("second failure sink down");
    const failedEvent = createFailedEvent();
    const rawError = new Error("raw provider error");
    const healthy = createRecordingSink();

    const broken: ModelStatusSink = {
      publish() {},
      publishFailure() {
        throw firstError;
      },
    };
    const partialAdapter = createAdapter({ statusSink: broken });
    partialAdapter.addStatusSink(healthy);
    await expect(
      adapterStatusSink(partialAdapter).publishFailure!(failedEvent, rawError),
    ).rejects.toBe(firstError);
    expect(healthy.failures).toEqual([{ error: rawError, event: failedEvent }]);

    const alsoBroken: ModelStatusSink = {
      publish() {},
      publishFailure() {
        throw secondError;
      },
    };
    const allFailedAdapter = createAdapter({ statusSink: broken });
    allFailedAdapter.addStatusSink(alsoBroken);

    const failure = await captureRejection(() =>
      adapterStatusSink(allFailedAdapter).publishFailure!(failedEvent, rawError),
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([firstError, secondError]);
  });

  it("同一 sink 连加 3 次只投递一次", async () => {
    const sink = createRecordingSink();
    const adapter = createAdapter();
    adapter.addStatusSink(sink);
    adapter.addStatusSink(sink);
    adapter.addStatusSink(sink);

    await createModel(adapter).generateText({ messages: MESSAGES });

    expect(sink.events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_completed",
    ]);
  });

  it("A→B→A 顺序重加时 A 与 B 各收一次", async () => {
    const first = createRecordingSink();
    const second = createRecordingSink();
    const adapter = createAdapter();
    adapter.addStatusSink(first);
    adapter.addStatusSink(second);
    adapter.addStatusSink(first);

    await createModel(adapter).generateText({ messages: MESSAGES });

    expect(first.events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_completed",
    ]);
    expect(second.events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_completed",
    ]);
  });

  it("A 同时作为构造选项与 addStatusSink 目标只投递一次", async () => {
    const sink = createRecordingSink();
    const adapter = createAdapter({ statusSink: sink });
    adapter.addStatusSink(sink);

    await createModel(adapter).generateText({ messages: MESSAGES });

    expect(sink.events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_completed",
    ]);
  });

  it("单叶子时保持 sink 身份，request 级同名出口不重复投递", async () => {
    const sink = createRecordingSink();
    const adapter = createAdapter({ statusSink: sink });
    // `runner-status` 用 `requestStatusSink !== statusSink` 去重：单叶子必须是叶子本身，
    // 套一层合成对象会让同一个 sink 作为 adapter 出口与 request 出口时投递两次。
    expect(adapterStatusSink(adapter)).toBe(sink);

    const model = createModel(adapter);
    await runWithModelInvocationContext({ statusSink: sink }, () =>
      model.generateText({ messages: MESSAGES }),
    );

    expect(sink.events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_completed",
    ]);
  });
});
