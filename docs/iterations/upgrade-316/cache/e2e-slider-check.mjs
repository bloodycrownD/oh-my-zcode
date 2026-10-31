// Radix dropdown 打开需要 pointerdown 序列；开菜单后查滑条
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

  const r1 = await evalJs(`(() => {
    const t = document.querySelector('[data-testid="chat-model-select-trigger"]');
    if (!t) return 'no-trigger';
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0 }));
    }
    return 'dispatched';
  })()`);
  await new Promise((r) => setTimeout(r, 1200));

  const ui = await evalJs(`(() => {
    const menu = document.querySelector('[role="menu"]');
    const slider = document.querySelectorAll('.composer-thought-slider, [data-testid="composer-thought-slider"]').length;
    const stops = document.querySelectorAll('.composer-thought-slider-stop').length;
    const menuText = menu ? (menu.textContent ?? '').slice(0, 260) : null;
    return { menuOpen: !!menu, slider, stops, menuText };
  })()`);
  console.log(r1, JSON.stringify(ui, null, 1));

  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'esc'`);
  ws.close();
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
