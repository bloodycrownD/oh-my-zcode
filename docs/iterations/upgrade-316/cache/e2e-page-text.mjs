const WS_URL = "http://127.0.0.1:9229/json/list";
async function main() {
  const pages = await (await fetch(WS_URL)).json();
  const page = pages.find((p) => p.type === "page" && /localhost:5174/.test(p.url)) ?? pages[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let msgId = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((resolve) => { const id = ++msgId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

  const t = await evalJs(`(() => {
    const r = document.querySelector('#root');
    return { text: (r?.innerText ?? '').slice(0, 200), testids: [...document.querySelectorAll('[data-testid]')].slice(0, 10).map(e => e.getAttribute('data-testid')) };
  })()`);
  console.log(JSON.stringify(t, null, 1));
  ws.close();
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
