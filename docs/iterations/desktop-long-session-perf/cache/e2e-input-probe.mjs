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

await evalSync(`(() => { window.__probe = { clicks: 0, downs: 0, targets: [] };
  document.addEventListener('pointerdown', () => window.__probe.downs++, true);
  document.addEventListener('click', (e) => { window.__probe.clicks++; window.__probe.targets.push(e.target.tagName + ':' + (e.target.dataset.testid ?? '')); }, true);
  return true; })()`);

const box = await evalSync(`(() => {
  const items = [...document.querySelectorAll('[data-testid^="v4-turn-navigator-item"]')];
  const btn = items[Math.floor(items.length * 0.4)];
  const r = btn.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height, vis: getComputedStyle(btn).visibility, pe: getComputedStyle(btn).pointerEvents };
})()`);
console.log("item box:", JSON.stringify(box));

await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, button: "none", pointerType: "mouse" });
await sleep(120);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clicks: 1, pointerType: "mouse" });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clicks: 1, pointerType: "mouse" });
await sleep(600);
console.log("probe:", JSON.stringify(await evalSync("JSON.stringify(window.__probe)")));
console.log("scrollTop:", await evalSync(`Math.round(document.querySelector('[data-testid="v4-timeline"]').scrollTop)`));
ws.close();
process.exit(0);
