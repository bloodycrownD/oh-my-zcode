/**
 * T-O1（magic-context-memory-management Step 9）：onboarding 停写 `memoryEnabled` 的三断言回归。
 *
 * 收口面（spec 变更点 12）：
 *   1. 保存路径 settings 侧不写——`OccupationOnboarding.tsx` 的 update() / appendRecord 调用
 *      不得再携带该键。UI 侧本迭代无渲染级单测入口，用源文本守卫钉住（token 检查剔除注释）；
 *   2. appendRecord 载荷不含该键——调用方省略传，落盘 JSON 里该属性必须缺席（不是 null，
 *      null 保留「该页被跳过」语义，写 null 会污染上传载荷的缺省口径）；
 *   3. 换号同步 syncSettingsFromRecord 不回写——回填 patch 不得含该键，存量记录里
 *      memoryEnabled=true 也不得复活开关（与挂载归零迁移共同构成双闸）。
 *
 * 兼容性：`@zcode/shared` 的 onboardingRecordEntrySchema 已把该键改为 nullable().optional()，
 * 旧记录带 true/false/null 照常解析；非布尔值仍须拒绝（optional 不得退化成任意值）。
 * 运行时解析 @zcode/shared 走 package.json exports 直连 src，不依赖 shared dist 重建。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { onboardingRecordEntrySchema, onboardingRecordFileSchema } from "@zcode/shared";
import { createOnboardingRecordService } from "../src/onboarding/onboardingRecordService.js";
import { getAppConfigDir, setDataBaseDir } from "../src/paths.js";

const DEVICE_MID = "device-mid-t-o1";

let fixture: {
  dir: string;
  recordPath: string;
  service: ReturnType<typeof createOnboardingRecordService>;
  setCurrentUserId: (userId: string | null) => void;
};

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-onboarding-memory-write-stop-"));
  // data dir 隔离：record 落 {dataBaseDir}/.omz/v2/onboarding-record.json，绝不触碰真实用户目录。
  setDataBaseDir(dir);
  let currentUserId: string | null = "user-a";
  const service = createOnboardingRecordService({
    loadUserId: async () => currentUserId,
    hasExistingLocalTask: async () => true,
  });
  fixture = {
    dir,
    recordPath: join(getAppConfigDir(), "onboarding-record.json"),
    service,
    setCurrentUserId: (userId) => {
      currentUserId = userId;
    },
  };
});

after(async () => {
  setDataBaseDir(null);
  if (fixture) await rm(fixture.dir, { recursive: true, force: true });
});

test("appendRecord 省略该键：落盘 entry 无 memoryEnabled 属性", async () => {
  await fixture.service.appendRecord(DEVICE_MID, {
    occupation: "developer",
    interfaceMode: "coding",
    proactiveSuggestionsEnabled: true,
    completedAt: new Date().toISOString(),
  });
  const raw = JSON.parse(await readFile(fixture.recordPath, "utf-8")) as {
    entries: Record<string, unknown>[];
  };
  const entry = raw.entries[0]!;
  assert.equal(
    Object.prototype.hasOwnProperty.call(entry, "memoryEnabled"),
    false,
    "调用方省略传 => JSON 里必须缺席（服务端 spread 不得补写该键）",
  );
  assert.equal(entry.proactiveSuggestionsEnabled, true, "其余偏好载荷照常落盘");
  // 无该键的 entry 必须仍是合法记录（optional 化的核心收益）。
  onboardingRecordFileSchema.parse(raw);
});

test("存量记录（memoryEnabled=true）照常解析，且 syncSettingsFromRecord 不回写该键", async () => {
  fixture.setCurrentUserId("user-a");
  await mkdir(getAppConfigDir(), { recursive: true });
  await writeFile(
    fixture.recordPath,
    JSON.stringify({
      version: 2,
      deviceMid: DEVICE_MID,
      entries: [
        {
          userId: "user-a",
          occupation: "student",
          interfaceMode: "office",
          memoryEnabled: true, // 旧版落盘的存量值：解析必须兼容
          proactiveSuggestionsEnabled: true,
          completedAt: new Date().toISOString(),
          uploadState: "pending",
        },
      ],
      decisions: [],
    }),
  );
  const latest = await fixture.service.getLatestEntry();
  assert.equal(latest?.memoryEnabled, true, "旧记录带值照常解析（不得因 optional 化丢字段）");
  const patch = await fixture.service.syncSettingsFromRecord();
  assert.ok(patch, "有记录时必须回填");
  assert.equal(
    Object.prototype.hasOwnProperty.call(patch, "memoryEnabled"),
    false,
    "换号同步不得回填 memoryEnabled（挂载归零后不得复活开关）",
  );
  assert.equal(patch.onboardingOccupation, "student");
  assert.equal(patch.proactiveSuggestionsEnabled, true);
});

test("entry schema：缺键 / true / false / null 均合法，非布尔仍被拒绝", () => {
  const base = {
    userId: null,
    occupation: "developer",
    interfaceMode: "coding",
    proactiveSuggestionsEnabled: null,
    completedAt: new Date().toISOString(),
    uploadState: "pending" as const,
  };
  assert.equal(onboardingRecordEntrySchema.safeParse(base).success, true, "缺键=新的调用方形态");
  for (const value of [true, false, null]) {
    assert.equal(
      onboardingRecordEntrySchema.safeParse({ ...base, memoryEnabled: value }).success,
      true,
      `旧记录值 ${String(value)} 照常解析`,
    );
  }
  assert.equal(
    onboardingRecordEntrySchema.safeParse({ ...base, memoryEnabled: "yes" }).success,
    false,
    "optional 不得退化成任意值",
  );
});

test("保存路径源守卫：OccupationOnboarding.tsx 不再读写该键，proactiveSuggestions 语义保留", async () => {
  const sourcePath = new URL(
    "../../../packages/ui/src/onboarding/OccupationOnboarding.tsx",
    import.meta.url,
  );
  const source = await readFile(sourcePath, "utf-8");
  // 粗剔除注释后再查 token：说明性注释出现字段名是允许的，真正的读写点不允许。
  // （该文件不含字符串内的 // 或 /*，粗剔除足够。）
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.equal(
    code.includes("memoryEnabled"),
    false,
    "保存路径（settings update + appendRecord）不得再携带该键",
  );
  assert.equal(code.includes("setMemory"), false, "记忆勾选状态全链应已删除");
  assert.ok(
    code.includes("proactiveSuggestionsEnabled"),
    "proactiveSuggestions 语义必须保留，不得随勾选删除误伤",
  );
});
