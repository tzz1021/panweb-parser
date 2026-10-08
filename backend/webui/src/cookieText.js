/**
 * 凭据文本解析（webui 侧；v1.4.1）
 *
 * 与 SPA `src/adapters/quark/cookies.ts#parseCookieText` 及 backend `src/cookie-text.js` **同一套语义**：
 * ①JSON（editthiscookie 数组/对象）②Netscape（制表符 ≥7 列）③Header 串（`k=v; k2=v2`）都认。
 * 面板粘贴任意一种都能自动转成请求头格式，并按网盘键做**输入即实时**的检测。
 */
export function parseCookieText(text) {
  const src = String(text ?? '').trim();
  if (!src) throw new Error('内容为空，请粘贴或选择 cookie 文件');
  const out = {};

  // 1. JSON
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
      /* 非 JSON，继续 */
    }
  }

  // 2. Netscape
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

/** 是否「结构化」文本（Netscape / JSON）—— 用于决定要不要自动转换 */
export function looksStructured(text) {
  const src = String(text ?? '');
  return /^\s*[[{]/.test(src) || src.includes('\t') || /^#\s*Netscape/i.test(src);
}

/** {name:value} → 请求头串 `k=v; k2=v2` */
export function toHeaderString(parsed) {
  return Object.entries(parsed ?? {})
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}
