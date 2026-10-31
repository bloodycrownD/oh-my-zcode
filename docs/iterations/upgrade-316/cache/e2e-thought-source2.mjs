// 沿 fiber 找 _debugSource（遍历所有 fiber 节点的 type 与 _debugInfo）
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

  const info = await evalJs(`(() => {
    const btn = document.querySelector('[data-testid="chat-thought-level-select-trigger"]');
    if (!btn) return { found: false };
    const key = Object.keys(btn).find(k => k.startsWith('__reactFiber'));
    let fiber = btn[key];
    const names = [];
    for (let i = 0; i < 60 && fiber; i++) {
      const t = fiber.type;
      const n = typeof t === 'function' ? (t.displayName ?? t.name ?? '') : (typeof t === 'string' ? t : '');
      const src = t?._debugSource?.fileName ?? t?._debugInfo?.find?.(x => x?.name === 'SOURCE_FILE')?.value ?? null;
      if (n && !n.startsWith('Primitive')) names.push({ n, src });
      fiber = fiber.return;
    }
    // 去重
    const seen = new Set(); const out = [];
    for (const e of names) { const k = e.n + '|' + e.src; if (!seen.has(k)) { seen.add(k); out.push(e); } }
    return out.slice(0, 20);
  })()`);
  console.log(JSON.stringify(info, null, 1));
  ws.close();
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
