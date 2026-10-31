// 打开模型菜单，查滑条形态是否渲染
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

  // 1. 点开模型菜单
  const opened = await evalJs(`(() => {
    const t = document.querySelector('[data-testid="chat-model-select-trigger"]');
    if (!t) return 'no-trigger';
    t.click();
    return 'clicked';
  })()`);
  await new Promise((r) => setTimeout(r, 900));

  // 2. 查滑条与菜单内思考等级区块
  const ui = await evalJs(`(() => {
    const slider = document.querySelectorAll('.composer-thought-slider, [class*="composer-thought-slider"]').length;
    const meter = document.querySelectorAll('[class*="composer-thought-meter"]').length;
    const dialogs = [...document.querySelectorAll('[role="dialog"], [role="listbox"], [data-radix-popper-content-wrapper]')].map(d => ({
      cls: (d.className ?? '').toString().slice(0, 60),
      text: (d.textContent ?? '').slice(0, 150),
    }));
    return { slider, meter, dialogs: dialogs.slice(0, 3) };
  })()`);
  console.log(opened, JSON.stringify(ui, null, 1));

  // 3. 关掉
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'esc'`);
  ws.close();
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
