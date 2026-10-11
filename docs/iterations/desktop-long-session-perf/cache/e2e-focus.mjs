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

const state = await send("Runtime.evaluate", {
  expression: `JSON.stringify({ visibility: document.visibilityState, hasFocus: document.hasFocus(), hidden: document.hidden })`,
  returnByValue: true,
});
console.log("state:", state.result.value);

await send("Page.bringToFront").catch((e) => console.log("bringToFront err:", e.message));
await sleep(1500);
const state2 = await send("Runtime.evaluate", {
  expression: `JSON.stringify({ visibility: document.visibilityState, hidden: document.hidden })`,
  returnByValue: true,
});
console.log("after bringToFront:", state2.result.value);

const a = await Promise.race([
  send("Runtime.evaluate", {
    expression: `new Promise((resolve) => { let t = 0; const tm = setInterval(() => { if (++t > 8) { clearInterval(tm); resolve("interval-ok"); } }, 250); })`,
    awaitPromise: true, returnByValue: true,
  }),
  sleep(6000).then(() => "TIMEOUT"),
]);
console.log("interval test:", JSON.stringify(a === "TIMEOUT" ? a : a?.result?.value));
ws.close();
process.exit(0);
