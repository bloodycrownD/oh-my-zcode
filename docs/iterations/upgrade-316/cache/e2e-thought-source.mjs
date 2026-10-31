// 从运行中的按钮挖 React 组件名与来源模块
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
    const chain = [];
    for (let i = 0; i < 14 && fiber; i++) {
      const name = fiber.type?.displayName ?? fiber.type?.name ?? (typeof fiber.type === 'string' ? fiber.type : '');
      if (name) chain.push(name);
      fiber = fiber.return;
    }
    // _debugSource 指向编译进 bundle 的文件路径
    let src = null;
    fiber = btn[key];
    for (let i = 0; i < 30 && fiber; i++) {
      if (fiber.type?._debugSource) { src = fiber.type._debugSource; break; }
      if (fiber.memoizedProps?.['__data-source']) { src = fiber.memoizedProps['__data-source']; break; }
      fiber = fiber.return;
    }
    return { found: true, chain, fileName: src?.fileName ?? null };
  })()`);
  console.log(JSON.stringify(info, null, 1));
  ws.close();
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
