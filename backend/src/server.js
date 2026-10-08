/**
 * 单 listener HTTP 服务（docs/backend-wrangler-plan.md §1.1/§4 重构，v1.2.2）
 *
 * 硬绑 127.0.0.1，一个端口同时提供：
 *   - /api/web/*         管理面板 API（webui 安全四件套：Host/Origin/CSRF/随机端口）
 *   - /api/proxy         增强 hop（token 校验 → 账号注入 → 转发 wrangler → 两阶段 trace；CORS *）
 *   - /api/proxy/cookie-pick  云端取号端点（X-Proxy-Token 鉴权，v1.2.2 §4）
 *   - /api/proxy-config  就绪探测端点（收紧：Host 白名单 + 不再下发 token，v1.2.2 §4）
 *   - /api/web/terminal/ws  严格终端穿透（xterm.js，Host + Origin + 令牌）
 *   - 静态 webui/dist
 *
 * 对外通道全部交给 wrangler / CF（backend 不再暴露任何端口，比旧双 listener 更安全）。
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, saveConfig, randomToken, syncDevVars, uptimeMs, BACKEND_VERSION } from './config.js';
import { initDb, getDb, audit, listAudit, listHosts, addHost, getSetting, setSetting, setSettingSmart, sweepTempSettings, listTempSettings, deleteLogsOlderThan, purgeAllLogs } from './db.js';
import { log, listLogs, clearRing } from './log.js';
import { hostAllowed, originAllowed, verifyWebuiToken, createCsrf, verifyCsrf, verifyProxyToken } from './auth.js';
import { handleProxy } from './proxy.js';
import { getWranglerHealth } from './wrangler.js';
import {
  captchaTokenForAction,
  clearXunleiTokenCache,
  findXunleiAccountIdByUserId,
  runOp,
  saveXunleiCapturedCredential,
  xunleiCredentialStatus,
  xunleiSetting,
  xunleiSettingsView,
  XunleiTokenConfigError,
  XunleiTokenUpstreamError,
} from './xunlei.js';
import { captureXunleiCredential } from './xunlei-cdp.js';
import { bindPort, bindingOf, listPortBindings, unbindPort } from './cdp-bind.js';
import { listPresets, runPreset, browserHealth } from './presets.js';
import {
  listAccounts, getAccount, upsertAccount, deleteAccount, countByPan, pickAccountForPan,
  listAccountIdentities, accountKeyState, accountTempKeys, sweepAccountKeyTemps,
  sweepTempAccounts,
} from './cookies.js';
import {
  authorizeTerminalWs, handleTerminalMessage, newTerminalSessionId,
} from './terminal.js';

const WEBUI_DIST = join(fileURLToPath(new URL('..', import.meta.url)), 'webui', 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 代理路由 CORS 头（跨源 SPA 用；/api/web 同源不需要） */
const PROXY_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-proxy-token',
  'access-control-expose-headers': 'x-pugs, x-quark-pus, x-quark-puus, x-panhub-account, x-panhub-backend',
  'access-control-max-age': '86400',
};

/** 读请求体（限 1MB，防撑爆内存） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error('body 过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders });
  res.end(body);
}

/* ================= 就绪探测端点（v1.2.2 §4 收紧：Host 白名单 + 不再下发 token） ================= */

/**
 * 判定"已初始化"：本机服务在跑（= 能响应本请求）+ proxy token 已生成。
 * 收紧（v1.2.2）：Host 限 127.0.0.1/localhost（防 0.0.0.0 下 LAN 探测）；
 * **不再返回 token**（防泄露）——SPA 改手动配置 proxy_address + proxy_token。
 * launcher 就绪探测继续用它（本机 127.0.0.1 命中白名单）。
 */
function handleProxyConfig(req, res) {
  if (!hostAllowed(req.headers.host)) {
    return json(res, 403, { error: 'HOST_NOT_ALLOWED', message: 'Host 头不在白名单（仅 127.0.0.1/localhost）' });
  }
  const cfg = getConfig();
  const wrangler = getWranglerHealth();
  const initialized = Boolean(cfg.proxy.token && cfg.proxy.port);
  json(res, 200, {
    ok: initialized,
    initialized,
    proxyUrl: initialized ? `http://${cfg.proxy.host}:${cfg.proxy.port}` : null,
    // token 不再下发（v1.2.2 §4 收紧；员工凭据 = proxy_address + proxy_token 手动配置）
    version: BACKEND_VERSION,
    wrangler: { running: wrangler.running, inspectorWs: wrangler.inspectorWs, port: cfg.wrangler.port, inspectorPort: cfg.wrangler.inspectorPort },
  });
}

/* ================= /api/proxy 增强 hop ================= */

async function handleProxyRoute(req, res, clientIp) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, PROXY_CORS);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    json(res, 404, { error: 'NOT_FOUND', message: '仅 POST /api/proxy' });
    return;
  }
  try {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      json(res, 400, { error: 'BAD_BODY', message: '请求体必须是 JSON' }, PROXY_CORS);
      return;
    }
    const proxyToken = req.headers['x-proxy-token'] ?? '';
    const traceHeader = req.headers['x-panhub-trace'] ?? '';
    const r = await handleProxy(body, clientIp, proxyToken, traceHeader);
    res.writeHead(r.status, { ...r.headers, ...PROXY_CORS });
    res.end(r.body);
  } catch (err) {
    json(res, 500, { error: 'INTERNAL', message: err.message }, PROXY_CORS);
  }
}

/* ================= /api/proxy/cookie-pick 云端取号（v1.2.2 §4，X-Proxy-Token 鉴权） ================= */

/**
 * 云端 proxy.js（CF）专用取号端点：body { pan, operation } → { cookie, account_id, tag, kind }。
 * kind = 'real'（正式账号）| 'guest'（游客占位）—— 云端据此决定是否回传 x-panhub-backend: ok；
 * 复用 pickAccountForPan（prase 注入正式账号；无正式账号走 guest 生成随机 __pugs，label guest#xxx）；
 * 本机 hop 与云端取号共用同一套账号策略（§1.3 硬约束 3）。
 * 返回明文 cookie 给云端进程内存使用（云端永不落库）；回传 x-panhub-account 由云端负责。
 */
async function handleCookiePick(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, PROXY_CORS);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    json(res, 404, { error: 'NOT_FOUND', message: '仅 POST /api/proxy/cookie-pick' }, PROXY_CORS);
    return;
  }
  if (!verifyProxyToken(req.headers['x-proxy-token'] ?? '')) {
    json(res, 401, { error: 'UNAUTHORIZED', message: 'X-Proxy-Token 无效' }, PROXY_CORS);
    return;
  }
  try {
    const raw = await readBody(req);
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      json(res, 400, { error: 'BAD_BODY', message: '请求体必须是 JSON' }, PROXY_CORS);
      return;
    }
    const pan = String(body.pan ?? '').trim();
    // v1.3.1 四类词表：新客户端发 download（旧名 prase 仍兼容）
    const rawOp = String(body.operation ?? 'download');
    const operation = rawOp === 'prase' ? 'download' : rawOp;
    if (!pan) {
      json(res, 400, { error: 'BAD_REQUEST', message: '缺少 pan' }, PROXY_CORS);
      return;
    }
    let hit = pickAccountForPan(pan, operation);
    if (!hit && operation === 'download') {
      // 无任何账号（正式 + guest 都没有）→ 自动生成 guest 占位（随机 __pugs，label guest#xxx 可追溯）
      // 与 webui 新增游客账号同源；只对 download 生效（scan 不注入登录态，保持 404）
      try {
        upsertAccount({ pan, kind: 'guest', cookieString: '' }, 'cookie-pick');
        hit = pickAccountForPan(pan, operation);
      } catch {
        /* pan 无效等 → 维持 404 */
      }
    }
    if (!hit) {
      json(res, 404, { error: 'NO_ACCOUNT', message: `pan=${pan} 无可用账号（含 guest 兜底）` }, PROXY_CORS);
      return;
    }
    audit('proxy.credential-pick', `${pan}/${operation} → ${hit.tag}`, 'hop');
    json(res, 200, { cookie: hit.cookieString, account_id: hit.account.id, tag: hit.tag, kind: hit.account.kind }, PROXY_CORS);
  } catch (err) {
    json(res, 500, { error: 'INTERNAL', message: err.message }, PROXY_CORS);
  }
}

/**
 * v1.3.1 四类路由 · credential-pick 的**身份查询**端点（Tzz D2/B3）：
 * GET /api/credential-pick/accounts?provider=<pan>&account=<身份> → { accounts: string[] }
 * - 只回**非敏感身份**（JWT 的 userId；解不出时 drive:<drive_id>；再不行退账号标签）—— 凭据本体永不出接口
 * - X-Proxy-Token 鉴权 + 简单限频（防被拿来刷探测）+ no-store
 * - 供 functions 的 /api/credential-pick 调用（SPA 不经手凭据；D1 后续接入滚动更新探测）
 */
const identityProbeHits = new Map(); // ip -> number[]（时间戳）
const IDENTITY_PROBE_PER_MIN = 30;

function identityProbeLimited(clientIp) {
  const now = Date.now();
  const arr = (identityProbeHits.get(clientIp) ?? []).filter((t) => now - t < 60_000);
  arr.push(now);
  identityProbeHits.set(clientIp, arr);
  return arr.length > IDENTITY_PROBE_PER_MIN;
}

async function handleCredentialPickAccounts(req, res, clientIp) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, PROXY_CORS);
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    json(res, 404, { error: 'NOT_FOUND', message: '仅 GET /api/credential-pick/accounts' }, PROXY_CORS);
    return;
  }
  if (!verifyProxyToken(req.headers['x-proxy-token'] ?? '')) {
    json(res, 401, { error: 'UNAUTHORIZED', message: 'X-Proxy-Token 无效' }, PROXY_CORS);
    return;
  }
  if (identityProbeLimited(clientIp)) {
    json(res, 429, { error: 'RATE_LIMITED', message: `身份探测限频 ${IDENTITY_PROBE_PER_MIN}/min` }, PROXY_CORS);
    return;
  }
  const u = new URL(req.url, 'http://x');
  const provider = String(u.searchParams.get('provider') ?? '').trim();
  const wanted = String(u.searchParams.get('account') ?? '').trim();
  const identities = listAccountIdentities(provider || null);
  const accounts = wanted ? identities.filter((x) => x === wanted) : identities;
  json(res, 200, { accounts, provider: provider || null }, { ...PROXY_CORS, 'cache-control': 'no-store' });
}

/**
 * v1.4 迅雷 captcha_token 端点（X-Proxy-Token 鉴权）：
 *   POST /api/xunlei/captcha-token  body { action, user_id? } → { captcha_token, expires_in, cached }
 * 供 functions 的透明注入链路调用（SPA 不经手；预热路由 /api/xunlei-captcha 再透传到这里）。
 * 硬约束：**绝不回传 sign / device_id**；未配置或上游失败一律明确 4xx/5xx + 中文 message。
 */
const XUNLEI_ACTION_RE = /^(get|post|put|delete):\/\S+$/i;

async function handleXunleiCaptchaToken(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, PROXY_CORS);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    json(res, 404, { error: 'NOT_FOUND', message: '仅 POST /api/xunlei/captcha-token' }, PROXY_CORS);
    return;
  }
  if (!verifyProxyToken(req.headers['x-proxy-token'] ?? '')) {
    json(res, 401, { error: 'UNAUTHORIZED', message: 'X-Proxy-Token 无效' }, PROXY_CORS);
    return;
  }
  let body = {};
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    json(res, 400, { error: 'BAD_BODY', message: '请求体必须是 JSON（{ action }）' }, PROXY_CORS);
    return;
  }
  const action = typeof body?.action === 'string' ? body.action.trim() : '';
  if (!XUNLEI_ACTION_RE.test(action)) {
    json(res, 400, { error: 'BAD_REQUEST', message: 'action 格式必须是 method:path（如 post:/drive/v1/share/restore）' }, PROXY_CORS);
    return;
  }
  const userId = body?.user_id !== undefined && body?.user_id !== null && String(body.user_id) !== '' ? String(body.user_id) : undefined;
  try {
    const r = await captchaTokenForAction(action, { userId });
    audit('xunlei.captcha-token', `${action} → ${r.cached ? 'cached' : 'fresh'}`, 'hop');
    // 只回 token 本身；sign / device_id 永不出接口
    json(res, 200, r, { ...PROXY_CORS, 'cache-control': 'no-store' });
  } catch (err) {
    if (err instanceof XunleiTokenConfigError) {
      json(res, 400, { error: 'XUNLEI_NOT_CONFIGURED', message: err.message }, PROXY_CORS);
      return;
    }
    if (err instanceof XunleiTokenUpstreamError) {
      json(res, 502, { error: 'XUNLEI_UPSTREAM_FAILED', message: err.message }, PROXY_CORS);
      return;
    }
    json(res, 500, { error: 'INTERNAL', message: err.message }, PROXY_CORS);
  }
}

/* ================= v1.4 迅雷账号相关 ops（settings/restore/rename/download） ================= */

/** op 词表（与 SPA XunleiOpName / functions 路由同表）；ping = 探活 */
const XUNLEI_OPS = ['ping', 'settings', 'restore', 'rename', 'download'];

/** v1.4.1：迅雷凭据抓取的限频（与其它驱动预设一致的 5 分钟） */
const XUNLEI_CAPTURE_MIN_INTERVAL_MS = 5 * 60_000;

/**
 * POST /api/xunlei/op（X-Proxy-Token 鉴权）—— 前端只发意图，backend 用自己的
 * device/sign→captcha_token/authorization 代发上游请求；结果原样回前端。
 */
async function handleXunleiOp(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, PROXY_CORS);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    json(res, 404, { error: 'NOT_FOUND', message: '仅 POST /api/xunlei/op' }, PROXY_CORS);
    return;
  }
  if (!verifyProxyToken(req.headers['x-proxy-token'] ?? '')) {
    json(res, 401, { error: 'UNAUTHORIZED', message: 'X-Proxy-Token 无效' }, PROXY_CORS);
    return;
  }
  let body = {};
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    json(res, 400, { error: 'BAD_BODY', message: '请求体必须是 JSON' }, PROXY_CORS);
    return;
  }
  const op = String(body?.op ?? '');
  if (!XUNLEI_OPS.includes(op)) {
    json(res, 400, { error: 'BAD_OP', message: `op 必须是 ${XUNLEI_OPS.join(' / ')}` }, PROXY_CORS);
    return;
  }
  try {
    const result = await runOp(op, body);
    // 业务失败（ok:false）也回 200：让前端拿到结构化 code/message（不静默、不抛 HTTP 错误）
    audit('xunlei.op', `${op}${result.ok ? ' ok' : ` → ${result.code ?? 'FAILED'}`}`, 'hop');
    json(res, 200, result, { ...PROXY_CORS, 'cache-control': 'no-store' });
  } catch (err) {
    json(res, 500, { ok: false, error: 'INTERNAL', code: 'INTERNAL', message: err.message }, PROXY_CORS);
  }
}

/* ================= v1.4 迅雷凭据（CDP 一条龙；WebUI 鉴权 + 二次确认） ================= */

/**
 * 迅雷凭据端点（v1.4）：
 *   GET  /api/xunlei/credential/status → 脱敏状态（**绝不回 authorization**）
 *   POST /api/xunlei/credential/cdp    → 用 CDP 抓登录态（authorization + captcha 身份）并落库；二次确认令牌
 * 安全口径（Tzz）：迅雷只走 CDP 取 authorization，**不存真实 cookie**；凭据不回面板。
 */
async function handleXunleiCredential(req, res, pathname) {
  if (!hostAllowed(req.headers.host)) {
    return json(res, 403, { error: 'HOST_NOT_ALLOWED', message: 'Host 头不在白名单（仅 127.0.0.1/localhost）' });
  }
  if (!originAllowed(req.headers.origin, req.headers.host)) {
    return json(res, 403, { error: 'ORIGIN_NOT_ALLOWED', message: 'Origin 不在白名单（仅同源）' });
  }
  if (!verifyWebuiToken(req.headers['x-webui-token'] ?? '')) {
    return json(res, 401, { error: 'UNAUTHORIZED', message: 'WebUI 令牌无效或未登录' });
  }

  if (pathname === '/api/xunlei/credential/status' && req.method === 'GET') {
    return json(res, 200, { ok: true, status: xunleiCredentialStatus(), portBindings: listPortBindings() });
  }

  // v1.4.1：手动改绑 / 解绑（port ↔ 账号）
  if (pathname === '/api/xunlei/credential/bind' && req.method === 'POST') {
    if (!verifyCsrf(req.headers['x-csrf-token'] ?? '')) {
      return json(res, 403, { error: 'CSRF_INVALID', message: 'CSRF 校验失败，请刷新页面重试' });
    }
    let b = {};
    try {
      const raw = await readBody(req);
      b = raw ? JSON.parse(raw) : {};
    } catch {
      return json(res, 400, { error: 'BAD_BODY', message: '请求体必须是 JSON' });
    }
    if (!verifyWebuiToken(String(b?.confirmToken ?? ''))) {
      return json(res, 403, { error: 'CONFIRM_REQUIRED', message: '修改浏览器↔账号绑定：请二次输入 WebUI 令牌' });
    }
    const port = Number(b?.port);
    try {
      if (b?.accountId === null || b?.accountId === undefined || b?.accountId === '') {
        const r = unbindPort(port);
        audit('xunlei.credential.bind', `port ${port} 解绑`, 'webui');
        return json(res, 200, { ok: true, ...r });
      }
      const rec = bindPort({ port, accountId: Number(b.accountId), userId: b?.userId, note: b?.note });
      audit('xunlei.credential.bind', `port ${port} → #${rec.accountId}`, 'webui');
      return json(res, 200, { ok: true, binding: rec });
    } catch (err) {
      return json(res, 400, { error: 'BAD_BIND', message: err.message });
    }
  }

  if (pathname === '/api/xunlei/credential/cdp' && req.method === 'POST') {
    if (!verifyCsrf(req.headers['x-csrf-token'] ?? '')) {
      return json(res, 403, { error: 'CSRF_INVALID', message: 'CSRF 校验失败，请刷新页面重试' });
    }
    let body = {};
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json(res, 400, { error: 'BAD_BODY', message: '请求体必须是 JSON' });
    }
    if (!verifyWebuiToken(String(body?.confirmToken ?? ''))) {
      return json(res, 403, {
        error: 'CONFIRM_REQUIRED',
        message: '抓取迅雷凭据会写账号池/设置：请二次输入 WebUI 令牌',
      });
    }
    // v1.4.1 限频（与其它驱动预设一致）：成功抓取后 5 分钟内不再抓（body.force=true 可强制）
    const lastCaptureAt = Number(xunleiSetting('credential_at')) || 0;
    if (lastCaptureAt && Date.now() - lastCaptureAt < XUNLEI_CAPTURE_MIN_INTERVAL_MS && body?.force !== true) {
      const wait = Math.ceil((XUNLEI_CAPTURE_MIN_INTERVAL_MS - (Date.now() - lastCaptureAt)) / 1000);
      return json(res, 429, {
        ok: false,
        error: 'RATE_LIMITED',
        message: `迅雷凭据抓取限频：请 ${wait} 秒后再试（每 ${Math.round(XUNLEI_CAPTURE_MIN_INTERVAL_MS / 1000)} 秒最多一次）`,
      });
    }
    const port = Number(body?.port) || 9222;
    try {
      const captured = await captureXunleiCredential({ port });
      // v1.4.1 port↔账号绑定：优先写回绑定账号；再按同一 userId 兜底复用（避免一个浏览器抓成两个账号）
      const binding = bindingOf(port);
      if (
        binding?.accountId &&
        binding.userId &&
        captured.userId &&
        String(captured.userId) !== String(binding.userId) &&
        body?.rebind !== true
      ) {
        return json(res, 409, {
          ok: false,
          error: 'PORT_BOUND_OTHER_ACCOUNT',
          message: `端口 ${port} 已绑定账号 ${binding.userId}（#${binding.accountId}），但本次抓到 ${captured.userId}：请确认改绑（rebind=true），或换端口/先在面板解绑`,
          binding,
        });
      }
      const reuseId = binding?.accountId ?? findXunleiAccountIdByUserId(captured.userId);
      const saved = saveXunleiCapturedCredential({ ...captured, toParentId: body?.toParentId, accountId: reuseId });
      let bound = null;
      try {
        bound = bindPort({
          port,
          accountId: saved.accountId,
          userId: saved.userId,
          label: saved.userId ? `xunlei#${saved.userId}` : 'xunlei',
          note: body?.note,
        });
      } catch {
        /* 绑定失败不影响凭据写入 */
      }
      // 面板账号快照是缓存（5min）——刚写入的 xunlei 账号要立即可见
      try {
        refreshAccountsSnapshot();
      } catch {
        /* 快照刷新失败不影响写入结果 */
      }
      audit('xunlei.credential.cdp', `userId=${saved.userId ?? '?'}`, 'webui');
      log('info', `xunlei：CDP 抓取凭据成功（userId=${saved.userId ?? '?'}，captchaSign=${saved.hasCaptchaSign ? '有' : '无'}）`);
      // 脱敏返回：绝不含 authorization / cookie
      return json(res, 200, {
        ok: true,
        userId: saved.userId,
        deviceId: saved.deviceId || null,
        expiresAt: saved.expiresAt,
        hasCaptchaSign: saved.hasCaptchaSign,
        accountId: saved.accountId,
        port,
        reusedAccount: Boolean(reuseId),
        binding: bound,
        note: saved.userId ? null : '未能从 JWT 解出 user_id（已尝试 captcha meta 兜底，仍为空）',
      });
    } catch (err) {
      const code = err?.code ?? 'CDP_ERROR';
      const status = code === 'CDP_UNAVAILABLE' ? 503 : code === 'NOT_LOGGED_IN' ? 409 : code === 'TIMEOUT' ? 504 : 500;
      audit('xunlei.credential.cdp.fail', String(code), 'webui');
      log('warn', `xunlei：CDP 抓取凭据失败（${code}）${err?.message ? ` — ${err.message}` : ''}`);
      return json(res, status, { ok: false, error: code, message: err?.message ?? '抓取失败' });
    }
  }

  return json(res, 405, { error: 'METHOD_NOT_ALLOWED', message: '仅 GET /api/xunlei/credential/status 与 POST /api/xunlei/credential/cdp' });
}

/* ================= webui API 路由 ================= */

/**
 * v1.3.1 账号快照（读写分离的另一半）：
 * 面板只读这份**服务端缓存**（5min 自动刷新 + 写操作后立即刷新 + 手动刷新端点），
 * 字段白名单在 listAccounts（无凭据、无指纹）；面板因此没有「按字段查库」的能力。
 */
let accountsSnap = { at: 0, data: null };

function refreshAccountsSnapshot() {
  accountsSnap = { at: Date.now(), data: { accounts: listAccounts(), counts: countByPan() } };
  return accountsSnap;
}

function accountsSnapshot() {
  if (!accountsSnap.data) refreshAccountsSnapshot();
  return accountsSnap;
}

/** 5min 定时：刷快照 + 清扫到期临时账号（只清凭据、审计保留） */
function startAccountsTicker() {
  const tick = () => {
    try {
      refreshAccountsSnapshot();
    } catch (err) {
      log('warn', `账号快照刷新失败：${err.message}`);
    }
    try {
      for (const r of sweepTempAccounts()) {
        audit('account.temp-expired', `${r.pan}/${r.label || `id=${r.id}`}（临时凭据到期，已清除；审计保留）`, 'backend');
        log('info', `账号池：临时凭据到期已清除（${r.pan}/${r.label || r.id}）`);
      }
      if (accountsSnap.data) refreshAccountsSnapshot();
    } catch (err) {
      log('warn', `临时账号清扫失败：${err.message}`);
    }
    // v1.4.1：按键级临时写入到期 → 恢复旧值（智能写入）
    try {
      for (const r of sweepTempSettings()) {
        audit('settings.temp-expired', `${r.key}（临时写入到期，${r.restored ? '已恢复旧值' : '旧值不存在已删键'}）`, 'backend');
        log('info', `settings：临时写入到期 ${r.key} → ${r.restored ? '恢复旧值' : '删键'}`);
      }
    } catch (err) {
      log('warn', `临时设置清扫失败：${err.message}`);
    }
    // v1.4.1 遗留#1：账号凭据串的按键级临时到期 → 恢复该键旧值（旧值不存在则删该键）
    try {
      for (const r of sweepAccountKeyTemps()) {
        audit('account.key-temp-expired', `#${r.accountId} ${r.key}（${r.restored ? '已恢复旧值' : '旧值不存在已删键'}）`, 'backend');
        log('info', `账号池：按键级临时到期 #${r.accountId} ${r.key} → ${r.restored ? '恢复旧值' : '删键'}`);
      }
    } catch (err) {
      log('warn', `按键级临时清扫失败：${err.message}`);
    }
  };
  tick();
  const timer = setInterval(tick, 5 * 60_000);
  if (typeof timer.unref === 'function') timer.unref();
}

/** webui 鉴权中间件：Host/Origin/令牌/CSRF（GET 免 CSRF） */
function webAuth(req, body) {
  if (!hostAllowed(req.headers.host)) return { ok: false, status: 403, body: { error: 'HOST_NOT_ALLOWED', message: 'Host 头不在白名单（仅 127.0.0.1/localhost）' } };
  if (!originAllowed(req.headers.origin, req.headers.host)) return { ok: false, status: 403, body: { error: 'ORIGIN_NOT_ALLOWED', message: 'Origin 不在白名单（仅同源）' } };
  const token = req.headers['x-webui-token'];
  if (!verifyWebuiToken(token)) return { ok: false, status: 401, body: { error: 'UNAUTHORIZED', message: 'WebUI 令牌无效或未登录' } };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const csrf = req.headers['x-csrf-token'] ?? body?.csrf;
    if (!verifyCsrf(csrf)) return { ok: false, status: 403, body: { error: 'CSRF_INVALID', message: 'CSRF 校验失败，请刷新页面重试' } };
  }
  return { ok: true };
}

/** 轮换 WebUI 令牌（旧令牌立即失效；新令牌打印到控制台） */
function rotateWebuiToken() {
  const t = randomToken();
  getConfig().webui.token = t;
  saveConfig();
  audit('token.rotate', 'webui token 已轮换', 'webui');
  console.log('');
  console.log('══════════════════════════════════════════');
  console.log(`  ⚠️  WebUI 令牌已轮换（旧令牌立即失效）`);
  console.log(`  新令牌: ${t}`);
  console.log('══════════════════════════════════════════');
  console.log('');
  return t;
}

/** 轮换 proxy 令牌（与 wrangler --binding 同一把 —— 轮换后必须 restart 才生效）
 * v1.2.2 微调：同步写根 .dev.vars（防 wrangler 下次启动拿到旧令牌 → 全员 401，实测事故） */
function rotateProxyToken() {
  const t = randomToken();
  getConfig().proxy.token = t;
  saveConfig();
  syncDevVars(t);
  audit('token.rotate', 'proxy token 已轮换（.dev.vars 已同步；wrangler 需 restart 生效）', 'webui');
  log('warn', `proxy：X-Proxy-Token 已轮换 —— 请执行 ./launcher.sh restart 让 wrangler 同步新令牌`);
  return t;
}

async function handleWebApi(req, res, pathname, body) {
  const cfg = getConfig();
  const auth = webAuth(req, body);
  if (!auth.ok) return json(res, auth.status, auth.body);
  const send = (status, data) => json(res, status, data);

  // ---- 会话/鉴权 ----
  if (pathname === '/api/web/auth/session') {
    return send(200, { ok: true, csrf: createCsrf(), webuiPort: cfg.webui.port });
  }

  // ---- 基础信息（含 wrangler 健康，WebUI 左栏实时显示） ----
  if (pathname === '/api/web/info') {
    const wrangler = getWranglerHealth();
    return send(200, {
      hostname: (await import('node:os')).hostname(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      pid: process.pid,
      uptimeMs: uptimeMs(),
      version: BACKEND_VERSION,
      bootAt: Date.now() - uptimeMs(),
      dbPath: (await import('node:path')).join(process.cwd(), 'data', 'period', 'panhub.db'),
      wrangler,
    });
  }

  // ---- 网络/令牌（单 listener：proxy 与 webui 同端口；无对外暴露开关——校验策略归 wrangler） ----
  if (pathname === '/api/web/network') {
    return send(200, {
      proxy: { ...cfg.proxy, token: undefined, tokenTail: cfg.proxy.token?.slice(-6) },
      webui: { ...cfg.webui, token: undefined, tokenTail: cfg.webui.token?.slice(-6) },
      wrangler: cfg.wrangler,
    });
  }
  if (pathname === '/api/web/network/rotate' && req.method === 'POST') {
    const which = body?.which === 'proxy' ? 'proxy' : 'webui';
    const t = which === 'proxy' ? rotateProxyToken() : rotateWebuiToken();
    return send(200, { ok: true, which, token: t, tokenTail: t.slice(-6) });
  }

  // ---- 实时日志（via 过滤：hop / wrangler） ----
  if (pathname === '/api/web/logs') {
    const q = new URL(req.url, 'http://x').searchParams;
    const logs = listLogs({
      limit: Math.min(Number(q.get('limit') ?? 300), 1000),
      level: q.get('level') ?? undefined,
      pan: q.get('pan') ?? undefined,
      via: q.get('via') ?? undefined,
      q: q.get('q') ?? undefined,
    });
    return send(200, { logs, queue: null });
  }
  if (pathname === '/api/web/logs/clear' && req.method === 'POST') {
    clearRing();
    audit('logs.clear', '环形日志已清空', 'webui');
    return send(200, { ok: true });
  }

  // ---- 数据看板 ----
  if (pathname === '/api/web/stats') {
    const q = new URL(req.url, 'http://x').searchParams;
    const days = Math.min(Number(q.get('days') ?? 7), 30);
    const pan = String(q.get('pan') ?? '').trim();
    const since = Date.now() - days * 86400_000;
    const panClause = pan ? ' AND pan = ?' : '';
    const params = pan ? [since, pan] : [since];
    const rows = getDb()
      .prepare(`SELECT id, frontend_id, ts, pan, operation, method, url, req_status, duration_ms, account_id, via, client_ip FROM proxy_logs WHERE ts >= ?${panClause} ORDER BY ts DESC LIMIT 2000`)
      .all(...params)
      .map((r) => ({ ...r, warning: r.req_status === null })); // v1.2.2：req_status IS NULL = 请求未完成 → 严重警告
    // 账号 id → 对外标签（quark#3 / guest#xxx），与 abuse 同一映射；无则 null
    const accMap = new Map(getDb().prepare('SELECT id, pan, label, kind FROM accounts').all().map((a) => [a.id, a]));
    const tagOf = (id) => {
      const a = accMap.get(id);
      if (!a) return null;
      return a.kind === 'guest' ? (a.label ?? 'guest') : `${a.pan}#${a.id}`;
    };
    const rowsOut = rows.map((r) => ({ ...r, account_tag: tagOf(r.account_id) }));
    const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);
    const buckets = new Map();
    for (const r of rows) {
      // v1.3.1 四类词表：历史 `prase` 读作 download（旧行无法再细分转存/取直链）
      const op = r.operation === 'prase' ? 'download' : (r.operation ?? 'other');
      const k = `${dayKey(r.ts)}|${r.pan ?? '?'}|${op}`;
      buckets.set(k, (buckets.get(k) ?? 0) + 1);
    }
    const daysArr = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
      const byPan = {};
      for (const [k, n] of buckets) {
        const [day, pan, op] = k.split('|');
        if (day !== d) continue;
        byPan[pan] ??= { scan: 0, download: 0, restore: 0, 'credential-pick': 0, other: 0, total: 0 };
        byPan[pan][op] = (byPan[pan][op] ?? 0) + n;
        byPan[pan].total += n;
      }
      daysArr.push({ day: d, byPan });
    }
    return send(200, { days: daysArr, calls: rowsOut.slice(0, 200) });
  }
  // 单次调用完整详情（完整行 + file_hits 列表，按 frontend_id 关联；req_body/resp_body 不再落库，完整体在服务器 debug 文件）
  // v1.2.2 微调：req_headers/resp_headers 不再下发（历次响应标头无意义——prase 后 SQL 已覆盖短期 cookie 项），
  // 完整体只在服务器 data/tmp/debug-*.log（权限 600）
  if (pathname.startsWith('/api/web/calls/') && pathname.endsWith('/detail')) {
    const id = Number(pathname.split('/')[4]);
    const row = getDb().prepare('SELECT * FROM proxy_logs WHERE id = ?').get(id);
    if (!row) return send(404, { error: 'NOT_FOUND', message: '调用记录不存在' });
    const fileHits = getDb().prepare('SELECT * FROM file_hits WHERE frontend_id = ? ORDER BY id').all(row.frontend_id ?? '');
    const { req_headers, resp_headers, ...rest } = row;
    return send(200, {
      ...rest,
      file_hits: fileHits,
      fullNote: '完整体（含明文 cookie/set-cookie）在服务器 data/tmp/debug-*.log（权限 600）',
    });
  }

  // 重复检测（v1.2.2 §4/§7）：file_hits 按 fid/md5 分组计数，超阈值列出 → 暴力解析检测
  if (pathname === '/api/web/abuse') {
    const q = new URL(req.url, 'http://x').searchParams;
    const pan = String(q.get('pan') ?? '').trim();
    const by = q.get('by') === 'md5' ? 'md5' : 'fid';
    const days = Math.min(Math.max(Number(q.get('days') ?? 7) || 7, 1), 365);
    const min = Math.max(Number(q.get('min') ?? 2) || 2, 1);
    const limit = Math.min(Math.max(Number(q.get('limit') ?? 50) || 50, 1), 500);
    const since = Date.now() - days * 86400_000;
    const panFilter = pan ? ' AND pan = ?' : '';
    const rows = getDb()
      .prepare(
        `SELECT ${by} AS key, file_name, COUNT(*) AS count, MAX(ts) AS last_ts FROM file_hits
         WHERE ts >= ?${panFilter} GROUP BY ${by}, file_name HAVING count >= ? ORDER BY count DESC, last_ts DESC LIMIT ?`,
      )
      .all(pan ? [since, pan, min, limit] : [since, min, limit]);
    // 涉及账号：每组取 distinct account_id → 映射为对外标签（quark#id / guest#xxx）
    const accStmt = getDb().prepare(`SELECT DISTINCT account_id FROM file_hits WHERE ${by} = ? AND ts >= ?${panFilter} AND account_id IS NOT NULL`);
    const accMap = new Map(getDb().prepare('SELECT id, pan, label, kind FROM accounts').all().map((a) => [a.id, a]));
    const tagOf = (id) => {
      const a = accMap.get(id);
      if (!a) return `#${id}`;
      return a.kind === 'guest' ? (a.label ?? 'guest') : `${a.pan}#${a.id}`;
    };
    const out = rows.map((r) => ({
      key: r.key,
      file_name: r.file_name ?? '',
      count: r.count,
      last_ts: r.last_ts,
      accounts: accStmt.all(pan ? [r.key, since, pan] : [r.key, since]).map((x) => tagOf(x.account_id)),
    }));
    return send(200, { by, pan, days, min, rows: out });
  }

  // 手动清理日志（v1.2.2 §2.3/§4）：body {days}，省略 = 全清两表
  if (pathname === '/api/web/logs/purge' && req.method === 'POST') {
    const b = body ?? {};
    let deleted;
    if (b.days === undefined || b.days === null || b.days === '') {
      deleted = purgeAllLogs();
      audit('logs.purge', `全清（proxy_logs ${deleted.proxy_logs} 行 / file_hits ${deleted.file_hits} 行）`, 'webui');
      return send(200, { ok: true, days: null, deleted });
    }
    const days = Number(b.days);
    if (!Number.isFinite(days) || days < 0) return send(400, { error: 'BAD_REQUEST', message: 'days 必须是 >= 0 的数字' });
    deleted = deleteLogsOlderThan(days);
    audit('logs.purge', `days=${days}（proxy_logs ${deleted.proxy_logs} 行 / file_hits ${deleted.file_hits} 行）`, 'webui');
    log('info', `日志清理：>${days} 天（proxy_logs ${deleted.proxy_logs} / file_hits ${deleted.file_hits}）`);
    return send(200, { ok: true, days, deleted });
  }

  // ---- 账号池（kind：real | guest）—— v1.3.1 读写分离 ----
  // 读：只给**服务端快照**（5min 自动刷新 + 写后即刷），字段白名单在 listAccounts（无凭据、无指纹）
  // 写：POST/DELETE 都要求**二次确认令牌**（body.confirmToken，服务端真校验，不只是前端拦）
  if (pathname === '/api/web/accounts' && req.method === 'GET') {
    // v1.4.1：先懒清扫（按键级临时到期 → 恢复旧值），面板秒见生效值
    try {
      sweepAccountKeyTemps();
    } catch {
      /* 清扫失败不影响读 */
    }
    const snap = accountsSnapshot();
    return send(200, { ...snap.data, snapshotAt: snap.at });
  }
  if (pathname === '/api/web/accounts/refresh' && req.method === 'POST') {
    refreshAccountsSnapshot();
    audit('account.snapshot-refresh', '手动刷新账号快照', 'webui');
    return send(200, { ok: true, snapshotAt: accountsSnapshot().at });
  }
  if (pathname === '/api/web/accounts' && req.method === 'POST') {
    if (!verifyWebuiToken(String(body?.confirmToken ?? ''))) {
      return send(403, { error: 'CONFIRM_REQUIRED', message: '账号池属高危操作：请二次输入 WebUI 令牌' });
    }
    try {
      const ttlDefault = Number(getSetting('account_temp_ttl_minutes') ?? 30);
      const isTemp = body?.temp === true;
      const id = upsertAccount(
        { ...body, ttlMinutes: isTemp ? Number(body?.ttlMinutes) || ttlDefault : null },
        'webui',
      );
      refreshAccountsSnapshot();
      // 审计里的标识：备注 → 身份（userId）；都不用 #num（Tzz 定稿）
      const saved = accountsSnapshot().data.accounts.find((x) => x.id === id) ?? null;
      const who = saved?.label || saved?.userId || `id=${id}`;
      audit('account.upsert', `${body?.pan ?? '?'}/${who}（${body?.kind ?? 'real'}${isTemp ? '，临时' : ''}）`, 'webui');
      log('info', `账号池：${body?.pan ?? '?'} ${body?.kind === 'guest' ? '游客' : '账号'}已保存${isTemp ? '（临时写入）' : ''}`);
      return send(200, { ok: true, id });
    } catch (err) {
      return send(400, { error: 'BAD_ACCOUNT', message: err.message });
    }
  }
  // v1.3.1：编辑不再回填凭据（写新不读旧）—— 只回非敏感元数据
  if (pathname.startsWith('/api/web/accounts/') && req.method === 'GET') {
    const id = Number(pathname.split('/')[4]);
    const a = accountsSnapshot().data.accounts.find((x) => x.id === id);
    if (!a) return send(404, { error: 'NOT_FOUND' });
    // v1.4.1：凭据不回显，只回 hit/none + 按键级临时剩余时间（不带值）
    return send(200, {
      account: a,
      credentialRefillable: false,
      keyState: accountKeyState(id),
      tempKeys: accountTempKeys(id),
    });
  }
  if (pathname.startsWith('/api/web/accounts/') && req.method === 'DELETE') {
    if (!verifyWebuiToken(String(body?.confirmToken ?? ''))) {
      return send(403, { error: 'CONFIRM_REQUIRED', message: '删除账号池属高危操作：请二次输入 WebUI 令牌' });
    }
    const id = Number(pathname.split('/')[4]);
    const before = accountsSnapshot().data.accounts.find((x) => x.id === id) ?? null;
    deleteAccount(id, 'webui');
    refreshAccountsSnapshot();
    // 审计带上身份（备注缺失时用 userId，不用 #num）
    audit('account.delete', `${before?.pan ?? '?'}/${before?.label || before?.userId || `id=${id}`}`, 'webui');
    return send(200, { ok: true });
  }

  // ---- 凭据刷新预设（v1.3.1 P4：**手动触发**，不做自动执行；写操作要二次令牌） ----
  if (pathname === '/api/web/plugins' && req.method === 'GET') {
    const health = await browserHealth();
    return send(200, {
      plugins: listPresets(),
      browser: health,
      note: '凭据刷新走真实浏览器（CDP 9222）：手动点运行、按预设限频；凭据只进加密库，不回面板',
    });
  }
  if (pathname.startsWith('/api/web/plugins/') && pathname.endsWith('/run') && req.method === 'POST') {
    const id = decodeURIComponent(pathname.split('/')[4] ?? '');
    if (!verifyWebuiToken(String(body?.confirmToken ?? ''))) {
      return send(403, { error: 'CONFIRM_REQUIRED', message: '运行凭据刷新会写账号池：请二次输入 WebUI 令牌' });
    }
    const r = await runPreset(id, 'webui');
    return send(r.ok ? 200 : 429, r);
  }
  // ---- hosts 映射（只增不减：只有 list + add，无删除端点） ----
  if (pathname === '/api/web/hosts' && req.method === 'GET') {
    return send(200, { hosts: listHosts() });
  }
  if (pathname === '/api/web/hosts' && req.method === 'POST') {
    try {
      const r = addHost(body?.host, body?.pan);
      audit('hosts.add', `${r.host} → ${r.pan}`, 'webui');
      return send(200, { ok: true, ...r });
    } catch (err) {
      return send(400, { error: 'BAD_HOST', message: err.message });
    }
  }

  // ---- 系统配置（高级：严格终端穿透 + devtools 绑定；日志保留期；校验策略说明） ----
  if (pathname === '/api/web/settings' && req.method === 'GET') {
    // v1.4.1：读前懒清扫（到期临时写入 → 恢复旧值），面板永远看到当前生效值
    try {
      sweepTempSettings();
    } catch {
      /* 清扫失败不影响读设置 */
    }
    return send(200, {
      notify: cfg.notify,
      advanced: cfg.advanced,
      logRetentionDays: Number(getSetting('log_retention_days') ?? 30), // v1.2.2 §2.3（重启后生效）
      // v1.3.1：临时写入默认 TTL（分钟；面板勾选「临时」时使用，可自行填写覆盖）+ trace 文件明细粒度
      accountTempTtlMinutes: Number(getSetting('account_temp_ttl_minutes') ?? 30),
      traceFileDetail: String(getSetting('trace_file_detail') ?? 'full'),
      // v1.4 迅雷 restore/download：web 身份 captcha 设置（sign 只回脱敏视图）
      xunlei: xunleiSettingsView(),
      // v1.4.1 智能写入：当前挂着的按键级临时写入（到期自动恢复旧值）
      tempKeys: listTempSettings(),
      // 只读说明：白名单/限频在 functions/api/proxy.js（单一实现），backend 不重复维护
      policy: { whitelist: 'functions/api/proxy.js → ALLOWED_HOST_SUFFIXES', rateLimit: 'proxy.js 内置 120/min/IP（v1.3.2 从 60 放宽）', owner: 'proxy.js' },
    });
  }
  if (pathname === '/api/web/settings' && req.method === 'POST') {
    const b = body ?? {};
    if (b.advanced !== undefined && typeof b.advanced === 'object') {
      cfg.advanced = { ...cfg.advanced, ...b.advanced };
      audit('settings.advanced', `高级设置更新（terminal=${Boolean(cfg.advanced.terminalEnabled)}）`, 'webui');
      log('warn', `settings：严格终端穿透 ${cfg.advanced.terminalEnabled ? '开启' : '关闭'}（风险自担，见终端页声明）`);
    }
    if (b.notify !== undefined) {
      cfg.notify = { enabled: Boolean(b.notify.enabled), webhooks: Array.isArray(b.notify.webhooks) ? b.notify.webhooks.slice(0, 10) : [] };
      audit('settings.notify', `通知渠道 ${cfg.notify.webhooks.length} 个`, 'webui');
    }
    if (b.log_retention_days !== undefined) {
      const n = Number(b.log_retention_days);
      if (!Number.isFinite(n) || n < 1 || n > 3650) return send(400, { error: 'BAD_REQUEST', message: 'log_retention_days 必须是 1–3650 的整数' });
      setSetting('log_retention_days', String(Math.round(n)));
      audit('settings.retention', `日志保留期 ${n} 天（重启后生效）`, 'webui');
      log('info', `settings：日志保留期 → ${n} 天（重启后生效）`);
    }
    // v1.3.1：临时写入默认 TTL（分钟；面板可自行填写覆盖）
    if (b.account_temp_ttl_minutes !== undefined) {
      const n = Number(b.account_temp_ttl_minutes);
      if (!Number.isFinite(n) || n < 1 || n > 10080) return send(400, { error: 'BAD_REQUEST', message: 'account_temp_ttl_minutes 必须是 1–10080（一周）的整数' });
      setSetting('account_temp_ttl_minutes', String(Math.round(n)));
      audit('settings.temp-ttl', `临时凭据默认 TTL ${Math.round(n)} 分钟`, 'webui');
      log('info', `settings：临时凭据默认 TTL → ${Math.round(n)} 分钟`);
    }
    // v1.3.1 隐私：trace 文件明细粒度（full=名称+大小+哈希 / safe=只留大小 / off=不记）
    // 背景（Tzz 审阅）：名称+大小+哈希足以对上游撞库反查文件，共享部署请考虑 safe/off
    if (b.trace_file_detail !== undefined) {
      const v = String(b.trace_file_detail);
      if (!['full', 'safe', 'off'].includes(v)) return send(400, { error: 'BAD_REQUEST', message: 'trace_file_detail 必须是 full / safe / off' });
      setSetting('trace_file_detail', v);
      audit('settings.trace-detail', `trace 文件明细 → ${v}`, 'webui');
      log('info', `settings：trace 文件明细粒度 → ${v}`);
    }
    // v1.4 迅雷设置（手动录入 sign 长期复用；client/package/device 必须与 sign 配套）
    if (b.xunlei !== undefined && typeof b.xunlei === 'object') {
      const allowed = ['captcha_sign', 'captcha_timestamp', 'device_id', 'client_id', 'client_version', 'package_name', 'authorization', 'to_parent_id', 'user_id'];
      let changedSign = false;
      for (const k of allowed) {
        if (b.xunlei[k] === undefined) continue;
        setSetting(`xunlei_${k}`, String(b.xunlei[k]).trim());
        if (k === 'captcha_sign' || k === 'captcha_timestamp' || k === 'device_id') changedSign = true;
      }
      if (changedSign) clearXunleiTokenCache(); // 滚动更新后旧 token 不再复用
      audit('settings.xunlei', `迅雷 captcha 设置更新（sign ${changedSign ? '已变更' : '未变'}）`, 'webui');
      log('info', `settings：迅雷 captcha 设置更新（sign ${changedSign ? '已变更' : '未变'}）`);
    }
    // v1.4.1 智能写入（批量形式）：`smart: { <key>: { value, ttlMinutes?, ttlSeconds? } }`
    if (b.smart !== undefined && typeof b.smart === 'object') {
      const applied = [];
      for (const [key, spec] of Object.entries(b.smart)) {
        const value = String(spec?.value ?? '');
        const ttlMinutes = Number(spec?.ttlMinutes);
        const ttlSeconds = Number(spec?.ttlSeconds);
        const ttlMs =
          Number.isFinite(ttlSeconds) && ttlSeconds > 0
            ? ttlSeconds * 1000
            : Number.isFinite(ttlMinutes) && ttlMinutes > 0
              ? ttlMinutes * 60_000
              : 0;
        try {
          const r = setSettingSmart(key, value, ttlMs);
          applied.push({ key: r.key, temp: r.temp, expiresAt: r.expiresAt });
          audit('settings.smart', `${key} → ${r.temp ? `临时（${Math.round(ttlMs / 1000)}s，到期恢复旧值）` : '长期'}`, 'webui');
        } catch (err) {
          return send(400, { error: 'BAD_SMART', message: `智能写入 ${key} 失败：${err.message}` });
        }
      }
      log('info', `settings：智能写入 ${applied.length} 个键`);
      return send(200, { ok: true, applied });
    }
    saveConfig();
    return send(200, { ok: true });
  }

  // ---- 操作日志（audit_log：backend 自身活动；上游网盘调用记录在数据看板） ----
  if (pathname === '/api/web/audit') {
    const q = new URL(req.url, 'http://x').searchParams;
    const limit = Math.min(Number(q.get('limit') ?? 200) || 200, 1000);
    const kw = String(q.get('q') ?? '').trim() || undefined;
    return send(200, { entries: listAudit(limit, kw) });
  }

  return send(404, { error: 'NOT_FOUND', message: `未知接口 ${pathname}` });
}

/* ================= 静态文件（webui/dist） ================= */

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(WEBUI_DIST, safe);
  if (!filePath.startsWith(WEBUI_DIST)) return false;
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) return false;
  const ext = extname(filePath).toLowerCase();
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(readFileSync(filePath));
  return true;
}

/* ================= 终端 ws（严格终端穿透） ================= */

/** 最小 WebSocket 服务端：只处理文本帧（opcode 1）/ping(9)/close(8)，支持掩码与分片缓冲 */
function handleTerminalUpgrade(req, socket) {
  const cfg = getConfig();
  if (!cfg.advanced.terminalEnabled) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\nterminal disabled');
    socket.destroy();
    return;
  }
  if (!authorizeTerminalWs(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const sessionId = newTerminalSessionId();
  log('info', `terminal：会话 ${sessionId} 已连接（严格终端穿透）`, { via: 'terminal', console: true });

  const sendText = (text) => {
    try {
      const payload = Buffer.from(text, 'utf8');
      const header = [0x81]; // FIN + text
      const len = payload.length;
      if (len < 126) header.push(len);
      else if (len < 65536) header.push(126, (len >> 8) & 0xff, len & 0xff);
      else {
        header.push(127);
        for (let i = 7; i >= 0; i--) header.push(Math.floor(len / 2 ** (8 * i)) & 0xff);
      }
      socket.write(Buffer.concat([Buffer.from(header), payload]));
    } catch {
      /* ignore */
    }
  };

  // 增量帧解析（缓冲不完整帧，等后续数据）
  let frameBuf = Buffer.alloc(0);
  socket.on('data', (buf) => {
    frameBuf = Buffer.concat([frameBuf, buf]);
    for (;;) {
      const bytes = frameBuf;
      if (bytes.length < 2) return;
      const opcode = bytes[0] & 0x0f;
      let len = bytes[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (bytes.length < 4) return;
        len = bytes.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (bytes.length < 10) return;
        len = Number(bytes.readBigUInt64BE(off));
        off += 8;
      }
      const masked = (bytes[1] & 0x80) !== 0;
      if (masked) {
        if (bytes.length < off + 4) return;
        off += 4;
      }
      if (bytes.length < off + len) return; // 帧不完整，等更多数据
      const raw = bytes.subarray(off, off + len);
      const mask = masked ? bytes.subarray(off - 4, off) : null;
      const payload = mask ? Buffer.from(raw.map((b, i) => b ^ mask[i % 4])) : raw;
      frameBuf = bytes.subarray(off + len);

      if (opcode === 8) {
        // close
        try {
          socket.end(Buffer.from([0x88, 0]));
        } catch {
          socket.end();
        }
        return;
      }
      if (opcode === 9 && len < 126) {
        // ping → pong（服务端帧不掩码）
        socket.write(Buffer.concat([Buffer.from([0x8a, len]), payload]));
        continue;
      }
      if (opcode === 1) {
        handleTerminalMessage(payload.toString('utf8'), (out) => {
          sendText(JSON.stringify(out));
        });
      }
    }
  });
  socket.on('close', () => log('info', `terminal：会话 ${sessionId} 已断开`, { via: 'terminal', console: true }));
  socket.on('error', () => socket.destroy());
}

/* ================= 单 listener ================= */

/** 启动单 listener（index.js 调用）；返回 server */
export async function startServers() {
  const cfg = getConfig();
  initDb();
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    const clientIp = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '?';
    try {
      // 就绪探测端点（Host 白名单 + 无 token；v1.2.2 §4）
      if (pathname === '/api/proxy-config' && req.method === 'GET') {
        return handleProxyConfig(req, res);
      }
      // 增强 hop（CORS *）
      if (pathname === '/api/proxy') {
        return await handleProxyRoute(req, res, clientIp);
      }
      // 云端取号（X-Proxy-Token 鉴权；v1.3.1 改名 credential-pick，旧路径保留一版）
      if (pathname === '/api/credential-pick') {
        return await handleCookiePick(req, res);
      }
      if (pathname === '/api/proxy/cookie-pick') {
        return await handleCookiePick(req, res);
      }
      // 账号身份查询（只回非敏感身份；供 functions 的 /api/credential-pick 调用）
      if (pathname === '/api/credential-pick/accounts') {
        return await handleCredentialPickAccounts(req, res, clientIp);
      }
      // v1.4 迅雷 captcha_token（供 functions 透明注入 / SPA 预热）
      if (pathname === '/api/xunlei/captcha-token') {
        return await handleXunleiCaptchaToken(req, res);
      }
      // v1.4 迅雷账号相关 ops（settings/restore/rename/download；backend 代发）
      if (pathname === '/api/xunlei/op') {
        return await handleXunleiOp(req, res);
      }
      // v1.4 迅雷凭据（CDP 一条龙；面板触发）+ v1.4.1 手动改绑
      if (
        pathname === '/api/xunlei/credential/cdp' ||
        pathname === '/api/xunlei/credential/status' ||
        pathname === '/api/xunlei/credential/bind'
      ) {
        return await handleXunleiCredential(req, res, pathname);
      }
      // webui API
      if (pathname.startsWith('/api/web/')) {
        let body = {};
        // v1.4.1 修：DELETE 也要读 body —— 前端把二次确认令牌放在 JSON body 里，
        // 之前只解析 POST/PUT，导致「输入了令牌也删不掉」（服务端拿到 confirmToken=空 → 403）
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE' || req.method === 'PATCH') {
          const raw = await readBody(req);
          try {
            body = raw ? JSON.parse(raw) : {};
          } catch {
            return json(res, 400, { error: 'BAD_BODY', message: '请求体必须是 JSON' });
          }
        }
        return await handleWebApi(req, res, pathname, body);
      }
      // 静态
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (serveStatic(req, res, pathname)) return;
      }
      json(res, 404, { error: 'NOT_FOUND' });
    } catch (err) {
      json(res, 500, { error: 'INTERNAL', message: err.message });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (pathname === '/api/web/terminal/ws') {
      handleTerminalUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.proxy.port, cfg.proxy.host, () => resolve(server));
  });
  log('info', `单 listener：http://${cfg.proxy.host}:${cfg.proxy.port}（/api/<四类> + /api/proxy-config + /api/web/* + 静态）`, { console: true });
  startAccountsTicker(); // 账号快照 5min 刷新 + 到期临时凭据清扫
  log('info', `wrangler：${cfg.wrangler.autoSpawn ? 'autoSpawn（未监听时自动拉起）' : 'attach 模式'}，转发目标 http://127.0.0.1:${cfg.wrangler.port}/api/<四类>（旧部署回退 /api/proxy）`);
  return server;
}
