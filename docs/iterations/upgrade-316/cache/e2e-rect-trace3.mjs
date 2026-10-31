// 闪帧全面 dump：菜单文本 / stops / aria / menu rect / trigger rect 同步采样
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

  await evalJs(`(() => {
    window.__snap = [];
    window.__raf = setInterval(() => {
      const wrap = document.querySelector('.composer-thought-slider');
      const input = document.querySelector('[data-testid="composer-thought-slider"]');
      const menu = document.querySelector('[role="menu"]');
      const trig = document.querySelector('[data-testid="chat-model-select-trigger"]');
      if (!wrap || !input) return;
      const mr = menu?.getBoundingClientRect(); const tr = trig?.getBoundingClientRect(); const wr = wrap.getBoundingClientRect();
      window.__snap.push({
        t: Math.round(performance.now() % 1000000),
        d: wrap.getAttribute('data-disabled'),
        o: getComputedStyle(wrap).opacity,
        wx: Math.round(wr.x), mx: mr ? Math.round(mr.x) : null, mw: mr ? Math.round(mr.width) : null,
        tx: tr ? Math.round(tr.x) : null, tw: tr ? Math.round(tr.width) : null,
        stops: document.querySelectorAll('[data-composer-thought-stop]').length,
        filled: document.querySelectorAll('[data-composer-thought-stop][data-filled="true"]').length,
        ariaD: input.getAttribute('aria-disabled'),
        vt: input.getAttribute('aria-valuetext'),
        levels: input.getAttribute('data-levels'),
        menuText: (menu?.textContent ?? '').slice(0, 40),
      });
    }, 16);
    return 'sampling';
  })()`);

  await evalJs(`(async () => {
    const input = document.querySelector('[data-testid="composer-thought-slider"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const fire = (v) => {
      setter.call(input, String(v));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    fire(2); await new Promise(r => setTimeout(r, 150));
    return 'fired-2';
  })()`).then(r => console.log(r));

  await new Promise((r) => setTimeout(r, 1200));
  const trace = await evalJs(`(() => { clearInterval(window.__raf); const t = window.__snap ?? []; window.__snap = []; return t; })()`);

  let prev = null;
  for (const e of trace) {
    const cur = JSON.stringify(e);
    if (cur !== prev) {
      console.log(`t=${e.t} d=${e.d} o=${e.o} wx=${e.wx} menu(${e.mx},w${e.mw}) trig(${e.tx},w${e.tw}) stops=${e.stops}/${e.filled} ariaD=${e.ariaD} vt=${e.vt} levels=${e.levels}`);
      console.log(`   text="${e.menuText}"`);
      prev = cur;
    }
  }
  console.log(`frames=${trace.length}`);

  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
  ws.close();
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
