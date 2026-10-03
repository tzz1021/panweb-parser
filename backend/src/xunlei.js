/**
 * 迅雷 restore/download 的 captcha_token 供给（v1.4）
 *
 * 背景（Tzz 2026-10-03 拍板 + 真机实测，见 docs/reverse-notes-xunlei.md）：
 * - **身份分家**：scan 用 alist 在野身份（SPA 本地自造 token）；restore/download 必须**登录态 web 身份**，
 *   而 web 端 captcha_sign 算法被混淆、前端算不出 ⇒ 由 backend 提供 token。
 * - **captcha_sign 无时效校验**：7 天前的 timestamp+sign 依旧能 init 出 token（token 本身 300s 过期）
 *   ⇒ backend 保存一份**手动录入**的 `(captcha_sign, timestamp)` 长期复用，需要时滚动更新；
 *     device_id / client_id / client_version 必须与录入 sign 时**配套**（混搭 → invalid captcha_sign）。
 *
 * 本模块职责：
 * - 读设置（settings 表优先 → config.json `xunlei` 段预置 → 内置 web 默认值）
 * - `captchaTokenForAction(action)`：POST xluser-ssl.xunlei.com/v1/shield/captcha/init，
 *   按 action 缓存 `{token, expiresAt}`，**剩余 > 60s 复用**（与 SPA 侧同门槛）
 * - 返回体**绝不**包含 sign / device_id（由 server.js 只挑 captcha_token/expires_in/cached 下发）
 *
 * 安全：sign/device_id 只在 backend 进程内使用；面板读接口只回 sign 是否已配置（脱敏）。
 * 测试：`PANHUB_XUNLEI_CAPTCHA_BASE` 可覆盖上游基址（hop-smoke 用它指向本地 mock，绝不打真上游）。
 */
import { getConfig } from './config.js';
import { getSetting, getDb, decrypt } from './db.js';

/** 内置 web 端身份默认值（Tzz 浏览器抓包；与 src/adapters/xunlei/types.ts#XL_WEB_CLIENT 同源） */
const WEB_DEFAULTS = {
  client_id: 'Xqp0kJBXWhwaTpB6',
  client_version: '1.93.6',
  package_name: 'pan.xunlei.com',
};

/** 手动录入项（空串 = 未配置）；账号相关（authorization / to_parent_id / user_id）由后台维护 */
const MANUAL_DEFAULTS = {
  captcha_sign: '',
  captcha_timestamp: '',
  device_id: '',
  // v1.4：托管账号（前端不再持凭据）——authorization + 转存目标目录
  authorization: '',
  to_parent_id: '',
  user_id: '',
};

const DEFAULTS = { ...WEB_DEFAULTS, ...MANUAL_DEFAULTS };

/** 设置键前缀（settings 表内键名 = `xunlei_<key>`，与契约给出的设置名一致） */
const SETTING_PREFIX = 'xunlei_';

/** captcha_token 复用门槛（剩余 > 60s 才复用；与 SPA 侧 XL_CAPTCHA_REUSE_MARGIN_MS 同值） */
export const XUNLEI_CAPTCHA_REUSE_MARGIN_MS = 60_000;

/** captcha init 默认有效期（响应未给 expires_in 时兜底，秒） */
const CAPTCHA_DEFAULT_TTL_S = 300;

/** 上游基址（env 覆盖仅用于测试；默认真机） */
function captchaBase() {
  return String(process.env.PANHUB_XUNLEI_CAPTCHA_BASE ?? '').replace(/\/+$/, '') || 'https://xluser-ssl.xunlei.com';
}

/** 设置读取：settings 表 → config.json `xunlei` 段 → 内置默认 */
export function xunleiSetting(key) {
  const fromDb = getSetting(`${SETTING_PREFIX}${key}`);
  if (fromDb !== null && fromDb !== undefined && String(fromDb) !== '') return String(fromDb);
  const fromCfg = getConfig().xunlei?.[key];
  if (fromCfg !== undefined && fromCfg !== null && String(fromCfg) !== '') return String(fromCfg);
  return DEFAULTS[key] ?? '';
}

/** sign 是否已录入（只要 sign 与 timestamp 都在即可用；device_id 缺失会退化为空串→上游会判 invalid） */
export function xunleiSignConfigured() {
  return Boolean(xunleiSetting('captcha_sign') && xunleiSetting('captcha_timestamp'));
}

/** 面板读视图：sign 只回「是否配置 + 长度/前缀」，**不回明文**；device_id 属操作者自查项，原样回 */
export function xunleiSettingsView() {
  const sign = xunleiSetting('captcha_sign');
  return {
    captchaSignSet: Boolean(sign),
    captchaSignMasked: sign ? `len:${sign.length} prefix:${sign.slice(0, 8)}…` : null,
    captchaTimestamp: xunleiSetting('captcha_timestamp'),
    deviceId: xunleiSetting('device_id'),
    clientId: xunleiSetting('client_id'),
    clientVersion: xunleiSetting('client_version'),
    packageName: xunleiSetting('package_name'),
    // v1.4 托管账号：authorization 只回是否配置（脱敏），to_parent_id / user_id 非敏感原样回
    authorizationSet: Boolean(xunleiSetting('authorization')),
    authorizationMasked: maskSecret(xunleiSetting('authorization')),
    toParentId: xunleiSetting('to_parent_id'),
    userId: xunleiSetting('user_id'),
  };
}

/** 只给长度+前缀的安全展示（凭据类；≤8 不报前缀） */
function maskSecret(v) {
  const s = String(v ?? '');
  if (!s) return null;
  return s.length <= 8 ? `len:${s.length}` : `len:${s.length} prefix:${s.slice(0, 6)}…`;
}

/** 配置类错误（4xx，明确中文文案，不静默） */
export class XunleiTokenConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XunleiTokenConfigError';
  }
}

/** 上游类错误（5xx） */
export class XunleiTokenUpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XunleiTokenUpstreamError';
  }
}

/** action 缓存：action → { token, expiresAt }（模块级；剩余 > 60s 复用） */
const tokenCache = new Map();

/** 清空 token 缓存（设置项滚动更新后调用，避免旧 token 继续复用） */
export function clearXunleiTokenCache() {
  tokenCache.clear();
}

/**
 * 取 action 对应的 captcha_token（缓存复用 >60s）。
 * @param {string} action `method:path`（如 `post:/drive/v1/share/restore`、`get:/drive/v1/files`）
 * @param {{ userId?: string }} [opts] 登录账号 user_id（游客 '0'）
 * @returns {Promise<{ captcha_token: string, expires_in: number, cached: boolean }>}
 */
export async function captchaTokenForAction(action, opts = {}) {
  const act = String(action ?? '').trim();
  if (!act) throw new XunleiTokenConfigError('缺少 action 参数（格式：method:path，如 post:/drive/v1/share/restore）');

  const now = Date.now();
  const hit = tokenCache.get(act);
  if (hit && hit.token && hit.expiresAt - now > XUNLEI_CAPTCHA_REUSE_MARGIN_MS) {
    return { captcha_token: hit.token, expires_in: Math.round((hit.expiresAt - now) / 1000), cached: true };
  }

  const sign = xunleiSetting('captcha_sign');
  const timestamp = xunleiSetting('captcha_timestamp');
  if (!sign) throw new XunleiTokenConfigError('未配置迅雷 captcha_sign：请在「系统配置 → 迅雷」录入 web 端 captcha_sign（并同步 captcha_timestamp）');
  if (!timestamp) throw new XunleiTokenConfigError('未配置迅雷 captcha_timestamp：必须与 captcha_sign 配套录入');
  const deviceId = xunleiSetting('device_id');
  if (!deviceId) throw new XunleiTokenConfigError('未配置迅雷 device_id：必须与录入的 captcha_sign 配套（同一 device 生成的 sign）');

  const body = {
    client_id: xunleiSetting('client_id'),
    action: act,
    device_id: deviceId,
    meta: {
      username: '',
      phone_number: '',
      email: '',
      package_name: xunleiSetting('package_name'),
      client_version: xunleiSetting('client_version'),
      captcha_sign: sign,
      // 服务端只用请求里的 timestamp 重算校验（无时效校验）→ 原样带上录入值
      timestamp: String(timestamp),
      user_id: opts.userId ? String(opts.userId) : '0',
    },
    redirect_uri: 'xlaccsdk01://xunlei.com/callback?state=harbor',
  };

  const url = `${captchaBase()}/v1/shield/captcha/init`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
        accept: '*/*',
        'x-client-id': xunleiSetting('client_id'),
        'x-device-id': deviceId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    throw new XunleiTokenUpstreamError(
      `迅雷验证码服务不可达（${err?.name === 'TimeoutError' ? '超时' : err?.message ?? err}）`,
    );
  }

  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!res.ok) {
    const detail = data?.error_description || data?.error || text.slice(0, 120) || `HTTP ${res.status}`;
    throw new XunleiTokenUpstreamError(`迅雷验证码服务返回 HTTP ${res.status}：${detail}（sign 失效/身份不配套时请滚动更新 captcha_sign）`);
  }
  if (!data || typeof data !== 'object' || !data.captcha_token) {
    throw new XunleiTokenUpstreamError(`迅雷验证码服务未返回 captcha_token${data?.error ? `（${data.error}）` : ''}`);
  }

  const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : CAPTCHA_DEFAULT_TTL_S;
  tokenCache.set(act, { token: data.captcha_token, expiresAt: now + expiresIn * 1000 });
  return { captcha_token: data.captcha_token, expires_in: expiresIn, cached: false };
}

/* ===================== v1.4 账号相关 ops（settings/restore/rename/download） ===================== */

/** 迅雷业务 API 基址（env 覆盖仅用于测试 mock；默认真机，与 SPA types.ts#API_BASE 同源） */
function xlApiBase() {
  return String(process.env.PANHUB_XUNLEI_API_BASE ?? '').replace(/\/+$/, '') || 'https://api-pan.xunlei.com';
}

/** web 端 UA（与登录态 web 身份配套；不含任何凭据） */
const XL_WEB_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 需先 rename 才出直链的压缩类 mime（云解压卖点） */
const COMPRESS_MIMES = new Set(['application/zip', 'application/x-7z-compressed', 'application/x-rar-compressed']);

function opFail(code, message) {
  return { ok: false, error: code, code, message };
}

/**
 * 解析托管凭据串：`authorization=Bearer …;to_parent_id=…;user_id=…`
 * （键名容忍别名；也接受裸 `Bearer xxx`）。
 */
export function parseXunleiCredential(raw) {
  const s = String(raw ?? '').trim();
  const out = { authorization: '', toParentId: '', userId: '' };
  if (!s) return out;
  for (const part of s.split(';')) {
    const seg = part.trim();
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    const k = seg.slice(0, eq).trim().toLowerCase();
    const v = seg.slice(eq + 1).trim();
    if (!v) continue;
    if (k === 'authorization' || k === 'auth') out.authorization = v;
    else if (k === 'to_parent_id' || k === 'restore_path' || k === 'parent_id') out.toParentId = v;
    else if (k === 'user_id' || k === 'userid') out.userId = v;
  }
  if (!out.authorization) {
    const m = /Bearer\s+([A-Za-z0-9._~+/=-]+)/i.exec(s);
    if (m) out.authorization = `Bearer ${m[1]}`;
  }
  return out;
}

/**
 * 取托管迅雷账号：settings（authorization/to_parent_id/user_id）优先，其次 accounts 表 pan='xunlei'。
 * 无 → null（runOp 返回 NO_ACCOUNT，指引 README 教程）。凭据本体永不回前端。
 */
export function xunleiAccount() {
  const auth = xunleiSetting('authorization');
  if (auth) {
    return {
      authorization: auth,
      toParentId: xunleiSetting('to_parent_id'),
      userId: xunleiSetting('user_id') || undefined,
      source: 'settings',
    };
  }
  try {
    const row = getDb()
      .prepare("SELECT * FROM accounts WHERE pan = 'xunlei' AND kind = 'real' ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT 1")
      .get();
    if (row) {
      const parsed = parseXunleiCredential(decrypt(row.cookie_enc));
      if (parsed.authorization) {
        getDb().prepare('UPDATE accounts SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
        return { authorization: parsed.authorization, toParentId: parsed.toParentId, userId: parsed.userId || undefined, source: 'pool' };
      }
    }
  } catch {
    /* 账号池不可用 → 视作无账号 */
  }
  return null;
}

function buildQuery(query) {
  const qs = Object.entries(query ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs ? `?${qs}` : '';
}

/** 带登录态 + captcha 的迅雷业务请求（backend 自己的 device/sign/authorization） */
async function xlRequest(account, { method, path, query, body, action }) {
  const token = await captchaTokenForAction(action, { userId: account.userId });
  const res = await fetch(`${xlApiBase()}${path}${buildQuery(query)}`, {
    method,
    headers: {
      'x-client-id': xunleiSetting('client_id'),
      'x-device-id': xunleiSetting('device_id'),
      'x-captcha-token': token,
      authorization: /^Bearer\s/i.test(account.authorization) ? account.authorization : `Bearer ${account.authorization}`,
      accept: '*/*',
      'content-type': 'application/json',
      origin: 'https://pan.xunlei.com',
      referer: 'https://pan.xunlei.com/',
      'user-agent': XL_WEB_UA,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: res.status, data, text };
}

/** 上游响应 → 统一失败对象；成功返回 null */
function upstreamError(r, step) {
  const d = r.data;
  const code = d?.error ?? d?.error_code;
  if (r.status >= 200 && r.status < 300 && !code) return null;
  if (r.status === 401 || code === 'unauthenticated') {
    return opFail('AUTH_EXPIRED', `${step}失败：托管账号登录态已过期（请后台更新 authorization）`);
  }
  if (r.status === 404 || code === 'not_found') return opFail('NOT_FOUND', `${step}失败：文件不存在（404）`);
  return opFail(
    code != null ? String(code) : `UPSTREAM_${r.status}`,
    `${step}失败（HTTP ${r.status}）：${d?.error_description ?? d?.error ?? String(r.text ?? '').slice(0, 120)}`,
  );
}

/** 详情响应 → 脱敏视图（token 只给类型/过期，URL 只报存在性；永不含明文凭据） */
function maskedDetail(data) {
  const links = {};
  for (const [mime, l] of Object.entries(data?.links ?? {})) {
    links[mime] = { hasUrl: Boolean(l?.url), tokenType: l?.token_type ?? null, expire: l?.expire ?? null };
  }
  return {
    name: data?.name ?? null,
    mimeType: data?.mime_type ?? null,
    size: data?.size === undefined || data?.size === '' ? null : Number(data.size),
    vip: data?.vip ?? null,
    hash: data?.hash ?? null,
    md5Checksum: data?.md5_checksum ?? null,
    links,
    params: {
      device_id: maskSecret(data?.params?.device_id),
      share_id: data?.params?.share_id ?? null,
      task_id: data?.params?.task_id ?? null,
    },
    webContentLinkPresent: typeof data?.web_content_link === 'string' && data.web_content_link.length > 0,
  };
}

/** 直链优先级：links[<mime>].url → web_content_link → medias[].link.url */
function pickLink(data, mime) {
  const links = data?.links;
  if (links && typeof links === 'object') {
    const entries = Object.entries(links).filter(([, l]) => l && l.url);
    const chosen = mime && links[mime]?.url ? links[mime] : entries.length === 1 ? entries[0][1] : null;
    if (chosen?.url) return { url: chosen.url, expire: chosen.expire };
  }
  if (typeof data?.web_content_link === 'string' && data.web_content_link) return { url: data.web_content_link };
  const media = (data?.medias ?? []).find((m) => m?.link?.url);
  if (media) return { url: media.link.url };
  return { url: '' };
}

function expiresOf(url, expireIso) {
  if (expireIso) {
    const ms = Date.parse(expireIso);
    if (Number.isFinite(ms)) return ms;
  }
  const m = /[?&]e=(\d{9,11})(?:&|$)/.exec(url);
  if (m) return Number(m[1]) * 1000;
  return undefined;
}

/**
 * 执行一条迅雷 ops。**账号相关请求全部在此由 backend 自己完成**（前端只发意图）。
 * @param {'settings'|'restore'|'rename'|'download'} op
 * @param {{share_id?:string, pass_code_token?:string, to_parent_id?:string, fids?:string[], fid?:string, name?:string, mime_type?:string}} payload
 * @returns {{ok:boolean, results?:Array<{fid:string,fileId:string}>, url?:string, expiresAt?:number, size?:number|string, detail?:object, name?:string, error?:string, code?:string, message?:string}}
 */
export async function runOp(op, payload = {}) {
  const account = xunleiAccount();
  if (!account) {
    return opFail(
      'NO_ACCOUNT',
      '托管后端未配置迅雷账号：请参照仓库自述（README 教程）在后台维护迅雷凭据（authorization + to_parent_id）后重试',
    );
  }
  try {
    if (op === 'settings') {
      if (!account.toParentId) return opFail('NO_TO_PARENT_ID', '未配置转存目标目录（to_parent_id）：请后台补齐');
      const r = await xlRequest(account, {
        method: 'POST',
        path: '/drive/v1/settings',
        body: { item: 'restore_path', value: account.toParentId },
        action: 'post:/drive/v1/settings',
      });
      const err = upstreamError(r, '设置转存目录');
      return err ?? { ok: true };
    }

    if (op === 'restore') {
      const fids = Array.isArray(payload.fids) ? payload.fids.filter((x) => typeof x === 'string' && x) : [];
      if (!payload.share_id || fids.length === 0) return opFail('BAD_REQUEST', 'restore 需要 share_id 与非空 fids');
      if (!account.toParentId) return opFail('NO_TO_PARENT_ID', '未配置转存目标目录（to_parent_id）：请后台补齐');
      const r = await xlRequest(account, {
        method: 'POST',
        path: '/drive/v1/share/restore',
        body: {
          parent_id: account.toParentId,
          share_id: payload.share_id,
          pass_code_token: payload.pass_code_token ?? '',
          ancestor_ids: [],
          file_ids: fids,
          specify_parent_id: true,
        },
        action: 'post:/drive/v1/share/restore',
      });
      const err = upstreamError(r, '转存到自己的网盘');
      if (err) return err;
      let trace = {};
      try {
        const parsed = JSON.parse(r.data?.params?.trace_file_ids ?? '{}');
        if (parsed && typeof parsed === 'object') trace = parsed;
      } catch {
        trace = {};
      }
      const results = fids
        .map((fid) => ({ fid, fileId: typeof trace[fid] === 'string' ? trace[fid] : '' }))
        .filter((x) => x.fileId);
      return { ok: true, results };
    }

    if (op === 'rename') {
      const fid = String(payload.fid ?? '');
      if (!fid) return opFail('BAD_REQUEST', 'rename 需要 fid');
      const base = String(payload.name ?? '').replace(/\s+$/, '') || fid;
      // 三位补零随机数伪装分卷（不要固定 001；Tzz 定稿）
      const suffix = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
      const name = `${base}.${suffix}`;
      const r = await xlRequest(account, {
        method: 'PATCH',
        path: `/drive/v1/files/${encodeURIComponent(fid)}`,
        body: { name, space: '' },
        action: 'patch:/drive/v1/files',
      });
      const err = upstreamError(r, '重命名（压缩包出直链）');
      return err ?? { ok: true, name };
    }

    if (op === 'download') {
      const fid = String(payload.fid ?? '');
      if (!fid) return opFail('BAD_REQUEST', 'download 需要 fid');
      const r = await xlRequest(account, {
        method: 'GET',
        path: `/drive/v1/files/${encodeURIComponent(fid)}`,
        query: { space: '', usage: 'CONSUME' },
        action: 'get:/drive/v1/files',
      });
      const err = upstreamError(r, '获取下载直链');
      if (err) return err;
      const mime = String(r.data?.mime_type ?? payload.mime_type ?? '');
      const link = pickLink(r.data, mime);
      if (!link.url) {
        if (COMPRESS_MIMES.has(mime.toLowerCase())) {
          return opFail('NEED_RENAME', '压缩类文件需先重命名才出直链（云解压），请先 rename 再 download');
        }
        return opFail('NO_DOWNLOAD_URL', '文件详情未返回直链（links / web_content_link / medias 均空）');
      }
      return {
        ok: true,
        url: link.url,
        expiresAt: expiresOf(link.url, link.expire),
        size: r.data?.size,
        detail: maskedDetail(r.data),
      };
    }

    return opFail('BAD_OP', `未知 op：${op}`);
  } catch (err) {
    return opFail('OP_FAILED', `迅雷操作失败：${err?.message ?? err}`);
  }
}
