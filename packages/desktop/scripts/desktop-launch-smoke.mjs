#!/usr/bin/env node
// 桌面启动 e2e 冒烟（v1.0.21 启动即崩事故补位，cr-fix-spec CR-4）：
// 以 production out/ 产物启动 electron（ZCODE_DESKTOP_SMOKE=1），断言：
// 1) 进程自然退出且退出码 0（main/index.ts 冒烟钩子在 first window ready-to-show 后 app.exit(0)）
// 2) stderr 不含 ERR_MODULE_NOT_FOUND / Uncaught Exception（模块加载期崩点恰好在此暴露）
// 3) 60s 超时兜底：未退即 kill 判红（renderer 异常致 ready-to-show 不触发时不挂死）
// 修复前红对照：模块加载期（窗口创建前）即崩 → 被 stderr 断言捕获 → 本脚本非零退出。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const desktopDir = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]scripts$/, "");
// electron 的 bin 文本文件内容即可执行路径（node_modules/electron/dist/electron.exe）。
const electronBinPath = require_("electron").trim();
const TIMEOUT_MS = Number(process.env.ZCODE_DESKTOP_SMOKE_TIMEOUT_MS || 60_000);

const stderrChunks = [];
const child = spawn(electronBinPath, ["."], {
  cwd: desktopDir,
  env: {
    ...process.env,
    NODE_ENV: "production",
    ZCODE_DESKTOP_SMOKE: "1",
    ELECTRON_ENABLE_LOGGING: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
child.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));

const verdict = await new Promise((settle) => {
  let done = false;
  const finish = (result) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    settle(result);
  };
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish({ ok: false, reason: `超时 ${TIMEOUT_MS}ms 未退出（ready-to-show 未触发或启动挂死）` });
  }, TIMEOUT_MS);
  child.on("exit", (code, signal) => {
    const stderr = stderrChunks.join("");
    const bad = /ERR_MODULE_NOT_FOUND|Uncaught Exception|Cannot find (?:module|package)/.exec(
      stderr,
    );
    if (bad) {
      finish({ ok: false, reason: `stderr 捕获启动崩溃：${bad[0]}`, code, stderr });
      return;
    }
    if (code === 0) {
      finish({ ok: true, reason: "冒烟退出码 0 且 stderr 干净" });
      return;
    }
    finish({
      ok: false,
      reason: `非零退出码 ${code}${signal ? ` signal=${signal}` : ""}`,
      code,
      stderr,
    });
  });
  child.on("error", (error) => finish({ ok: false, reason: `启动失败：${error.message}` }));
});

if (!verdict.ok) {
  console.error(`[desktop-launch-smoke] FAIL：${verdict.reason}`);
  if (verdict.stderr) console.error("--- stderr 尾部 ---\n" + verdict.stderr.slice(-1500));
  process.exit(1);
}
console.log("[desktop-launch-smoke] PASS：" + verdict.reason);
