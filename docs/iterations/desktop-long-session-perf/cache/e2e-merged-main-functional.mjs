// 合并后 main 的 Electron 功能 E2E —— 全部驱动侧轮询（同步 evaluate），
// 不依赖页内定时器（隐藏窗口下 Chromium 会节流页面 timer）。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch("http://127.0.0.1:9229/json/list")).json();
const page = list.find((t) => t.type === "page");

const cdp = await new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onopen = () => resolve({ ws, consoleErrors, send(method, params = {}) {
    const id = ++seq;
    return new Promise((res, rej) => {
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  } });
  ws.onerror = () => reject(new Error("CDP ws 连接失败"));
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push(msg.params.args?.map((a) => a.value ?? a.description ?? "").join(" "));
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push("exception: " + (msg.params.exceptionDetails?.text ?? ""));
    }
  };
});

async function syncEval(expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 250));
  return r.result.value;
}
async function poll(expression, check, label, timeoutMs = 8000, intervalMs = 400) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await syncEval(expression);
    if (check(last)) return { ok: true, value: last, ms: Date.now() - t0 };
    await sleep(intervalMs);
  }
  return { ok: false, value: last, ms: Date.now() - t0 };
}

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail: detail ?? "" });
  console.log(`${pass ? "PASS" : "FAIL"} | ${name} | ${detail ?? ""}`);
};

await cdp.send("Runtime.enable").catch(() => {});
// 隐藏窗口下 rAF 挂起：smooth 滚动永远不动。模拟 prefers-reduced-motion 让组件走 auto。
await cdp.send("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: "reduce" }],
}).catch(() => {});

// 0) 会话快照
const session = await syncEval(`(() => {
  const el = document.querySelector('[data-testid="v4-timeline"]');
  const nav = document.querySelector('[data-testid="v4-turn-navigator"]');
  return { rows: Number(el?.getAttribute("data-window-row-count")), total: Number(el?.getAttribute("data-total-row-count")),
    items: nav ? Number(nav.getAttribute("data-item-count")) : 0, busy: nav?.getAttribute("aria-busy") };
})()`);
record("长会话已加载（rows >= 40）", session.rows >= 40, `rows=${session.rows} total=${session.total}`);
record("turn rail 合并条目 >= 2", session.items >= 2, `items=${session.items} aria-busy=${session.busy}`);

// 1) hover：真实鼠标事件（Input 域）+ 驱动侧轮询 tooltip（隐藏窗口钳制定时器，放宽到 8s）。
const box = await syncEval(`(() => {
  const btn = document.querySelector('[data-testid^="v4-turn-navigator-item"]');
  if (!btn) return null; const r = btn.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
let hoverOk = false;
let hoverDetail = "无 rail item";
if (box) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, button: "none", pointerType: "mouse" }).catch(() => {});
  const hp = await poll(`(() => {
    const tip = document.querySelector('[data-testid^="v4-turn-navigator-tooltip"]');
    return { present: Boolean(tip), chars: (tip?.textContent ?? "").trim().length };
  })()`, (v) => v.present && v.chars > 0, "hover", 9000, 500);
  hoverOk = hp.ok;
  hoverDetail = JSON.stringify(hp.value) + ` ${hp.ms}ms`;
}
record("rail hover 出现摘要 tooltip", hoverOk, hoverDetail);
// 移开鼠标，避免 tooltip 干扰后续点击。
await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 600, y: 400, button: "none", pointerType: "mouse" }).catch(() => {});

// 2) 跳转：先滚回中部，Input 域真实点击 0.4 处条目，驱动侧轮询位移 + loading 收敛。
await syncEval(`(() => { const el = document.querySelector('[data-testid="v4-timeline"]'); el.scrollTop = Math.floor(el.scrollHeight / 2); return true; })()`);
await sleep(600);
const before = await syncEval(`Math.round(document.querySelector('[data-testid="v4-timeline"]').scrollTop)`);
const jumpTarget = await syncEval(`(() => {
  const items = [...document.querySelectorAll('[data-testid^="v4-turn-navigator-item"]')];
  const btn = items[Math.floor(items.length * 0.4)];
  if (!btn) return null; const r = btn.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), count: items.length };
})()`);
let jumpOk = false;
let jumpDetail = "无条目";
if (jumpTarget) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: jumpTarget.x, y: jumpTarget.y, button: "none", pointerType: "mouse" }).catch(() => {});
  await sleep(150);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: jumpTarget.x, y: jumpTarget.y, button: "left", clicks: 1, pointerType: "mouse" }).catch(() => {});
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: jumpTarget.x, y: jumpTarget.y, button: "left", clicks: 1, pointerType: "mouse" }).catch(() => {});
  const jp = await poll(`(() => { const el = document.querySelector('[data-testid="v4-timeline"]');
    return { top: Math.round(el.scrollTop), loading: el.getAttribute("data-jump-loading") }; })()`,
    (v) => Math.abs(v.top - before) > 200 && v.loading === "false", "jump", 25000, 500);
  jumpOk = jp.ok;
  jumpDetail = `before=${before} after=${JSON.stringify(jp.value)} ${jp.ms}ms items=${jumpTarget.count}`;
}
record("rail 跳转产生位移且 loading 收敛", jumpOk, jumpDetail);

// 3) 上滚分页：滚到顶，轮询窗口行数增长。
const rowsBefore = (await syncEval(`Number(document.querySelector('[data-testid="v4-timeline"]').getAttribute("data-window-row-count"))`));
await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 600, y: 400, deltaX: 0, deltaY: -3000 }).catch(() => {});
await syncEval(`(() => { const el = document.querySelector('[data-testid="v4-timeline"]'); el.scrollTo({ top: 0 }); return true; })()`);
const pp = await poll(`Number(document.querySelector('[data-testid="v4-timeline"]').getAttribute("data-window-row-count"))`,
  (v) => v > rowsBefore, "paging", 20000, 600);
record("上滚触发历史分页（窗口行数增长）", pp.ok, `before=${rowsBefore} after=${pp.value} ${pp.ms}ms`);

// 4) 分享域下线冒烟。
const share = await syncEval(`[...document.querySelectorAll("button")].filter((b) => /分享|share/i.test(b.textContent ?? "") || /share/i.test(b.dataset.testid ?? "")).length`);
record("分享发布入口已下线（正文无分享按钮）", share === 0, `matches=${share}`);

// 5) console 零异常。
record("console 零异常", cdp.consoleErrors.length === 0,
  cdp.consoleErrors.length === 0 ? "" : JSON.stringify(cdp.consoleErrors.slice(0, 5)));

const failed = results.filter((r) => !r.pass);
console.log("SUMMARY " + JSON.stringify({ total: results.length, failed: failed.length }));
cdp.ws.close();
process.exit(failed.length === 0 ? 0 : 1);
