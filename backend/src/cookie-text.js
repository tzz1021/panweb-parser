/**
 * 凭据文本解析（backend/src/cookie-text.js，v1.4.1）
 *
 * 与 SPA `src/adapters/quark/cookies.ts#parseCookieText` **同一套语义**（Netscape / JSON / Header 串都认），
 * 供 backend 侧（CDP 抓取入库 / 面板粘贴）复用；webui 侧有一份同构实现（backend/webui/src/cookieText.js）。
 *
 * 为什么单独一份：CDP 抓到的 cookie 需要先拼成 Netscape 文本再统一解析入库（Tzz：**不再按「取前 N 个」截断**）。
 */

/**
 * 解析 cookie 文本 → { name: value }。
 * 支持：① JSON（editthiscookie 数组/对象）② Netscape（制表符 ≥7 列）③ Header 串（`k=v; k2=v2`，可带 `Cookie:` 前缀）。
 * @throws {Error} 内容为空 / 无法识别
 */
export function parseCookieText(text) {
  const src = String(text ?? '').trim();
  if (!src) throw new Error('内容为空，请粘贴或选择 cookie 文件');
  const out = {};

  // 1. JSON（editthiscookie 数组 / 对象）
  if (src.startsWith('[') || src.startsWith('{')) {
    try {
      const parsed = JSON.parse(src);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of arr) {
        if (item && typeof item === 'object') {
          const name = item.name ?? item.key ?? item.cookie;
          const value = item.value;
          if (typeof name === 'string' && name && typeof value === 'string') out[name] = value;
        }
      }
      if (Object.keys(out).length > 0) return out;
    } catch {
      /* 不是合法 JSON → 当普通文本继续 */
    }
  }

  // 2. Netscape（domain flag path secure expiry name value）
  if (/^#\s*Netscape/i.test(src) || src.includes('\t')) {
    let hit = 0;
    for (const line of src.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const cols = t.split('\t');
      if (cols.length >= 7 && cols[5] && cols[6]) {
        out[cols[5]] = cols[6];
        hit++;
      }
    }
    if (hit > 0) return out;
  }

  // 3. Header string
  const stripped = src.replace(/^cookie\s*:\s*/i, '');
  for (const pair of stripped.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k && v) out[k] = v;
  }
  if (Object.keys(out).length > 0) return out;

  throw new Error('未能识别 cookie 内容（支持 Netscape / JSON / Header 字符串）');
}

/**
 * CDP 抓到的 cookie 数组 → Netscape 文本（全量，不截断）。
 * 字段顺序：domain \t TRUE(域名生效) \t path \t TRUE(https) \t expiry \t name \t value
 */
export function buildNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies ?? []) {
    if (!c || typeof c.name !== 'string' || !c.name) continue;
    const domain = String(c.domain ?? '');
    const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const path = String(c.path ?? '/');
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expiry = Number.isFinite(Number(c.expires)) && Number(c.expires) > 0 ? Math.floor(Number(c.expires)) : 0;
    lines.push([domain, includeSub, path, secure, expiry, c.name, String(c.value ?? '')].join('\t'));
  }
  return lines.join('\n');
}

/**
 * 从解析出的 {name:value} 里挑凭据串。
 * @param {Record<string,string>} parsed
 * @param {string[]} whitelist 该网盘关心的键（顺序即输出顺序）
 * @param {{ keepUnlisted?: boolean }} [opts] keepUnlisted = 白名单外的键也带上（默认 false）
 * @returns {string|null} `k=v; k2=v2`（一个都没命中 → null）
 */
export function cookieStringFrom(parsed, whitelist, opts = {}) {
  const parts = [];
  const seen = new Set();
  for (const k of whitelist ?? []) {
    if (parsed?.[k] !== undefined && parsed[k] !== '') {
      parts.push(`${k}=${parsed[k]}`);
      seen.add(k);
    }
  }
  if (opts.keepUnlisted) {
    for (const [k, v] of Object.entries(parsed ?? {})) {
      if (!seen.has(k) && v !== undefined && v !== '') parts.push(`${k}=${v}`);
    }
  }
  return parts.length > 0 ? parts.join('; ') : null;
}
