// T-UF2（backlog-sweep Step 15 / upstream-v3.16-sync T-S2，phase-u-backports blocking）：
// 引导"本机使用证据"判定的品牌适配与三证据源语义：
// - 路径常量必须落在 omz 品牌根（{home}/.omz/cli/...，不是上游的 ~/.zcode/...）——漏改的表现是
//   证据源 2 永远 miss、静默失效，故既断言解析结果，也断言源码零 .zcode 路径残留；
// - tasks-index 查询必须 includeDeleted: true（清空过任务列表的存量用户不失去资格），且必须在
//   node.ts 装配处真实接线（不得退回内联 listTaskMetas({}) 判断）；
// - 读不了 ≠ 没有：除 ENOENT 外的读取/查询失败一律上抛，由 UI 保守判不弹。
// 运行形态：仓库根 `node --import tsx --test packages/services/test/localUsageEvidence.test.ts`
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
import {
  createHasExistingLocalTask,
  hasAnyAgentSessionRow,
  resolveAgentSessionDbPath,
} from "../src/onboarding/localUsageEvidence.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omz-onboarding-usage-"));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** 独立 home，避免读到运行机器的真实 ~/.omz/cli/config.json。 */
async function freshHome(): Promise<{ home: string; userConfigPath: string }> {
  const home = join(await makeTempDir(), "home");
  return { home, userConfigPath: join(home, ".omz", "cli", "config.json") };
}

function createFactory(
  indexTasks: unknown[],
  hasAgentSessionRow: boolean,
  legacySessionsDir: string,
) {
  return createHasExistingLocalTask({
    listIndexTasks: async () => indexTasks,
    hasAgentSessionRow: async () => hasAgentSessionRow,
    resolveLegacyTaskSessionsDir: () => legacySessionsDir,
  });
}

function createSessionDb(dbPath: string, rows: number): void {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE session (id TEXT)");
  const insert = db.prepare("INSERT INTO session (id) VALUES (?)");
  for (let i = 0; i < rows; i += 1) insert.run(`s${i}`);
  db.close();
}

test("T-UF2 createHasExistingLocalTask：索引有行即存量用户（短路，不查会话库）", async () => {
  let sessionProbeCalls = 0;
  const check = createHasExistingLocalTask({
    listIndexTasks: async () => [{ id: "t1" }],
    hasAgentSessionRow: async () => {
      sessionProbeCalls += 1;
      return false;
    },
    resolveLegacyTaskSessionsDir: () => join(tmpdir(), "omz-not-exist-legacy"),
  });
  assert.equal(await check(), true);
  assert.equal(sessionProbeCalls, 0);
});

test("T-UF2 createHasExistingLocalTask：索引为空但会话库有行 → 存量用户（回填时序缺陷回归）", async () => {
  const emptyDir = await makeTempDir();
  const check = createFactory([], true, emptyDir);
  assert.equal(await check(), true);
});

test("T-UF2 createHasExistingLocalTask：索引与会话库皆空，旧版任务快照非空 → 存量用户", async () => {
  const legacySessionsDir = await makeTempDir();
  await writeFile(join(legacySessionsDir, "task-1.json"), "{}");
  await writeFile(join(legacySessionsDir, "task-2.deleted.json"), "{}");
  const check = createFactory([], false, legacySessionsDir);
  assert.equal(await check(), true);
});

test("T-UF2 createHasExistingLocalTask：三源全空（目录不存在/为空）→ 新用户", async () => {
  const missing = createFactory([], false, join(await makeTempDir(), "not-exist"));
  assert.equal(await missing(), false);
  const empty = createFactory([], false, await makeTempDir());
  assert.equal(await empty(), false);
});

test("T-UF2 createHasExistingLocalTask：索引查询异常时上抛，由上层保守判不弹", async () => {
  const check = createHasExistingLocalTask({
    listIndexTasks: async () => {
      throw new Error("index db locked");
    },
    hasAgentSessionRow: async () => true,
    resolveLegacyTaskSessionsDir: () => join(tmpdir(), "omz-not-exist-legacy"),
  });
  await assert.rejects(check(), /index db locked/);
});

test("T-UF2 hasAnyAgentSessionRow：session 表有行 → true；空表/无表 → false", async () => {
  const dir = await makeTempDir();
  const withRows = join(dir, "rows.sqlite");
  createSessionDb(withRows, 2);
  assert.equal(await hasAnyAgentSessionRow(withRows), true);

  const emptyRows = join(dir, "empty.sqlite");
  createSessionDb(emptyRows, 0);
  assert.equal(await hasAnyAgentSessionRow(emptyRows), false);

  const otherTable = join(dir, "other.sqlite");
  const db = new DatabaseSync(otherTable);
  db.exec("CREATE TABLE other (a TEXT)");
  db.close();
  assert.equal(await hasAnyAgentSessionRow(otherTable), false);
});

test("T-UF2 hasAnyAgentSessionRow：库文件不存在（ENOENT）→ false；损坏 → 上抛", async () => {
  const dir = await makeTempDir();
  assert.equal(await hasAnyAgentSessionRow(join(dir, "not-exist", "db.sqlite")), false);

  const corrupt = join(dir, "corrupt.sqlite");
  await writeFile(corrupt, "definitely not a sqlite file");
  await assert.rejects(hasAnyAgentSessionRow(corrupt));
});

test("T-UF2 resolveAgentSessionDbPath：默认 userConfigPath 钉住 omz 品牌 {home}/.omz/cli/config.json", async () => {
  // 品牌适配的核心断言：上游默认值是 ~/.zcode/cli/config.json，漏改会让证据源 2 永远 miss。
  const { home } = await freshHome();
  const readPaths: string[] = [];
  const resolved = await resolveAgentSessionDbPath({
    env: {},
    homedirPath: home,
    readConfigFile: async (path) => {
      readPaths.push(path);
      return "{}";
    },
  });
  assert.deepEqual(readPaths, [join(home, ".omz", "cli", "config.json")]);
  assert.ok(!readPaths[0]!.includes(".zcode"));
  assert.equal(resolved, join(home, ".omz", "cli", "db", "db.sqlite"));
});

test("T-UF2 resolveAgentSessionDbPath：user config 不存在 → 默认 {home}/.omz/cli/db/db.sqlite", async () => {
  const { home, userConfigPath } = await freshHome();
  const resolved = await resolveAgentSessionDbPath({
    env: {},
    homedirPath: home,
    userConfigPath,
  });
  assert.equal(resolved, join(home, ".omz", "cli", "db", "db.sqlite"));
  assert.ok(resolved !== null && !resolved.includes(".zcode"));
});

test("T-UF2 resolveAgentSessionDbPath：env 双别名沿用 CLI 的 ZCODE_* 键名并按 env 键序取后者", async () => {
  const dbA = join(await makeTempDir(), "a.sqlite");
  const dbB = join(await makeTempDir(), "b.sqlite");
  const { home, userConfigPath } = await freshHome();

  assert.equal(
    await resolveAgentSessionDbPath({
      env: { ZCODE_SESSION_DB_PATH: dbA },
      homedirPath: home,
      userConfigPath,
    }),
    dbA,
  );
  assert.equal(
    await resolveAgentSessionDbPath({
      env: { ZCODE_SESSION_DB: "~/session-alt.sqlite" },
      homedirPath: home,
      userConfigPath,
    }),
    join(home, "session-alt.sqlite"),
  );
  // PATH 别名后出现 → PATH 胜出；交换插入顺序 → DB 别名胜出（固定优先级会在此产生偏差）。
  assert.equal(
    await resolveAgentSessionDbPath({
      env: { ZCODE_SESSION_DB: dbA, ZCODE_SESSION_DB_PATH: dbB },
      homedirPath: home,
      userConfigPath,
    }),
    dbB,
  );
  assert.equal(
    await resolveAgentSessionDbPath({
      env: { ZCODE_SESSION_DB_PATH: dbB, ZCODE_SESSION_DB: dbA },
      homedirPath: home,
      userConfigPath,
    }),
    dbA,
  );
});

test("T-UF2 resolveAgentSessionDbPath：相对路径按未知跳过（env 与 config 两路都返回 null）", async () => {
  const { home, userConfigPath } = await freshHome();
  assert.equal(
    await resolveAgentSessionDbPath({
      env: { ZCODE_SESSION_DB_PATH: "history/session.sqlite" },
      homedirPath: home,
      userConfigPath,
    }),
    null,
  );

  await mkdir(join(home, ".omz", "cli"), { recursive: true });
  await writeFile(userConfigPath, JSON.stringify({ storage: { sessionDbPath: "db/rel.sqlite" } }));
  assert.equal(
    await resolveAgentSessionDbPath({ env: {}, homedirPath: home, userConfigPath }),
    null,
  );
});

test("T-UF2 resolveAgentSessionDbPath：config storage.sessionDbPath 覆盖且 ~/ 展开", async () => {
  const { home, userConfigPath } = await freshHome();
  await mkdir(join(home, ".omz", "cli"), { recursive: true });
  await writeFile(
    userConfigPath,
    JSON.stringify({ storage: { sessionDbPath: "~/data/s.sqlite" } }),
  );
  assert.equal(
    await resolveAgentSessionDbPath({ env: {}, homedirPath: home, userConfigPath }),
    join(home, "data", "s.sqlite"),
  );
});

test("T-UF2 resolveAgentSessionDbPath：非 ENOENT 读取失败与非法 JSON 上抛（读不了 ≠ 没有）", async () => {
  const { home, userConfigPath } = await freshHome();
  const eacces = Object.assign(new Error("read denied"), { code: "EACCES" });
  await assert.rejects(
    resolveAgentSessionDbPath({
      env: {},
      homedirPath: home,
      userConfigPath,
      readConfigFile: async () => {
        throw eacces;
      },
    }),
    /read denied/,
  );

  await mkdir(join(home, ".omz", "cli"), { recursive: true });
  await writeFile(userConfigPath, "{broken json");
  await assert.rejects(resolveAgentSessionDbPath({ env: {}, homedirPath: home, userConfigPath }));
});

test("T-UF2 品牌守卫：localUsageEvidence 源码零 .zcode 路径字面量", async () => {
  const source = await readFile(
    new URL("../src/onboarding/localUsageEvidence.ts", import.meta.url),
    "utf-8",
  );
  // 允许 ZCODE_* 环境变量键（omz 实际前缀，按规格保留），但不得出现 .zcode 目录字面量。
  assert.ok(!/\.zcode/i.test(source), "localUsageEvidence 仍含 .zcode 路径字面量");
  assert.match(source, /getZCodeDataRootDir/);
});

test("T-UF2 接线守卫：node.ts 用 createHasExistingLocalTask + includeDeleted:true + {configDir}/sessions", async () => {
  const source = await readFile(new URL("../src/node.ts", import.meta.url), "utf-8");
  // 旧内联判断必须消失（否则三证据源形同虚设）。
  assert.ok(
    !source.includes("listTaskMetas({})).length > 0"),
    "node.ts 仍保留内联 listTaskMetas({}) 判断",
  );

  const wiringStart = source.indexOf("hasExistingLocalTask: createHasExistingLocalTask({");
  assert.ok(wiringStart >= 0, "node.ts 未接线 createHasExistingLocalTask");
  const wiring = source.slice(wiringStart, wiringStart + 2500);
  assert.match(
    wiring,
    /listIndexTasks:\s*\(\)\s*=>\s*taskIndexRepo\.listTaskMetas\(\{\s*includeDeleted:\s*true\s*\}\)/,
    "tasks-index 证据源未传 includeDeleted: true",
  );
  assert.match(wiring, /hasAgentSessionRow:\s*async\s*\(\)\s*=>/, "会话库证据源未接线");
  assert.match(wiring, /resolveAgentSessionDbPath\(\)/, "会话库路径未走镜像解析");
  assert.match(wiring, /hasAnyAgentSessionRow\(sessionDbPath\)/, "会话库未做 session 表行检查");
  assert.match(
    wiring,
    /resolveLegacyTaskSessionsDir:\s*\(\)\s*=>\s*join\(resolveAppConfigDir\(\),\s*"sessions"\)/,
    "旧版快照目录未落在 {dataBaseDir}/.omz/v2/sessions",
  );
});
