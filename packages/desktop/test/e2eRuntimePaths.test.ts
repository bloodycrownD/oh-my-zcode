import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  E2E_RUNTIME_RELATIVE_ROOT,
  E2E_RUNTIME_ROOT_REPLAY_TOKEN,
  createE2EReplayFixtureVariables,
  resolveE2EHomeDir,
  resolveE2EStorageRoot,
  resolveE2ERuntimePath,
  resolveE2ERuntimeRoot,
  resolveE2EShellPath,
  resolveE2EToolPath,
} from "./e2e/helpers/e2e-runtime-paths.js";

const DESKTOP_TEST_DIR = import.meta.dirname;
const E2E_DIR = join(DESKTOP_TEST_DIR, "e2e");
const SOURCE_EXTENSIONS = new Set([".js", ".json", ".mjs", ".ts", ".tsx"]);
// 这条守卫约束的是「Desktop E2E 自己的 runtime 文件不许落在本机系统 /tmp」。
// R3A-BLD-09 的被测对象恰好是远端主机的 /tmp（8MB noexec tmpfs），用例必须断言
// 远端 mount 属性以及安装后 /tmp 无 zcode-server 残留，这里的 /tmp 不是本地 runtime 路径。
// 新增豁免必须像这样显式登记并说明理由，避免守卫被整体放宽。
const REMOTE_TMP_ASSERTION_SOURCES = new Set([
  "conversation-session/manual-review/pending/conversation-session-r3-install-environment.test.ts",
]);
// 只匹配作为绝对路径起点的系统 /tmp：前面不能紧跟路径字符，后面不能继续是单词字符。
// 缺陷原因：此前用 includes("/tmp") 子串匹配，把远端 Source 的私有 staging 目录
// "$HOME/.zcode/tmp/prompt-attachments" 也当成了系统 /tmp（R3 attachments 用例被误报）。
const SYSTEM_TMP_PATH_PATTERN = /(?<![\w.\-~}$])\/tmp(?![\w-])/u;
// 用户级数据根在 fork 是 ~/.omz（packages/services/src/paths.ts）。这里只拦截
// 「以用户 HOME 为基座」的 .zcode 字面量；workspace 级 <workspace>/.zcode
// （hooks/project config/agents/skills）以及 .zcode-e2e / .zcode-plugin 是合法布局。
const USER_HOME_BASE =
  "(?:homedir\\(\\)|process\\.env\\.HOME|process\\.env\\.ZCODE_E2E_HOME_DIR!?|host\\.home|sourceHome|serverHome|testHome|customRoot|customDataBaseDir|remoteHome|fakeHome|FAKE_HOME|TEST_HOME_DIR|E2E_HOME_DIR|E2E_HOME|e2eHomeDir|paths\\.homeDir|E2E_PATHS\\.homeDir|getE2EAppDataPaths\\(\\)\\.homeDir|dirname\\(DEFAULT_WORKSPACE\\)|fixture\\.root|homeDir|home)";
// join/resolve(<用户 HOME>, ".zcode", ...)；\s* 允许跨行，覆盖多行 join 的参数布局。
const USER_LEVEL_ZCODE_JOIN = new RegExp(
  `(?:join|resolve)\\(\\s*${USER_HOME_BASE}\\s*,\\s*"\\.zcode(?:["/])`,
  "gu",
);
const USER_LEVEL_ZCODE_REMOTE = [
  // 远端 shell 字符串：$HOME/.zcode、${HOME}/.zcode、~/.zcode、/home/<user>/.zcode。
  /(?:\$HOME|\$\{HOME\}|~|\/home\/[^\s"'`]+)\/\.zcode(?![-\w])/gu,
  // E2E HOME 占位符注释/断言。
  /<E2E_HOME>\/\.zcode(?![-\w])/gu,
  // process.env.HOME + "/.zcode"（字符串拼接形式）。
  /env\.HOME\s*\+\s*["']\/\.zcode(?![-\w])/gu,
];

describe("Desktop E2E runtime paths", () => {
  it("keeps runtime files below the isolated Agent execution workspace", () => {
    const e2eHomeDir = resolve("root", "isolated-e2e-home");

    expect(resolveE2ERuntimeRoot(e2eHomeDir)).toBe(join(e2eHomeDir, "ZCodeProject", ".zcode-e2e"));
    expect(resolveE2ERuntimePath("bg25", "release-child-bash")).toBe(
      join(resolveE2ERuntimeRoot(), "bg25", "release-child-bash"),
    );
  });

  it("uses portable absolute tool paths and workspace-relative shell paths", () => {
    expect(resolveE2EToolPath("bg25", "continued-work.txt")).toBe(
      resolveE2ERuntimePath("bg25", "continued-work.txt").replaceAll("\\", "/"),
    );
    expect(resolveE2EShellPath("bg25", "release-child-bash")).toBe(
      ".zcode-e2e/bg25/release-child-bash",
    );
    expect(E2E_RUNTIME_RELATIVE_ROOT).toBe(".zcode-e2e");
    expect(E2E_RUNTIME_ROOT_REPLAY_TOKEN).toBe("{{e2eRuntimeRoot}}");
    expect(createE2EReplayFixtureVariables(resolve("root", "fixture-home"))).toEqual({
      e2eRuntimeRoot: resolveE2ERuntimeRoot(resolve("root", "fixture-home")).replaceAll("\\", "/"),
    });
  });

  it("uses the existing E2E HOME precedence", () => {
    expect(
      resolveE2EHomeDir({
        cwd: resolve("root", "desktop"),
        env: { ZCODE_DATA_BASE_DIR: resolve("root", "data-base") },
      }),
    ).toBe(resolve("root", "data-base"));
    expect(
      resolveE2EHomeDir({
        cwd: resolve("root", "desktop"),
        env: {
          ZCODE_DATA_BASE_DIR: resolve("root", "data-base"),
          ZCODE_E2E_HOME_DIR: resolve("root", "explicit-home"),
        },
      }),
    ).toBe(resolve("root", "explicit-home"));
  });

  it("keeps the E2E CLI storage under the fork user data root .omz", () => {
    const homeDir = resolve("root", "isolated-e2e-home");

    expect(resolveE2EStorageRoot(homeDir)).toBe(join(homeDir, ".omz"));
  });

  it("aligns the E2E storage root with the product runtime data root", async () => {
    // 守卫的是「E2E helper 与产品 paths.ts 同源」：产品把用户数据根定在
    // ZCODE_AGENT_RUNTIME.nativeConfigDir（.omz/cli）的首段，fixture 不得独立漂移。
    const { ZCODE_AGENT_RUNTIME } = await import("@zcode/shared");
    const homeDir = resolve("root", "isolated-e2e-home");
    const [productDataRoot] = ZCODE_AGENT_RUNTIME.nativeConfigDir.split("/");

    expect(productDataRoot).toBe(".omz");
    expect(resolveE2EStorageRoot(homeDir)).toBe(join(homeDir, productDataRoot!));
  });

  it("does not allow raw system /tmp paths in Desktop E2E runtime sources", () => {
    const offenders = collectSourceFiles(E2E_DIR)
      .filter((path) => SYSTEM_TMP_PATH_PATTERN.test(readFileSync(path, "utf-8")))
      .map((path) => relative(E2E_DIR, path).replaceAll("\\", "/"))
      .filter((path) => !REMOTE_TMP_ASSERTION_SOURCES.has(path));

    expect(offenders).toEqual([]);
  });

  it("does not hardcode user-level .zcode under the fork .omz data root", () => {
    // 干净 HOME 上写死 ~/.zcode 会静默写错目录（CLI 读 ~/.omz）：清单里的
    // provider-readiness-history / workspace-close / bot-topic-worker 曾因此直接失败。
    const offenders = collectSourceFiles(E2E_DIR).flatMap((path) => {
      const source = readFileSync(path, "utf-8");
      return [
        ...collectMatches(source, USER_LEVEL_ZCODE_JOIN, path),
        // 正则字面量里的 \/home\/dev\/.zcode 需要先还原转义再匹配。
        ...USER_LEVEL_ZCODE_REMOTE.flatMap((pattern) =>
          collectMatches(source.replaceAll("\\/", "/"), pattern, path),
        ),
      ];
    });

    expect(offenders).toEqual([]);
  });
});

function collectSourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      // fixtures 是上游录制的回放数据，路径属于被测内容而不是 E2E runtime 配置。
      if (entry.name === "fixtures") return [];
      return collectSourceFiles(path);
    }
    const extension = entry.name.slice(entry.name.lastIndexOf("."));
    return SOURCE_EXTENSIONS.has(extension) ? [path] : [];
  });
}

function collectMatches(source: string, pattern: RegExp, path: string): string[] {
  return [...source.matchAll(pattern)].map((match) => {
    const line = source.slice(0, match.index ?? 0).split("\n").length;
    return `${relative(E2E_DIR, path).replaceAll("\\", "/")}:${line}: ${match[0].replaceAll("\n", " ")}`;
  });
}
