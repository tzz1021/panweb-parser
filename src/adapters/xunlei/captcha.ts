/**
 * 迅雷云盘验证码（captcha）与统一 API 请求层（docs/STRUCTURE.md：src/adapters/xunlei/captcha.ts）
 *
 * 迅雷**每个 API action 都需先领 captcha_token**：action = `method:path`（如
 * `get:/drive/v1/share`、`post:/drive/v1/share/restore`、`get:/drive/v1/files`）。
 * 本模块负责：
 * - getDeviceId()：随机 32 位 hex，首次生成后持久化（localStorage，本项目键风格）
 * - captchaSign(timestamp)：`1.` + md5 链（详见函数注释，身份/盐表在 types.ts）
 * - getCaptchaToken(action)：缓存（>60s 复用）+ init 带上次 token
 * - captchaHeaders()：分享/业务请求统一客户端头
 * - xlApiRequest()：统一加客户端头 + captcha + 可选 Authorization + 业务错误码解析
 *
 * 实现依据：主线程 2026-10-02 真机实测（captcha init 响应 {captcha_token, expires_in:300}；
 * 分享读链路 200 零登录；错误码见 types.ts#ERROR_MESSAGES）。
 *
 * 说明：captcha 缓存为**单条**（action 变化即重新 init），与主线程给出的缓存形态一致
 * （`{action, token, deviceId, expiresAt}`）；scan 一次窗口内足够（60s 复用门限）。
 */
import { getActiveTransport, TransportError } from '../../core/transport/types';
import {
  API_BASE,
  ERROR_MESSAGES,
  XL_CAPTCHA_DEFAULT_TTL_S,
  XL_CAPTCHA_REDIRECT_URI,
  XL_CAPTCHA_REUSE_MARGIN_MS,
  XL_CAPTCHA_STORAGE_KEY,
  XL_CLIENT,
  XL_DEVICE_STORAGE_KEY,
  XLUSER_BASE,
  type XlApiErrorBody,
  type XlCaptchaInitResponse,
} from './types';

/** 迅雷接口错误（携带 code 供 core/errors 分类；message 已是最终中文，可直接展示） */
export class XunleiApiError extends Error {
  readonly code: number | string;

  constructor(code: number | string, message: string) {
    super(message);
    this.name = 'XunleiApiError';
    this.code = code;
  }
}

/** 错误码 → 中文（无映射时用 fallback 兜底） */
export function xunleiErrorText(code: number | string | undefined, fallback: string): string {
  if (code === undefined || code === null || code === '') return fallback;
  return ERROR_MESSAGES[String(code)] ?? fallback;
}

/* ============================== 存储访问（浏览器 localStorage；node/测试环境内存兜底） ============================== */

/**
 * localStorage 安全访问：浏览器用 localStorage；无 window/localStorage（如 node 测试）时
 * 退回**模块内存**兜底 —— 保证设备 id 在同一进程内稳定、验证码缓存可复用。
 */
const memStore = new Map<string, string>();

function storageGet(key: string): string | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage.getItem(key);
  } catch {
    // 隐私模式/配额异常 → 走内存兜底
  }
  return memStore.get(key) ?? null;
}

function storageSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
      return;
    }
  } catch {
    // 落内存
  }
  memStore.set(key, value);
}

function storageRemove(key: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(key);
      return;
    }
  } catch {
    // 落内存
  }
  memStore.delete(key);
}

/* ============================== 设备 id ============================== */

let cachedDeviceId: string | null = null;

function randomHex32(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * 设备 id：随机 32 位 hex，首次生成后持久化（localStorage 键 XL_DEVICE_STORAGE_KEY）。
 * 读-改-写：先读已持久化值（含大小写归一校验），没有再生成并写回；进程内再缓存一层。
 * 同一 session 内 restore 必须用同一个 device_id —— 本函数就是那个唯一来源，故 auth/download
 * 不再另开 device（见 auth.ts 注释）。
 */
export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId;
  const existing = storageGet(XL_DEVICE_STORAGE_KEY);
  if (existing && /^[0-9a-f]{32}$/i.test(existing)) {
    cachedDeviceId = existing.toLowerCase();
    return cachedDeviceId;
  }
  const id = randomHex32();
  cachedDeviceId = id;
  storageSet(XL_DEVICE_STORAGE_KEY, id);
  return id;
}

/* ============================== captcha_sign ============================== */

/**
 * captcha_sign：`1.` + md5 链。
 *   h = client_id + client_version + package_name + device_id + timestamp(ms 字符串)
 *   for salt of salts: h = md5hex(h + salt)   // 10 条盐，逐次 md5，结果回填为下一次的输入
 *   return '1.' + h
 * 与 alist 在野身份配套（身份/盐表见 types.ts#XL_CLIENT）。
 */
export function captchaSign(timestamp: number): string {
  let h = `${XL_CLIENT.clientId}${XL_CLIENT.clientVersion}${XL_CLIENT.packageName}${getDeviceId()}${String(timestamp)}`;
  for (const salt of XL_CLIENT.salts) h = md5Hex(h + salt);
  return `1.${h}`;
}

/* ============================== captcha_token ============================== */

/** 验证码缓存记录（单条；action 变化即失效重新 init） */
interface CaptchaCache {
  action: string;
  token: string;
  deviceId: string;
  expiresAt: number;
}

function readCaptchaCache(): CaptchaCache | null {
  const raw = storageGet(XL_CAPTCHA_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CaptchaCache> | null;
    if (
      parsed &&
      typeof parsed.action === 'string' &&
      typeof parsed.token === 'string' &&
      typeof parsed.deviceId === 'string' &&
      typeof parsed.expiresAt === 'number'
    ) {
      return { action: parsed.action, token: parsed.token, deviceId: parsed.deviceId, expiresAt: parsed.expiresAt };
    }
  } catch {
    // 损坏按无缓存处理
  }
  return null;
}

function writeCaptchaCache(rec: CaptchaCache | null): void {
  if (!rec) {
    storageRemove(XL_CAPTCHA_STORAGE_KEY);
    return;
  }
  storageSet(XL_CAPTCHA_STORAGE_KEY, JSON.stringify(rec));
}

/** 清除验证码缓存（业务码 9 / captcha_invalid 时调用后重新 init） */
export function clearCaptchaCache(): void {
  writeCaptchaCache(null);
}

/**
 * 取指定 action 的 captcha_token。
 * - 缓存命中（同 action + 同 deviceId + 剩余 > 60s）→ 直接复用，不发请求
 * - 否则 POST {XLUSER_BASE}/v1/shield/captcha/init；body 带上**上一次**的 captcha_token
 *   （失效也不影响响应，仅统计用）
 * @param action `method:path`（如 'get:/drive/v1/share'）
 * @param opts.userId 登录态场景传真实 user_id（游客 '0'）
 * @param opts.force 强制跳过缓存重新 init
 */
export async function getCaptchaToken(action: string, opts: { userId?: string; force?: boolean } = {}): Promise<string> {
  const deviceId = getDeviceId();
  const now = Date.now();

  if (!opts.force) {
    const cached = readCaptchaCache();
    if (
      cached &&
      cached.action === action &&
      cached.deviceId === deviceId &&
      cached.token &&
      cached.expiresAt - now > XL_CAPTCHA_REUSE_MARGIN_MS
    ) {
      return cached.token;
    }
  }

  const prev = readCaptchaCache();
  const timestamp = now;
  const body: Record<string, unknown> = {
    client_id: XL_CLIENT.clientId,
    action,
    device_id: deviceId,
    meta: {
      username: '',
      phone_number: '',
      email: '',
      package_name: XL_CLIENT.packageName,
      client_version: XL_CLIENT.clientVersion,
      captcha_sign: captchaSign(timestamp),
      timestamp: String(timestamp),
      user_id: opts.userId ?? '0',
    },
    redirect_uri: XL_CAPTCHA_REDIRECT_URI,
  };
  // init 时若手上有上一次的 captcha_token，一并放进 body（失效也不影响响应）
  if (prev?.token) body.captcha_token = prev.token;

  const data = await captchaInitRequest(body);
  const token = data.captcha_token;
  if (!token) {
    throw new XunleiApiError('captcha-init-failed', '获取验证码令牌失败（captcha init 未返回 captcha_token）');
  }
  writeCaptchaCache({
    action,
    token,
    deviceId,
    expiresAt: now + (typeof data.expires_in === 'number' ? data.expires_in : XL_CAPTCHA_DEFAULT_TTL_S) * 1000,
  });
  return token;
}

/** captcha init 请求（独立于业务 API：xluser 域 + text/plain 请求体） */
async function captchaInitRequest(body: Record<string, unknown>): Promise<XlCaptchaInitResponse> {
  const url = `${XLUSER_BASE}/v1/shield/captcha/init`;
  const headers: Record<string, string> = {
    'content-type': 'text/plain;charset=UTF-8',
    accept: '*/*',
    'x-client-id': XL_CLIENT.clientId,
    'x-device-id': getDeviceId(),
    'user-agent': XL_CLIENT.ua,
  };
  let res: { status: number; body: string };
  try {
    res = await getActiveTransport().request({ url, method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    throw toTransportError(err, '获取验证码令牌');
  }
  const parsed = parseJson<XlCaptchaInitResponse & XlApiErrorBody>(res.body);
  if (res.status < 200 || res.status >= 300) {
    const code = parsed?.error ?? parsed?.error_code ?? res.status;
    throw new XunleiApiError(code, xunleiErrorText(code, parsed?.error_description ?? `验证码服务 HTTP ${res.status}`));
  }
  if (!parsed) {
    throw new XunleiApiError('captcha-bad-response', '验证码服务返回异常（非 JSON），请稍后重试');
  }
  if (parsed.error || parsed.error_code) {
    const code = parsed.error ?? parsed.error_code ?? 'captcha-error';
    throw new XunleiApiError(code, xunleiErrorText(code, parsed.error_description ?? `验证码服务错误（code: ${code}）`));
  }
  return parsed;
}

/* ============================== 统一业务请求 ============================== */

/** xlApiRequest 选项 */
export interface XlApiRequestOptions {
  method?: 'GET' | 'POST';
  /** 业务路径（不含 API_BASE），如 '/drive/v1/share' */
  path: string;
  /** query 参数；undefined 跳过，空串保留（真机 URL 形态见主线程契约） */
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /**
   * captcha action 覆盖（缺省 `method:path`）。
   * 特例：GET /drive/v1/files/<id> 的 action 是 `get:/drive/v1/files`（见契约），故需显式传。
   */
  action?: string;
  /** 登录态（restore/download 需要）；authorization 可裸 token（自动补 Bearer） */
  auth?: { authorization: string; userId?: string };
  /**
   * captcha token 分工（v1.4 Tzz 拍板，identity split）：
   * - `local`（缺省；scan 专用）：适配器用 alist 在野身份本地自造 token（见 getCaptchaToken）
   * - `injected`（restore/download/settings 专用）：**不本地自造、也不带** x-captcha-token
   *   —— web 端身份的 sign 前端算不出，由代理层（functions）向 backend 要 token 后透明注入
   * - `none`：完全不带 captcha 头（保留给不校验的只读端点/测试）
   */
  captcha?: 'local' | 'injected' | 'none';
  /** 错误文案里的步骤名（中文） */
  step?: string;
}

/** 拼 URL（query 值 encodeURIComponent；undefined 跳过） */
function buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
  const qs = Object.entries(query ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
}

function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

/** 登录态头归一：裸 token 自动补 `Bearer `（用户可能只贴 token） */
function normalizeBearer(auth: string): string {
  return /^Bearer\s+/i.test(auth) ? auth : `Bearer ${auth}`;
}

/** 传输层错误 → 中文 Error（CORS 提示与非迅雷域直连场景对齐 alipan） */
function toTransportError(err: unknown, step: string): Error {
  if (err instanceof TransportError) {
    if (err.kind === 'cors' && typeof window !== 'undefined') {
      return new Error(
        `网络请求失败（${step}）：${err.message}；迅雷 API 无 CORS 白名单，请在设置中填写代理地址`,
      );
    }
    return new Error(`网络请求失败（${step}）：${err.message}`);
  }
  return err instanceof Error ? err : new Error(`网络请求失败（${step}）：${String(err)}`);
}

/**
 * 迅雷业务 API 统一请求：加客户端头 + captcha_token（+ 可选 Authorization），
 * 解析业务错误（HTTP 4xx + body error/error_code），业务码 9 / captcha_invalid 时
 * 清缓存 + 同 action 重新 init 重试一次。
 *
 * alist 容错说明：alist 对错误码 4121/4122/10/16 会**刷新 access token**；
 * 本适配器的登录态是用户手填串（无 refresh_token），故只保留码 + 过期文案抛错，
 * 由 UI 提示重新填写（与 alipan AccessTokenInvalid 的处理同构）。
 */
export async function xlApiRequest<T>(opts: XlApiRequestOptions): Promise<T> {
  const method = opts.method ?? 'GET';
  const action = opts.action ?? `${method.toLowerCase()}:${opts.path}`;
  const step = opts.step ?? '迅雷接口';
  const userId = opts.auth?.userId ?? '0';
  const captchaMode = opts.captcha ?? 'local';

  const attempt = async (): Promise<T> => {
    // captcha token 分工（v1.4）：scan 本地自造；restore/download 由代理层/后端注入。
    // injected 模式下**不**发起本地 captcha/init（injected 的 sign 前端算不出）。
    const token = captchaMode === 'local' ? await getCaptchaToken(action, { userId }) : '';
    const deviceId = getDeviceId();
    const headers: Record<string, string> = {
      'x-client-id': XL_CLIENT.clientId,
      'x-device-id': deviceId,
      accept: '*/*',
      'content-type': 'application/json',
      origin: 'https://pan.xunlei.com',
      referer: 'https://pan.xunlei.com/',
      'user-agent': XL_CLIENT.ua,
    };
    // 仅本地自造出来的 token 才由适配器带上；injected 模式留空，等代理层注入
    if (token) headers['x-captcha-token'] = token;
    if (opts.auth?.authorization) headers.Authorization = normalizeBearer(opts.auth.authorization);

    let res: { status: number; body: string };
    try {
      res = await getActiveTransport().request({
        url: buildUrl(opts.path, opts.query),
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (err) {
      throw toTransportError(err, step);
    }

    const parsed = parseJson<T & XlApiErrorBody>(res.body);
    if (res.status < 200 || res.status >= 300) {
      const code = parsed?.error ?? parsed?.error_code ?? res.status;
      throw new XunleiApiError(code, xunleiErrorText(code, parsed?.error_description ?? `${step}失败（HTTP ${res.status}）`));
    }
    if (!parsed) {
      throw new XunleiApiError('bad-response', `${step}返回异常（非 JSON 或为空），请稍后重试`);
    }
    if (parsed.error !== undefined && parsed.error !== '' && parsed.error !== 0) {
      const code = parsed.error;
      throw new XunleiApiError(code, xunleiErrorText(code, parsed.error_description ?? `${step}失败（code: ${code}）`));
    }
    if (parsed.error_code !== undefined && parsed.error_code !== '' && parsed.error_code !== 0) {
      const code = parsed.error_code;
      throw new XunleiApiError(code, xunleiErrorText(code, parsed.error_description ?? `${step}失败（code: ${code}）`));
    }
    return parsed;
  };

  try {
    return await attempt();
  } catch (err) {
    // captcha 过期：业务码 9 / captcha_invalid → 清缓存重新 init，同 action 重试一次
    // 仅 local（scan，GET 幂等）自动重试；injected（restore/download，含写请求）**不重试**
    // —— 代理层每次转发都会按 >60s 门槛重新取 token，若仍被拒就是真实业务失败，
    //    贸然重试 restore 会重复转存（同号/配额问题）。
    if (
      captchaMode === 'local' &&
      err instanceof XunleiApiError &&
      (String(err.code) === String(9) || err.code === 'captcha_invalid')
    ) {
      clearCaptchaCache();
      return attempt();
    }
    throw err;
  }
}

/** 分享/业务请求统一客户端头（供调试/独立请求用；xlApiRequest 内部已拼） */
export function captchaHeaders(token: string): Record<string, string> {
  return {
    'x-client-id': XL_CLIENT.clientId,
    'x-device-id': getDeviceId(),
    'x-captcha-token': token,
  };
}

/* ============================== MD5（纯 TS，浏览器/Node 通用） ============================== */
/**
 * 纯 JS MD5（RFC 1321），输入按 UTF-8 编码，输出 32 位小写 hex。
 * 为什么不用 node:crypto / SubtleCrypto：浏览器无 node:crypto，且 SubtleCrypto 不支持 md5，
 * 而 captcha_sign 必须逐次同步计算 —— 故内置实现（已被单测与 node:crypto 对拍验证）。
 */
function md5Hex(input: string): string {
  const bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(input) : utf8Encode(input);
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;

  const origLen = bytes.length;
  const paddedLen = (origLen + 8 + 64) & ~63; // +1 字节 0x80 + 8 字节长度，再补齐到 64 的倍数
  const msg = new Uint8Array(paddedLen);
  msg.set(bytes);
  msg[origLen] = 0x80;
  const dv = new DataView(msg.buffer);
  const bitLen = origLen * 8;
  dv.setUint32(paddedLen - 8, bitLen >>> 0, true);
  dv.setUint32(paddedLen - 4, Math.floor(bitLen / 4294967296) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Uint32Array(16);

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << s[i]) | (F >>> (32 - s[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true);
  odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true);
  odv.setUint32(12, d0, true);
  let hex = '';
  for (let i = 0; i < 16; i++) hex += out[i].toString(16).padStart(2, '0');
  return hex;
}

/** 无 TextEncoder 时的 UTF-8 兜底编码（老浏览器；正常环境走 TextEncoder） */
function utf8Encode(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(++i);
      c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}
