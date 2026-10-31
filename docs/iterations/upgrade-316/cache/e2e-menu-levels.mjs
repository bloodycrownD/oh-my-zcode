// 从菜单 fiber 挖 ComposerModelMenu 的 options.levels 实际值
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

  // 打开模型菜单
  await evalJs(`(() => {
    const t = document.querySelector('[data-testid="chat-model-select-trigger"]');
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0 }));
    return 1;
  })()`);
  await new Promise((r) => setTimeout(r, 1000));

  const info = await evalJs(`(() => {
    // ComposerModelMenu 渲染的内容挂载在 portal 里；从 DOM 向上找 fiber
    const menu = document.querySelector('[role="menu"]');
    if (!menu) return { menu: false };
    const key = Object.keys(menu).find(k => k.startsWith('__reactFiber'));
    let fiber = menu[key];
    for (let i = 0; i < 40 && fiber; i++) {
      const n = typeof fiber.type === 'function' ? (fiber.type.displayName ?? fiber.type.name) : '';
      if (n === 'ComposerModelMenu') {
        const p = fiber.memoizedProps ?? {};
        const o = p.options ?? {};
        return { menu: true, at: n, optionKeys: Object.keys(o), levels: o.levels, value: o.value, effortLabel: o.effortLabel ?? null };
      }
      fiber = fiber.return;
    }
    return { menu: true, at: 'not-found' };
  })()`);
  console.log(JSON.stringify(info, null, 1));

  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
  ws.close();
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
