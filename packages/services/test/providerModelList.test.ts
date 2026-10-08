import assert from "node:assert/strict";
import test from "node:test";
import {
  createProviderModelLister,
  type ProviderModelListSource,
} from "../src/model-provider/providerModelList.js";

const API_KEY = "sk-test-secret-0001";
const CUSTOM_HEADER_VALUE = "header-secret-9001";

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
}

type FetchHandler = (
  call: RecordedCall,
  signal: AbortSignal | null | undefined,
) => Response | Promise<Response>;

/** 记录调用序列与请求头的 fake fetch；头按 Headers 语义归一化（大小写不敏感）。 */
function createFakeFetch(handler: FetchHandler) {
  const calls: RecordedCall[] = [];
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    return handler(call, init?.signal);
  };
  return { calls, fetch: fakeFetch as typeof fetch };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function statusResponse(status: number): Response {
  return new Response(null, { status });
}

function createLister(options: {
  fetch: typeof fetch;
  source?: ProviderModelListSource;
  timeoutMs?: number;
}) {
  return createProviderModelLister({
    readSource: (providerId) => (providerId === "provider-1" ? (options.source ?? {}) : undefined),
    fetch: options.fetch,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

async function readErrorMessage(promise: Promise<unknown>): Promise<string> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error, "expected the lister to reject");
  return failure.message;
}

test("openai 协议候选顺序：基址 /models → /v1/models → 源站两条", async () => {
  const { calls, fetch } = createFakeFetch(() => statusResponse(404));
  const listModels = createLister({
    fetch,
    source: {
      apiType: "openai-chat-completions",
      baseUrl: "https://x.test/api/",
      apiKey: API_KEY,
    },
  });

  await assert.rejects(listModels({ providerId: "provider-1" }), /未找到模型列表端点/);
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "https://x.test/api/models",
      "https://x.test/api/v1/models",
      "https://x.test/v1/models",
      "https://x.test/models",
    ],
  );
  assert.ok(calls.every((call) => call.method === "GET"));
});

test("anthropic 协议候选顺序与鉴权头：protocol 双发、源站仅 Bearer", async () => {
  const { calls, fetch } = createFakeFetch((call) =>
    call.url === "https://a.test/models"
      ? jsonResponse({ data: [{ id: "claude-x" }] })
      : statusResponse(404),
  );
  const listModels = createLister({
    fetch,
    source: {
      apiType: "anthropic-messages",
      baseUrl: "https://a.test/api",
      apiKey: API_KEY,
    },
  });

  const result = await listModels({ providerId: "provider-1" });
  assert.deepEqual(result.models, ["claude-x"]);
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "https://a.test/api/v1/models",
      "https://a.test/api/models",
      "https://a.test/v1/models",
      "https://a.test/models",
    ],
  );
  for (const call of calls.slice(0, 2)) {
    assert.equal(call.headers.get("authorization"), `Bearer ${API_KEY}`);
    assert.equal(call.headers.get("x-api-key"), API_KEY);
    assert.equal(call.headers.get("anthropic-version"), "2023-06-01");
  }
  for (const call of calls.slice(2)) {
    assert.equal(call.headers.get("authorization"), `Bearer ${API_KEY}`);
    assert.equal(call.headers.get("x-api-key"), null);
    assert.equal(call.headers.get("anthropic-version"), null);
  }
});

test("全链 404：恰 4 次调用，错误列出已试端点与最后状态", async () => {
  const { calls, fetch } = createFakeFetch(() => statusResponse(404));
  const listModels = createLister({
    fetch,
    source: {
      apiType: "openai-chat-completions",
      baseUrl: "https://x.test/api",
      apiKey: API_KEY,
    },
  });

  const message = await readErrorMessage(listModels({ providerId: "provider-1" }));
  assert.match(message, /未找到模型列表端点/);
  assert.match(message, /已尝试 \/models、\/v1\/models、源站 \/v1\/models、源站 \/models/);
  assert.match(message, /HTTP 404/);
  assert.equal(calls.length, 4);
});

test("全链 404/405 交替：错误带最后一个状态码", async () => {
  const { calls, fetch } = createFakeFetch((call) =>
    call.url === "https://x.test/models" ? statusResponse(405) : statusResponse(404),
  );
  const listModels = createLister({
    fetch,
    source: {
      apiType: "openai-chat-completions",
      baseUrl: "https://x.test/api",
      apiKey: API_KEY,
    },
  });

  const message = await readErrorMessage(listModels({ providerId: "provider-1" }));
  assert.match(message, /HTTP 405/);
  assert.equal(calls.length, 4);
});

test("401 与路径无关：只请求第一个候选即抛出并提示检查 API Key", async () => {
  const { calls, fetch } = createFakeFetch(() => statusResponse(401));
  const listModels = createLister({
    fetch,
    source: {
      apiType: "openai-chat-completions",
      baseUrl: "https://x.test/api",
      apiKey: API_KEY,
    },
  });

  const message = await readErrorMessage(listModels({ providerId: "provider-1" }));
  assert.match(message, /HTTP 401/);
  assert.match(message, /请检查 API Key/);
  assert.equal(calls.length, 1);
});

test("握手永不完成：到点报超时文案，而不是网络错误", { timeout: 5_000 }, async () => {
  const { fetch } = createFakeFetch(
    (_call, signal) =>
      new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      }),
  );
  const listModels = createLister({
    fetch,
    timeoutMs: 20,
    source: {
      apiType: "openai-chat-completions",
      baseUrl: "https://x.test/api",
      apiKey: API_KEY,
    },
  });

  const message = await readErrorMessage(listModels({ providerId: "provider-1" }));
  assert.match(message, /超时/);
});

test("只发响应头不结束响应体：超时同样按超时文案报错", { timeout: 5_000 }, async () => {
  const { fetch } = createFakeFetch(
    (_call, signal) =>
      new Promise<Response>((resolve) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener("abort", () => {
              controller.error(new DOMException("This operation was aborted", "AbortError"));
            });
          },
        });
        resolve(
          new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
        );
      }),
  );
  const listModels = createLister({
    fetch,
    timeoutMs: 20,
    source: {
      apiType: "openai-chat-completions",
      baseUrl: "https://x.test/api",
      apiKey: API_KEY,
    },
  });

  const message = await readErrorMessage(listModels({ providerId: "provider-1" }));
  assert.match(message, /超时/);
});

test("响应体不是合法 JSON：错误点名 HTTP 状态而不是 JSON 解析细节", async () => {
  const { fetch } = createFakeFetch(() => new Response("<html>gateway</html>", { status: 200 }));
  const listModels = createLister({
    fetch,
    source: {
      apiType: "openai-chat-completions",
      baseUrl: "https://x.test/api",
      apiKey: API_KEY,
    },
  });

  const message = await readErrorMessage(listModels({ providerId: "provider-1" }));
  assert.match(message, /HTTP 200/);
  assert.match(message, /响应不是合法 JSON/);
});

test("脏 payload：去空白、去重、只认 data[].id 并排序", async () => {
  const { calls, fetch } = createFakeFetch(() =>
    jsonResponse({ data: [" b", "a", "a", "", 42, { id: "c" }, { model: "x" }, null] }),
  );
  const listModels = createLister({
    fetch,
    source: { apiType: "openai-chat-completions", baseUrl: "https://x.test/api", apiKey: API_KEY },
  });

  const result = await listModels({ providerId: "provider-1" });
  assert.deepEqual(result.models, ["a", "b", "c"]);
  assert.equal(calls.length, 1);
});

test("data 非数组：返回空列表而不是抛错", async () => {
  const { fetch } = createFakeFetch(() => jsonResponse({ data: { models: ["a"] } }));
  const listModels = createLister({
    fetch,
    source: { apiType: "openai-chat-completions", baseUrl: "https://x.test/api", apiKey: API_KEY },
  });

  const result = await listModels({ providerId: "provider-1" });
  assert.deepEqual(result.models, []);
});

test("legacy 自定义头随请求发出，显式鉴权头覆盖同名自定义头", async () => {
  const { calls, fetch } = createFakeFetch((call) =>
    call.url === "https://x.test/api/models"
      ? jsonResponse({ data: [{ id: "m-1" }] })
      : statusResponse(404),
  );
  const listModels = createLister({
    fetch,
    source: {
      apiType: "anthropic-messages",
      baseUrl: "https://x.test/api",
      apiKey: API_KEY,
      headers: {
        "X-Gateway-Tenant": CUSTOM_HEADER_VALUE,
        // 大小写不同也算同名：显式 Bearer / x-api-key 必须覆盖它们。
        Authorization: "Bearer legacy-should-lose",
        "x-api-key": "legacy-should-lose",
      },
    },
  });

  const result = await listModels({ providerId: "provider-1" });
  assert.deepEqual(result.models, ["m-1"]);
  const [firstCall] = calls;
  assert.ok(firstCall);
  assert.equal(firstCall.headers.get("x-gateway-tenant"), CUSTOM_HEADER_VALUE);
  assert.equal(firstCall.headers.get("authorization"), `Bearer ${API_KEY}`);
  assert.equal(firstCall.headers.get("x-api-key"), API_KEY);
  assert.equal(firstCall.headers.get("anthropic-version"), "2023-06-01");
});

test("错误信息与日志都不携带 API Key 与自定义头取值", async () => {
  const capturedLines: string[] = [];
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const capture = (...args: unknown[]) => {
    capturedLines.push(args.map((arg) => String(arg)).join(" "));
  };
  Object.assign(console, { log: capture, warn: capture, error: capture, debug: capture });

  const messages: string[] = [];
  try {
    const source: ProviderModelListSource = {
      apiType: "anthropic-messages",
      baseUrl: "https://x.test/api",
      apiKey: API_KEY,
      headers: { "x-gateway-tenant": CUSTOM_HEADER_VALUE },
    };
    // 全链 404
    const notFound = createFakeFetch(() => statusResponse(404));
    messages.push(
      await readErrorMessage(
        createLister({ fetch: notFound.fetch, source })({ providerId: "provider-1" }),
      ),
    );
    // 鉴权失败
    const unauthorized = createFakeFetch(() => statusResponse(403));
    messages.push(
      await readErrorMessage(
        createLister({ fetch: unauthorized.fetch, source })({ providerId: "provider-1" }),
      ),
    );
    // 传输层异常
    const networkFailure = createFakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    messages.push(
      await readErrorMessage(
        createLister({ fetch: networkFailure.fetch, source })({ providerId: "provider-1" }),
      ),
    );
    // 成功路径的 debug 日志同样不得带上秘密
    const success = createFakeFetch(() => jsonResponse({ data: [{ id: "m-1" }] }));
    await createLister({ fetch: success.fetch, source })({ providerId: "provider-1" });
  } finally {
    Object.assign(console, originalConsole);
  }

  for (const message of messages) {
    assert.ok(!message.includes(API_KEY), `error message leaked the API key: ${message}`);
    assert.ok(
      !message.includes(CUSTOM_HEADER_VALUE),
      `error message leaked a custom header value: ${message}`,
    );
  }
  const logged = capturedLines.join("\n");
  assert.ok(!logged.includes(API_KEY), `logs leaked the API key: ${logged}`);
  assert.ok(!logged.includes(CUSTOM_HEADER_VALUE), `logs leaked a custom header value: ${logged}`);
});
