/**
 * T-RU6（upstream-v316-fullsync P7 续批）：composer 草稿 taskGroupId 分组草稿流转。
 *
 * 形态与 T-VU4 一致：无 jsdom，纯逻辑 + 源码形状守卫，可直接
 * npx tsx --tsconfig packages/ui/tsconfig.json --test 运行。
 * ①__draft__ 草稿按 ComposerScope（namespace/host/project）分 key 隔离；
 * ②taskGroupId/projectId 组织意图持久化与继承（正文/模型更新不抹掉归属，显式 null 才清除）；
 * ③clearV4ComposerDraftTaskGroup 只撤销分组、保留正文与项目；
 * ④Session scope（ROOT 外）落盘剥离组织态副本；
 * ⑤legacyClaimed：旧工作区 key 的显式项目归属一次性认领；
 * ⑥消费接线源码形状守卫（TaskGroupedView 草稿行/useDraftConfigControl 合流/
 *   useRootWorkspaceActions 组织意图/useComposerClientNamespace 出口）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import {
  clearV4ComposerDraft,
  clearV4ComposerDraftTaskGroup,
  composerScopeKey,
  getV4ComposerDraftStorageKey,
  persistV4ComposerDraft,
  readComposerWorkspaceScope,
  readV4ComposerDraft,
  rememberComposerWorkspaceScope,
  resolveComposerScope,
  V4_DRAFT_SCOPE_ROOT,
  type ComposerScope,
} from "../src/v4/composer/composerDraftStore.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const uiSrc = path.join(root, "packages", "ui", "src");
const read = (...parts: string[]) => readFileSync(path.join(...parts), "utf8");

// ---------- localStorage stub（composerDraftStore 只用 getItem/setItem/removeItem） ----------

function installStorageStub() {
  const backing = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (key) => (backing.has(key) ? (backing.get(key) as string) : null),
    key: () => null,
    removeItem: (key) => void backing.delete(key),
    setItem: (key, value) => void backing.set(key, String(value)),
  };
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  return backing;
}

const storageBacking = installStorageStub();

const WORKSPACE = "/tmp/project-a";
const IDENTITY = "remote:server:srv-1:/tmp/project-a";

function scopeOf(projectId: string | null, clientNamespace = "desktop"): ComposerScope {
  return resolveComposerScope(projectId, IDENTITY, clientNamespace);
}

// ---------- ①ComposerScope 分 key 隔离 ----------

test("__draft__ 草稿按组织 key 隔离：同目录不同项目互不可见", () => {
  storageBacking.clear();
  const projectA = scopeOf("project-a");
  const projectB = scopeOf("project-b");
  assert.notEqual(composerScopeKey(projectA), composerScopeKey(projectB));

  persistV4ComposerDraft(WORKSPACE, IDENTITY, V4_DRAFT_SCOPE_ROOT, { text: "A" }, projectA);
  assert.equal(
    readV4ComposerDraft(WORKSPACE, IDENTITY, V4_DRAFT_SCOPE_ROOT, projectB)?.text,
    undefined,
  );
  assert.equal(readV4ComposerDraft(WORKSPACE, IDENTITY, V4_DRAFT_SCOPE_ROOT, projectA)?.text, "A");

  // 无 scope 回落旧工作区 key：未归类历史不受组织 key 写入影响。
  assert.equal(readV4ComposerDraft(WORKSPACE, IDENTITY, V4_DRAFT_SCOPE_ROOT)?.text, undefined);
});

test("hostId 来自 workspaceIdentity 的完整远端前缀；无 identity 归 local", () => {
  assert.equal(resolveComposerScope(null, IDENTITY).hostId, "remote:server:srv-1");
  assert.equal(resolveComposerScope(null, undefined).hostId, "local");
});

// ---------- ②组织意图持久化与继承 ----------

test("正文更新不抹掉已存 taskGroupId/projectId；显式 null 才清除", () => {
  storageBacking.clear();
  const scope = scopeOf("project-a");
  persistV4ComposerDraft(
    WORKSPACE,
    IDENTITY,
    V4_DRAFT_SCOPE_ROOT,
    { text: "草稿", projectId: "project-a", taskGroupId: "group-1" },
    scope,
  );
  // 模型/正文各自保存的调用不带组织字段——必须继承旧归属。
  persistV4ComposerDraft(WORKSPACE, IDENTITY, V4_DRAFT_SCOPE_ROOT, { text: "草稿2" }, scope);
  let draft = readV4ComposerDraft(WORKSPACE, IDENTITY, V4_DRAFT_SCOPE_ROOT, scope);
  assert.equal(draft?.text, "草稿2");
  assert.equal(draft?.taskGroupId, "group-1");
  assert.equal(draft?.projectId, "project-a");

  persistV4ComposerDraft(
    WORKSPACE,
    IDENTITY,
    V4_DRAFT_SCOPE_ROOT,
    { text: "草稿3", taskGroupId: null, projectId: null },
    scope,
  );
  draft = readV4ComposerDraft(WORKSPACE, IDENTITY, V4_DRAFT_SCOPE_ROOT, scope);
  assert.equal(draft?.taskGroupId, null);
  assert.equal(draft?.projectId, null);
});

// ---------- ③clearV4ComposerDraftTaskGroup ----------

test("clearTaskGroup 只撤销分组：正文与项目保留，再次调用幂等", () => {
  storageBacking.clear();
  const scope = scopeOf("project-a");
  persistV4ComposerDraft(
    WORKSPACE,
    IDENTITY,
    V4_DRAFT_SCOPE_ROOT,
    { text: "正文", projectId: "project-a", taskGroupId: "group-1" },
    scope,
  );
  assert.equal(clearV4ComposerDraftTaskGroup(WORKSPACE, IDENTITY, scope), true);
  const draft = readV4ComposerDraft(WORKSPACE, IDENTITY, V4_DRAFT_SCOPE_ROOT, scope);
  assert.equal(draft?.text, "正文");
  assert.equal(draft?.projectId, "project-a");
  assert.equal(draft?.taskGroupId, undefined);
  assert.equal(clearV4ComposerDraftTaskGroup(WORKSPACE, IDENTITY, scope), true);
});

// ---------- ④Session scope 剥组织态 ----------

test("正式 session 草稿不保留组织态副本；只按工作区 key 隔离", () => {
  storageBacking.clear();
  persistV4ComposerDraft(WORKSPACE, IDENTITY, "session-1", {
    text: "会话草稿",
    projectId: "project-a",
    taskGroupId: "group-1",
  } as never);
  const draft = readV4ComposerDraft(WORKSPACE, IDENTITY, "session-1");
  assert.equal(draft?.text, "会话草稿");
  assert.equal(draft?.projectId, undefined);
  assert.equal(draft?.taskGroupId, undefined);
});

// ---------- ⑤legacyClaimed 认领 ----------

test("旧工作区 key 只有显式项目归属才能被组织 key 认领一次", () => {
  storageBacking.clear();
  // 旧版写入：无 scope（工作区 key），带项目归属。
  persistV4ComposerDraft(WORKSPACE, IDENTITY, V4_DRAFT_SCOPE_ROOT, {
    text: "旧草稿",
    projectId: "project-a",
  } as never);
  const scope = scopeOf("project-a");
  assert.equal(
    readV4ComposerDraft(WORKSPACE, IDENTITY, V4_DRAFT_SCOPE_ROOT, scope)?.text,
    "旧草稿",
  );
  // 认领后旧 key 数据保留，但未被其他项目认领的入口不再回落。
  const other = scopeOf("project-b");
  assert.equal(readV4ComposerDraft(WORKSPACE, IDENTITY, V4_DRAFT_SCOPE_ROOT, other), null);
});

// ---------- ⑥workspace scope 记忆 ----------

test("rememberComposerWorkspaceScope 记录身份；hostId 不匹配或坏数据拒绝读取", () => {
  storageBacking.clear();
  const scope = scopeOf("project-a");
  rememberComposerWorkspaceScope(WORKSPACE, IDENTITY, scope);
  assert.deepEqual(readComposerWorkspaceScope(WORKSPACE, IDENTITY, "desktop"), {
    clientNamespace: "desktop",
    hostId: "remote:server:srv-1",
    projectId: "project-a",
  });
  // 换 identity 后 hostId 校验失败，不能把 A 设备的目录身份冒用到 B 设备。
  assert.equal(readComposerWorkspaceScope(WORKSPACE, undefined, "desktop"), undefined);
});

// ---------- ⑦消费接线源码形状守卫 ----------

test("TaskGroupedView 查看会话时从 __draft__ 草稿读分组归属；closeDraft 清 composer 分组", () => {
  const source = read(uiSrc, "project-sidebar", "TaskGroupedView.tsx");
  assert.match(
    source,
    /readV4ComposerDraft\(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, draftScope\)/,
    "查看会话（activeTaskId 在场）必须读 composer 草稿的 taskGroupId",
  );
  assert.match(source, /activeTaskId\s*\?\s*readV4ComposerDraft/);
  assert.match(
    source,
    /clearV4ComposerDraftTaskGroup\(workspacePath, workspaceIdentity, draftScope\)/,
    "关闭分组行必须清 composer 草稿的分组归属（正文保留）",
  );
  assert.match(source, /useComposerClientNamespace\(\)/);
});

test("useDraftConfigControl 落盘合入 store 组织意图并按 rootScope 分 key", () => {
  const source = read(uiSrc, "v4", "composer", "useDraftConfigControl.ts");
  assert.match(
    source,
    /resolveComposerScope\(draftProjectId, workspaceIdentity, clientNamespace\)/,
  );
  assert.match(source, /workspace\.draftTaskGroupId !== undefined/);
  assert.match(source, /workspace\.draftProjectId !== undefined/);
  assert.match(
    source,
    /readV4ComposerDraft\(workspacePath, workspaceIdentity, scopeId, rootScope\)/,
  );
  assert.match(
    source,
    /clearV4ComposerDraft\(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, rootScope\)/,
  );
});

test("useRootWorkspaceActions 预填落盘携带项目与分组意图", () => {
  const source = read(uiSrc, "root", "useRootWorkspaceActions.ts");
  assert.match(source, /rememberComposerWorkspaceScope\(/);
  assert.match(source, /taskGroupId: draftTaskGroupId/);
  assert.match(source, /projectId: draftProjectId/);
});

test("useServices 暴露 useComposerClientNamespace 且 ServiceProvider 可注入", () => {
  const source = read(uiSrc, "hooks", "useServices.tsx");
  assert.match(source, /export function useComposerClientNamespace/);
  assert.match(source, /composerClientNamespace\?: string/);
  assert.match(source, /ComposerClientNamespaceContext\.Provider/);
});

test("draftStorageKey：组织 key 与工作区 key 分离", () => {
  // 组织 key 前缀独立，不与旧工作区 key 互写。
  const legacyKey = getV4ComposerDraftStorageKey(WORKSPACE, IDENTITY);
  assert.match(legacyKey, /zcode-v4-composer-drafts:v1:/);
  const scope = scopeOf("project-a");
  persistV4ComposerDraft(WORKSPACE, IDENTITY, V4_DRAFT_SCOPE_ROOT, { text: "x" }, scope);
  // 写入组织 key 后，旧 key 上仍无该 scope（不互写）。
  assert.equal(readV4ComposerDraft(WORKSPACE, IDENTITY, V4_DRAFT_SCOPE_ROOT)?.text, undefined);
});

test("clearV4ComposerDraft 支持组织 key 定向清理", () => {
  storageBacking.clear();
  const scope = scopeOf("project-a");
  persistV4ComposerDraft(WORKSPACE, IDENTITY, V4_DRAFT_SCOPE_ROOT, { text: "x" }, scope);
  clearV4ComposerDraft(WORKSPACE, IDENTITY, V4_DRAFT_SCOPE_ROOT, scope);
  assert.equal(readV4ComposerDraft(WORKSPACE, IDENTITY, V4_DRAFT_SCOPE_ROOT, scope), null);
});
