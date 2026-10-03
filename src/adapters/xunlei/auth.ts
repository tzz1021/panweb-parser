/**
 * 迅雷云盘登录态凭据存取与解析（docs/STRUCTURE.md：src/adapters/xunlei/auth.ts）
 *
 * 迅雷 scan 免登录；但 restore/download 需要 `Authorization: <token_type> <access_token>`。
 *
 * 存储策略（Tzz 2026-10-03 定稿，与 quark/alipan 全局方案一致）：
 * - **主存 localStorage**（键 `XL_AUTH_STORAGE_KEY`），写入按字段**合并**（参考 alipan 的凭据快捷更新：
 *   粘贴只带 authorization 时不得冲掉已存的 to_parent_id / captcha_sign）；
 * - 读取顺序 localStorage → sessionStorage（后者是历史临时填写框的遗留位置，兼容一版）；
 * - 清除时两边一起清。
 *
 * 凭据串格式（与 CookieInputModal 整串模式对齐）：
 *   `authorization=Bearer xxx;to_parent_id=<转存目标目录 file_id>;captcha_sign=<可选>;user_id=<可选>`
 * - authorization：必填。网页端已登录后抓包/DevTools 里的 Authorization 头整行
 *   （可只贴 token，代码自动补 `Bearer `）；支持**裸 `Bearer xxx`** 与纯 JWT。
 * - to_parent_id：转存目标目录 file_id（`settings{restore_path}` + `share/restore{parent_id}` 用）。
 *   别名兼容 `restore_path` / `to_parent_file_id`（早期命名）。
 * - captcha_sign：可选。**应急自备**用：web 端 sign 前端算不出（后端有自己的一份、不下发前端）；
 *   若用户自带一份（形如 `1.<32hex>`）则随凭据一起保存并可用于直连链路。
 * - user_id：可选。登录账号 user_id（captcha meta.user_id 用；缺省游客 '0'）。
 *
 * device_id 不在本文件另开：captcha.ts#getDeviceId() 是同一 session 内唯一来源
 * （restore 必须用同一个 device_id，故复用而非新建）。
 */
import { XL_AUTH_STORAGE_KEY } from './types';

/** 凭据串关键键（弹窗展示/校验用；顺序 = 推荐书写顺序） */
export const XUNLEI_AUTH_KEYS = ['authorization', 'to_parent_id', 'captcha_sign', 'user_id'] as const;

/** 解析结果（authorization 未填为空串） */
export interface XunleiAuth {
  /** Authorization 头值（可含/不含 Bearer 前缀；未填为空串） */
  authorization: string;
  /** 登录账号 user_id（可选；captcha meta.user_id 缺省 '0'） */
  userId?: string;
  /** 转存目标目录 file_id（= to_parent_id；download 的 settings/restore 用；未填则下载会报错） */
  restorePath?: string;
  /** captcha_sign（可选；应急自备用，后端/账号池模式下由后端持有） */
  captchaSign?: string;
}

/* ====== 存储访问（localStorage 主 / sessionStorage 兼容；node/测试环境内存兜底） ====== */
const memLocal = new Map<string, string>();
const memSession = new Map<string, string>();

type StoreKind = 'local' | 'session';

function storeGet(kind: StoreKind, key: string): string | null {
  try {
    if (kind === 'local' && typeof localStorage !== 'undefined') return localStorage.getItem(key);
    if (kind === 'session' && typeof sessionStorage !== 'undefined') return sessionStorage.getItem(key);
  } catch {
    // 隐私模式异常 → 内存兜底
  }
  return (kind === 'local' ? memLocal : memSession).get(key) ?? null;
}

function storeSet(kind: StoreKind, key: string, value: string): void {
  try {
    if (kind === 'local' && typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
      return;
    }
    if (kind === 'session' && typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(key, value);
      return;
    }
  } catch {
    // 落内存
  }
  (kind === 'local' ? memLocal : memSession).set(key, value);
}

function storeRemove(kind: StoreKind, key: string): void {
  try {
    if (kind === 'local' && typeof localStorage !== 'undefined') {
      localStorage.removeItem(key);
      return;
    }
    if (kind === 'session' && typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(key);
      return;
    }
  } catch {
    // 落内存
  }
  (kind === 'local' ? memLocal : memSession).delete(key);
}

/** 读取当前生效的迅雷凭据串；优先级：localStorage（主） > sessionStorage（历史兼容）；无则 '' */
export function getXunleiAuthString(): string {
  const l = storeGet('local', XL_AUTH_STORAGE_KEY);
  if (l && l.trim()) return l.trim();
  const s = storeGet('session', XL_AUTH_STORAGE_KEY);
  return s && s.trim() ? s.trim() : '';
}

/** 解析后的当前凭据（便捷入口） */
export function getXunleiAuth(): XunleiAuth {
  return parseXunleiAuthString(getXunleiAuthString());
}

/** 序列化（固定键顺序，便于人工检查与 diff） */
function serializeAuth(auth: XunleiAuth): string {
  const parts: string[] = [];
  if (auth.authorization) parts.push(`authorization=${auth.authorization}`);
  if (auth.restorePath) parts.push(`to_parent_id=${auth.restorePath}`);
  if (auth.captchaSign) parts.push(`captcha_sign=${auth.captchaSign}`);
  if (auth.userId) parts.push(`user_id=${auth.userId}`);
  return parts.join(';');
}

/**
 * 写入迅雷凭据串（空串 = 清除）。
 * **按字段合并**：本次解析出的非空字段覆盖旧的，未提及的字段保留（防「粘贴只带 token 冲掉转存目录」）。
 * 主存 localStorage；同时清掉 sessionStorage 里的同名键，避免两处不一致。
 */
export function setXunleiAuth(authString: string): void {
  const clean = (authString ?? '').trim();
  if (!clean) {
    clearXunleiAuth();
    return;
  }
  const incoming = parseXunleiAuthString(clean);
  const prev = parseXunleiAuthString(getXunleiAuthString());
  const merged: XunleiAuth = {
    authorization: incoming.authorization || prev.authorization,
    restorePath: incoming.restorePath ?? prev.restorePath,
    captchaSign: incoming.captchaSign ?? prev.captchaSign,
    userId: incoming.userId ?? prev.userId,
  };
  storeSet('local', XL_AUTH_STORAGE_KEY, serializeAuth(merged));
  storeRemove('session', XL_AUTH_STORAGE_KEY);
}

/** 清除凭据（localStorage + sessionStorage 一起清） */
export function clearXunleiAuth(): void {
  storeRemove('local', XL_AUTH_STORAGE_KEY);
  storeRemove('session', XL_AUTH_STORAGE_KEY);
}

/** 是否已具备登录态（有可解析的 authorization） */
export function hasXunleiAuth(authString: string): boolean {
  return parseXunleiAuthString(authString).authorization.length > 0;
}

/**
 * 容错解析凭据串：
 * - 键值对 `authorization=…;to_parent_id=…;captcha_sign=…;user_id=…`
 *   （别名：`auth` / `restore_path` / `to_parent_file_id` / `userid`）
 * - 裸 `Bearer xxx` 整行（无键名）→ 当作 authorization
 * - 纯 JWT（三段 base64url）→ 当作 authorization
 */
export function parseXunleiAuthString(authString: string): XunleiAuth {
  const src = (authString ?? '').trim();
  const out: XunleiAuth = { authorization: '' };
  if (!src) return out;

  for (const part of src.split(';')) {
    const seg = part.trim();
    if (!seg) continue;
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    const key = seg.slice(0, eq).trim().toLowerCase();
    const value = seg.slice(eq + 1).trim();
    if (!value) continue;
    if (key === 'authorization' || key === 'auth') out.authorization = value;
    else if (key === 'user_id' || key === 'userid') out.userId = value;
    else if (key === 'to_parent_id' || key === 'restore_path' || key === 'to_parent_file_id') out.restorePath = value;
    else if (key === 'captcha_sign') out.captchaSign = value;
  }

  // 裸 Bearer / 纯 JWT 容错（无 `authorization=` 键时）
  if (!out.authorization) {
    const bearer = /Bearer\s+([A-Za-z0-9._~+/=-]+)/i.exec(src);
    const bare = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.exec(src);
    const token = bearer?.[1] ?? bare?.[0];
    if (token) out.authorization = token;
  }
  return out;
}

/** 当前凭据串里已有的关键键（弹窗「已检测到…」展示；裸 Bearer 也按 authorization 补报） */
export function xunleiAuthKeysPresent(authString: string): string[] {
  const esc = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alias: Record<string, string> = {
    authorization: 'authorization',
    auth: 'authorization',
    to_parent_id: 'to_parent_id',
    restore_path: 'to_parent_id',
    to_parent_file_id: 'to_parent_id',
    captcha_sign: 'captcha_sign',
    user_id: 'user_id',
    userid: 'user_id',
  };
  const found = new Set<string>();
  for (const part of (authString ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const mapped = alias[part.slice(0, eq).trim().toLowerCase()];
    if (mapped) found.add(mapped);
  }
  if (!found.has('authorization') && parseXunleiAuthString(authString).authorization) {
    found.add('authorization');
  }
  return XUNLEI_AUTH_KEYS.filter((k) => found.has(k) || new RegExp(`(?:^|;)\\s*${esc(k)}=`).test(authString ?? ''));
}
