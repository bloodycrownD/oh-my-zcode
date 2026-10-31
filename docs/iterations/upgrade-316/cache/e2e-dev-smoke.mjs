// dev 真机四项验证 · 第一步：应用基本状态 + 冷开性能 + 时间线渲染
// CDP over WebSocket，复用既往 e2e 手法（Input.dispatchMouseEvent 对本 app 无效，用 element.click()）
const WS_URL = "http://127.0.0.1:9229/json/list";

async function main() {
  const pages = await (await fetch(WS_URL)).json();
  const page = pages.find((p) => p.type === "page" && /localhost:5174/.test(p.url)) ?? pages[0];
  console.log("target:", page?.url?.slice(0, 80));

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

  // 1. 基本状态
  const basic = await evalJs(`(() => {
    const root = document.querySelector('#root') || document.body;
    return {
      hasRoot: !!document.querySelector('#root'),
      bodyChildren: document.body.children.length,
      title: document.title,
      testids: document.querySelectorAll('[data-testid]').length,
    };
  })()`);
  console.log("basic:", JSON.stringify(basic));

  // 2. 会话列表/时间线是否渲染（冷开后的可见状态）
  const timeline = await evalJs(`(() => {
    const sels = [
      '[data-testid="conversation-timeline"]',
      '[data-testid="conversation-list"]',
      '[data-testid="session-pane"]',
      '[class*="ConversationTimeline"]',
      '[class*="SessionPane"]',
    ];
    const found = {};
    for (const s of sels) found[s] = document.querySelectorAll(s).length;
    const msgs = document.querySelectorAll('[data-testid*="row"], [class*="conversation-row"], [class*="UserInput"]');
    return { found, messageRows: msgs.length, textLen: document.body.innerText.length };
  })()`);
  console.log("timeline:", JSON.stringify(timeline));

  // 3. 侧边栏分组（useGroupedTaskView 重写验证点）
  const sidebar = await evalJs(`(() => {
    const sels = ['[data-testid*="sidebar"]', '[class*="Sidebar"]', '[class*="WorkspaceSidebar"]', '[class*="GroupedTask"]'];
    const found = {};
    for (const s of sels) found[s] = document.querySelectorAll(s).length;
    return found;
  })()`);
  console.log("sidebar:", JSON.stringify(sidebar));

  // 4. 输入框（编辑重发入口）
  const composer = await evalJs(`(() => {
    const ta = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
    return { hasComposer: !!ta, tag: ta?.tagName, editable: ta?.getAttribute('contenteditable') };
  })()`);
  console.log("composer:", JSON.stringify(composer));

  ws.close();
}

main().catch((e) => { console.error("E2E FAILED:", e.message ?? e); process.exit(1); });
