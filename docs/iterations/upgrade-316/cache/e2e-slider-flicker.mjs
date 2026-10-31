// 观测调档时滑条 value/data-disabled 的抖动序列：装 observer → 程序化调档 → 收集变化
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

  // 装 observer 监听滑条容器属性变化 + input value 变化
  await evalJs(`(() => {
    window.__flicker = [];
    const slider = document.querySelector('[data-testid="composer-thought-slider"]');
    const wrap = slider?.closest('.composer-thought-slider');
    if (!slider || !wrap) return 'no-slider';
    const log = (what) => window.__flicker.push({ t: Math.round(performance.now() % 100000), what,
      value: slider.value, disabled: wrap.getAttribute('data-disabled'), opacity: getComputedStyle(wrap).opacity });
    const mo = new MutationObserver(() => log('attr'));
    mo.observe(wrap, { attributes: true, attributeFilter: ['data-disabled', 'class', 'style'] });
    const mo2 = new MutationObserver(() => log('value-prop'));
    mo2.observe(slider, { attributes: true, attributeFilter: ['value', 'aria-disabled', 'data-levels'] });
    // 受控 input 的 value 由 React 直接设 property——轮询采样兜底
    let last = slider.value + '|' + wrap.getAttribute('data-disabled');
    window.__poll = setInterval(() => {
      const cur = slider.value + '|' + wrap.getAttribute('data-disabled') + '|' + getComputedStyle(wrap).opacity;
      if (cur !== last) { last = cur; log('poll'); }
    }, 30);
    return 'observing';
  })()`);

  // 程序化调档：input 设 value=1（高）并派发 change（React onChange 走原生 setter）
  const changed = await evalJs(`(() => {
    const slider = document.querySelector('[data-testid="composer-thought-slider"]');
    if (!slider) return 'no-slider';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(slider, '1');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    return 'changed-to-1';
  })()`);
  console.log(changed);

  // 收 1.5 秒内的抖动序列
  await new Promise((r) => setTimeout(r, 1500));
  const trace = await evalJs(`(() => { clearInterval(window.__poll); const t = window.__flicker ?? []; window.__flicker = []; return t; })()`);
  console.log("flicker trace:");
  for (const e of trace) console.log(` t=${e.t} ${e.what} value=${e.value} disabled=${e.disabled} opacity=${e.opacity}`);

  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
  ws.close();
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
