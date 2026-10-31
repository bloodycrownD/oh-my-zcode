// 打开菜单 → 点进「智谱」分组 → 查滑条
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

  // 开菜单
  await evalJs(`(() => {
    const t = document.querySelector('[data-testid="chat-model-select-trigger"]');
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0 }));
    return 1;
  })()`);
  await new Promise((r) => setTimeout(r, 900));

  // 点「智谱」分组
  const clicked = await evalJs(`(() => {
    const menu = document.querySelector('[role="menu"]');
    if (!menu) return 'no-menu';
    const items = [...menu.querySelectorAll('[role="menuitem"], [data-radix-collection-item]')];
    const zhipu = items.find(i => (i.textContent ?? '').includes('智谱'));
    if (!zhipu) return 'no-zhipu:' + items.map(i => (i.textContent ?? '').trim()).slice(0, 6).join('/');
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) zhipu.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0 }));
    return 'clicked-zhipu';
  })()`);
  await new Promise((r) => setTimeout(r, 900));

  const ui = await evalJs(`(() => {
    const slider = document.querySelectorAll('.composer-thought-slider, [data-testid="composer-thought-slider"]').length;
    const stops = document.querySelectorAll('.composer-thought-slider-stop').length;
    const thumb = document.querySelectorAll('.composer-thought-slider-thumb').length;
    const menu = document.querySelector('[role="menu"]');
    const labels = [...document.querySelectorAll('.composer-thought-slider-stop, [class*="composer-thought"]')].slice(0, 10).map(e => e.className.toString().slice(0, 50));
    return { slider, stops, thumb, menuText: menu ? (menu.textContent ?? '').slice(0, 300) : null, labels };
  })()`);
  console.log(clicked, JSON.stringify(ui, null, 1));

  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
  ws.close();
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
