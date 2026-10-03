/**
 * 自有路由 · xunlei-captcha（v1.3.3；SPA 预热/调试用）
 *
 * `POST /api/xunlei-captcha`，body `{ action }`（`method:path`，如 `post:/drive/v1/share/restore`）
 *   → 透传 backend `POST /api/xunlei/captcha-token`，回 `{ captcha_token, expires_in, cached }`。
 *
 * 定位：与 credential-pick 同类的**自有端点**（走 X-Proxy-Token 鉴权 + 限频），
 * **不混进** classifyOperation 的 scan/download 词表 —— 它不转发到网盘上游，只是 backend 的薄透传。
 * 主链路（restore/download）的 token 由 proxy-core 在转发时**自动注入**，SPA 无需主动调用本端点；
 * 这里保留给预热/自检/排障。
 *
 * 降级（绝不静默）：
 *   - 未配置 BACKEND_URL → 501 BACKEND_NOT_CONFIGURED
 *   - backend 不可达/超时 → 502 BACKEND_UNREACHABLE
 *   - backend 明确报错（未配 sign / 上游失败）→ 502 + 后端中文 message
 */
import { CORS_HEADERS, checkRateLimit, checkToken, json } from './_shared/proxy-core.js';

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** action 形态（与 backend XUNLEI_ACTION_RE 同表） */
const ACTION_RE = /^(get|post|put|delete):\/\S+$/i;

/** 后端透传超时（captcha init 要走上游，比取号的 800ms 宽松） */
const UPSTREAM_TIMEOUT_MS = 6000;

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = checkToken(request, env);
  if (denied) return denied;
  const limited = checkRateLimit(request);
  if (limited) return limited;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: 'BAD_BODY', message: '请求体必须是 JSON（{ action }）' });
  }
  const action = typeof payload?.action === 'string' ? payload.action.trim() : '';
  if (!ACTION_RE.test(action)) {
    return json(400, { error: 'BAD_BODY', message: 'action 格式必须是 method:path（如 post:/drive/v1/share/restore）' });
  }

  const base = String(env.BACKEND_URL ?? '').replace(/\/+$/, '');
  if (!base) {
    return json(501, {
      error: 'BACKEND_NOT_CONFIGURED',
      message: '未配置 BACKEND_URL：本端点无法获取迅雷验证码令牌（restore/download 的 token 由转发链路自动注入）',
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${base}/api/xunlei/captcha-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-proxy-token': env.PROXY_TOKEN ?? '' },
      body: JSON.stringify({ action }),
      signal: controller.signal,
    });
  } catch (err) {
    return json(502, {
      error: 'BACKEND_UNREACHABLE',
      message: `托管后端不可达（${err?.name === 'AbortError' ? '超时' : err?.message ?? err}）`,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!res.ok || !data) {
    return json(502, {
      error: 'XUNLEI_CAPTCHA_FAILED',
      message: data?.message ?? `托管后端返回 HTTP ${res.status}`,
    });
  }
  // 只透传 token 三件套；sign / device_id 后端本就不下发
  return json(200, { captcha_token: data.captcha_token, expires_in: data.expires_in, cached: data.cached });
}
