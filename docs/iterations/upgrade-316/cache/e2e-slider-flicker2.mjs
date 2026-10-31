// 连续拖动模拟：0→1→2 连发 input+change（模拟真实拖动跨档），观测回弹
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

  await evalJs(`(() => {
    const t = document.querySelector('[data-testid="chat-model-select-trigger"]');
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0 }));
    return 1;
  })()`);
  await new Promise((r) => setTimeout(r, 900));

  await evalJs(`(() => {
    window.__flicker = [];
    const slider = document.querySelector('[data-testid="composer-thought-slider"]');
    const wrap = slider?.closest('.composer-thought-slider');
    if (!slider) return 'no-slider';
    let last = '';
    window.__poll = setInterval(() => {
      const cur = JSON.stringify({ v: slider.value, d: wrap.getAttribute('data-disabled'), o: getComputedStyle(wrap).opacity,
        bubble: document.querySelectorAll('.composer-thought-bubble').length,
        menuOpen: !!document.querySelector('[role="menu"]') });
      if (cur !== last) { last = cur; window.__flicker.push({ t: Math.round(performance.now() % 100000), s: cur }); }
    }, 16);
    return 'observing';
  })()`);

  // 连续跨档拖动：0→1→2 快速连发（React 每次都上报宿主）
  const seq = await evalJs(`(async () => {
    const slider = document.querySelector('[data-testid="composer-thought-slider"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const fire = (v) => {
      setter.call(slider, String(v));
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    };
    fire(1); await new Promise(r => setTimeout(r, 60));
    fire(2); await new Promise(r => setTimeout(r, 60));
    fire(1); await new Promise(r => setTimeout(r, 60));
    return 'fired-1-2-1';
  })()`);
  console.log(seq);

  await new Promise((r) => setTimeout(r, 1800));
  const trace = await evalJs(`(() => { clearInterval(window.__poll); const t = window.__flicker ?? []; window.__flicker = []; return t; })()`);
  console.log("flicker trace:");
  for (const e of trace) console.log(` t=${e.t} ${e.s}`);

  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
  ws.close();
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
