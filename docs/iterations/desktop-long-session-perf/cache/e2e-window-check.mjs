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

const r = await send("Runtime.evaluate", {
  expression: `(() => {
    const el = document.querySelector('[data-testid="v4-timeline"]');
    const nav = document.querySelector('[data-testid="v4-turn-navigator"]');
    return {
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      jumpLoading: el?.getAttribute("data-jump-loading"),
      loadingOlder: el?.getAttribute("data-loading-older"),
      scrollTop: Math.round(el?.scrollTop ?? -1),
      navWidth: nav?.getBoundingClientRect().width ?? -1,
      navVisible: nav ? getComputedStyle(nav).visibility : "n/a",
    };
  })()`,
  returnByValue: true,
});
console.log(JSON.stringify(r.result.value));
ws.close();
process.exit(0);
