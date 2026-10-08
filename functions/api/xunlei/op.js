/**
 * 自有路由 · 迅雷 ops（v1.4）：`POST /api/xunlei/op`
 *
 * 路径（v1.4 修）：Pages Functions 支持嵌套目录 —— 本文件放在 `functions/api/xunlei/op.js`
 * 才是 `/api/xunlei/op`（与 SPA `XUNLEI_OP_PATH` 一致）；`_` 开头的目录才不生成路由。
 * 旧位置 `functions/api/xunlei-op.js` 会变成 `/api/xunlei-op`（404 → CORS 假象），已废弃。
 *
 * 架构（Tzz 2026-10-03 定稿）：settings / restore / rename / download 属**账号相关**操作，
 * **不能由前端带凭据/头去发** —— 前端只发「请求意图」，本路由透传给 backend，
 * **backend 用自己的 device_id / captcha_token / authorization 完成上游请求**。
 *
 * 请求：`body { op: 'ping'|'settings'|'restore'|'rename'|'download', ... }`
 *   `ping` = 端点探活（backend 直接回 `{ok:true}`，不碰上游/不查账号）——SPA 解析前先探测，
 *   失败即弹「后端断线了。。。」并中止本批，避免逐文件失败。
 * 响应：backend 的 `{ ok, ... }` **原样**回前端（HTTP 状态也透传）。
 *
 * 降级（绝不静默；**任何分支都必须返回带 CORS 头的 JSON**，否则浏览器只会看到 CORS 错误）：
 *   - 未配置 BACKEND_URL → 501 BACKEND_NOT_CONFIGURED
 *   - backend 不可达/超时 → 502 BACKEND_UNREACHABLE
 *   - backend 返回非 JSON → 502 BACKEND_BAD_RESPONSE
 * 鉴权：X-Proxy-Token（+ 既有每 IP 限频）。与 credential-pick 同类**自有端点**，
 * 不混进 classifyOperation 的 scan/download 词表（本路由不转发网盘上游，只透传 backend）。
 */
import { CORS_HEADERS, checkRateLimit, checkToken, json } from '../_shared/proxy-core.js';

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** op 词表（与 backend runOp / SPA XunleiOpName 同表）；ping = 探活 */
const OPS = ['ping', 'settings', 'restore', 'rename', 'download'];

/** 后端透传超时：一个 op 可能要 captcha init + 上游请求（download 逐个），给足 30s */
const UPSTREAM_TIMEOUT_MS = 30000;

export async function onRequestPost(context) {
  // 兜底：任何未预期异常都必须变成「带 CORS 头的 JSON」，否则浏览器表现为 CORS 失败
  try {
    return await handle(context);
  } catch (err) {
    return json(500, { ok: false, error: 'INTERNAL', code: 'INTERNAL', message: `代理内部错误：${err?.message ?? err}` });
  }
}

async function handle(context) {
  const { request, env } = context;
  const denied = checkToken(request, env);
  if (denied) return denied;
  const limited = checkRateLimit(request);
  if (limited) return limited;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: 'BAD_BODY', message: '请求体必须是 JSON（{ op, ... }）' });
  }
  const op = typeof payload?.op === 'string' ? payload.op : '';
  if (!OPS.includes(op)) {
    return json(400, { error: 'BAD_OP', message: `op 必须是 ${OPS.join(' / ')}` });
  }

  const base = String(env.BACKEND_URL ?? '').replace(/\/+$/, '');
  if (!base) {
    return json(501, {
      error: 'BACKEND_NOT_CONFIGURED',
      message: '未配置 BACKEND_URL：迅雷转存/取直链需代理托管（后台代发），请在代理环境变量配置托管后端地址',
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${base}/api/xunlei/op`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-proxy-token': env.PROXY_TOKEN ?? '' },
      body: JSON.stringify(payload),
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
  if (!data) {
    return json(502, { error: 'BACKEND_BAD_RESPONSE', message: `托管后端返回非 JSON（HTTP ${res.status}）` });
  }
  // 原样透传 backend 的业务结果（ok / results / url / expiresAt / code / message）
  return json(res.status, data);
}
