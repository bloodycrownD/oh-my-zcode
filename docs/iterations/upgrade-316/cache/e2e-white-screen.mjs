// 白屏诊断：抓 renderer console 错误 + React 挂载状态
const WS_URL = "http://127.0.0.1:9229/json/list";

async function main() {
  const pages = await (await fetch(WS_URL)).json();
  const page = pages.find((p) => p.type === "page" && /localhost:5174/.test(p.url)) ?? pages[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Runtime.consoleAPICalled" || m.method === "Runtime.exceptionThrown") events.push(m.params);
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send("Runtime.enable");
  // 刷新页面触发重新加载，收集启动期 console
  await send("Page.enable");
  await send("Page.reload", { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 12000));

  const errors = events.filter((e) => e.type === "error" || e.exceptionDetails);
  console.log("console events:", events.length, " errors:", errors.length);
  for (const e of errors.slice(0, 6)) {
    const detail = e.exceptionDetails
      ? (e.exceptionDetails.exception?.description ?? e.exceptionDetails.text)
      : (e.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
    console.log("ERR:", String(detail).slice(0, 300).replace(/\n/g, " | "));
  }

  const r = await send("Runtime.evaluate", {
    expression: `(() => ({
      rootChildren: document.querySelector('#root')?.children?.length ?? -1,
      textLen: (document.querySelector('#root')?.innerText ?? '').length,
      textHead: (document.querySelector('#root')?.innerText ?? '').slice(0, 120),
    }))()`,
    returnByValue: true,
  });
  console.log("after reload:", JSON.stringify(r.result?.result?.value));

  ws.close();
}

main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
