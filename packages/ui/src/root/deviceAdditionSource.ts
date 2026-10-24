import type {
  RemoteTarget,
  SourceServerManagementSnapshot,
  SourceServerProfileTarget,
} from "@zcode/shared";
import type { DeviceAdditionReturnTarget } from "@/app-shell/types.js";

/**
 * 连接目标身份键：与 Host 侧 `SourceServerDirectory.profileTargetIdentityKey` 同口径。
 * 只保留决定「是不是同一条线路」的字段：
 * - ssh：host（小写）/port（缺省 22）/username/privateKeyPath（换私钥会建新 Profile）；
 * - wsl：distro/user；docker：container。
 * assetInstallMode、sshConfigAlias、resourcePackages 只影响部署/展示，不参与身份，
 * 凭据字段更不参与——这里绝不能把密码等 secret 带进比较键。
 */
function sourceTargetIdentityKey(target: RemoteTarget | SourceServerProfileTarget): string {
  switch (target.kind) {
    case "ssh":
      return JSON.stringify({
        kind: "ssh",
        host: target.host.trim().toLowerCase(),
        port: target.port ?? 22,
        username: target.username.trim(),
        privateKeyPath: target.privateKeyPath?.trim() ?? "",
      });
    case "wsl":
      return JSON.stringify({
        kind: "wsl",
        distro: target.distro?.trim() ?? "",
        user: target.user?.trim() ?? "",
      });
    case "docker":
      return JSON.stringify({ kind: "docker", container: target.container.trim() });
  }
}

/**
 * 设备管理回执是否需要确认 Source 归属（Root 据此区分「反解失败 = 可读失败」与
 * 「legacy 设备照常 connected」）。
 *
 * 判定只复用设备行现有身份字段（owner 把 `ProjectDevice.sourceServerId` 原样透传为
 * `deviceSourceServerId`），不新造设备分类枚举：
 * - add-device：向导里还没有设备行，新设备经 Source 管理注册；owner 又依赖回传的
 *   Source 选中新设备（ProjectCreation 的 add-device 分支要求 sourceServerId 非空），
 *   所以必须反解出唯一归属；
 * - connect-device：server 形态设备（host 身份 `remote:server:<id>`）的
 *   `deviceSourceServerId` 有值，属于「本身能归属 Source 的设备」，反解失败必须给
 *   可读失败；legacy ssh/wsl/docker 设备没有 Source 归属，该字段恒为 undefined，
 *   沿用既有约定「报告 connected 即回原流程」（ProjectCreation 只在
 *   `device.sourceServerId` 存在时才校验回传身份），反解失败也不能把成功连接降级成取消。
 *
 * 该值只参与能力判定与日志；真正的「仍是同一 Source」比较仍在 owner 的 finish 里完成。
 */
export function requiresResolvedDeviceAdditionSource(
  target: DeviceAdditionReturnTarget,
): boolean {
  return target.kind === "add-device" || target.deviceSourceServerId !== undefined;
}

/**
 * 从设备管理快照反解「向导本次实际连上的 Source」。
 *
 * 缺陷根因：向导入口偏好里的「打开时选中的设备」不代表用户最终连上的机器——用户可以在
 * 向导里改选另一台机器；把入口值原样回显会把创建草稿和后续「查看项目」带到错的 Source。
 *
 * 反解依据（全部是 management 快照字段，不使用入口提示）：
 * 1. `profiles`：Host 连接链 `ensureProfile` 在握手前按 target 落盘（同一 target 只会
 *    有一条活动 Profile），`recordHandshake` 在握手成功后回写 `sourceServerId`；
 * 2. `states`：该 Profile 的 `online` 状态携带本次握手确认的 `sourceServerId`
 *    （连接结果的权威投影，其他状态不能证明连上的是哪台设备）；
 * 3. `servers`：`preferredProfileId` 指向该 Profile 的设备记录，作为 Profile 绑定
 *    尚未回写时的归属兜底。
 *
 * 三处证据必须收敛到唯一 sourceServerId 才返回；0 个（无法确认）或多个（证据冲突）
 * 一律返回 undefined，由调用点按设备类型决定是「可读失败」还是 legacy 设备照常
 * connected——宁可让上层失败，也不能回写一个猜的 id。
 */
export function resolveConnectedSourceServerId(
  snapshot: SourceServerManagementSnapshot,
  connectedTarget: RemoteTarget,
): string | undefined {
  const targetKey = sourceTargetIdentityKey(connectedTarget);
  const matchingProfiles = snapshot.profiles.filter(
    (profile) =>
      profile.lifecycleState !== "retired" && sourceTargetIdentityKey(profile.target) === targetKey,
  );
  if (matchingProfiles.length === 0) return undefined;

  const matchingProfileIds = new Set(matchingProfiles.map((profile) => profile.profileId));
  const candidateSourceServerIds = new Set<string>();

  for (const state of snapshot.states) {
    if (state.state !== "online" || !state.sourceServerId) continue;
    if (matchingProfileIds.has(state.profileId)) {
      candidateSourceServerIds.add(state.sourceServerId);
    }
  }

  for (const profile of matchingProfiles) {
    if (profile.sourceServerId) candidateSourceServerIds.add(profile.sourceServerId);
  }

  for (const server of snapshot.servers) {
    if (server.preferredProfileId && matchingProfileIds.has(server.preferredProfileId)) {
      candidateSourceServerIds.add(server.sourceServerId);
    }
  }

  if (candidateSourceServerIds.size !== 1) return undefined;
  return candidateSourceServerIds.values().next().value;
}
