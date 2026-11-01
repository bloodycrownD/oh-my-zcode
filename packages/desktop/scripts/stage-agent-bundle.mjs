// Agent bundle 的暂存动作：把 apps/zcode-cli/packages/cli/dist/zcode.cjs 放进
// bundled-agents/<平台>/glm，写 meta，并把 zcode.cjs 的运行期 external 依赖闭包
// 平铺进 glm/node_modules。
//
// dev 与打包**必须**用同一份暂存实现。
// 只有打包链（prepare-agent-node-bundle.mjs）会暂存是不够的，dev 链
// （scripts/build-desktop-agent-cli.mjs）不会；而 dev 未打包时的 agent 二进制由
// desktopRuntimeEnv.ts 的 resolveBundledZCodeAgentBinaryPath() 解析，候选**只有**
// bundled-agents/，没有 cli/dist/。于是 dev 一直跑着上一次打包时留下的那份 ——
// 实测陈旧 3 天，任何 agent CLI 侧改动在 dev 里静默不生效，排查时会把「改动没生效」
// 误判成「代码没起作用」。两边共用这一份，dev 与打包不可能再各自漂移。
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { buildDesktopAgentBytecode } from "../../../scripts/build-desktop-agent-bytecode.mjs";
import { collectRuntimeModuleClosureEntries } from "./runtime-dependency-closure.mjs";

export const AGENT_BUNDLE_SOURCE_RELATIVE = "apps/zcode-cli/packages/cli/dist/zcode.cjs";

// zcode.cjs 是 CJS bundle，但有一批依赖被 esbuild 外置（见 cli/scripts/build.mjs 的
// resolveBuildExternal()：@zcode/magic-context 因模块级 top-level await 与
// import.meta.url 无法内联 CJS）。产物里它们是 `require("@zcode/magic-context")`，
// 只能靠 Node 的目录向上查找从 zcode.cjs 旁解析——也就是 glm/node_modules。
// 这里登记 **app-server 启动路径会立即加载** 的 external：
// - @zcode/magic-context：存储/上下文 chokepoint，`app-server --stdio --prepare-storage`
//   一启动就 require（Host 的存储准备 Worker 因此崩过整包启动，见
//   docs/specs/desktop-agent-bundle-externals.md）；
// - @zcode/tui：只有交互 TUI 命令路径才加载，桌面 app-server 永远不经过；
// - playwright-core / koffi：browser-use/headless 懒加载，不在启动路径。
// 依赖闭包（zod、ai-tokenizer 等）由暂存逻辑按生产依赖递归展开，无需在这里列全。
export const AGENT_BUNDLE_RUNTIME_EXTERNAL_MODULES = ["@zcode/magic-context"];

const STAGED_PACKAGE_EXCLUDE_NAMES = new Set(["node_modules", ".turbo"]);
const stagedPackageFileExcludes = [/\.tsbuildinfo$/, /\.map$/];
const agentSelfCheckTimeoutMs = 120_000;

export function resolveAgentBundlePaths({ repoRoot, platformKey }) {
  const glmDir = resolve(repoRoot, "packages", "desktop", "bundled-agents", platformKey, "glm");
  return {
    cliBundlePath: resolve(repoRoot, AGENT_BUNDLE_SOURCE_RELATIVE),
    glmDir,
    stagedBundlePath: resolve(glmDir, "zcode.cjs"),
    stagedMetaPath: resolve(glmDir, ".node-bundle-meta.json"),
    stagedRuntimeModulesDir: resolve(glmDir, "node_modules"),
  };
}

function shouldCopyStagedPackageEntry(sourcePath) {
  const name = basename(sourcePath);
  if (STAGED_PACKAGE_EXCLUDE_NAMES.has(name)) return false;
  if (stagedPackageFileExcludes.some((pattern) => pattern.test(name))) return false;
  return true;
}

/**
 * 按生产依赖闭包把 external 依赖平铺进 glm/node_modules/。
 *
 * pnpm 布局下依赖真实文件分散在 .pnpm store 与 workspace 目录里，直接拷贝
 * node_modules/@zcode/magic-context 这类链接只能得到符号链接；这里对闭包里每个包
 * realpath 后拷贝真实内容（deref），并剔除包内自己的 node_modules/.turbo 等
 * 非运行时目录——闭包成员已全部平铺在 glm/node_modules 根上，包内链接不需要复制。
 */
function stageRuntimeExternalModules({ repoRoot, stagedRuntimeModulesDir, log }) {
  if (AGENT_BUNDLE_RUNTIME_EXTERNAL_MODULES.length === 0) return [];

  const cliPackageRoot = resolve(repoRoot, "apps", "zcode-cli", "packages", "cli");
  const lookupRoots = [
    cliPackageRoot,
    resolve(repoRoot, "apps", "zcode-cli"),
  ];
  const closureEntries = collectRuntimeModuleClosureEntries(
    AGENT_BUNDLE_RUNTIME_EXTERNAL_MODULES,
    lookupRoots,
  );
  const missingEntries = closureEntries.filter((entry) => !entry.sourceModulePath);
  if (missingEntries.length > 0) {
    throw new Error(
      `[stage:agent-bundle] 运行期 external 依赖在 workspace 中不可解析: ${missingEntries
        .map((entry) => entry.moduleName)
        .join(", ")}；searched=${lookupRoots.join(", ")}`,
    );
  }

  for (const { moduleName, sourceModulePath } of closureEntries) {
    const sourceRoot = realpathSync(sourceModulePath);
    const targetRoot = resolve(stagedRuntimeModulesDir, ...moduleName.split("/"));
    mkdirSync(dirname(targetRoot), { recursive: true });
    rmSync(targetRoot, { force: true, recursive: true });
    cpSync(sourceRoot, targetRoot, {
      recursive: true,
      dereference: true,
      filter: (entry) => shouldCopyStagedPackageEntry(entry),
    });
    log(`[stage:agent-bundle] staged runtime module ${moduleName}`);
  }
  return closureEntries;
}

/**
 * 暂存后的机械自检：两道断言缺一不可。
 *
 * 1) 从暂存后的 zcode.cjs require.resolve 每个 external（含闭包传递成员）——
 *    这正是 Worker 启动时的解析路径，布局错了当场失败，而不是等打包产物在用户侧
 *    崩成「数据准备进程意外退出或连接中断」。
 * 2) 实跑一次 `zcode.cjs --version`。注意 --version 分支会把加载异常打印后仍以
 *    exit 0 结束，所以除退出码外必须同时断言 stderr 不含 "Cannot find module"。
 */
function verifyStagedBundle({ stagedBundlePath, closureModuleNames, log }) {
  const stagedRequire = createRequire(stagedBundlePath);
  for (const moduleName of closureModuleNames) {
    stagedRequire.resolve(moduleName);
  }

  const result = spawnSync(process.execPath, [stagedBundlePath, "--version"], {
    cwd: dirname(stagedBundlePath),
    encoding: "utf8",
    timeout: agentSelfCheckTimeoutMs,
  });
  const stderr = result.stderr ?? "";
  if (result.error) {
    throw new Error(
      `[stage:agent-bundle] 暂存自检未能启动 (${stagedBundlePath}): ${result.error.message}`,
    );
  }
  if (result.status !== 0 || /Cannot find module/i.test(stderr)) {
    throw new Error(
      `[stage:agent-bundle] 暂存自检失败 (exit=${result.status}):\n${stderr.trim().slice(0, 4000)}`,
    );
  }
  log(`[stage:agent-bundle] staged bundle self-check passed (--version)`);
}

/**
 * 干净重建 glm 目录再拷贝。清空是刻意的：electron-builder 整目录拷贝
 * bundled-agents/<平台> → resources，本地工作树里上一次构建残留的原生二进制
 * （zcode-agent / zcode-acp 等）和旧 meta 会被一并打进安装包（CI 干净检出不会有，本地会有）。
 */
export async function stageAgentBundle({ repoRoot, platformKey, log = console.log }) {
  const { cliBundlePath, glmDir, stagedBundlePath, stagedMetaPath, stagedRuntimeModulesDir } =
    resolveAgentBundlePaths({
      repoRoot,
      platformKey,
    });
  if (!existsSync(cliBundlePath)) {
    throw new Error(`[stage:agent-bundle] agent bundle 源产物不存在：${cliBundlePath}`);
  }
  rmSync(glmDir, { recursive: true, force: true });
  mkdirSync(glmDir, { recursive: true });
  cpSync(cliBundlePath, stagedBundlePath);
  log(`[stage:agent-bundle] staged ${stagedBundlePath}`);

  // 发布包必须带 V8 code cache：14MB 的 zcode.cjs 每次冷启动都要完整解析编译，
  // 真机实测跨项目首次打开 agent 启动 4.45s 的主要构成。字节码必须由目标平台
  // Electron 的 Node 模式编译（V8 版本强绑定），所以放在 stage 阶段用本机 electron
  // 生成；生成三件套与 zcode.cjs 同级分发，host 侧优先加载 zcode.bytecode.cjs，
  // loader 缺失时自动回退裸 cjs——这里是纯加速产物，不作为启动的硬依赖。
  // 跨架构构建必须跳过字节码：V8 code cache 绑定目标平台的 V8 版本与 arch，
  // 而这里的编译器只能拿本机 Electron。mac-x64 包在 macos-latest（arm64）上打，
  // 若照常生成，产出的 .jsc 元数据写着 arch=arm64，目标机 desktop-agent-bytecode-runtime
  // 校验 arch 不一致即抛错 —— 安装包能装上，但任何会话都起不来 agent。
  // 架构一致时才编；不一致就退回裸 cjs（慢一些，但能启动）。
  const hostPlatformKey = `${process.platform}-${process.arch}`;
  // coverage 构建不产出字节码（buildDesktopAgentBytecode 内部禁止该组合），
  // 这里提前跳过，避免 test:e2e:all:coverage 在 staging 阶段抛错。
  const bytecodeAllowed = platformKey === hostPlatformKey && process.env.ZCODE_E2E_COVERAGE !== "1";
  if (!bytecodeAllowed) {
    log(
      `[stage:agent-bundle] 跳过 bytecode：目标 ${platformKey} 与本机 ${hostPlatformKey} 架构不一致`,
    );
  }
  const bytecode = bytecodeAllowed
    ? await buildDesktopAgentBytecode({ entryPath: stagedBundlePath })
    : undefined;
  if (bytecode) {
    log(
      `[stage:agent-bundle] staged bytecode ${basename(bytecode.loaderPath)} (${bytecode.metadata.bytecodeBytes} bytes)`,
    );
  }

  const meta = {
    runtime: "electron-node",
    entry: "zcode.cjs",
    ...(bytecode === undefined
      ? {}
      : {
          bytecode: {
            loader: basename(bytecode.loaderPath),
            bytecodeFile: bytecode.metadata.bytecodeFile,
          },
        }),
    platform: platformKey,
    source: AGENT_BUNDLE_SOURCE_RELATIVE,
  };
  writeFileSync(stagedMetaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  const closureEntries = stageRuntimeExternalModules({
    repoRoot,
    stagedRuntimeModulesDir,
    log,
  });
  verifyStagedBundle({
    stagedBundlePath,
    closureModuleNames: closureEntries.map((entry) => entry.moduleName),
    log,
  });
  // 字节码入口自检：必须用与编译同一份 Electron Node 跑，验证缓存可被真正命中
  // （用系统 node 跑会因 V8 版本不一致静默降级成重新编译，测不出问题）。
  if (bytecode) {
    verifyStagedBytecodeLoader({ loaderPath: bytecode.loaderPath, log });
  }

  return { stagedBundlePath, stagedMetaPath, bytecode };
}

function verifyStagedBytecodeLoader({ loaderPath, log }) {
  const electronPath = createRequire(loaderPath)("electron");
  const result = spawnSync(electronPath, [loaderPath, "--version"], {
    cwd: dirname(loaderPath),
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "" },
    timeout: agentSelfCheckTimeoutMs,
  });
  const stderr = result.stderr ?? "";
  if (result.error) {
    throw new Error(
      `[stage:agent-bundle] 字节码入口无法启动 (${loaderPath}): ${result.error.message}`,
    );
  }
  if (result.status !== 0 || /Cannot find module/i.test(stderr)) {
    throw new Error(
      `[stage:agent-bundle] 字节码入口自检失败 (exit=${result.status}):\n${stderr.trim().slice(0, 4000)}`,
    );
  }
  log(`[stage:agent-bundle] staged bytecode loader self-check passed (--version)`);
}
