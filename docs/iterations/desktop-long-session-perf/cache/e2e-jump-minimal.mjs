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

// 先滚回中部，再点 0.4 处条目，观察回调。
await send("Runtime.evaluate", {
  expression: `(() => { const el = document.querySelector('[data-testid="v4-timeline"]'); el.scrollTop = el.scrollHeight / 2; return el.scrollTop; })()`,
  returnByValue: true,
});
await sleep(800);

const t0 = Date.now();
let settled = false;
const r = await Promise.race([
  send("Runtime.evaluate", {
    expression: `(() => new Promise((resolve) => {
      const el = document.querySelector('[data-testid="v4-timeline"]');
      const items = [...document.querySelectorAll('[data-testid^="v4-turn-navigator-item"]')];
      const before = el.scrollTop;
      items[Math.floor(items.length * 0.4)].click();
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        if (ticks > 10) { clearInterval(timer); resolve({ delta: el.scrollTop - before, ticks }); }
      }, 250);
    }))()`,
    awaitPromise: true,
    returnByValue: true,
  }).then((x) => { settled = true; return x; }),
  sleep(20000),
]);
console.log(JSON.stringify({ elapsedMs: Date.now() - t0, settled, value: settled ? r?.result?.value : "TIMEOUT-20s" }));
ws.close();
process.exit(0);
