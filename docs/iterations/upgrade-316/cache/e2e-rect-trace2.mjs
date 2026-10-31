// 采样所有 composer-thought* 元素（区分菜单内滑条 vs 工具栏 trigger 指示器）
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

  await send("Page.enable");
  await send("Page.reload", { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 9000));

  await evalJs(`(() => {
    const t = document.querySelector('[data-testid="chat-model-select-trigger"]');
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0 }));
    return 1;
  })()`);
  await new Promise((r) => setTimeout(r, 1000));

  // 全量采样：每个 .composer-thought-slider 的 rect/opacity/disabled + 是否在菜单内
  await evalJs(`(() => {
    window.__rect = [];
    window.__raf = setInterval(() => {
      const all = [...document.querySelectorAll('.composer-thought-slider')];
      const menu = document.querySelector('[role="menu"]');
      const m = menu?.getBoundingClientRect();
      window.__rect.push({
        t: Math.round(performance.now() % 1000000),
        menuH: m ? Math.round(m.height * 10) / 10 : null,
        items: all.map(el => {
          const r = el.getBoundingClientRect();
          const inMenu = !!el.closest('[role="menu"]');
          return { inMenu, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width),
            d: el.getAttribute('data-disabled'), o: getComputedStyle(el).opacity,
            cls: el.className.toString().split(' ')[0] };
        }),
      });
    }, 16);
    return 'sampling:' + document.querySelectorAll('.composer-thought-slider').length;
  })()`).then(r => console.log("setup:", r));

  await evalJs(`(async () => {
    const input = document.querySelector('[data-testid="composer-thought-slider"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const fire = (v) => {
      setter.call(input, String(v));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    fire(2); await new Promise(r => setTimeout(r, 120));
    fire(0); await new Promise(r => setTimeout(r, 120));
    fire(2); await new Promise(r => setTimeout(r, 120));
    return 'fired-2-0-2';
  })()`).then(r => console.log(r));

  await new Promise((r) => setTimeout(r, 1200));
  const trace = await evalJs(`(() => { clearInterval(window.__raf); const t = window.__rect ?? []; window.__rect = []; return t; })()`);

  let prev = null;
  for (const e of trace) {
    const cur = JSON.stringify({ menuH: e.menuH, items: e.items });
    if (cur !== prev) {
      const parts = e.items.map(i => `${i.inMenu ? 'MENU' : 'TRIG'}(${i.x},${i.y},${i.w}x${i.h}) d=${i.d} o=${i.o}`);
      console.log(`t=${e.t} menuH=${e.menuH} | ${parts.join(' | ')}`);
      prev = cur;
    }
  }
  console.log(`frames=${trace.length}`);

  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
  ws.close();
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
