/**
 * S32（L1 品牌改名）首启提示：数据根目录从 `~/.zcode` 换到 `~/.omz`。
 *
 * 刻意「新起 + 提示」，不做自动迁移：旧目录里混着会话库、凭据、插件缓存与 runtime
 * 工具，整段搬过去会把上一代产品的状态一起带进来，出问题也无法定位是改名引入的还是
 * 历史脏数据。因此这里只做两件事：
 *
 *   1. 第一次以新数据根启动时，在 stderr 打一次性提示，说明新目录 + 旧目录不会被迁移；
 *   2. 在新数据根里写一个 marker 文件，之后不再提示。
 *
 * 最小侵入：只在 CLI 入口调一次，纯 stderr 文本 + 一个 marker 文件，不进协议通道、
 * 不改任何解析逻辑。marker 写不进去（只读家目录、盘满）时静默放弃提示，绝不因此
 * 让 CLI 起不来。
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** S32 之后的用户级数据根目录名。 */
export const OMZ_DATA_DIR_NAME = ".omz";
/** S32 之前的数据根目录名；只用于「旧目录还在不在」的只读探测，绝不写入。 */
export const LEGACY_DATA_DIR_NAME = ".zcode";
/** 一次性 marker：存在即代表提示已经打过。 */
const NOTICE_MARKER_FILE_NAME = ".oh-my-zcode-first-run-notice";

type CliEnv = Record<string, string | undefined>;

export interface DataDirNoticeInput {
  env?: CliEnv;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

export interface DataDirNoticeResult {
  dataRoot: string;
  legacyRoot: string;
  legacyRootExists: boolean;
  markerPath: string;
  shown: boolean;
}

/**
 * 解析当前生效的数据根。与 `execution-utils` / `clipboard-image` / `sea-runtime-tools`
 * 保持同一优先级：`ZCODE_STORAGE_DIR` 显式指定，否则 `$HOME/.omz`。
 */
export function resolveDataRoot(env: CliEnv = process.env): string {
  const configured = env.ZCODE_STORAGE_DIR?.trim();
  if (configured) return resolve(configured);
  return join(homedir(), OMZ_DATA_DIR_NAME);
}

/** 旧数据根：只用于提示文案里指路，不迁移、不写入。 */
function resolveLegacyDataRoot(env: CliEnv, dataRoot: string): string {
  if (env.ZCODE_STORAGE_DIR?.trim()) return join(dirname(dataRoot), LEGACY_DATA_DIR_NAME);
  return join(homedir(), LEGACY_DATA_DIR_NAME);
}

function formatNotice(dataRoot: string, legacyRoot: string, legacyRootExists: boolean): string {
  const lines = [
    "",
    `[oh-my-zcode] 数据目录已更名：本产品现在使用 ${dataRoot}。`,
    `[oh-my-zcode] 旧的 ${legacyRoot} 不会被自动迁移——请按需自行把里面的内容复制到新目录后重启。`,
  ];
  if (legacyRootExists) {
    lines.push(`[oh-my-zcode] 检测到旧目录 ${legacyRoot} 仍然存在，复制与否由你决定。`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 打一次性首启提示。返回结果便于调用方观察命中路径；任何失败都退化成「不提示」，
 * 绝不把首启提示变成启动失败的原因。
 */
export function maybeShowDataDirFirstRunNotice(
  input: DataDirNoticeInput = {},
): DataDirNoticeResult {
  const env = input.env ?? process.env;
  const stderr = input.stderr ?? process.stderr;
  const dataRoot = resolveDataRoot(env);
  const legacyRoot = resolveLegacyDataRoot(env, dataRoot);
  const markerPath = join(dataRoot, NOTICE_MARKER_FILE_NAME);
  const legacyRootExists = directoryExists(legacyRoot);

  if (existsSync(markerPath)) {
    return { dataRoot, legacyRoot, legacyRootExists, markerPath, shown: false };
  }

  try {
    stderr.write(formatNotice(dataRoot, legacyRoot, legacyRootExists));
  } catch {
    return { dataRoot, legacyRoot, legacyRootExists, markerPath, shown: false };
  }

  try {
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(markerPath, `${new Date().toISOString()}\n`, "utf8");
  } catch {
    // marker 写不进去就让用户下次再看一次提示，绝不因此让 CLI 启动失败。
  }

  return { dataRoot, legacyRoot, legacyRootExists, markerPath, shown: true };
}
