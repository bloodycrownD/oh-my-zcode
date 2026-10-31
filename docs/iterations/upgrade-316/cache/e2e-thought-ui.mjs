// 查运行中 app 的思考等级 UI 现状
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

  const ui = await evalJs(`(() => {
    const slider = document.querySelectorAll('.composer-thought-slider, [class*="thought-slider"]').length;
    const meter = document.querySelectorAll('[class*="thought-meter"]').length;
    const cycle = document.querySelectorAll('[data-testid*="thought"], [class*="ThoughtLevel"]').length;
    // 聊天输入区附近的所有按钮文案，找思考等级入口
    const toolbar = document.querySelector('[class*="omposer"], [class*="toolbar"]');
    const btns = toolbar ? [...toolbar.querySelectorAll('button')].map(b => (b.textContent ?? '').trim() + '|' + (b.getAttribute('data-testid') ?? '')).filter(t => t !== '|') : [];
    return { slider, meter, cycle, toolbarBtns: btns.slice(0, 24) };
  })()`);
  console.log(JSON.stringify(ui, null, 1));
  ws.close();
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
