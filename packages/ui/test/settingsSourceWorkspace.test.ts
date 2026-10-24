/**
 * T-SS2（backlog-sweep Step 11）：设置页 Source 作用域纯逻辑。
 * 移植上游 ui/test/settingsSourceWorkspace.test.ts（vitest → node:test）。
 *
 * 本批（source-settings 收口）追加：
 * ①归属判定矩阵；②锚点解析（含「别的设备不能当锚点」回归）；③投影键口径与 loading 结束；
 * ④SettingsPage / 三个 section 的源码形状守卫（生产入口必须真的把 id 传下去）。
 *
 * 运行：npx tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/settingsSourceWorkspace.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { IServiceAccessor } from "@zcode/services";
import {
  buildSettingsSourceAuthorityKey,
  buildSettingsSourceUserScopeRpcPath,
  buildSourceSettingsProjectionKey,
  filterWorkspaceTabsForSettingsSource,
  isSettingsProjectionCurrent,
  isSettingsSourceOnline,
  resolveSettingsSourceCapabilityServices,
  resolveSettingsSourceScopeAnchor,
  resolveSettingsSourceServerSelection,
  resolveSettingsSourceServiceRoute,
  resolveSettingsUserScopeTarget,
  resolveSourceSettingsHomeDir,
  resolveSourceSettingsValue,
  workspaceBelongsToSettingsSource,
} from "../src/settings/settingsSourceWorkspace.js";
import {
  getSourceSettingsServices,
  registerSourceSettingsServices,
  subscribeSourceSettingsServices,
} from "../src/store/sourceSettingsServiceStore.js";
import type { WorkspaceTabState } from "../src/store/tabStore.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const read = (...segments: string[]) => readFileSync(path.join(repoRoot, ...segments), "utf8");

function tab(id: string, workspaceIdentity?: string): WorkspaceTabState {
  return {
    id,
    kind: "workspace",
    label: id,
    workspacePath: `/work/${id}`,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  } as WorkspaceTabState;
}

/** 只填四个分区真正消费的能力面；其余字段本批用例不触达。 */
function createPortServices(tag: string): IServiceAccessor {
  return {
    hooksService: { tag },
    pluginManagementService: { tag },
    skillsService: { tag },
    subagentsService: { tag },
    skillSyncService: { tag },
    settingsSyncService: { tag },
  } as unknown as IServiceAccessor;
}

test("T-SS2 显式本机跳转优先于上次保存的远端 Source", () => {
  assert.equal(
    resolveSettingsSourceServerSelection({
      pendingTarget: { sourceServerId: null },
      persistedSourceServerId: "source-a",
      sourceServerIds: ["source-a"],
    }),
    null,
  );

  assert.equal(
    resolveSettingsSourceServerSelection({
      pendingTarget: undefined,
      persistedSourceServerId: "source-a",
      sourceServerIds: ["source-a"],
    }),
    "source-a",
  );

  // 持久化偏好指向已下线/已删除 Source 时回落本机。
  assert.equal(
    resolveSettingsSourceServerSelection({
      pendingTarget: undefined,
      persistedSourceServerId: "source-gone",
      sourceServerIds: ["source-a"],
    }),
    null,
  );
});

test("T-SS2 不把 Source A 的项目作用域发给 Source B 的服务", () => {
  const tabs = [
    tab("local"),
    tab("a", "remote:server:source-a:/work/a"),
    tab("b", "remote:server:source-b:/work/b"),
    tab("legacy", "remote:ssh:host:22:user:/work/legacy"),
  ];

  assert.deepEqual(
    filterWorkspaceTabsForSettingsSource(tabs, "source-b").map((item) => item.id),
    ["b"],
  );
  assert.deepEqual(
    filterWorkspaceTabsForSettingsSource(tabs, null).map((item) => item.id),
    ["local"],
  );
});

test("T-SS2 归属判定唯一口径：server identity 认设备，其余 identity 归本机/不归任何设备", () => {
  const owned = { workspaceIdentity: "remote:server:source-a:/work/a" };
  const sibling = { workspaceIdentity: "remote:server:source-b:/work/b" };
  const legacySsh = { workspaceIdentity: "remote:ssh:host:22:user:/work/legacy" };
  const local = { workspaceIdentity: undefined };

  assert.equal(workspaceBelongsToSettingsSource(owned, "source-a"), true);
  assert.equal(workspaceBelongsToSettingsSource(owned, "source-b"), false);
  assert.equal(workspaceBelongsToSettingsSource(owned, null), false, "远端项目不属于本机");
  assert.equal(workspaceBelongsToSettingsSource(sibling, "source-a"), false);
  assert.equal(workspaceBelongsToSettingsSource(legacySsh, "source-a"), false, "ssh 旧链不归设备");
  assert.equal(workspaceBelongsToSettingsSource(legacySsh, null), false, "ssh 旧链不是本机");
  assert.equal(workspaceBelongsToSettingsSource(local, null), true, "无 identity 的项目归本机");
  assert.equal(workspaceBelongsToSettingsSource(local, "source-a"), false);
});

test("T-SS2 锚点解析：别的设备的 workspace 不能当所选 Source 的锚点", () => {
  const foreignFallback = {
    fallbackWorkspacePath: "/work/b",
    fallbackWorkspaceIdentity: "remote:server:source-b:/work/b",
  };

  const rejected = resolveSettingsSourceScopeAnchor({
    sourceServerId: "source-a",
    scopedTabs: [],
    ...foreignFallback,
  });
  assert.equal(rejected.available, false, "不属于 source-a 的 identity 必须判不可用");
  assert.equal(rejected.workspacePath, undefined, "不可用时不得泄漏外来路径");
  assert.equal(rejected.workspaceIdentity, undefined);

  const accepted = resolveSettingsSourceScopeAnchor({
    sourceServerId: "source-a",
    scopedTabs: [],
    fallbackWorkspacePath: "/work/a",
    fallbackWorkspaceIdentity: "remote:server:source-a:/work/a",
  });
  assert.equal(accepted.available, true);
  assert.equal(accepted.workspacePath, "/work/a");
  assert.equal(accepted.workspaceIdentity, "remote:server:source-a:/work/a");

  const tabAnchor = resolveSettingsSourceScopeAnchor({
    sourceServerId: "source-a",
    scopedTabs: [tab("a", "remote:server:source-a:/work/a")],
    ...foreignFallback,
  });
  assert.equal(tabAnchor.available, true);
  assert.equal(tabAnchor.tab?.id, "a", "已连接 workspace 优先于注入的项目锚点");
});

test("T-SS2 锚点解析：本机 scope 无锚点也合法，注入的远端项目不得被本机 scope 采用", () => {
  const localNoAnchor = resolveSettingsSourceScopeAnchor({
    sourceServerId: null,
    scopedTabs: [],
    fallbackWorkspacePath: "/work/remote",
    fallbackWorkspaceIdentity: "remote:server:source-a:/work/remote",
  });
  assert.equal(localNoAnchor.available, true, "本机 user 配置不需要 workspace 锚点");
  assert.equal(localNoAnchor.workspacePath, undefined);

  const localPathOnly = resolveSettingsSourceScopeAnchor({
    sourceServerId: null,
    scopedTabs: [],
    fallbackWorkspacePath: "/work/local",
  });
  assert.equal(localPathOnly.available, true);
  assert.equal(localPathOnly.workspacePath, "/work/local", "无 identity 的本机项目可以当锚点");
});

test("T-SS2 锚点解析：无 tab 的远端 Source 用 home 构造归属 identity", () => {
  const anchor = resolveSettingsSourceScopeAnchor({
    sourceServerId: "source-a",
    scopedTabs: [],
    sourceHomeDir: "/root",
  });
  assert.equal(anchor.available, true);
  assert.equal(anchor.workspacePath, "/root");
  assert.equal(anchor.workspaceIdentity, "remote:server:source-a:/root");
  assert.equal(workspaceBelongsToSettingsSource(anchor, "source-a"), true);

  const missingHome = resolveSettingsSourceScopeAnchor({
    sourceServerId: "source-a",
    scopedTabs: [],
  });
  assert.equal(missingHome.available, false, "拿不到 home 时必须显式不可用");
});

test("T-SS2 Source user scope 不绑定项目 identity，但必须由 Source 构造归属 identity", () => {
  assert.deepEqual(
    resolveSettingsUserScopeTarget({
      sourceServerId: "source-b",
      sourceHomeDir: "/root",
      projectWorkspacePath: "/work/b",
      projectWorkspaceIdentity: "remote:server:source-b:/work/b",
    }),
    {
      workspacePath: "/root",
      workspaceIdentity: "remote:server:source-b:/root",
      authorityKey: "source-settings:source-b",
      unavailable: false,
    },
  );

  // 没有 home 时不能给「无 identity 的远端路径」，必须显式 unavailable。
  assert.deepEqual(resolveSettingsUserScopeTarget({ sourceServerId: "source-b" }), {
    authorityKey: "source-settings:source-b",
    unavailable: true,
  });
});

test("T-SS2 拿不到 Source 时降级为本机项目 scope", () => {
  assert.deepEqual(
    resolveSettingsUserScopeTarget({
      sourceServerId: null,
      projectWorkspacePath: "/work/local",
      projectWorkspaceIdentity: "local:work",
    }),
    {
      workspacePath: "/work/local",
      workspaceIdentity: "local:work",
      unavailable: false,
    },
  );
});

test("T-SS2 不暴露上一台 Source 的 home", () => {
  const home = { sourceServerId: "source-a", homedir: "/home/alice" };
  assert.equal(resolveSourceSettingsHomeDir(home, "source-a"), "/home/alice");
  assert.equal(resolveSourceSettingsHomeDir(home, "source-b"), undefined);
  assert.equal(resolveSourceSettingsHomeDir(null, "source-a"), undefined);
});

test("T-SS2 不暴露上一台 Source 的设置代际", () => {
  const snapshot = { sourceServerId: "source-a", value: { memoryEnabled: true } };
  assert.deepEqual(resolveSourceSettingsValue(snapshot, "source-a"), {
    memoryEnabled: true,
  });
  assert.equal(resolveSourceSettingsValue(snapshot, "source-b"), null);
  assert.equal(resolveSourceSettingsValue(null, "source-a"), null);
});

test("T-SS2 只有 active profile 在线才请求 Source 设置", () => {
  const snapshot = {
    generation: 1,
    profiles: [
      { profileId: "profile-a", sourceServerId: "source-a", lifecycleState: "active" as const },
      { profileId: "profile-b", sourceServerId: "source-b", lifecycleState: "retired" as const },
    ],
    states: [
      { profileId: "profile-a", state: "online" },
      { profileId: "profile-b", state: "online" },
    ],
  };
  assert.equal(isSettingsSourceOnline(snapshot, "source-a"), true);
  assert.equal(isSettingsSourceOnline(snapshot, "source-b"), false);
  assert.equal(isSettingsSourceOnline(snapshot, "source-c"), false);
  assert.equal(isSettingsSourceOnline(snapshot, null), false);
  assert.equal(isSettingsSourceOnline(null, "source-a"), false);
});

test("T-SS2 同路径的设置投影按 Source authority 隔离", () => {
  assert.notEqual(
    buildSourceSettingsProjectionKey("/root", undefined, "source-settings:a"),
    buildSourceSettingsProjectionKey("/root", undefined, "source-settings:b"),
  );
  // 无 authority 时保持既有键形态（identity 优先于 path）。
  assert.equal(
    buildSourceSettingsProjectionKey("/root", "remote:server:a:/root"),
    "remote:server:a:/root",
  );
  assert.equal(buildSourceSettingsProjectionKey("/root"), "/root");
  assert.equal(buildSettingsSourceAuthorityKey("source-a"), "source-settings:source-a");
});

test("T-SS2 Source scope 下 skills 投影能结束 loading（键口径一致）", () => {
  const authorityKey = buildSettingsSourceAuthorityKey("source-a");
  const activeTargetKey = buildSourceSettingsProjectionKey(
    "/root",
    "remote:server:source-a:/root",
    authorityKey,
  );
  const requestTargetKey = buildSourceSettingsProjectionKey(
    "/root",
    "remote:server:source-a:/root",
    authorityKey,
  );
  const loadedTargetKey = requestTargetKey;

  assert.equal(
    isSettingsProjectionCurrent({ hasTarget: true, activeTargetKey, loadedTargetKey }),
    true,
    "request/loaded 与 active 同口径时 loading 必须结束",
  );

  // 回归守卫：旧实现 request/loaded 只用 identity||path，永远匹配不上带 authority 的 active。
  const legacyLoadedKey = "remote:server:source-a:/root";
  assert.equal(
    isSettingsProjectionCurrent({
      hasTarget: true,
      activeTargetKey,
      loadedTargetKey: legacyLoadedKey,
    }),
    false,
    "只带 identity 的旧键必须判不匹配（这就是永久 loading 的根因）",
  );
  assert.equal(
    isSettingsProjectionCurrent({ hasTarget: false, activeTargetKey, loadedTargetKey: "" }),
    true,
    "没有 target 时不需要加载",
  );
});

// ---------- 服务来源解析：端口 → 锚点 → unavailable ----------

test("T-SS2 端口优先：四个分区解析到已登记端口服务而不是锚点", () => {
  const sourceServerId = "source-port-priority";
  const anchor = resolveSettingsSourceScopeAnchor({
    sourceServerId,
    scopedTabs: [tab("a", `remote:server:${sourceServerId}:/work/a`)],
  });
  const port = createPortServices("port");

  const anchorOnly = resolveSettingsSourceServiceRoute({ sourceServerId, anchor });
  assert.equal(anchorOnly.kind, "anchor", "未登记端口时必须保持原锚点链行为");
  assert.equal(anchorOnly.capabilities, undefined);

  const route = resolveSettingsSourceServiceRoute({ sourceServerId, portServices: port, anchor });
  assert.equal(route.kind, "port");
  assert.equal(route.capabilities?.hooksService, port.hooksService);
  assert.equal(route.capabilities?.pluginManagementService, port.pluginManagementService);
  assert.equal(route.capabilities?.skillsService, port.skillsService);
  assert.equal(route.capabilities?.subagentsService, port.subagentsService);
  assert.equal(route.userScopeRpcPath, "/work/a", "有锚点时复用锚点路径作为 user scope RPC 路径");
});

test("T-SS2 端口迟到：注册表变化通知订阅者，重算后切到端口服务", () => {
  const sourceServerId = "source-port-late";
  // 设备在线但没打开 workspace：锚点链本身不可用，这正是端口要补的缺口。
  const anchor = resolveSettingsSourceScopeAnchor({ sourceServerId, scopedTabs: [] });
  assert.equal(anchor.available, false);

  assert.equal(
    resolveSettingsSourceServiceRoute({
      sourceServerId,
      portServices: getSourceSettingsServices(sourceServerId),
      anchor,
    }).kind,
    "unavailable",
    "端口未登记且无锚点时先显示 unavailable",
  );

  const notifications: number[] = [];
  const unsubscribe = subscribeSourceSettingsServices(() =>
    notifications.push(notifications.length),
  );
  const release = registerSourceSettingsServices({
    sourceServerId,
    attachmentId: "attachment-late",
    services: createPortServices("late"),
    dispose: () => {},
  });
  assert.equal(notifications.length, 1, "端口登记必须通知订阅者，分区据此重算");

  const portServices = getSourceSettingsServices(sourceServerId);
  const after = resolveSettingsSourceServiceRoute({ sourceServerId, portServices, anchor });
  assert.equal(after.kind, "port", "端口迟到后无需重选设备即可生效");
  assert.equal(after.capabilities?.subagentsService, portServices?.subagentsService);
  assert.equal(after.anchor.available, false, "端口路由不伪造成立锚点");
  assert.equal(after.userScopeRpcPath, buildSettingsSourceUserScopeRpcPath(sourceServerId));

  release();
  assert.equal(notifications.length, 2, "端口释放同样通知订阅者");
  unsubscribe();
});

test("T-SS2 端口释放：有锚点回落锚点链，无锚点回落 unavailable", () => {
  const withAnchorId = "source-port-release-anchor";
  const anchor = resolveSettingsSourceScopeAnchor({
    sourceServerId: withAnchorId,
    scopedTabs: [tab("a", `remote:server:${withAnchorId}:/work/a`)],
  });
  const releaseWithAnchor = registerSourceSettingsServices({
    sourceServerId: withAnchorId,
    attachmentId: "attachment-release-anchor",
    services: createPortServices("release-anchor"),
    dispose: () => {},
  });
  assert.equal(
    resolveSettingsSourceServiceRoute({
      sourceServerId: withAnchorId,
      portServices: getSourceSettingsServices(withAnchorId),
      anchor,
    }).kind,
    "port",
  );

  releaseWithAnchor();
  const backToAnchor = resolveSettingsSourceServiceRoute({
    sourceServerId: withAnchorId,
    portServices: getSourceSettingsServices(withAnchorId),
    anchor,
  });
  assert.equal(backToAnchor.kind, "anchor", "端口释放后回落到锚点链");
  assert.equal(backToAnchor.capabilities, undefined);

  const noAnchorId = "source-port-release-unavailable";
  const noAnchor = resolveSettingsSourceScopeAnchor({ sourceServerId: noAnchorId, scopedTabs: [] });
  const releaseNoAnchor = registerSourceSettingsServices({
    sourceServerId: noAnchorId,
    attachmentId: "attachment-release-unavailable",
    services: createPortServices("release-unavailable"),
    dispose: () => {},
  });
  releaseNoAnchor();
  const fallback = resolveSettingsSourceServiceRoute({
    sourceServerId: noAnchorId,
    portServices: getSourceSettingsServices(noAnchorId),
    anchor: noAnchor,
  });
  assert.equal(fallback.kind, "unavailable", "端口释放且无锚点时回到显式空态");
  assert.equal(fallback.capabilities, undefined);
  assert.equal(fallback.userScopeRpcPath, undefined);
});

test("T-SS2 无端口且无锚点 → unavailable；本机 scope 与非完整服务集都不消费端口", () => {
  const sourceServerId = "source-none";
  const unavailable = resolveSettingsSourceServiceRoute({
    sourceServerId,
    anchor: resolveSettingsSourceScopeAnchor({ sourceServerId, scopedTabs: [] }),
  });
  assert.equal(unavailable.kind, "unavailable");
  assert.equal(unavailable.capabilities, undefined);
  assert.equal(unavailable.userScopeRpcPath, undefined);

  // 本机 scope 没有 attachment：即便别的 Source 端口已登记也不能被借来当本机事实。
  const local = resolveSettingsSourceServiceRoute({
    sourceServerId: null,
    portServices: createPortServices("local-ignored"),
    anchor: resolveSettingsSourceScopeAnchor({ sourceServerId: null, scopedTabs: [] }),
  });
  assert.equal(local.kind, "anchor");
  assert.equal(local.capabilities, undefined);

  // 旧 Source 的集合缺通道时不能拿 undefined 顶替服务（会伪装成「设备确实没有配置」）。
  const partial = { hooksService: {} } as unknown as IServiceAccessor;
  assert.equal(resolveSettingsSourceCapabilityServices(partial), undefined);
  assert.equal(resolveSettingsSourceCapabilityServices(undefined), undefined);
});

// ---------- 生产入口形状守卫 ----------

test("T-SS2 生产入口：SettingsPage 真的把选中的 Source 传给四个 section 并申请 attachment", () => {
  const settingsPage = read("packages", "ui", "src", "SettingsPage.tsx");

  assert.match(
    settingsPage,
    /data-settings-source-select="true"/,
    "必须有可见的 Source 选择器（不能只加 prop）",
  );
  assert.match(
    settingsPage,
    /data-settings-source-select[\s\S]*?sourceServers\.map/,
    "选择器选项来自 management 快照的设备列表",
  );
  assert.match(
    settingsPage,
    /import \{ ensureSourceSettingsServices \} from "@\/store\/sourceSettingsServiceStore\.js";/,
    "SettingsPage 必须直接消费 Source attachment admission",
  );
  assert.match(
    settingsPage,
    /ensureSourceSettingsServices\(\s*selectedSettingsSourceServerId,\s*sourceAttachmentRequest,?\s*\)/,
    "选中 Source 时必须调用 ensureSourceSettingsServices（生产调用方）",
  );
  assert.match(
    settingsPage,
    /resolveSourceSettingsAttachmentRequest\(platform\)/,
    "attachment 请求必须经平台能力探测（不得直接摸 window.zcode）",
  );
  assert.doesNotMatch(settingsPage, /window\.zcode/, "UI 不得直接调用 window.zcode");

  const forwarded = (
    settingsPage.match(/settingsSourceServerId=\{selectedSettingsSourceServerId\}/g) ?? []
  ).length;
  assert.ok(
    forwarded >= 6,
    `PluginsSection(plugin/mcp/skill/commands)+SubagentsSection+HooksSection 都必须拿到 id，实际 ${forwarded}`,
  );

  const selectionMapping = settingsPage.match(
    /settingsSourceSelection === SETTINGS_SOURCE_ALL[\s\S]*?SETTINGS_SOURCE_LOCAL[\s\S]*?settingsSourceSelection;/,
  );
  assert.ok(selectionMapping, "选择器三态必须映射为 undefined / null / sourceId");
});

test("T-SS2 生产入口：三个 section 的服务来源走统一「端口→锚点→unavailable」解析", () => {
  for (const file of [
    ["packages", "ui", "src", "settings", "HooksSection.tsx"],
    ["packages", "ui", "src", "settings", "SubagentsSection.tsx"],
    ["packages", "ui", "src", "settings", "PluginsSection.tsx"],
  ] as const) {
    const source = read(...file);
    assert.match(
      source,
      /useSettingsSourceServiceRoute\(/,
      `${file.at(-1)} 必须走统一来源解析（端口优先 + 锚点归属判定）`,
    );
    assert.doesNotMatch(
      source,
      /!workspaceIdentity\?\.trim\(\)/,
      `${file.at(-1)} 不得再用「identity 非空」当归属证明`,
    );
  }
});

test("T-SS2 生产入口：SkillsSection 三处 key 同口径且用共享 loading 判定", () => {
  const skills = read("packages", "ui", "src", "settings", "SkillsSection.tsx");
  assert.match(
    skills,
    /const activeSkillTargetKey = buildSourceSettingsProjectionKey\(\s*activeWorkspacePath,\s*activeWorkspaceIdentity,\s*cacheAuthorityKey,\s*\)/,
    "active key 必须带 authorityKey",
  );
  assert.match(
    skills,
    /const requestTargetKey = buildSourceSettingsProjectionKey\(\s*activeWorkspacePath,\s*activeWorkspaceIdentity,\s*cacheAuthorityKey,\s*\)/,
    "request key 必须与 active 同口径",
  );
  assert.match(
    skills,
    /setLoadedSkillTargetKey\(requestTargetKey\)/,
    "loaded key 只保存 request key",
  );
  assert.match(skills, /isSettingsProjectionCurrent\(\{/, "loading 结束条件必须复用共享判定");
});
