/**
 * 迅雷凭据抓取（CDP；backend/src/xunlei-cdp.js，v1.4）
 *
 * 目标（Tzz 定稿）：面板「一条龙」——点按钮 → backend 用**现有浏览器会话**（CDP）打开 pan.xunlei.com，
 * 等页面自己发出 `api-pan.xunlei.com` 请求，**从 `Network.requestWillBeSent` 读该请求的 authorization 头**
 * 当凭据（比从 storage 里抠更稳）；顺带抓 `captcha/init` 请求体里的身份字段（有就存，没有不算失败）。
 *
 * 安全口径（Tzz 明确）：
 * - 迅雷云盘虽支持 cookie 恢复 web 会话，但**不存真实 cookie**，只取 `authorization`；
 * - 凭据只在内存流转：本模块返回给 server.js → 直接写账号池/设置；**绝不经 HTTP 回传面板**，
 *   面板只见脱敏状态（server.js 负责裁剪）。
 *
 * 测试钩子（仅测试用）：`PANHUB_XUNLEI_CDP_STUB_FILE` 指向一个 JSON 文件时，本模块直接读它当「抓取结果」，
 * 不连真浏览器：`{error:'connect-failed'|'not-logged-in'}` 或
 * `{requests:[{url,headers:{authorization,x-device-id},postData}]}`。每次调用都重新读文件，便于逐断言切换场景。
 */
import { DEFAULT_CDP_PORT, probeCdp, openPageSession } from './cdp.js';

/** 迅雷云盘首页（登录后才会发 api-pan 请求） */
export const XUNLEI_PAN_URL = 'https://pan.xunlei.com/';

/** 抓取业务请求的域名标识 */
const API_HOST_MARK = 'api-pan.xunlei.com';
/** captcha/init 路径（顺带抓身份字段） */
const CAPTCHA_PATH = '/v1/shield/captcha/init';

/** 测试钩子（仅测试用；生产不设） */
const STUB_ENV = 'PANHUB_XUNLEI_CDP_STUB_FILE';

/** CDP 抓取错误（携带结构化 code，server.js 直接映射 HTTP 状态 + 中文 message） */
export class XunleiCdpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'XunleiCdpError';
    this.code = code;
  }
}

/** 解析抓取到的 requests（真机与 stub 共用同一归一逻辑） */
function normalizeCapture(requests) {
  let authorization = '';
  let deviceId = '';
  let captchaMeta = null;
  for (const req of requests ?? []) {
    const url = String(req?.url ?? '');
    const headers = req?.headers ?? {};
    const lower = {};
    for (const k of Object.keys(headers)) lower[String(k).toLowerCase()] = headers[k];
    const auth = typeof lower.authorization === 'string' ? lower.authorization.trim() : '';
    if (!authorization && auth && url.includes(API_HOST_MARK)) authorization = auth;
    if (!deviceId && typeof lower['x-device-id'] === 'string' && lower['x-device-id']) deviceId = lower['x-device-id'];
    if (!captchaMeta && url.includes(CAPTCHA_PATH) && typeof req?.postData === 'string') {
      try {
        const body = JSON.parse(req.postData);
        const meta = body?.meta;
        if (meta && typeof meta === 'object') {
          captchaMeta = {
            packageName: meta.package_name,
            clientVersion: meta.client_version,
            captchaSign: meta.captcha_sign,
            timestamp: meta.timestamp !== undefined ? String(meta.timestamp) : undefined,
            userId: meta.user_id !== undefined ? String(meta.user_id) : undefined,
            deviceId: body?.device_id !== undefined ? String(body.device_id) : undefined,
          };
        }
      } catch {
        /* postData 非 JSON：忽略（不算失败） */
      }
    }
  }
  return { authorization, deviceId, captchaMeta };
}

/** base64url 解 JWT payload（解不出返回 null；纯离线，不校验签名） */
export function decodeXunleiJwt(token) {
  const raw = String(token ?? '').replace(/^Bearer\s+/i, '');
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const claims = JSON.parse(json);
    const userId = [claims?.sub, claims?.user_id, claims?.userId, claims?.uid].find((v) => typeof v === 'string' && v) ?? null;
    const exp = Number(claims?.exp);
    return { userId: userId ? String(userId) : null, exp: Number.isFinite(exp) && exp > 0 ? exp * 1000 : null };
  } catch {
    return null;
  }
}

/**
 * 抓一份迅雷凭据。
 * @param {{port?:number, timeoutMs?:number, settleMs?:number}} [opts]
 * @returns {Promise<{authorization:***, deviceId:string, userId:string|null, expiresAt:number|null, captchaMeta:object|null}>}
 * @throws {XunleiCdpError} code: CDP_UNAVAILABLE | NOT_LOGGED_IN | TIMEOUT | CDP_ERROR
 */
export async function captureXunleiCredential(opts = {}) {
  const port = Number(opts.port) || DEFAULT_CDP_PORT;
  const timeoutMs = Number(opts.timeoutMs) || 25000;
  const settleMs = Number(opts.settleMs) || 2500;

  // ---- 测试钩子：直接读 stub 文件 ----
  const stubFile = process.env[STUB_ENV];
  if (stubFile) {
    let raw;
    try {
      const { readFileSync } = await import('node:fs');
      raw = JSON.parse(readFileSync(stubFile, 'utf8'));
    } catch (err) {
      throw new XunleiCdpError('CDP_ERROR', `测试 stub 读取失败：${err?.message ?? err}`);
    }
    if (raw?.error === 'connect-failed') {
      throw new XunleiCdpError('CDP_UNAVAILABLE', '无法连接浏览器调试端口（测试 stub）：请用 --remote-debugging-port=9222 启动 Chromium 并登录 pan.xunlei.com');
    }
    if (raw?.error === 'timeout') throw new XunleiCdpError('TIMEOUT', '等待页面发出业务请求超时（测试 stub）');
    return finishCapture(normalizeCapture(raw?.requests));
  }

  // ---- 真机 CDP ----
  const probe = await probeCdp(port);
  if (!probe.ok) {
    throw new XunleiCdpError(
      'CDP_UNAVAILABLE',
      `无法连接浏览器调试端口 ${port}（${probe.reason ?? '未知原因'}）：请用 --remote-debugging-port=${port} 启动 Chromium/Chrome 并在其中登录 pan.xunlei.com`,
    );
  }

  const requests = [];
  let session;
  try {
    session = await openPageSession(port, 5000, (msg) => {
      if (msg?.method !== 'Network.requestWillBeSent') return;
      const req = msg.params?.request ?? {};
      if (String(req.url ?? '').includes(API_HOST_MARK) || String(req.url ?? '').includes(CAPTCHA_PATH)) {
        requests.push({ url: req.url, headers: req.headers ?? {}, postData: req.postData });
      }
    });
  } catch (err) {
    throw new XunleiCdpError('CDP_UNAVAILABLE', `CDP 会话建立失败：${err?.message ?? err}`);
  }

  const { ws, send } = session;
  try {
    await send('Network.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: XUNLEI_PAN_URL });
    const deadline = Date.now() + timeoutMs;
    // 轮询等待：拿到带 authorization 的业务请求即可提前结束；否则等到超时
    while (Date.now() < deadline) {
      if (normalizeCapture(requests).authorization) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!normalizeCapture(requests).authorization) {
      // 再给一次「页面刷新」的机会（登录态下刷一次会重新发业务请求）
      await send('Page.reload', { ignoreCache: false }).catch(() => {});
      const settle = Date.now() + Math.min(settleMs + 3000, 8000);
      while (Date.now() < settle) {
        if (normalizeCapture(requests).authorization) break;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  return finishCapture(normalizeCapture(requests));
}

/** 归一结果 → 校验/补 JWT 信息；无 authorization 抛 NOT_LOGGED_IN */
function finishCapture(captured) {
  if (!captured.authorization) {
    throw new XunleiCdpError(
      'NOT_LOGGED_IN',
      '未在页面里捕获到带 authorization 的迅雷请求：请先在该浏览器登录 pan.xunlei.com（登录后再点一次）',
    );
  }
  const jwt = decodeXunleiJwt(captured.authorization);
  return {
    authorization: captured.authorization,
    deviceId: captured.deviceId || '',
    userId: jwt?.userId ?? (captured.captchaMeta?.userId || null),
    expiresAt: jwt?.exp,
    captchaMeta: captured.captchaMeta,
  };
}
