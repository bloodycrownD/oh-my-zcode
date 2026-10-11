const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Browser 域要求连 browser 级 ws（/json/version 里的 webSocketDebuggerUrl）。
const version = await (await fetch("http://127.0.0.1:9229/json/version")).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
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

const list0 = await (await fetch("http://127.0.0.1:9229/json/list")).json();
const page0 = list0.find((t) => t.type === "page");
const targetInfo = await send("Browser.getWindowForTarget", page0?.targetId ? { targetId: page0.targetId } : {}).catch((e) => {
  console.error("getWindowForTarget err:", e.message);
  return null;
});
if (!targetInfo) process.exit(1);
const windowId = targetInfo.windowId;
const before = await send("Browser.getWindowBounds", { windowId });
console.log("bounds before:", JSON.stringify(before.bounds));
if (before.bounds.windowState && before.bounds.windowState !== "normal") {
  await send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  await sleep(500);
}
// 即便已是 normal，再显式 set 一次并前置窗口。
await send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal", left: 60, top: 60, width: 1280, height: 900 } }).catch((e) => console.log("set err:", e.message));
await sleep(800);
const afterB = await send("Browser.getWindowBounds", { windowId });
console.log("bounds after:", JSON.stringify(afterB.bounds));

// 用页面级连接确认 visibilityState。
const list = await (await fetch("http://127.0.0.1:9229/json/list")).json();
const page = list.find((t) => t.type === "page");
const pws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (pws.onopen = r));
pws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "document.visibilityState", returnByValue: true } }));
pws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id === 1) { console.log("visibility:", m.result.result.value); pws.close(); ws.close(); process.exit(0); }
};
