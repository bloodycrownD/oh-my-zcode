// 查运行时模型注册表是否声明了 reasoningLevel（滑条的数据前提）
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
    // 从 ThoughtLevelCycleControl 的 fiber 里挖 props（含 thoughtOption / levels）
    const btn = document.querySelector('[data-testid="chat-thought-level-select-trigger"]');
    if (!btn) return { found: false };
    const key = Object.keys(btn).find(k => k.startsWith('__reactFiber'));
    let fiber = btn[key];
    for (let i = 0; i < 30 && fiber; i++) {
      const n = fiber.type?.displayName ?? '';
      if (n === 'ThoughtLevelCycleControl' || n === 'V4ComposerModelControlsImpl') {
        const p = fiber.memoizedProps ?? {};
        const opt = p.thoughtOption ?? p.option ?? p.thoughtLevels ?? null;
        return {
          found: true, at: n,
          propKeys: Object.keys(p).slice(0, 15),
          option: opt ? { id: opt.id, values: opt.options?.map?.(o => o.value) } : null,
          levelsCount: Array.isArray(opt) ? opt.length : (p.levels?.length ?? p.thoughtLevels?.length ?? null),
        };
      }
      fiber = fiber.return;
    }
    return { found: true, at: 'not-found' };
  })()`);
  console.log(JSON.stringify(info, null, 1));
  ws.close();
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
