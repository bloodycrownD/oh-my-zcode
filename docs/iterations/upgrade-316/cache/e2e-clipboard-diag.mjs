// 深挖启动失败页的诊断信息：点击「复制诊断信息」并截获写入剪贴板的文本
const WS_URL = "http://127.0.0.1:9229/json/list";

async function main() {
  const pages = await (await fetch(WS_URL)).json();
  const page = pages.find((p) => p.type === "page" && /localhost:5174/.test(p.url)) ?? pages[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };

  // 劫持剪贴板写入，再点按钮
  const clip = await evalJs(`(() => {
    window.__clip = [];
    const orig = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (orig) navigator.clipboard.writeText = (t) => { window.__clip.push(t); return orig(t); };
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('复制诊断信息'));
    btn?.click();
    return 'clicked';
  })()`);
  await new Promise((r) => setTimeout(r, 1500));
  const text = await evalJs(`window.__clip?.[0] ?? '(no clipboard capture)'`);
  console.log(clip, "->");
  console.log(String(text).slice(0, 3000));

  ws.close();
}

main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
