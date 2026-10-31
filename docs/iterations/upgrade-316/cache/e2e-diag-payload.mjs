// 从 renderer 侧读取启动失败页的「复制诊断信息」内容
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

  // 点「复制诊断信息」按钮，然后读剪贴板不可行（权限），改为从 DOM/React 状态直接挖
  const diag = await evalJs(`(() => {
    const btns = [...document.querySelectorAll('button')].map(b => b.textContent?.trim());
    const root = document.querySelector('#root');
    // React fiber 里找诊断 payload
    const fiberKey = Object.keys(root ?? {}).find(k => k.startsWith('__reactFiber'));
    let payload = null;
    if (fiberKey && root) {
      let fiber = root[fiberKey];
      for (let i = 0; i < 40 && fiber; i++) {
        const s = fiber.memoizedState;
        const p = s?.memoizedState;
        if (p && typeof p === 'object' && (p.diagnostic || p.error || p.steps || p.progress)) { payload = p; break; }
        fiber = fiber.return;
      }
    }
    return { btns, payloadStr: JSON.stringify(payload)?.slice(0, 1500) };
  })()`);
  console.log("buttons:", JSON.stringify(diag.btns));
  console.log("payload:", diag.payloadStr);

  ws.close();
}

main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
