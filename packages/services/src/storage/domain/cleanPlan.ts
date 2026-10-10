/**
 * 清理计划：给定类别与候选文件列表，决定哪些能删。纯函数，删除动作由 adapters 执行。
 */
import {
  getStorageCategoryCleanability,
  hasStorageCleanPathOverride,
  isProtectedStoragePath,
  isStoragePathInCleanScope,
  type StorageCatalogContext,
} from "./storageCatalog.js";
import type { StorageCategoryId } from "@zcode/shared";

export interface StorageCleanCandidate {
  relativePath: string;
  bytes: number;
  mtimeMs: number;
}

interface StorageCleanPlan {
  targets: StorageCleanCandidate[];
  skippedCount: number;
}

/** 子代理产物：会话目录 24 小时内有更新就整个跳过，避免删掉进行中 subagent 的 transcript。 */
const SUBAGENT_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * exec 输出日志的在飞保护窗口（与 subagentTranscripts 同档 24h）。
 *
 * `cli/exec` 下仍在运行的后台 Bash（含子代理的 run_in_background，即事故路径）会
 * 持续追加自己的 `-stdout.log`，fd 仍被持有。一键清理若不分窗口，会把正在运行
 * 任务的输出文件从目录里删掉：POSIX 上 unlink 之后进程继续写孤儿 inode，磁盘
 * 空间要到进程退出才回收；Windows 上则直接 EBUSY/EPERM 记失败。24h 内有过
 * 写入的文件一律视为"可能在飞"跳过。
 */
const EXEC_OUTPUT_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function planStorageClean(params: {
  categoryId: StorageCategoryId;
  candidates: StorageCleanCandidate[];
  context: StorageCatalogContext;
  now: number;
}): StorageCleanPlan {
  const { categoryId, candidates, context, now } = params;
  // uix/G-1 r3：none 门同样让位 per-path 覆盖类别（toolOutputs → cli/exec）。
  // 类别级整组不可一键清理，但覆盖前缀这一段要能出计划；候选随后由
  // isStoragePathInCleanScope 收敛到覆盖前缀，不会误伤整组其余成员。
  if (
    getStorageCategoryCleanability(categoryId) === "none" &&
    !hasStorageCleanPathOverride(categoryId)
  ) {
    return { targets: [], skippedCount: candidates.length };
  }
  // 候选来自按前缀枚举，可能混入其他类别（如 cli/plugins 下的 cache）；只保留分类一致且未受保护的。
  // 6c：toolOutputs 走 per-path 覆盖，只认 cli/exec（见 isStoragePathInCleanScope）。
  const owned = candidates.filter(
    (candidate) =>
      isStoragePathInCleanScope(categoryId, candidate.relativePath, context) &&
      !isProtectedStoragePath(candidate.relativePath),
  );
  let targets = owned;
  if (categoryId === "logs") {
    targets = owned.filter((candidate) => !isSameLocalDay(candidate.mtimeMs, now));
  } else if (categoryId === "subagentTranscripts") {
    // 活动判定如果只看 owned（已按类别过滤，只剩 transcript.jsonl），会漏掉同目录下
    // 刚写入的 metadata/output 文件，把进行中 subagent 的 transcript 判成不活跃。这里用全部候选算活动时间。
    targets = filterInactiveSessionDirs(owned, candidates, now);
  } else if (hasStorageCleanPathOverride(categoryId)) {
    // 6c 在飞保护：per-path 覆盖类别（当前 toolOutputs → cli/exec）按文件本身的新鲜度
    // 判定，仍在写入的日志不删；同会话里的旧日志不受影响，仍可回收。
    targets = filterInactiveFiles(owned, now);
  }
  return { targets, skippedCount: candidates.length - targets.length };
}

function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** 会话目录 = 前三段（cli/agents/sess_x）；任一文件在活动窗口内则整组跳过。 */
function filterInactiveSessionDirs(
  targets: StorageCleanCandidate[],
  allCandidates: StorageCleanCandidate[],
  now: number,
): StorageCleanCandidate[] {
  const latestBySession = new Map<string, number>();
  const sessionKey = (path: string) => path.split("/").slice(0, 3).join("/");
  for (const candidate of allCandidates) {
    const key = sessionKey(candidate.relativePath);
    latestBySession.set(key, Math.max(latestBySession.get(key) ?? 0, candidate.mtimeMs));
  }
  return targets.filter(
    (candidate) =>
      now - (latestBySession.get(sessionKey(candidate.relativePath)) ?? 0) >
      SUBAGENT_ACTIVE_WINDOW_MS,
  );
}

/** 文件级不活跃过滤：窗口内有写入（在飞）的文件跳过，只回收终态旧日志。 */
function filterInactiveFiles(
  targets: StorageCleanCandidate[],
  now: number,
): StorageCleanCandidate[] {
  // 时钟基准卫语句（uix/G-2）：mtime 晚于 now 时（本机时钟回拨、NTP 跳变、
  // 从时钟更准的机器拷来的文件）now - mtimeMs 为负，本就不满足 24h 窗口——
  // 这里显式写出来只为锁定「未来文件绝不回删」的语义，过滤行为与旧算式一致，
  // 由 T-C2-5 两例 fake clock 测试钉住。
  return targets.filter(
    (candidate) =>
      candidate.mtimeMs <= now && now - candidate.mtimeMs > EXEC_OUTPUT_ACTIVE_WINDOW_MS,
  );
}
