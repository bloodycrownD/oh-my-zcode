/**
 * T-RU8（upstream-v316-fullsync P7 续批）：project-sidebar 三缝真接通形状守卫。
 *
 * 形态：源码形状守卫，npx tsx --tsconfig packages/ui/tsconfig.json --test 运行。
 * ①useProjectTree remoteService 不再恒缺省，目录投影进入 state 与返回值；
 * ②Source 观察链（observeSources/workspaceSourceGenerationSignature）随批照搬；
 * ③scopes 按 buildRemoteHostWorkspaceIdentity 参与（registry 在场且非 local Host）；
 * ④projectSourceServerId 恢复上游 server kind 解析（entriesBySourceServerId 消费入口）；
 * ⑤accessor 增可选 remoteProjectService（缺席=P4 空集语义，注册链随 host 服务批）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...parts: string[]) => readFileSync(path.join(...parts), "utf8");

test("useProjectTree：remoteService 接 base accessor，directory 进入读取与返回值", () => {
  const source = read(root, "packages", "ui", "src", "project-sidebar", "useProjectTree.ts");
  assert.match(source, /const remoteService = services\.remoteProjectService;/);
  assert.doesNotMatch(source, /const remoteService = undefined/);
  assert.match(source, /const \[directory, setDirectory\] = useState<RemoteProjectDirectory>/);
  assert.match(
    source,
    /areStabilizedValuesEquivalent\(previous, result\.directory\)/,
    "目录投影必须在接收边界等价合并",
  );
  assert.match(source, /previous\.remote === remoteService/, "归档清理必须校验目录服务身份");
  // windowProjectDirectory（web replayable 专面）不随本批：relay v2/P9 挂账登记。
  assert.match(source, /windowProjectDirectory（web replayable 专面）不接/);
});

test("useProjectTree：Source 观察链随批照搬（observeSources + sourceRevision）", () => {
  const source = read(root, "packages", "ui", "src", "project-sidebar", "useProjectTree.ts");
  assert.match(source, /const sourceRevision = registry\?\.getSourceRevision\(\) \?\? 0;/);
  assert.match(
    source,
    /workspaceSourceGenerationSignature: `\$\{sourceRevision\}:\$\{sourceVersion\}`/,
  );
  assert.match(source, /await Promise\.all\(\[refresh\(\), observeSources\(\)\]\)/);
});

test("useProjectTree：scopes 按 remote identity 参与订阅", () => {
  const source = read(root, "packages", "ui", "src", "project-sidebar", "useProjectTree.ts");
  assert.match(source, /buildRemoteHostWorkspaceIdentity\(project\.hostId, root\.rootPath\)/);
  assert.match(source, /\[tree, tabs, registry\]/);
});

test("view.projectSourceServerId：恢复 server kind 解析（归属模型消费入口）", () => {
  const source = read(root, "packages", "ui", "src", "project-sidebar", "view.ts");
  assert.match(source, /parseRemoteWorkspaceIdentity\(/);
  assert.match(source, /buildRemoteHostWorkspaceIdentity\(project\.hostId, project\.roots\[0\]/);
  assert.match(source, /\)\?\.sourceServerId;/);
  assert.doesNotMatch(
    source,
    /return project\.hostId === "local" \? undefined : undefined;/,
    "P4 恒 undefined 占位必须已拆除",
  );
});

test("accessor：remoteProjectService 可选字段在位（注册链随 host 服务批，缺席为 P4 空集语义）", () => {
  const accessor = read(root, "packages", "services", "src", "accessor.ts");
  assert.match(accessor, /readonly remoteProjectService\?: IRemoteProjectService;/);
  const index = read(root, "packages", "ui", "src", "project-sidebar", "index.tsx");
  assert.match(index, /directory=\{directory\}/, "侧栏 ProjectSections 不得回退为硬编码空目录");
});
