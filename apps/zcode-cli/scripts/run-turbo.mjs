#!/usr/bin/env node
/**
 * 在 apps/zcode-cli 这个嵌套 workspace 里调用 turbo。
 *
 * 根 workspace 使用 hoisted linker，turbo 只落在仓库根的 node_modules；
 * 而 pnpm 在嵌套 workspace 内执行脚本时只把 apps/zcode-cli/node_modules/.bin
 * 放进 PATH（bootstrap 也只跑根 pnpm install），因此直接写 `turbo` 会报
 * 「不是内部或外部命令」。这里按 Node 模块解析顺序定位 turbo 的 bin：
 * 嵌套 workspace 自己安装过就优先用本地的，否则回落到仓库根安装。
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let turboBin;
try {
  turboBin = require.resolve("turbo/bin/turbo");
} catch {
  console.error("[turbo] 未找到 turbo，请先在仓库根执行 pnpm install。");
  process.exit(1);
}

const result = spawnSync(process.execPath, [turboBin, ...process.argv.slice(2)], {
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
