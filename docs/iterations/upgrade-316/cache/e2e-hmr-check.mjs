// 1) 验证 HMR 是否生效（源码里搜冻结逻辑特征字符串） 2) 装尺寸采样日志观测抖动
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

  // HMR 生效验证：vite 模块源里搜冻结注释特征
  const hmr = await evalJs(`(async () => {
    const mod = await import('/src/v4/composer/V4ComposerToolbar.tsx?t=' + Date.now());
    const src = await (await fetch('/src/v4/composer/V4ComposerToolbar.tsx?t=' + Date.now())).text();
    return { hasFreeze: src.includes('composerOptionsRef'), srcLen: src.length };
  })()`);
  console.log("HMR check:", JSON.stringify(hmr));

  ws.close();
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
