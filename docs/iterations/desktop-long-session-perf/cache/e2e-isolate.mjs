const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch("http://127.0.0.1:9229/json/list")).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
};
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const race = (p, ms) => Promise.race([p, sleep(ms).then(() => "TIMEOUT")]);

// A) 纯 interval，无点击
const a = await race(send("Runtime.evaluate", {
  expression: `new Promise((resolve) => { let t = 0; const tm = setInterval(() => { if (++t > 8) { clearInterval(tm); resolve("interval-ok"); } }, 250); })`,
  awaitPromise: true, returnByValue: true,
}), 5000);
console.log("A interval-no-click:", JSON.stringify(a === "TIMEOUT" ? a : a?.result?.value));

// B) 点击但立即返回
const b = await race(send("Runtime.evaluate", {
  expression: `(() => { const items = [...document.querySelectorAll('[data-testid^="v4-turn-navigator-item"]')]; items[Math.floor(items.length * 0.6)]?.click(); return "click-returned"; })()`,
  returnByValue: true,
}), 5000);
console.log("B click-immediate:", JSON.stringify(b === "TIMEOUT" ? b : b?.result?.value));
await sleep(3000);

// C) 点击 + interval 组合
const c = await race(send("Runtime.evaluate", {
  expression: `(() => { const items = [...document.querySelectorAll('[data-testid^="v4-turn-navigator-item"]')]; items[Math.floor(items.length * 0.3)]?.click(); return new Promise((resolve) => { let t = 0; const tm = setInterval(() => { if (++t > 8) { clearInterval(tm); resolve("click-interval-ok"); } }, 250); }); })()`,
  awaitPromise: true, returnByValue: true,
}), 8000);
console.log("C click+interval:", JSON.stringify(c === "TIMEOUT" ? c : c?.result?.value));

ws.close();
process.exit(0);
