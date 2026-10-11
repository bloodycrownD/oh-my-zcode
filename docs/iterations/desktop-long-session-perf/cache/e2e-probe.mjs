const get = (p) => fetch(`http://127.0.0.1:9229${p}`).then((x) => x.json());

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await get("/json/list");
const page = list.find((t) => t.type === "page");
const cdp = await connect(page.webSocketDebuggerUrl);

async function snapshot() {
  const r = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const el = document.querySelector('[data-testid="v4-timeline"]');
      const nav = document.querySelector('[data-testid="v4-turn-navigator"]');
      return {
        windowRows: el?.getAttribute("data-window-row-count"),
        totalRows: el?.getAttribute("data-total-row-count"),
        nav: Boolean(nav),
        navItems: nav?.getAttribute("data-item-count"),
        sidebarSessions: [...document.querySelectorAll('[data-testid*="session"]')].length,
        bodySnippet: (document.querySelector("main, #root > div")?.textContent ?? "").slice(0, 120),
      };
    })()`,
    returnByValue: true,
  });
  return r.result.value;
}

for (let i = 0; i < 12; i += 1) {
  const s = await snapshot();
  console.log(new Date().toISOString().slice(11, 19), JSON.stringify(s));
  if (Number(s.windowRows) > 0) break;
  await sleep(5000);
}
cdp.ws.close();
process.exit(0);
