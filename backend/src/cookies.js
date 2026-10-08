/**
 * 账号 cookie 池（docs/backend-wrangler-plan.md §4.1 保留 + 扩展）
 *
 * 字段名与 SPA 侧 CookieInputModal 对齐（v1.2 约定，勿改）：
 * - pan：adapter id —— 'quark' | 'uc'（与 src/adapters/registry.ts 的 id 一致）
 * - quark 存**整串** cookie（关键 key：__pus / __uid / __puus）
 * - uc 存 __pugs（游客态下载凭据，208 字符）
 * 读取时按 pan 合并进转发请求的 Cookie 头；服务端 Set-Cookie 刷新自动回写。
 *
 * v0.1.0-next 新增：
 * - kind 列（real | guest）：guest = 游客模拟账号，label 自动打标 guest#随机后缀
 *   （可追溯，排查 412/403 用）；每次使用时随机生成必要值（__pugs）并落库
 * - 注入时向 SPA 回传账号标识（x-panhub-account：quark#3 / guest#abc123），
 *   真实 cookie 整串绝不下发前端
 *
 * v1.2.2 新增（§9 P2）：
 * - runRefreshCycle()：cookie 刷新定时器（quark 优先）——轻量登录态请求捕获 set-cookie
 *   → mergeSetCookies；连续失败 ≥3 标 expired；整体 try/catch 永不崩溃
 */
import { getDb, encrypt, decrypt, audit, upsertAccountKeyTemp, getAccountKeyTemp, listAccountKeyTemps, listExpiredAccountKeyTemps, deleteAccountKeyTemp, deleteAccountKeyTempsOf } from './db.js';
import { log } from './log.js';
import { randomBytes } from 'node:crypto';

/** 已知凭据名（日志脱敏用；与 SPA redactSensitive 同思路） */
export const CREDENTIAL_KEYS = ['__pus', '__puus', '__pugs', '__uid', 'sdid', 'up', 'wk'];

/** pan → 关键 key（账号池表单/校验用；与 SPA 对齐） */
export const PAN_KEYS = {
  quark: ['__pus', '__uid', '__puus'],
  uc: ['__pugs'],
  // v1.4：迅雷不是 cookie 而是「授权头 + 转存目标目录」；面板录号走同一张表（键名同凭据串）
  xunlei: ['authorization', 'to_parent_id', 'user_id'],
  // v1.4.1：阿里云盘也是凭据串（auth/drive_id/to_parent_file_id），面板添加账号曾报「未知网盘 pan：alipan」
  alipan: ['authorization', 'drive_id', 'to_parent_file_id'],
};

/** guest 账号只认 __pugs（游客态下载凭据，quark 小文件/UC 同机制） */
export const GUEST_KEYS = ['__pugs'];

/** 从整串里取某 key 的值（无则 undefined） */
export function cookieValueOf(cookieString, key) {
  const stripped = String(cookieString ?? '').replace(/^cookie\s*:\s*/i, '');
  for (const pair of stripped.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    if (pair.slice(0, eq).trim() === key) return pair.slice(eq + 1).trim();
  }
  return undefined;
}

/** 整串里已有关键 key 列表（账号池表单实时检测） */
export function keysPresent(cookieString, pan, kind = 'real') {
  const keys = kind === 'guest' ? GUEST_KEYS : PAN_KEYS[pan] ?? [];
  return keys.filter((k) => Boolean(cookieValueOf(cookieString, k)));
}

/* ---------------- v1.4.1 凭据串结构编辑（按键级临时/长期；遗留#1） ---------------- */

/** 凭据串 → [[k,v],...]（保序；只取首个 '=' 分割） */
function credentialPairs(str) {
  const out = [];
  for (const part of String(str ?? '').split(';')) {
    const seg = part.trim();
    if (!seg) continue;
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    const k = seg.slice(0, eq).trim();
    const v = seg.slice(eq + 1).trim();
    if (k) out.push([k, v]);
  }
  return out;
}

function pairsToString(pairs) {
  return pairs.map(([k, v]) => `${k}=${v}`).join('; ');
}

function setPair(pairs, key, value) {
  const i = pairs.findIndex(([k]) => k === key);
  if (i >= 0) pairs[i][1] = value;
  else pairs.push([key, value]);
}

function dropPair(pairs, key) {
  const i = pairs.findIndex(([k]) => k === key);
  if (i >= 0) pairs.splice(i, 1);
}

/** 按键级临时的 TTL 归一（支持 ttlSeconds 便于测试 / ttlMinutes 面板用） */
function ttlMsOf(spec) {
  const ttlSeconds = Number(spec?.ttlSeconds);
  const ttlMinutes = Number(spec?.ttlMinutes);
  if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) return ttlSeconds * 1000;
  if (Number.isFinite(ttlMinutes) && ttlMinutes > 0) return ttlMinutes * 60_000;
  return 0;
}

/** 某账号已挂的按键级临时（key + 到期时间；**不带值**） */
export function accountTempKeys(accountId) {
  return listAccountKeyTemps(accountId);
}

/** 某账号凭据串的键存在性（**只回 hit/none，绝不回值**） */
export function accountKeyState(accountId) {
  const r = getDb().prepare('SELECT pan, kind, cookie_enc FROM accounts WHERE id = ?').get(Number(accountId));
  if (!r) return null;
  const plain = decrypt(r.cookie_enc) ?? '';
  const keys = (r.kind ?? 'real') === 'guest' ? GUEST_KEYS : PAN_KEYS[r.pan] ?? [];
  const state = {};
  for (const k of keys) state[k] = cookieValueOf(plain, k) ? 'hit' : 'none';
  return state;
}

/**
 * 到期清扫（按键级）：临时键恢复**旧值**（旧值不存在 → 删该键）；返回明细。
 * 挂到现有懒清 + 5min ticker 上即可（不要求秒级）。
 */
export function sweepAccountKeyTemps() {
  const rows = listExpiredAccountKeyTemps();
  const db = getDb();
  const out = [];
  for (const r of rows) {
    const acc = db.prepare('SELECT id, cookie_enc FROM accounts WHERE id = ?').get(r.account_id);
    if (acc) {
      const pairs = credentialPairs(decrypt(acc.cookie_enc) ?? '');
      const prev = r.prev_value_enc ? decrypt(r.prev_value_enc) : null;
      if (prev === null || prev === undefined) dropPair(pairs, r.key);
      else setPair(pairs, r.key, prev);
      db.prepare('UPDATE accounts SET cookie_enc = ?, updated_at = ? WHERE id = ?').run(encrypt(pairsToString(pairs)), Date.now(), r.account_id);
    }
    deleteAccountKeyTemp(r.account_id, r.key);
    out.push({ accountId: r.account_id, key: r.key, restored: Boolean(r.prev_value_enc) });
  }
  return out;
}

/* ---------------- CRUD ---------------- */

/** 账号列表（cookie 值脱敏：只露末 8 位；expiresAt/status/lastUsedAt 明细） */
/**
 * 账号列表（**读写分离：只回非敏感元数据**）。
 * v1.3.1（Tzz 定稿）：去掉 cookieTail / cookieLength / keys 等指纹字段 —— 读不裸奔；
 * 只保留备注/状态/时间 + **账号身份**（userId，非敏感，供辨认与滚动更新比对）。
 * 备注缺省时回退到身份（Tzz：不要回退 #num）。
 */
export function listAccounts() {
  const rows = getDb().prepare('SELECT * FROM accounts ORDER BY pan, id').all();
  return rows.map((r) => {
    const userId = accountIdentity(r);
    return {
      id: r.id,
      pan: r.pan,
      label: (r.label ?? '').trim() || userId || '',
      kind: r.kind ?? 'real',
      status: r.status,
      userId,
      expiresAt: r.expires_at,
      tempExpiresAt: r.temp_expires_at ?? null,
      isTemp: Boolean(r.temp_expires_at),
      lastUsedAt: r.last_used_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      // v1.4.1 遗留#1：按键级临时剩余时间（key + 到期，**不带值**）
      tempKeys: listAccountKeyTemps(r.id),
      // 凭据本体与任何指纹（长度/尾串/关键 key）都不出现在接口层
    };
  });
}

/** 单个账号（含解密后的整串，编辑回填用；仅 webui 本机可调） */
export function getAccount(id) {
  const r = getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!r) return null;
  return { ...r, cookieString: decrypt(r.cookie_enc) ?? '' };
}

/** 随机 __pugs 形态值（guest 账号每次使用重新生成；形状对齐真实凭据便于排查） */
export function randomPugs() {
  return randomBytes(156).toString('base64').replace(/[+/=]/g, (c) => (c === '+' ? '-' : c === '/' ? '_' : ''));
}

/** 账号对外标识（x-panhub-account 回传 SPA；真实 cookie 不下发） */
export function accountTag(a) {
  if (!a) return null;
  if (a.kind === 'guest') {
    const m = String(a.label ?? '').match(/^guest#(.+)$/);
    return m ? `guest#${m[1]}` : 'guest';
  }
  return `${a.pan}#${a.id}`;
}

/**
 * 新增/更新账号。
 * @param fields { id?, pan, label, cookieString, expiresAt?, kind? }
 *   kind='guest'：游客模拟账号 —— cookieString 可空（空则生成随机 __pugs）；
 *   label 缺省自动打标 guest#<随机6位>（可追溯）。
 */
export function upsertAccount(fields, via = 'webui') {
  const kind = fields.kind === 'guest' ? 'guest' : 'real';
  const pan = String(fields.pan ?? '').trim();
  if (!PAN_KEYS[pan]) throw new Error(`未知网盘 pan：${pan}（支持 ${Object.keys(PAN_KEYS).join('/')}）`);
  let cookieString = String(fields.cookieString ?? '').trim().replace(/^cookie\s*:\s*/i, '');
  let label = String(fields.label ?? '').trim().slice(0, 60);

  if (kind === 'guest') {
    // 游客模拟：cookieString 可空，空则生成随机 __pugs；label 打标 guest#随机后缀
    if (!cookieString) cookieString = `__pugs=${randomPugs()}`;
    if (!/^guest#/.test(label)) label = `guest#${Math.random().toString(36).slice(2, 8)}`;
  } else if (!cookieString) {
    throw new Error('cookie 为空，未保存');
  }

  const found = keysPresent(cookieString, pan, kind);
  if (found.length === 0) {
    throw new Error(
      `未识别到 ${kind === 'guest' ? '游客凭据' : pan} 关键 cookie key（${(kind === 'guest' ? GUEST_KEYS : PAN_KEYS[pan]).join(' / ')}），请检查粘贴内容`,
    );
  }
  const now = Date.now();
  const expiresAt = Number.isFinite(Number(fields.expiresAt)) && Number(fields.expiresAt) > 0 ? Number(fields.expiresAt) : null;
  // v1.3.1：临时写入 —— ttlMinutes > 0 时记录自动清除时间（到期由 sweepTempAccounts 清凭据，审计保留）
  const ttl = Number(fields.ttlMinutes);
  const tempExpiresAt = Number.isFinite(ttl) && ttl > 0 ? now + Math.round(ttl) * 60_000 : null;
  const enc = encrypt(cookieString);
  const db = getDb();
  // v1.4.1：按键级临时写入需要「写入前的旧值」快照（编辑时从旧凭据串取）
  const prevPlain = fields.id
    ? decrypt(db.prepare('SELECT cookie_enc FROM accounts WHERE id = ?').get(Number(fields.id))?.cookie_enc) ?? ''
    : '';
  let accountId;
  if (fields.id) {
    db.prepare(
      'UPDATE accounts SET pan=?, label=?, cookie_enc=?, expires_at=?, temp_expires_at=?, status=?, kind=?, updated_at=? WHERE id=?',
    ).run(pan, label, enc, expiresAt, tempExpiresAt, 'ok', kind, now, fields.id);
    audit(tempExpiresAt ? 'account.temp-write' : 'account.update', `${pan}/${label}${tempExpiresAt ? `（临时 ${Math.round(ttl)} 分钟）` : ''}`, via);
    accountId = Number(fields.id);
  } else {
    const info = db
      .prepare(
        'INSERT INTO accounts (pan, label, cookie_enc, expires_at, temp_expires_at, status, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(pan, label, enc, expiresAt, tempExpiresAt, 'ok', kind, now, now);
    audit(tempExpiresAt ? 'account.temp-write' : 'account.add', `${pan}/${label}${tempExpiresAt ? `（临时 ${Math.round(ttl)} 分钟）` : ''}`, via);
    accountId = Number(info.lastInsertRowid);
  }

  // ---- v1.4.1 遗留#1：按键级临时 / 长期（手动写入优先级最高）----
  const keyTemps = fields.keyTemps && typeof fields.keyTemps === 'object' ? fields.keyTemps : {};
  for (const [k, spec] of Object.entries(keyTemps)) {
    const ttlMs = ttlMsOf(spec);
    if (ttlMs > 0) {
      const existing = getAccountKeyTemp(accountId, k);
      const prev = cookieValueOf(prevPlain, k);
      // 首次临时化才快照旧值（已有记录只续期，不动 prev）
      upsertAccountKeyTemp(accountId, k, existing ? undefined : prev === undefined ? null : encrypt(prev), now + ttlMs);
    } else {
      deleteAccountKeyTemp(accountId, k);
    }
  }
  // 本次写入但未标「临时」的键 = 手动长期写入 → 清掉它们的临时记录（优先级最高）
  for (const [k] of credentialPairs(cookieString)) {
    if (!Object.prototype.hasOwnProperty.call(keyTemps, k)) deleteAccountKeyTemp(accountId, k);
  }
  return accountId;
}

/**
 * 清扫到期临时写入（v1.3.1）：只删凭据行，**审计保留**（Tzz：临时写入算新号，记得保留审计）。
 * @returns 被清除的账号摘要（供上层写审计/日志）
 */
export function sweepTempAccounts() {
  const now = Date.now();
  const rows = getDb().prepare('SELECT id, pan, label FROM accounts WHERE temp_expires_at IS NOT NULL AND temp_expires_at <= ?').all(now);
  if (rows.length === 0) return [];
  const stmt = getDb().prepare('DELETE FROM accounts WHERE id = ?');
  for (const r of rows) {
    stmt.run(r.id);
    deleteAccountKeyTempsOf(r.id); // v1.4.1：账号级到期清除时一并清按键级临时
  }
  return rows.map((r) => ({ id: r.id, pan: r.pan, label: r.label ?? '' }));
}

/** 删除账号 */
export function deleteAccount(id, via = 'webui') {
  const r = getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (r) {
    getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id);
    deleteAccountKeyTempsOf(id); // v1.4.1：连带清掉该账号的按键级临时记录
    audit('account.delete', `${r.pan}/${r.label ?? ''}`, via);
  }
}

/**
 * 转发时按目标域名找账号（v1 分流矩阵）：
 * - prase/download：优先正式账号（最近使用优先）；无正式账号时回退 guest 账号
 *   （guest 每次使用重新生成随机 __pugs 并落库，label guest#xxx 可追溯）
 * - scan：保持游客，不注入
 * @returns { account, cookieString, tag } | null
 */
export function pickAccountForPan(pan, operation = 'download') {
  // v1.3.1 四类词表：取号只对 download（旧名 prase）生效；scan/restore 不注入登录态
  if (operation !== 'download' && operation !== 'prase') return null;
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM accounts WHERE pan = ? AND kind = 'real' ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT 1")
    .all(pan);
  let row = rows[0] ?? null;
  if (!row) {
    const guests = db
      .prepare("SELECT * FROM accounts WHERE pan = ? AND kind = 'guest' ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT 1")
      .all(pan);
    row = guests[0] ?? null;
  }
  if (!row) return null;
  let plain = decrypt(row.cookie_enc) ?? '';
  if (!plain) return null;
  if ((row.kind ?? 'real') === 'guest') {
    // 每次使用随机生成必要值（__pugs），落库打标 guest#随机后缀
    plain = `__pugs=${randomPugs()}`;
    db.prepare('UPDATE accounts SET cookie_enc = ?, last_used_at = ?, updated_at = ? WHERE id = ?').run(
      encrypt(plain),
      Date.now(),
      Date.now(),
      row.id,
    );
  } else {
    db.prepare('UPDATE accounts SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
  }
  return { account: row, cookieString: plain, tag: accountTag(row) };
}

/**
 * 服务端 Set-Cookie 刷新合并（与 SPA 前端 mergeQuarkSetCookies 同构）：
 * 响应里的 __pus/__puus/__pugs 更新到账号池对应**正式**账号。
 * guest 账号跳过（游客占位值每次使用随机生成，不做真实凭据回写）。
 * @param pan    'quark' | 'uc'
 * @param setCookies  Set-Cookie 头值数组
 */
export function mergeSetCookies(pan, setCookies) {
  if (!Array.isArray(setCookies) || setCookies.length === 0) return;
  const keys = PAN_KEYS[pan] ?? [];
  const patches = new Map();
  for (const sc of setCookies) {
    const eq = sc.indexOf('=');
    if (eq <= 0) continue;
    const name = sc.slice(0, eq).trim();
    const value = sc.slice(eq + 1).split(';')[0].trim();
    if (keys.includes(name) && value) patches.set(name, value);
  }
  if (patches.size === 0) return;
  const db = getDb();
  for (const row of db.prepare("SELECT * FROM accounts WHERE pan = ? AND kind = 'real'").all(pan)) {
    const plain = decrypt(row.cookie_enc) ?? '';
    if (!plain) continue;
    let out = plain;
    for (const [k, v] of patches) {
      const exists = cookieValueOf(out, k) !== undefined;
      const rest = exists
        ? out
            .split(';')
            .filter((p) => p.indexOf('=') > 0 && p.slice(0, p.indexOf('=')).trim() !== k)
            .join('; ')
        : out;
      out = rest ? `${rest}; ${k}=${v}` : `${k}=${v}`;
    }
    if (out !== plain) {
      db.prepare('UPDATE accounts SET cookie_enc = ?, updated_at = ? WHERE id = ?').run(encrypt(out), Date.now(), row.id);
    }
  }
}

/** 统计各 pan 账号数（账号池页展示；区分 kind） */
export function countByPan() {
  return getDb().prepare('SELECT pan, kind, COUNT(*) AS n FROM accounts GROUP BY pan, kind').all();
}

/* ---------------- cookie 刷新定时器（v1.2.2 §9 P2：quark 优先） ---------------- */

const REFRESH_TIMEOUT_MS = 10_000;
const REFRESH_FAIL_LIMIT = 3; // 连续失败 ≥3 次 → 标记 expired

/**
 * 各 pan 的轻量登录态刷新端点（请求后捕获 set-cookie → mergeSetCookies）。
 * TODO(v1.2.2 §9 P2)：quark 刷新 URL 待真机验证 —— 先按设计稿实现，不硬编码断言成功；
 * uc 暂无轻量登录态接口（P4 再补），只有 quark 在表里就只刷 quark。
 * UA 参考 src/adapters/quark/types.ts QUARK_DL_UA（Electron 客户端 UA，夸克风控识别用）。
 */
const REFRESH_ENDPOINTS = {
  quark: {
    // 2026-08-30 真机验证：drive-h.quark.cn/1/clouddrive/account/info 404（旧值），
    // pan.quark.cn/account/info 200（{success, data:{nickname,...}}）——登录态保活用；
    // 无 set-cookie 时仅确认状态不合并（刷新 URL 已不再挂 404，避免误标 expired）
    url: 'https://pan.quark.cn/account/info',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.20.0 Chrome/112.0.5615.165 Electron/24.1.3.8 Safari/537.36 Channel/pckk_other_ch',
  },
};

/** 连续失败计数（内存态；重启清零） */
const failCounts = new Map();

/** 失败计数 +1；连续 ≥3 次 → 标 expired（计数清零，下轮重新累积） */
function bumpFail(accountId, pan) {
  const n = (failCounts.get(accountId) ?? 0) + 1;
  failCounts.set(accountId, n);
  if (n >= REFRESH_FAIL_LIMIT) {
    try {
      getDb().prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?').run('expired', Date.now(), accountId);
      audit('account.expired', `${pan}#${accountId} 连续刷新失败 ${REFRESH_FAIL_LIMIT} 次，标记 expired`, 'refresh');
      log('warn', `refresh：${pan}#${accountId} 连续失败 ${REFRESH_FAIL_LIMIT} 次，已标记 expired`);
    } catch {
      /* 落库失败不阻断 */
    }
    failCounts.delete(accountId);
  }
}

/**
 * 跑一轮 cookie 刷新：对每个 pan 的正式账号逐个发轻量登录态请求，
 * 捕获 set-cookie → mergeSetCookies(pan, setCookies)；成功恢复 ok，连续失败 ≥3 标 expired。
 * 整体 try/catch 永不崩溃（定时器调用方直接 await，异常不外抛）。
 */
export async function runRefreshCycle() {
  try {
    const db = getDb();
    for (const [pan, ep] of Object.entries(REFRESH_ENDPOINTS)) {
      const rows = db.prepare("SELECT * FROM accounts WHERE pan = ? AND kind = 'real'").all(pan);
      for (const row of rows) {
        try {
          const plain = decrypt(row.cookie_enc) ?? '';
          if (!plain) {
            bumpFail(row.id, pan);
            continue;
          }
          const res = await fetch(ep.url, {
            method: 'GET',
            headers: { cookie: plain, 'user-agent': ep.ua, accept: 'application/json' },
            signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
          });
          if (!res.ok) {
            log('warn', `refresh：${pan}#${row.id} 登录态检查失败（HTTP ${res.status}）`);
            bumpFail(row.id, pan);
            continue;
          }
          const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
          if (setCookies.length > 0) {
            mergeSetCookies(pan, setCookies);
            log('info', `refresh：${pan}#${row.id} 合并 set-cookie ${setCookies.length} 条`);
          }
          failCounts.delete(row.id);
          if ((row.status ?? 'ok') !== 'ok') {
            db.prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?').run('ok', Date.now(), row.id);
            log('info', `refresh：${pan}#${row.id} 恢复 ok`);
          }
        } catch (err) {
          log('warn', `refresh：${pan}#${row.id} 失败 — ${err?.message ?? err}`);
          bumpFail(row.id, pan);
        }
      }
    }
  } catch (err) {
    log('error', `refresh：周期异常 — ${err?.message ?? err}`);
  }
}

/* ============================== v1.3.1 账号身份（非敏感） ============================== */

/**
 * 离线解凭据串里的 JWT 账号 id（规则与前端 carry.ts 一致：userId → user_id → sub → uid）。
 * 凭据串形态：alipan `auth=Bearer xxx;drive_id=…`（也可能只贴 Bearer/纯 token）；uc/quark 是 cookie 整串。
 */
function decodeAccountUserId(credentialString) {
  const s = String(credentialString ?? '');
  let token = /Bearer\s+([A-Za-z0-9._~+/=-]+)/i.exec(s)?.[1];
  if (!token) {
    const m = /(?:^|[;\s])auth=([A-Za-z0-9._~+/=-]+)/i.exec(s);
    if (m) token = m[1].replace(/^Bearer\s+/i, '');
  }
  if (!token || token.split('.').length !== 3) return null;
  try {
    const json = Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const claims = JSON.parse(json);
    for (const key of ['userId', 'user_id', 'sub', 'uid']) {
      const v = claims?.[key];
      if (typeof v === 'string' && v) return v;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 账号身份（**非敏感**，可回传 SPA/functions 做账号比对）：
 * JWT userId → `drive:<drive_id>`（凭据里显式写的）→ 账号标签兜底（uc/quark 无 JWT 时只能如此）。
 * 注意：**绝不返回凭据本体**；Tzz D2：换号不换 #3 没意义，优先 userId。
 */
export function accountIdentity(a) {
  if (!a) return null;
  let plain = '';
  try {
    plain = decrypt(a.cookie_enc) ?? '';
  } catch {
    plain = '';
  }
  const userId = decodeAccountUserId(plain);
  if (userId) return userId;
  const driveId = /drive_id=([A-Za-z0-9_-]+)/i.exec(plain)?.[1];
  if (driveId) return `drive:${driveId}`;
  return accountTag(a);
}

/** 某网盘（缺省全部）可用账号的身份集合（去重；只含非敏感身份） */
export function listAccountIdentities(pan = null) {
  const rows = pan
    ? getDb().prepare('SELECT * FROM accounts WHERE pan = ? ORDER BY id').all(pan)
    : getDb().prepare('SELECT * FROM accounts ORDER BY pan, id').all();
  const out = [];
  for (const r of rows) {
    const id = accountIdentity(r);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}
