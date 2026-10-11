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

await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await evalSync(`(() => {
  window.__warns = [];
  const orig = console.warn.bind(console);
  console.warn = (...a) => { window.__warns.push(a.map((x) => String(x?.message ?? x).slice(0, 160)).join(" | ")); orig(...a); };
  return true;
})()`);
await sleep(1500);

const info = await evalSync(`(() => {
  const items = [...document.querySelectorAll('[data-testid^="v4-turn-navigator-item"]')];
  const btn = items[Math.floor(items.length * 0.4)];
  const el = document.querySelector('[data-testid="v4-timeline"]');
  const before = Math.round(el.scrollTop);
  btn.click();
  return { rowId: btn.dataset.queryRowId, unitIndex: btn.dataset.unitIndex, fallback: btn.dataset.directoryFallback, before };
})()`);
console.log("click:", JSON.stringify(info));
await sleep(2500);
const after = await evalSync(`(() => ({
  top: Math.round(document.querySelector('[data-testid="v4-timeline"]').scrollTop),
  warns: window.__warns,
  unitCount: document.querySelector('[data-testid="v4-timeline"]').getAttribute("data-render-unit-count"),
}))()`);
console.log("after:", JSON.stringify(after, null, 2));
ws.close();
process.exit(0);
