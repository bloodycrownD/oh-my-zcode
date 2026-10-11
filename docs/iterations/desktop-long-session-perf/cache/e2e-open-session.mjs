// 打开侧栏中的长会话（PERF-基线导入-勿动）并等待时间线加载。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await fetch("http://127.0.0.1:9229/json/list").then((x) => x.json());
const page = list.find((t) => t.type === "page");

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.onopen = () =>
      resolve({
        ws,
        send(method, params = {}) {
          const id = ++seq;
          return new Promise((res2, rej2) => {
            pending.set(id, { res: res2, rej: rej2 });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
      });
    ws.onerror = () => reject(new Error("ws connect failed"));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    };
  });
}

const cdp = await connect(page.webSocketDebuggerUrl);
async function evalJs(expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}

// 1) 找侧栏里的目标会话条目（按文本匹配，兼容列表项无 testid 的情况）。
const found = await evalJs(`(() => {
  const candidates = [...document.querySelectorAll("button, a, [role='button'], li, div")];
  const target = candidates.filter((el) => {
    const t = (el.textContent ?? "").trim();
    return t.includes("PERF") && t.length < 200;
  });
  return target.map((el) => ({
    tag: el.tagName,
    testid: el.dataset.testid ?? "",
    text: (el.textContent ?? "").trim().slice(0, 80),
    depth: true,
  })).slice(0, 8);
})()`);
console.log("候选条目:", JSON.stringify(found, null, 2));

// 2) 取最内层匹配（文本最短的），完整 pointer 序列点击（Radix/自定义组件需要）。
const clicked = await evalJs(`(() => {
  const candidates = [...document.querySelectorAll("button, a, [role='button'], li, div")]
    .filter((el) => ((el.textContent ?? "").trim().includes("PERF")));
  if (candidates.length === 0) return { ok: false, why: "无匹配" };
  const el = candidates.reduce((smallest, cur) =>
    (cur.textContent ?? "").length <= (smallest.textContent ?? "").length ? cur : smallest,
  );
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, pointerId: 1, isPrimary: true };
  el.dispatchEvent(new PointerEvent("pointerover", opts));
  el.dispatchEvent(new PointerEvent("pointerenter", { ...opts, bubbles: false }));
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
  return { ok: true, text: (el.textContent ?? "").trim().slice(0, 60) };
})()`);
console.log("点击:", JSON.stringify(clicked));

// 3) 等时间线加载长会话。
for (let i = 0; i < 24; i += 1) {
  const s = await evalJs(`(() => {
    const el = document.querySelector('[data-testid="v4-timeline"]');
    const nav = document.querySelector('[data-testid="v4-turn-navigator"]');
    return {
      rows: el?.getAttribute("data-window-row-count"),
      total: el?.getAttribute("data-total-row-count"),
      nav: nav?.getAttribute("data-item-count") ?? "0",
    };
  })()`);
  console.log(new Date().toISOString().slice(11, 19), JSON.stringify(s));
  if (Number(s.rows) >= 40) {
    console.log("LONG SESSION OPEN ✓");
    break;
  }
  await sleep(5000);
}
cdp.ws.close();
process.exit(0);
