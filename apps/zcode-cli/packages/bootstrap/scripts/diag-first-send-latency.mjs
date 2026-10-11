/**
 * ③ 首发消息卡顿——诊断脚本（不入门禁链，手动跑）。
 *
 * 在隔离临时库上用真工厂测每段固有成本：
 *   t0  createMagicContextTurnTransform（DB open + 迁移检查 + transform 装配）
 *   t1  首条消息的 pass（首轮投影 + 会话注册）
 *   t2/t3 第二、三条消息的 pass（热路径对照）
 * 与用户 dev 实测相位对照：admit→context.built 841ms；context.built→model.request ~1985ms。
 */

import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const TS_SOURCE_PACKAGES = new Set([
  "@zcode/shared",
  "@zcode/model-option-map",
  "@zcode/provider",
  "@zcode/provider-node",
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const segments = specifier.split("/");
    const packageName = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : TS_SOURCE_PACKAGES.has(segments.slice(0, 2).join("/"))
        ? segments.slice(0, 2).join("/")
        : null;
    if (packageName !== null) {
      const distRoot = `${REPO_ROOT}packages/${packageName.slice("@zcode/".length)}/dist/`;
      const subpath = specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
      for (const candidate of [`${distRoot}${subpath}.js`, `${distRoot}${subpath}/index.js`]) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
      throw new Error(`no compiled dist for "${specifier}" — build ${packageName} first`);
    }
    return nextResolve(specifier, context);
  },
});

const TEST_HOME = mkdtempSync(join(tmpdir(), "diag-first-send-"));
process.env.ZCODE_STORAGE_DIR = TEST_HOME;
process.env.MAGIC_CONTEXT_DB_DIR = join(TEST_HOME, "magic-context");
process.env.ZCODE_MAGIC_CONTEXT_DEBUG_WIRE = "1";

const { createMagicContextTurnTransform } =
  await import("../dist/app/magic-context-turn-transform.js");

const NOOP_LOGGER = {
  info: (msg, ctx) =>
    console.log(
      "  [log]",
      perfNow(),
      String(msg).slice(0, 90),
      ctx?.event ?? "",
      ctx?.passDurationMs ?? "",
    ),
  warn: (msg, ctx) => console.log("  [warn]", perfNow(), String(msg).slice(0, 120)),
  error: (msg, ctx) => console.log("  [err]", perfNow(), String(msg).slice(0, 120)),
};
const perfNow = () => `${Math.round(performance.now())}ms`;
const sessionId = "ses_diag_1";

const t = async (label, fn) => {
  const startedAt = performance.now();
  const out = await fn();
  console.log(label, Math.round(performance.now() - startedAt), "ms");
  return out;
};

const makeModel = () => ({
  providerId: "zcode",
  modelId: "glm-4.6",
  displayName: "glm-4.6",
  properties: { contextWindow: 128_000 },
  optionSpecs: { maxOutputTokens: { max: 8192 }, reasoningLevel: { values: [] } },
  options: {},
  bind() {
    return this;
  },
});

const entries = (text) => [
  { kind: "message", message: { role: "system", content: "you are zcode" } },
  { kind: "message", message: { role: "user", content: text }, metadata: { source: "real_user" } },
];

const port = await t("t0 factory-create (db open+migrations):", () =>
  createMagicContextTurnTransform({
    enabled: true,
    configDomain: JSON.parse(process.env.DIAG_CONFIG ?? "{}"),
    sessionId,
    workingDirectory: TEST_HOME,
    logger: NOOP_LOGGER,
    createSidecarModel: makeModel,
    registerClose: () => {},
    processExitsAfterTurn: false,
  }),
);

let n = 0;
const labels = ["t1 first-message pass:", "t2 second pass:", "t3 third pass:"];
// 模拟真实形态：工厂建好（app 启动）与首条消息之间有用户输入间隙——给 fire-and-forget
// 预热留出完成窗口（prewarm 在 queueMicrotask 里跑）。
await new Promise((resolve) => setTimeout(resolve, Number(process.env.DIAG_SETTLE_MS ?? 2500)));
console.log("t0.5 prewarm-settle:", "done");
// 可选：只对 t1 窗口打 CPU profile（DIAG_PROFILE=1）。
let profSession;
let profileFile;
if (process.env.DIAG_PROFILE === "1") {
  const { Session } = await import("node:inspector/promises");
  profSession = new Session();
  profSession.connect();
  await profSession.post("Profiler.enable");
  await profSession.post("Profiler.setSamplingInterval", { interval: 1000 });
  await profSession.post("Profiler.start");
}
for (const label of labels) {
  if (label === "t2 second pass:" && profSession) {
    const { profile } = await profSession.post("Profiler.stop");
    profileFile = `${TEST_HOME}/t1.cpuprofile`;
    (await import("node:fs")).writeFileSync(profileFile, JSON.stringify(profile));
  }
  await t(label, () =>
    port({
      entries: entries(`diag message ${++n}`),
      model: { providerId: "zcode", modelId: "glm-4.6", properties: { contextWindow: 128_000 } },
      sessionId,
      workingDirectory: TEST_HOME,
    }),
  );
}
if (profSession) console.log("t1-profile:", profileFile);

console.log("temp-home:", TEST_HOME);
