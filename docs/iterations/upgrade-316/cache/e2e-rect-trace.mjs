// 刷新页面（拉最新模块）→ 开菜单 → 装 rect 采样 → 模拟拖动 → 输出抖动序列
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

  const opened = await evalJs(`(() => {
    const t = document.querySelector('[data-testid="chat-model-select-trigger"]');
    if (!t) return 'no-trigger';
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0 }));
    return 'opened';
  })()`);
  console.log(opened);
  await new Promise((r) => setTimeout(r, 1000));

  // 装采样：rAF 每帧记录滑条容器 rect + input value + opacity + 菜单 rect
  await evalJs(`(() => {
    window.__rect = [];
    const wrap = document.querySelector('.composer-thought-slider');
    const input = document.querySelector('[data-testid="composer-thought-slider"]');
    const menu = document.querySelector('[role="menu"]');
    if (!wrap || !input) return 'no-slider';
    const sample = () => {
      const w = wrap.getBoundingClientRect(), m = menu?.getBoundingClientRect();
      window.__rect.push({
        t: Math.round(performance.now() % 1000000),
        v: input.value,
        x: Math.round(w.x * 10) / 10, y: Math.round(w.y * 10) / 10,
        w: Math.round(w.width * 10) / 10, h: Math.round(w.height * 10) / 10,
        o: getComputedStyle(wrap).opacity,
        menuH: m ? Math.round(m.height * 10) / 10 : null,
      });
    };
    window.__raf = setInterval(sample, 16);
    return 'sampling';
  })()`);

  // 模拟真实拖动序列（含 pointer 事件，让 hoveredStop 等路径也跑）
  const fired = await evalJs(`(async () => {
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
  })()`);
  console.log(fired);

  await new Promise((r) => setTimeout(r, 1500));
  const trace = await evalJs(`(() => { clearInterval(window.__raf); const t = window.__rect ?? []; window.__rect = []; return t; })()`);

  // 输出：只打印发生变化的帧（相对上一帧 diff）
  let prev = null;
  let changes = 0;
  for (const e of trace) {
    const cur = JSON.stringify({ v: e.v, x: e.x, y: e.y, w: e.w, h: e.h, o: e.o, menuH: e.menuH });
    if (cur !== prev) {
      console.log(`t=${e.t} v=${e.v} rect=${e.w}x${e.h}@(${e.x},${e.y}) op=${e.o} menuH=${e.menuH}`);
      prev = cur; changes++;
    }
  }
  console.log(`frames=${trace.length} distinct-states=${changes}`);

  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
  ws.close();
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
