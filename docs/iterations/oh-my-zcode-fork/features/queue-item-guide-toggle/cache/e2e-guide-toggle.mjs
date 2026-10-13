#!/usr/bin/env node
// e2e 驱动 v5：分支② queue-item-guide-toggle 场景 S4-S5。
// 凭据：复制真实 ~/.omz/v2（provider 配置+凭据）到一次性 home（跑完删除，绝不留在磁盘）；
// 真实模型调用一次「数数」长 turn 制造 busy 窗口；config.json 备份/还原。
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
const root = path.join(os.tmpdir(), `omz-e2e-guide-${stamp}`);
const storage = path.join(root, "storage");
const home = path.join(root, "home");
const ws = path.join(root, "ws");
for (const d of [storage, home, ws]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "omz-e2e-ws", private: true }, null, 2));

// 复制真实 v2（provider 凭据）到隔离 home——只在一次性目录内存续，结束即删
const realV2 = path.join(os.homedir(), ".omz", "v2");
const isoV2 = path.join(home, ".omz", "v2");
try { fs.cpSync(realV2, isoV2, { recursive: true }); log("已复制 ~/.omz/v2 到隔离 home"); } catch (e) { log("复制 v2 失败:", String(e).slice(0, 120)); }

const isolatedEnv = { ...process.env, ZCODE_STORAGE_DIR: storage, ZCODE_DESKTOP_HOME_DIR: home, MAGIC_CONTEXT_DB_DIR: path.join(root, "mc") };
log("临时环境:", root);

const results = { env: { root, storage, home, ws }, scenarios: {}, evidence: {} };
const cliConfigPath = path.join(os.homedir(), ".omz", "cli", "config.json");
const configBackup = cliConfigPath + ".omz-e2e-bak";
let configExistedBefore = false;
try { fs.copyFileSync(cliConfigPath, configBackup); configExistedBefore = true; } catch {}

function portBusy(port) { try { execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { stdio: "pipe" }); return true; } catch { return false; } }
if (portBusy(9229) || portBusy(5174)) { console.error(JSON.stringify({ fatal: "9229/5174 被占用，中止" })); process.exit(2); }

async function cdpPage() {
  const list = await fetch(`${CDP}/json/list`).then((x) => x.json());
  const page = list.find((t) => t.type === "page" && String(t.url).includes("http://localhost:5174/") && !String(t.url).includes("resource-manager.html"));
  if (!page) return null;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let seq = 0; const pending = new Map();
    ws.onopen = () => resolve({
      close: () => ws.close(),
      eval: (expression) => { const id = ++seq; return new Promise((res2, rej2) => { pending.set(id, { res: res2, rej: rej2 }); ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })); }); },
    });
    ws.onerror = () => reject(new Error("ws connect failed"));
    ws.onmessage = (event) => { const msg = JSON.parse(event.data); if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); if (msg.error) rej(new Error(msg.error.message)); else res(msg.result); } };
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
const appendTail = (c) => { devLogTail = (devLogTail + String(c)).slice(-4000); };
dev.stdout.on("data", appendTail); dev.stderr.on("data", appendTail);
let cdp = null;
for (let i = 0; i < 120; i += 1) {
  await sleep(5000);
  try { cdp = await cdpPage(); if (cdp) break; } catch {}
  if (dev.exitCode !== null) { console.error(JSON.stringify({ fatal: "dev 提前退出", tail: devLogTail.slice(-1200) })); process.exit(3); }
}
if (!cdp) { console.error(JSON.stringify({ fatal: "未等到 CDP", tail: devLogTail.slice(-1200) })); process.exit(3); }
log("CDP 已连接");

let ready = false;
for (let i = 0; i < 30; i += 1) { ready = await evalJs(cdp, `Boolean(document.querySelector('[data-testid="v4-composer-input"]'))`).catch(() => false); if (ready) break; await sleep(2000); }

const electronPkg = createRequire(path.join(REPO, "packages", "desktop", "scripts", "dev.mjs")).resolve("electron/package.json");
spawn(path.join(path.dirname(electronPkg), "dist", "electron.exe"), [".", `--open-workspace=${ws}`], { cwd: path.join(REPO, "packages", "desktop"), env: isolatedEnv, stdio: "ignore", windowsHide: true });

let wsOpen = false;
for (let i = 0; i < 45; i += 1) { wsOpen = await evalJs(cdp, `Boolean(document.querySelector('[data-testid="v4-composer-input"]'))`).catch(() => false); if (wsOpen) break; await sleep(2000); }
log("workspace 就绪:", wsOpen);
results.scenarios.S0_workspace_open = wsOpen ? "passed" : "blocked";

// ---------- 工具：composer 填文本+发送 ----------
async function typeAndSend(text) {
  return evalJs(cdp, `(() => {
    const input = document.querySelector('[data-testid="v4-composer-input"]');
    if (!input) return { ok: false, why: 'input 未找到' };
    input.focus();
    const ok = document.execCommand('insertText', false, ${JSON.stringify(text)});
    return { ok: true, inserted: ok };
  })()`).then(async (r) => {
    if (!r.ok) return r;
    await sleep(400);
    const sent = await evalJs(cdp, `(() => {
      const send = document.querySelector('[data-testid="v4-composer-send"]');
      if (!send) return { ok: false, why: 'send 按钮未找到' };
      if (send.disabled) return { ok: false, why: 'send disabled（输入未生效？）' };
      send.click();
      return { ok: true };
    })()`);
    return { ...r, send: sent };
  }).catch((e) => ({ ok: false, why: String(e).slice(0, 120) }));
}
const isBusy = () => evalJs(cdp, `Boolean(document.querySelector('[data-testid="v4-stop"]'))`).catch(() => false);
const queueItemIds = () => evalJs(cdp, `(() => [...document.querySelectorAll('[data-testid^="v4-queue-item-queue_"]')].map(el => el.dataset.testid))()`).catch(() => []);

if (wsOpen) {
  // ---------- S4：busy + 排队 + 按钮存在性 ----------
  const first = await typeAndSend("请用 Bash 工具执行命令：ping -n 4 127.0.0.1 。等它结束后再执行同样的命令，总共重复执行 10 次，每次都必须等上一次结束。除此之外不要做任何别的事。，每个数字单独一行输出，不要省略任何数字，也不要做别的事。");
  log("首条消息:", JSON.stringify(first));
  let busy = false;
  for (let i = 0; i < 40; i += 1) { busy = await isBusy(); if (busy) { await sleep(1200); if (await isBusy()) { await sleep(1200); busy = await isBusy(); if (busy) break; } } await sleep(1500); }
  log("busy:", busy);
  results.evidence.firstTurnBusy = busy;
    results.evidence.devLogQueueLines = devLogTail.split(/\r?\n/).filter((l) => /setQueueItemDelivery|[Qq]ueue/.test(l)).slice(-25);
  if (!busy) {
    results.scenarios.S4_queue_buttons = { status: "failed", detail: { first, busy, note: "首条消息未产生 busy turn（模型无响应/凭据问题？）" } };
    results.scenarios.S5_toggle_roundtrip = { status: "blocked", detail: "依赖 S4" };
  } else {
    // busy 中排队两条
    const q1 = await typeAndSend("第二条排队消息：1+1 等于几？");
    await sleep(1200);
    const q2 = await typeAndSend("第三条排队消息：2+2 等于几？");
    let ids = [];
    for (let i = 0; i < 30; i += 1) { ids = await queueItemIds(); if (ids.length >= 1) break; await sleep(1500); }
    log("队列项:", JSON.stringify(ids));
    const guideBtns = await evalJs(cdp, `(() => [...document.querySelectorAll('[data-testid^="v4-queue-item-guide"]')].map(el => el.dataset.testid))()`).catch(() => []);
    results.scenarios.S4_queue_buttons = {
      status: ids.length >= 1 && guideBtns.some((x) => x.startsWith("v4-queue-item-guide-")) ? "passed" : "failed",
      detail: { q1: q1.send ?? q1, q2: q2.send ?? q2, ids, guideBtns },
    };

    // ---------- S5：切换往返 ----------
    const target = ids[0];
    const targetId = target.replace("v4-queue-item-", "");
    if (results.scenarios.S4_queue_buttons.status === "passed" && target) {
      // 先 patch console.error/console.warn 捕获拒绝观测（SessionPane 的 onRejected 只打 console）
      await evalJs(cdp, `(() => { window.__capErr = []; const oe = console.error.bind(console); console.error = (...a) => { window.__capErr.push(['error', a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')].join(':')); oe(...a); }; const ow = console.warn.bind(console); console.warn = (...a) => { window.__capErr.push(['warn', a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')].join(':')); ow(...a); }; })()`).catch(() => {});
      const clickGuide = await evalJs(cdp, `(async () => {
        for (let i = 0; i < 40; i += 1) {
          const btn = document.querySelector('[data-testid="v4-queue-item-guide-${targetId}"]');
          if (btn && !btn.disabled && !btn.getAttribute('aria-disabled')) { btn.click(); return { ok: true, waitedMs: i * 250 }; }
          await new Promise((r) => setTimeout(r, 250));
        }
        return { ok: false, why: 'guide 按钮未出现或一直 disabled' };
      })()`).catch((e) => ({ ok: false, why: String(e).slice(0, 120) }));
      log("guide 点击:", JSON.stringify(clickGuide));
      // 等待：项离开可见队列 + 待引导列表出现 restore 按钮
      let gone = false; let restoreSel = null; const diag = [];
      for (let i = 0; i < 45; i += 1) {
        const snap = await evalJs(cdp, `(() => ({
          busy: Boolean(document.querySelector('[data-testid="v4-stop"]')),
          still: Boolean(document.querySelector('[data-testid="v4-queue-item-${targetId}"]')),
          restore: (() => { const el = document.querySelector('[data-testid^="v4-queue-item-guide-restore"]'); return el ? el.dataset.testid : null; })(),
          guideBtnDisabled: (() => { const el = document.querySelector('[data-testid="v4-queue-item-guide-${targetId}"]'); return el ? (el.disabled ?? el.getAttribute('aria-disabled')) : '(gone)'; })(),
          restoreBtn: (() => { const el = document.querySelector('[data-testid^="v4-queue-item-guide-restore"]'); if (el) return el.dataset.testid; const byText = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('恢复排队')); return byText ? 'byText:' + (byText.textContent || '').trim().slice(0, 20) : null; })(),
          guideTrace: (() => { const b = document.body.textContent || ''; return b.includes('正在引导对话') ? 'steering' : b.includes('等待引导当前任务') ? 'pending' : null; })(),
          toasts: [...document.querySelectorAll('[data-sonner-toast], [role="status"], [data-testid*="toast"]')].map(x => (x.textContent || '').trim().slice(0, 80)).slice(0, 3),
        }))()`).catch((e) => ({ err: String(e).slice(0, 100) }));
        diag.push(snap);
        if (!snap.still && (snap.restoreBtn || snap.guideTrace)) { gone = true; restoreSel = snap.restoreBtn ?? ('trace:' + snap.guideTrace); break; }
        await sleep(1000);
      }
      results.evidence.s5Diag = diag.filter((d, i) => i < 3 || !d.busy || d.restoreBtn || d.guideTrace || i === diag.length - 1).slice(0, 12);
      results.evidence.s5Console = await evalJs(cdp, `(() => (window.__capErr || []).filter(x => /setQueueItemDelivery|queue|Queue|reject|cas|revision/i.test(x)).slice(0, 10))()`).catch(() => null);
      results.evidence.s5ConsoleAll = await evalJs(cdp, `(() => (window.__capErr || []).slice(0, 10))()`).catch(() => null);
      log("S5 切guide后: gone=" + gone + " restore=" + restoreSel);
      // 点「恢复排队」
      let back = false;
      if (gone && restoreSel) {
        const clickRestore = await evalJs(cdp, `(() => { const btn = document.querySelector('[data-testid="${restoreSel}"]'); if (!btn) return { ok: false }; btn.click(); return { ok: true }; })()`).catch((e) => ({ ok: false, why: String(e).slice(0, 120) }));
        for (let i = 0; i < 20; i += 1) {
          const again = await evalJs(cdp, `Boolean(document.querySelector('[data-testid="v4-queue-item-${targetId}"]'))`).catch(() => false);
          const restoreGone = !(await evalJs(cdp, `Boolean(document.querySelector('[data-testid="${restoreSel}"]'))`).catch(() => false));
          if (again && restoreGone) { back = true; break; }
          await sleep(1500);
        }
        results.scenarios.S5_toggle_roundtrip = {
          status: gone && back ? "passed" : "failed",
          detail: { clickGuide, leftQueue: gone, restoreSel, clickRestore, backToQueue: back, stillBusyAtEnd: await isBusy() },
        };
      } else {
        results.scenarios.S5_toggle_roundtrip = { status: "failed", detail: { clickGuide, leftQueue: gone, note: "切 guide 后项未离开队列或未出现恢复排队按钮" } };
      }
    } else {
      results.scenarios.S5_toggle_roundtrip = { status: "blocked", detail: "S4 未通过" };
    }
    // 观察项：busy 结束后 guide/queue 项最终被消费（不强断言）
    let finalBusy = await isBusy();
    for (let i = 0; i < 20 && finalBusy; i += 1) { await sleep(3000); finalBusy = await isBusy(); }
    results.evidence.afterTurn = { busyEnded: !finalBusy, remainingQueue: await queueItemIds() };
  }
} else {
  results.scenarios.S4_queue_buttons = { status: "blocked", detail: "workspace 未打开" };
  results.scenarios.S5_toggle_roundtrip = { status: "blocked", detail: "workspace 未打开" };
}

// ---------- 清理 ----------
log("清理…");
try { execSync(`taskkill /PID ${dev.pid} /T /F`, { stdio: "ignore" }); } catch {}
await sleep(3000);
try { execSync('taskkill /IM electron.exe /F', { stdio: "ignore" }); } catch {}
try { fs.rmSync(cliConfigPath, { force: true }); } catch {}
if (configExistedBefore) { try { fs.copyFileSync(configBackup, cliConfigPath); fs.rmSync(configBackup, { force: true }); log("config.json 已还原"); } catch (e) { log("还原失败!", String(e).slice(0, 120)); } }
else { try { fs.rmSync(configBackup, { force: true }); } catch {} }
try { fs.rmSync(root, { recursive: true, force: true }); log("临时目录（含凭据副本）已删除"); } catch (e) { log("临时目录删除失败:", String(e).slice(0, 120)); }
cdp.close();
console.log("===E2E-RESULT===");
console.log(JSON.stringify(results, null, 2));
process.exit(0);
