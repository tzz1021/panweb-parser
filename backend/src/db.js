/**
 * SQLite 存储 + AES-256-GCM 加密（docs/backend-wrangler-plan.md §4.1 重构）
 *
 * - node:sqlite（Node ≥22.5 内置，零 native 依赖；Termux/bionic 友好）
 * - 账号 cookie 密文：`v1:iv:tag:cipher`（AES-256-GCM，密钥来自 data/period/secret.key）
 * - 表：accounts / hosts / proxy_logs / file_hits / settings / audit_log
 *
 * v1.2.2（trace v2）变化：
 * - proxy_logs 加 frontend_id 列（SPA ProxyTransport 每请求 randomUUID，后端缺失兜底）
 * - 新增 file_hits 表（文件级 fid/md5/name/size，§2.2 白名单）+ fid/md5/ts 索引
 * - 新增 deleteLogsOlderThan / purgeAllLogs（保留期清理 + 手动清空，两表联动）
 *
 * v0.1.0-next 变化：
 * - accounts 加 kind 列（real | guest，guest = 游客模拟账号，label 带 guest# 随机后缀可追溯）
 * - proxy_logs 加 via 列（hop=backend 增强 hop 捕获 / wrangler=stdout 行解析聚合）、
 *   req_body / resp_body 列（截断 64KB 落库，完整进 data/tmp/debug-*.log）
 * - 新增 hosts 表（host → pan 注入映射，只增不减：只允许新增，不允许删除）
 */
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { PERIOD_DIR, loadSecretKey } from './config.js';

let db = null;
let secretKey = null;

/** 加密（返回 v1:iv:tag:cipher base64 拼接串） */
export function encrypt(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/** 解密（格式不符/密钥不对 → 返回 null，不抛） */
export function decrypt(payload) {
  try {
    const [v, ivB64, tagB64, dataB64] = String(payload).split(':');
    if (v !== 'v1') return null;
    const decipher = createDecipheriv('aes-256-gcm', secretKey, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** 查询某表是否已有某列（node:sqlite 无 PRAGMA 快捷封装，用 raw 查询） */
function columnExists(table, column) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}

/** 初始化（幂等）+ 轻量迁移（旧库补列，不丢数据） */
export function initDb() {
  if (db) return db;
  secretKey = loadSecretKey();
  db = new DatabaseSync(join(PERIOD_DIR, 'panhub.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY,
      pan TEXT NOT NULL,              -- 'quark' | 'uc' | ...
      label TEXT,                     -- 备注名（guest 账号 = guest#随机后缀）
      cookie_enc TEXT NOT NULL,       -- AES-256-GCM 密文
      expires_at INTEGER,             -- 已知过期时间（可空）
      status TEXT DEFAULT 'ok',       -- ok | expired | risk
      last_used_at INTEGER,
      temp_expires_at INTEGER,        -- v1.3.1：临时写入的自动清除时间（到期只清凭据，审计保留）
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS hosts (
      host TEXT PRIMARY KEY,          -- 域名（如 drive.quark.cn）
      pan TEXT NOT NULL,              -- 注入映射的网盘 id（quark | uc）
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS proxy_logs (
      id INTEGER PRIMARY KEY,
      ts INTEGER,
      pan TEXT,
      operation TEXT,                 -- scan | prase | other
      method TEXT, url TEXT,
      req_status INTEGER,
      duration_ms INTEGER,
      account_id INTEGER,
      queued_ms INTEGER,
      client_ip TEXT,
      req_headers TEXT,               -- 脱敏 JSON
      resp_headers TEXT,              -- 脱敏 JSON（凭据值 SHA-256）
      body_preview TEXT
    );
    CREATE TABLE IF NOT EXISTS file_hits (
      id INTEGER PRIMARY KEY,
      frontend_id TEXT,
      ts INTEGER,
      pan TEXT,
      account_id INTEGER,             -- 命中账号 id（可空）
      client_ip TEXT,                 -- 哈希化 IP（可空）
      fid TEXT,
      md5 TEXT,
      file_name TEXT,
      size INTEGER,
      category INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_fh_fid ON file_hits(fid);
    CREATE INDEX IF NOT EXISTS idx_fh_md5 ON file_hits(md5);
    CREATE INDEX IF NOT EXISTS idx_fh_ts  ON file_hits(ts);
    CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
    -- v1.4.1 智能写入：按键级临时写入的**旧值快照**（到期恢复旧值，不是清空）
    CREATE TABLE IF NOT EXISTS setting_temps (
      k TEXT PRIMARY KEY,
      prev_v TEXT,
      expires_at INTEGER
    );
    -- v1.4.1 遗留#1：账号凭据串内部的**按键级**临时写入（值同样 AES 加密；到期恢复旧值/删键）
    CREATE TABLE IF NOT EXISTS account_key_temps (
      account_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      prev_value_enc TEXT,
      expires_at INTEGER,
      PRIMARY KEY (account_id, key)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY,
      ts INTEGER,
      action TEXT,
      detail TEXT,
      via TEXT
    );
  `);
  // ---- 轻量迁移（旧库补列） ----
  if (!columnExists('accounts', 'temp_expires_at')) {
    db.exec(`ALTER TABLE accounts ADD COLUMN temp_expires_at INTEGER`);
  }
  if (!columnExists('accounts', 'kind')) {
    db.exec(`ALTER TABLE accounts ADD COLUMN kind TEXT DEFAULT 'real'`);
  }
  if (!columnExists('proxy_logs', 'via')) {
    db.exec(`ALTER TABLE proxy_logs ADD COLUMN via TEXT DEFAULT 'hop'`);
  }
  if (!columnExists('proxy_logs', 'frontend_id')) {
    db.exec(`ALTER TABLE proxy_logs ADD COLUMN frontend_id TEXT DEFAULT ''`);
  }
  if (!columnExists('proxy_logs', 'req_ms')) {
    db.exec(`ALTER TABLE proxy_logs ADD COLUMN req_ms INTEGER`);
  }
  if (!columnExists('proxy_logs', 'req_body')) {
    db.exec(`ALTER TABLE proxy_logs ADD COLUMN req_body TEXT DEFAULT ''`);
  }
  if (!columnExists('proxy_logs', 'resp_body')) {
    db.exec(`ALTER TABLE proxy_logs ADD COLUMN resp_body TEXT DEFAULT ''`);
  }
  // v1.4 迅雷域 → pan 映射（host 只增不减：INSERT OR IGNORE）。
  // 功能上 proxy.js#panOfHostname 已按后缀兜底 xunlei.com；落表是为了面板可见/终端可查。
  for (const host of ['api-pan.xunlei.com', 'xluser-ssl.xunlei.com']) {
    db.prepare('INSERT OR IGNORE INTO hosts (host, pan, created_at) VALUES (?,?,?)').run(host, 'xunlei', Date.now());
  }
  return db;
}

export function getDb() {
  if (!db) initDb();
  return db;
}

/** 审计写入（webui/cli/terminal 都走这里） */
export function audit(action, detail = '', via = 'webui') {
  try {
    getDb().prepare('INSERT INTO audit_log (ts, action, detail, via) VALUES (?,?,?,?)').run(Date.now(), action, String(detail).slice(0, 500), via);
  } catch {
    /* 审计失败不阻断 */
  }
}

/* ---------------- settings 键值（敏感字段加密） ---------------- */
export function getSetting(key) {
  const row = getDb().prepare('SELECT v FROM settings WHERE k = ?').get(key);
  return row ? row.v : null;
}
export function setSetting(key, value) {
  getDb().prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, String(value));
}

/* ---------------- v1.4.1 智能写入：按键级「临时/长期」+ 到期恢复旧值 ---------------- */

/**
 * 智能写入单个设置键。
 * - `ttlMs > 0`：临时写入 —— 首次写入时 **快照当前值**，到期由 `sweepTempSettings()` **恢复旧值**
 *   （不是清空；旧值本就不存在时才删键）；重复写入同一键只续期、不覆盖快照。
 * - `ttlMs <= 0`：长期写入（**手动写入优先级最高**）—— 写值并**清掉该键的临时记录**。
 * @returns {{key:string, temp:boolean, expiresAt:number|null, restoredFrom:string|null}}
 */
export function setSettingSmart(key, value, ttlMs = 0) {
  const k = String(key ?? '').trim();
  if (!k) throw new Error('设置键不能为空');
  const db = getDb();
  if (Number(ttlMs) > 0) {
    const cur = getSetting(k);
    const existing = db.prepare('SELECT k, prev_v FROM setting_temps WHERE k = ?').get(k);
    const expiresAt = Date.now() + Number(ttlMs);
    if (!existing) {
      db.prepare('INSERT INTO setting_temps (k, prev_v, expires_at) VALUES (?,?,?)').run(k, cur === null ? null : String(cur), expiresAt);
    } else {
      db.prepare('UPDATE setting_temps SET expires_at = ? WHERE k = ?').run(expiresAt, k);
    }
    setSetting(k, value);
    return { key: k, temp: true, expiresAt, restoredFrom: existing ? existing.prev_v : (cur === null ? null : String(cur)) };
  }
  setSetting(k, value);
  const before = db.prepare('SELECT prev_v FROM setting_temps WHERE k = ?').get(k);
  db.prepare('DELETE FROM setting_temps WHERE k = ?').run(k);
  return { key: k, temp: false, expiresAt: null, restoredFrom: before?.prev_v ?? null };
}

/** 到期临时写入清扫：**恢复旧值**（旧值不存在则删键）；返回本次处理明细 */
export function sweepTempSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM setting_temps WHERE expires_at <= ?').all(Date.now());
  for (const r of rows) {
    if (r.prev_v === null || r.prev_v === undefined) db.prepare('DELETE FROM settings WHERE k = ?').run(r.k);
    else db.prepare('INSERT INTO settings (k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(r.k, r.prev_v);
    db.prepare('DELETE FROM setting_temps WHERE k = ?').run(r.k);
  }
  return rows.map((r) => ({ key: r.k, restored: r.prev_v !== null && r.prev_v !== undefined }));
}

/** 当前挂着的临时写入（面板显示 + 测试断言） */
export function listTempSettings() {
  return getDb()
    .prepare('SELECT k, expires_at FROM setting_temps ORDER BY expires_at')
    .all()
    .map((r) => ({ key: r.k, expiresAt: r.expires_at }));
}

/* ---------------- v1.4.1 账号凭据串的按键级临时（遗留#1） ---------------- */

/** 写/更新某账号某键的临时记录（首次调用方负责传 prev_value_enc 快照） */
export function upsertAccountKeyTemp(accountId, key, prevValueEnc, expiresAt) {
  getDb()
    .prepare(
      'INSERT INTO account_key_temps (account_id, key, prev_value_enc, expires_at) VALUES (?,?,?,?)\n       ON CONFLICT(account_id, key) DO UPDATE SET expires_at = excluded.expires_at',
    )
    .run(Number(accountId), String(key), prevValueEnc === undefined ? null : prevValueEnc, Number(expiresAt));
}

/** 某账号已挂的按键级临时（可按 key 查） */
export function getAccountKeyTemp(accountId, key) {
  return (
    getDb()
      .prepare('SELECT account_id, key, prev_value_enc, expires_at FROM account_key_temps WHERE account_id = ? AND key = ?')
      .get(Number(accountId), String(key)) ?? null
  );
}

/** 某账号全部按键级临时（面板显示剩余时间用；**不带值**） */
export function listAccountKeyTemps(accountId) {
  return getDb()
    .prepare('SELECT key, expires_at FROM account_key_temps WHERE account_id = ? ORDER BY expires_at')
    .all(Number(accountId))
    .map((r) => ({ key: r.key, expiresAt: r.expires_at }));
}

/** 已到期的全部按键级临时记录（清扫用） */
export function listExpiredAccountKeyTemps(now = Date.now()) {
  return getDb().prepare('SELECT account_id, key, prev_value_enc, expires_at FROM account_key_temps WHERE expires_at <= ?').all(now);
}

/** 删某账号某键的临时记录（手动长期写入 = 最高优先级时调） */
export function deleteAccountKeyTemp(accountId, key) {
  getDb().prepare('DELETE FROM account_key_temps WHERE account_id = ? AND key = ?').run(Number(accountId), String(key));
}

/** 删某账号的全部临时记录（账号被删 / 账号级临时到期清扫时调） */
export function deleteAccountKeyTempsOf(accountId) {
  getDb().prepare('DELETE FROM account_key_temps WHERE account_id = ?').run(Number(accountId));
}

/** 最近审计记录（新→旧；可选关键字过滤 action/detail/via） */
export function listAudit(limit = 200, q) {
  const db = getDb();
  if (q) {
    const kw = `%${String(q).toLowerCase()}%`;
    return db
      .prepare("SELECT * FROM audit_log WHERE lower(action) LIKE ? OR lower(detail) LIKE ? OR lower(COALESCE(via,'')) LIKE ? ORDER BY id DESC LIMIT ?")
      .all(kw, kw, kw, limit);
  }
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
}

/* ---------------- hosts 表（host → pan 注入映射；只增不减） ---------------- */

/** 全部映射（终端 hosts list / 看板展示） */
export function listHosts() {
  return getDb().prepare('SELECT host, pan, created_at FROM hosts ORDER BY host').all();
}

/**
 * 新增映射（host 操作允许新增 —— 只增不减，幂等 INSERT OR IGNORE）。
 * @returns { added: boolean, host, pan }
 */
export function addHost(host, pan) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!h || h.includes('..') || h.includes('/') || h.length > 253) throw new Error('host 不合法（只接受纯域名）');
  if (!['quark', 'uc', 'xunlei', 'alipan'].includes(pan)) throw new Error('pan 只支持 quark / uc / xunlei / alipan');
  const info = getDb()
    .prepare('INSERT OR IGNORE INTO hosts (host, pan, created_at) VALUES (?,?,?)')
    .run(h, pan, Date.now());
  return { added: info.changes > 0, host: h, pan };
}

/** 按 host 查映射（无则 null） */
export function findHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!h) return null;
  return getDb().prepare('SELECT host, pan FROM hosts WHERE host = ?').get(h) ?? null;
}

/* ---------------- 日志保留期（v1.2.2 §2.3：长期存放 + 定时清理） ---------------- */

/**
 * 删除超过保留天数的日志（proxy_logs + file_hits 两表联动）。
 * @param days 保留天数（默认 30）；0 = 保留期立即截止（约等于清空）
 * @returns { proxy_logs, file_hits } 各自删除行数
 */
export function deleteLogsOlderThan(days = 30) {
  const cutoff = Date.now() - Math.max(0, Number(days) || 0) * 86400_000;
  const db = getDb();
  const a = db.prepare('DELETE FROM proxy_logs WHERE ts < ?').run(cutoff);
  const b = db.prepare('DELETE FROM file_hits WHERE ts < ?').run(cutoff);
  return { proxy_logs: Number(a.changes), file_hits: Number(b.changes) };
}

/** 全清两表（POST /api/web/logs/purge 的 days 省略分支；连带 ts IS NULL 的行） */
export function purgeAllLogs() {
  const db = getDb();
  const a = db.prepare('DELETE FROM proxy_logs').run();
  const b = db.prepare('DELETE FROM file_hits').run();
  return { proxy_logs: Number(a.changes), file_hits: Number(b.changes) };
}
