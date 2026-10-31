import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = process.argv[2];
const readyMarkerNames = {
  main: ".main-build-ready",
  host: ".host-build-ready",
  preload: ".preload-build-ready",
  // scheduler 已成为独立 tsup target，onSuccess 会调用同一 marker 脚本。
  // 旧白名单缺少该 target，导致 production build 在 bundle 成功后仍以 unknown target 失败。
  scheduler: ".scheduler-build-ready",
};

if (!Object.hasOwn(readyMarkerNames, target)) {
  throw new Error(`unknown ready marker target: ${target ?? "<empty>"}`);
}

// FORK(upgrade-316)：tsup 的 esbuild 把值导入的 `node:sqlite` 说明符重写成裸 "sqlite"
// （shared/sqlite-migrations 的 backup/restore 等），Electron ESM 运行时按裸包名解析即
// ERR_MODULE_NOT_FOUND。external 声明拦不住该重写，这里在写 marker 前对产物做输出级
// 回写：from "sqlite" → from "node:sqlite"。只处理精确说明符 "sqlite"，不碰其它模块。
function restoreNodeSqliteSpecifiers(chunkDir) {
  let patched = 0;
  for (const file of readdirSync(chunkDir, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith(".js")) continue;
    const fullPath = join(chunkDir, file.name);
    const source = readFileSync(fullPath, "utf8");
    const next = source.replace(
      /(from\s*|import\s*\(\s*)("|')sqlite\2/g,
      (_m, prefix, quote) => `${prefix}${quote}node:sqlite${quote}`,
    );
    if (next !== source) {
      writeFileSync(fullPath, next, "utf8");
      patched += 1;
    }
  }
  return patched;
}

const targetChunkDir = join(root, "out", target);
let restored = 0;
try {
  restored = restoreNodeSqliteSpecifiers(targetChunkDir);
} catch {
  // preload 无独立目录等情况：处理失败不阻塞 marker（Electron 报错会兜底暴露）。
}
if (restored > 0) {
  console.log(`[ready-marker] restored node:sqlite specifier in ${restored} ${target} chunk(s)`);
}

const readyMarkerPath = resolve(root, "out", readyMarkerNames[target]);

mkdirSync(dirname(readyMarkerPath), { recursive: true });

// tsup 的 CLI 级 onSuccess 会被每个子构建单独触发，不能代表 desktop 整体构建完成。
// 这里改成 main/host/preload 各自写独立 marker，dev.mjs 只有在三者都就绪后才会启动 Electron。
writeFileSync(readyMarkerPath, `${new Date().toISOString()}\n`, "utf8");
