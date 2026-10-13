#!/usr/bin/env node
// e2e 驱动 v4：分支① system-language-unification 场景 S1-S3。
// 口径：config.json 无环境变量可隔离（os.homedir() 落点）——备份/恢复式验证；
// 证据只记录 promptLanguage 字段（绝不 dump 完整 config，含 MCP 凭据）。
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const REPO = "D:\\Dev\\Js\\oh-my-zcode";
const CDP = "http://127.0.0.1:9229";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const stamp = process.env.OMZ_E2E_STAMP || String(Date.now());
const root = path.join(os.tmpdir(), `omz-e2e-lang4-${stamp}`);
const storage = path.join(root, "storage");
const home = path.join(root, "home");
const ws = path.join(root, "ws");
fs.mkdirSync(storage, { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "omz-e2e-ws", private: true }, null, 2));
const isolatedEnv = {
  ...process.env,
  ZCODE_STORAGE_DIR: storage,
  ZCODE_DESKTOP_HOME_DIR: home,
  MAGIC_CONTEXT_DB_DIR: path.join(root, "mc"),
};
log("临时环境:", root);

const results = { env: { root, storage, home, ws }, scenarios: {}, evidence: {} };

const cliConfigPath = path.join(os.homedir(), ".omz", "cli", "config.json");
const configBackup = cliConfigPath + ".omz-e2e-bak";
let configExistedBefore = false;
const readCliConfig = () => {
  try {
    return { exists: true, data: JSON.parse(fs.readFileSync(cliConfigPath, "utf8")) };
  } catch {
    return { exists: false };
  }
};
// 启动前备份（真实 config.json）
try { fs.copyFileSync(cliConfigPath, configBackup); configExistedBefore = true; log("已备份真实 config.json"); } catch { log("真实 config.json 不存在（e2e 中新建，跑完删除）"); }

function portBusy(port) {
  try { execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { stdio: "pipe" }); return true; } catch { return false; }
}
if (portBusy(9229) || portBusy(5174)) {
  console.error(JSON.stringify({ fatal: "9229 或 5174 已被占用（可能有并行 dev/e2e），中止" }));
  process.exit(2);
}

async function cdpPage() {
  const list = await fetch(`${CDP}/json/list`).then((x) => x.json());
  const page = list.find((t) => t.type === "page" && String(t.url).includes("http://localhost:5174/") && !String(t.url).includes("resource-manager.html"));
  if (!page) return null;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let seq = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      close: () => ws.close(),
      eval: (expression) => {
        const id = ++seq;
        return new Promise((res2, rej2) => {
          pending.set(id, { res: res2, rej: rej2 });
          ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
        });
      },
    });
    ws.onerror = () => reject(new Error("ws connect failed"));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      }
    };
  });
}
async function evalJs(cdp, expression) {
  const r = await cdp.eval(expression);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result?.value;
}

log("启动 dev 桌面环境…");
const dev = spawn("pnpm.cmd", ["--filter", "@zcode/desktop", "dev"], { cwd: REPO, env: isolatedEnv, stdio: ["ignore", "pipe", "pipe"], shell: true, windowsHide: true });
let devLogTail = "";
const appendTail = (chunk) => { devLogTail = (devLogTail + String(chunk)).slice(-4000); };
dev.stdout.on("data", appendTail);
dev.stderr.on("data", appendTail);

let cdp = null;
for (let i = 0; i < 120; i += 1) {
  await sleep(5000);
  try { cdp = await cdpPage(); if (cdp) break; } catch {}
  if (dev.exitCode !== null) { console.error(JSON.stringify({ fatal: "dev 进程提前退出", tail: devLogTail.slice(-1500) })); process.exit(3); }
}
if (!cdp) { console.error(JSON.stringify({ fatal: "10 分钟未等到 renderer CDP", tail: devLogTail.slice(-1500) })); process.exit(3); }
log("renderer CDP 已连接");

let ready = false;
for (let i = 0; i < 30; i += 1) {
  ready = await evalJs(cdp, `Boolean(window.__testActions && window.__testActions.setLocale)`).catch(() => false);
  if (ready) break;
  await sleep(2000);
}
log("renderer 首屏就绪:", ready);

const electronPkg = createRequire(path.join(REPO, "packages", "desktop", "scripts", "dev.mjs")).resolve("electron/package.json");
const electronBin = path.join(path.dirname(electronPkg), "dist", "electron.exe");
spawn(electronBin, [".", `--open-workspace=${ws}`], { cwd: path.join(REPO, "packages", "desktop"), env: isolatedEnv, stdio: "ignore", windowsHide: true });

let wsOpen = false;
for (let i = 0; i < 45; i += 1) {
  wsOpen = await evalJs(cdp, `Boolean(document.querySelector('[data-testid="v4-composer"], [data-testid="v4-composer-input"], [data-testid="chat-send-button"]'))`).catch(() => false);
  if (wsOpen) break;
  await sleep(2000);
}
log("workspace 界面就绪:", wsOpen);
results.scenarios.S0_workspace_open = wsOpen ? "passed" : "blocked";

async function openSettings() {
  const clicked = await evalJs(cdp, `(() => {
    const btns = [...document.querySelectorAll('button')];
    const target = btns.find(b => { const label = (b.getAttribute('aria-label') || '').trim(); return label === '设置' || label === 'Settings' || /^设置/.test(label) || /^Settings/.test(label); });
    if (!target) return { ok: false, why: 'footer 齿轮未找到' };
    const rect = target.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2, button: 0, pointerId: 1, isPrimary: true };
    target.dispatchEvent(new PointerEvent('pointerdown', opts));
    target.dispatchEvent(new MouseEvent('mousedown', opts));
    target.dispatchEvent(new PointerEvent('pointerup', opts));
    target.dispatchEvent(new MouseEvent('mouseup', opts));
    target.dispatchEvent(new MouseEvent('click', opts));
    return { ok: true };
  })()`).catch((e) => ({ ok: false, why: String(e).slice(0, 120) }));
  if (!clicked.ok) return clicked;
  for (let i = 0; i < 15; i += 1) {
    const onPage = await evalJs(cdp, `Boolean(document.querySelector('[data-testid="settings-page"]'))`).catch(() => false);
    if (onPage) return { ok: true };
    await sleep(1000);
  }
  return { ok: false, why: "settings-page 未出现" };
}

async function goGeneralSection() {
  const ids = await evalJs(cdp, `(() => [...document.querySelectorAll('[data-testid^="settings-section-nav"]')].map(el => el.dataset.testid))()`).catch(() => []);
  log("设置分区导航:", JSON.stringify(ids));
  const general = ids.find((x) => /general/i.test(x));
  if (general) {
    await evalJs(cdp, `document.querySelector('[data-testid="${general}"]').click()`).catch(() => {});
    await sleep(800);
  }
  return ids;
}

const FORM_PROBE = `(() => {
  const localeTrigger = document.querySelector('[data-testid="settings-locale-select-trigger"]');
  const modelLang = document.querySelector('[data-testid*="model-language"], [data-testid*="modelLanguage"]');
  const body = document.body.textContent || "";
  return {
    localeTrigger: Boolean(localeTrigger),
    modelLangGone: !modelLang && !body.includes("模型语言") && !body.includes("Model language"),
    systemLangLabel: body.includes("系统语言") || body.includes("System language"),
    settingsTestids: [...document.querySelectorAll('[data-testid]')].map(el => el.dataset.testid).filter(x => x.startsWith("settings")).slice(0, 40),
  };
})()`;

async function s1() {
  const open = await openSettings();
  if (!open.ok) return { status: "blocked", detail: { open } };
  const navIds = await goGeneralSection();
  const form = await evalJs(cdp, FORM_PROBE).catch(() => null);
  const passed = Boolean(form && form.localeTrigger && form.modelLangGone && form.systemLangLabel);
  return { status: passed ? "passed" : "failed", detail: { navIds, form } };
}

async function s2() {
  if (!wsOpen) return { status: "blocked", detail: "workspace 未打开" };
  let baseline = null;
  for (let i = 0; i < 20; i += 1) { baseline = readCliConfig(); if (baseline.exists) break; await sleep(2000); }
  const before = baseline.exists ? baseline.data.promptLanguage ?? "(absent)" : "(no-file)";
  await evalJs(cdp, `window.__testActions.setLocale('en-US')`);
  let afterEn = null;
  for (let i = 0; i < 20; i += 1) { const c = readCliConfig(); if (c.exists && c.data.promptLanguage === "en-US") { afterEn = "en-US"; break; } await sleep(1500); }
  await evalJs(cdp, `window.__testActions.setLocale('zh-CN')`);
  let afterZh = null;
  for (let i = 0; i < 20; i += 1) { const c = readCliConfig(); if (c.exists && c.data.promptLanguage === "zh-CN") { afterZh = "zh-CN"; break; } await sleep(1500); }
  const passed = afterEn === "en-US" && afterZh === "zh-CN";
  return { status: passed ? "passed" : "failed", detail: { before, afterEn: afterEn ?? "(timeout)", afterZh: afterZh ?? "(timeout)" } };
}

async function s3() {
  if (!wsOpen) return { status: "blocked", detail: "workspace 未打开" };
  const open = await openSettings();
  if (!open.ok) return { status: "blocked", detail: { open } };
  await goGeneralSection();
  const r = await evalJs(cdp, `(() => {
    const trigger = document.querySelector('[data-testid="settings-locale-select-trigger"]');
    if (!trigger) return { ok: false, why: 'locale trigger 未找到' };
    trigger.scrollIntoView({ block: 'center' });
    const rect = trigger.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2, button: 0, pointerId: 1, isPrimary: true };
    trigger.dispatchEvent(new PointerEvent('pointerover', opts));
    trigger.dispatchEvent(new PointerEvent('pointerenter', { ...opts, bubbles: false }));
    trigger.dispatchEvent(new PointerEvent('pointerdown', opts));
    trigger.dispatchEvent(new MouseEvent('mousedown', opts));
    trigger.dispatchEvent(new PointerEvent('pointerup', opts));
    trigger.dispatchEvent(new MouseEvent('mouseup', opts));
    trigger.dispatchEvent(new MouseEvent('click', opts));
    return { ok: true };
  })()`).catch((e) => ({ ok: false, why: String(e).slice(0, 120) }));
  await sleep(1200);
  const menu = await evalJs(cdp, `(() => [...document.querySelectorAll('[role="option"], [role="menuitem"], [data-testid^="settings-locale-select-item"]')].map(el => (el.textContent || '').trim()).slice(0, 10))()`).catch(() => []);
  if (!menu.length) return { status: "blocked", detail: { step: "下拉未展开", click: r } };
  const picked = await evalJs(cdp, `(() => {
    const items = [...document.querySelectorAll('[role="option"], [role="menuitem"], [data-testid^="settings-locale-select-item"]')];
    const el = items.find(x => (x.textContent || '').includes('系统') || /system/i.test(x.textContent || '') || (x.textContent || '').includes('跟随'));
    if (!el) return { ok: false, options: items.map(x => (x.textContent || '').trim()) };
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, isPrimary: true }));
    el.click();
    return { ok: true, text: (el.textContent || '').trim() };
  })()`).catch((e) => ({ ok: false, why: String(e).slice(0, 120) }));
  let afterSystem = null;
  for (let i = 0; i < 20; i += 1) { const c = readCliConfig(); if (c.exists && (c.data.promptLanguage === "zh-CN" || c.data.promptLanguage === "en-US")) { afterSystem = c.data.promptLanguage; break; } await sleep(1500); }
  const hostLocale = new Intl.DateTimeFormat().resolvedOptions().locale.startsWith("zh") ? "zh-CN" : "en-US";
  return { status: picked.ok && afterSystem === hostLocale ? "passed" : "blocked", detail: { click: r, menu, picked, afterSystem: afterSystem ?? "(timeout)", hostLocale } };
}

results.scenarios.S1_settings_form = await s1();
results.scenarios.S2_prompt_language_sync = await s2();
results.scenarios.S3_system_follow = await s3();

results.evidence.toastProbe = await evalJs(cdp, `(() => { const t = document.body.textContent || ""; return { hasErrorToast: /保存失败|failed to save|Save failed/i.test(t) }; })()`).catch(() => null);
// 安全口径：只记录 promptLanguage，绝不 dump 完整 config
results.evidence.cliConfigFinalPromptLanguage = readCliConfig().exists ? readCliConfig().data.promptLanguage ?? "(absent)" : "(no-file)";

log("清理进程树与临时目录…");
try { execSync(`taskkill /PID ${dev.pid} /T /F`, { stdio: "ignore" }); } catch {}
await sleep(3000);
try { execSync('taskkill /IM electron.exe /F', { stdio: "ignore" }); } catch {}
// 恢复真实 config.json（先删后还原，消除 e2e 写入）
try { fs.rmSync(cliConfigPath, { force: true }); } catch {}
if (configExistedBefore) { try { fs.copyFileSync(configBackup, cliConfigPath); fs.rmSync(configBackup, { force: true }); log("真实 config.json 已还原"); } catch (e) { log("还原失败!", String(e).slice(0, 120)); } }
else { try { fs.rmSync(configBackup, { force: true }); } catch {} }
try { fs.rmSync(root, { recursive: true, force: true }); log("临时目录已删除"); } catch (e) { log("临时目录删除失败:", String(e).slice(0, 120)); }
cdp.close();
console.log("===E2E-RESULT===");
console.log(JSON.stringify(results, null, 2));
process.exit(0);
