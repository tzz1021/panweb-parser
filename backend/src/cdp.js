/**
 * 最小 CDP 客户端（backend/src/cdp.js，v1.3.1 P4）
 *
 * 用途：**只服务于「手动预设」的凭据刷新插件** —— 让真实浏览器（比 node 模拟更少风控）
 * 打开上游页面、模拟一次「刷新」（F5 / 点到目标页），再把页面里已下发的凭据读出来。
 *
 * 端口约定（Tzz 定稿，别再混）：
 *   - 9229/9230 = wrangler inspector（devtools 协议，应用不可消费）→ 只作 /health
 *   - **9222 = 浏览器 CDP**（本文件）→ 凭据刷新专用
 *
 * 设计约束：
 *   - 零依赖：Node ≥22 内置 WebSocket + fetch，不再引 ws/chrome-remote-interface
 *   - **不自动执行**（Tzz 定稿）：本文件只提供「连一次、干一件事、断开」的原语，
 *     调度、频率限制、审计全部在 presets.js / panel 侧（手动触发）
 *   - 只读页面里**已经存在**的凭据（模拟人刷新后抓取），不注入、不伪造、不爆破
 *   - 凭据只在内存里流转：调用方直接写 db（cookies.js upsertAccount），**不经 HTTP 返回给面板**
 */
/** 默认 CDP 端口（可用 config.browser.cdpPort 或 env PANHUB_CDP_PORT 覆盖） */
export const DEFAULT_CDP_PORT = 9222;

/** 探测 CDP 是否在线（GET /json/version）；返回 {ok, browser, port}，失败不抛 */
export async function probeCdp(port = DEFAULT_CDP_PORT, timeoutMs = 1200) {
  const base = `http://127.0.0.1:${port}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/json/version`, { signal: controller.signal });
    if (!res.ok) return { ok: false, browser: null, port, reason: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, browser: String(data?.Browser ?? 'chromium'), port };
  } catch (err) {
    return { ok: false, browser: null, port, reason: err?.name === 'AbortError' ? '超时' : (err?.message ?? String(err)) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 打开一个 CDP 会话（连到首个 page target；没有页面就新建一个 about:blank）。
 * v1.4：导出供 xunlei-cdp.js 复用（同一套「连一次、干一件事、断开」原语）。
 * @param {number} port CDP 端口
 * @param {number} timeoutMs 连接超时
 * @param {(msg:object)=>void} [onEvent] 事件回调（无 id 的 CDP 事件，如 Network.requestWillBeSent）
 */
export async function openPageSession(port, timeoutMs = 5000, onEvent = null) {
  const base = `http://127.0.0.1:${port}`;
  const list = await (await fetch(`${base}/json/list`)).json();
  const pages = Array.isArray(list) ? list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl) : [];
  let wsUrl = pages[0]?.webSocketDebuggerUrl;
  if (!wsUrl) {
    // 没有可用页面 target：让浏览器开一个新标签（新版本 headless 也支持）
    const created = await fetch(`${base}/json/new?about:blank`, { method: 'PUT' });
    if (!created.ok) throw new Error('浏览器没有可用页面，且新建标签失败（请确认是 --remote-debugging-port 启动的 Chromium）');
    const t = await created.json();
    wsUrl = t?.webSocketDebuggerUrl;
  }
  if (!wsUrl) throw new Error('未找到可用的 CDP page target');

  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP 连接超时（${wsUrl}）`)), timeoutMs);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('CDP 连接失败'));
    };
  });
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    const p = pending.get(msg.id);
    if (!p) {
      // v1.4：无 id = CDP 事件（如 Network.requestWillBeSent）→ 交给 onEvent 消费者
      if (!msg.id && typeof onEvent === 'function') {
        try {
          onEvent(msg);
        } catch {
          /* 事件回调异常不影响会话 */
        }
      }
      return;
    }
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${msg.error.message ?? 'CDP 错误'}（${msg.error.code ?? '?'}）`));
    else p.resolve(msg.result);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send };
}

/**
 * 读取浏览器**全部** cookie（CDP `Network.getAllCookies`；含 HttpOnly —— `document.cookie` 看不到）。
 * v1.4.1：quark/uc 预设用它抓全量 cookie（不再按「取前 N 个」截断）。
 * @returns {Promise<Array<{name:string,value:string,domain?:string,path?:string,expires?:number,secure?:boolean,httpOnly?:boolean}>>}
 */
export async function getAllCookies({ port = DEFAULT_CDP_PORT, timeoutMs = 5000 } = {}) {
  const { ws, send } = await openPageSession(port, timeoutMs);
  try {
    await send('Network.enable');
    const res = await send('Network.getAllCookies');
    return Array.isArray(res?.cookies) ? res.cookies : [];
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 打开目标页 → 等页面自己把凭据发下来（模拟人的一次刷新）→ 在页面里执行取值表达式。
 *
 * @param {object} opts
 * @param {string} opts.url        目标页面（上游站点）
 * @param {string} opts.expression 在页面上下文里求值的 JS 表达式（返回 JSON 字符串）
 * @param {number} [opts.port]     CDP 端口
 * @param {number} [opts.settleMs] 打开后等待时间（默认 6000ms，给页面自己完成鉴权/刷新）
 * @param {boolean} [opts.reload]  打开后是否再按一次刷新（F5，模拟「刷新拿新凭据」）
 * @returns {Promise<unknown>}     表达式求值结果（已 JSON.parse）
 */
export async function evaluateOnPage({ url, expression, port = DEFAULT_CDP_PORT, settleMs = 6000, reload = true }) {
  const { ws, send } = await openPageSession(port);
  try {
    await send('Page.enable');
    await send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, settleMs));
    if (reload) {
      await send('Page.reload', { ignoreCache: false });
      await new Promise((r) => setTimeout(r, settleMs));
    }
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res?.exceptionDetails) {
      throw new Error(`页面求值异常：${res.exceptionDetails.text ?? 'unknown'}`);
    }
    const value = res?.result?.value;
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}
