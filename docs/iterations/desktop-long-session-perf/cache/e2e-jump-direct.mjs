const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch("http://127.0.0.1:9229/json/list")).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
});
const evalSync = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true });
  return r.result.value;
};

// 直接 el.click()（绕过 hit-test 合成），驱动侧轮询位移与 loading。
// 隐藏窗口下 rAF 挂起：同会话设置 prefers-reduced-motion 让 smooth 退化为 auto。
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
console.log("reduced-motion:", await evalSync(`window.matchMedia("(prefers-reduced-motion: reduce)").matches`));
await evalSync(`(() => { const el = document.querySelector('[data-testid="v4-timeline"]'); el.scrollTop = Math.floor(el.scrollHeight / 2); return true; })()`);
await sleep(500);
// 等 usePrefersReducedMotion 的 matchMedia listener 捕捉到仿真变化并触发重渲染。
await sleep(1500);
const before = await evalSync(`Math.round(document.querySelector('[data-testid="v4-timeline"]').scrollTop)`);
const clicked = await evalSync(`(() => {
  const items = [...document.querySelectorAll('[data-testid^="v4-turn-navigator-item"]')];
  const btn = items[Math.floor(items.length * 0.4)];
  if (!btn) return "none";
  btn.click();
  return btn.dataset.queryRowId ?? "?";
})()`);
console.log("clicked item queryRowId:", clicked, "before:", before);

const t0 = Date.now();
let last = null;
while (Date.now() - t0 < 20000) {
  last = await evalSync(`(() => { const el = document.querySelector('[data-testid="v4-timeline"]');
    return { top: Math.round(el.scrollTop), loading: el.getAttribute("data-jump-loading"), rows: el.getAttribute("data-window-row-count") }; })()`);
  if (Math.abs(last.top - before) > 200 && last.loading === "false") break;
  await sleep(500);
}
const moved = Math.abs(last.top - before) > 200;
console.log(moved ? "JUMP OK" : "JUMP NO-MOVE", JSON.stringify({ before, ...last, ms: Date.now() - t0 }));
ws.close();
process.exit(moved ? 0 : 1);
