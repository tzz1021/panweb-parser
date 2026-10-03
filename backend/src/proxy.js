/**
 * 增强 hop（docs/backend-wrangler-plan.md §3/§4 重构，v1.2.2 trace v2）
 *
 * backend 的 /api/proxy 不是转发实现，是**增强 hop**：
 *   token 校验 → 账号注入 → 转发 wrangler（wrangler 执行 functions/api/proxy.js
 *   全部校验：token/白名单/限频，转发代码唯一一份）→ set-cookie 合并回账号池
 *   → 两阶段 trace（v1.2.2 §3）落库
 *
 * trace v2（两阶段写入，§3）：
 *   阶段一（请求开始）：INSERT(proxy_logs: frontend_id, ts, url, operation, method, client_ip, via)
 *   阶段二（转发完成）：UPDATE(pan, account_id, req_status, req_ms, duration_ms, body_preview)
 *                     + 批量 INSERT(file_hits)（文件级 fid/md5/name/size，§2.2 白名单）
 *   req_body / resp_body 列保留但不再写入（防磁盘膨胀；完整 body 只进 data/tmp/debug-*.log）
 *   上游挂/中途失败：行留在 req_status IS NULL → 看板标严重警告（错误分支不做处理，天然留痕）
 *
 * 边界（设计稿 §2.2 硬约束）：
 * - 校验策略（token/白名单/限频）只属于 functions/api/proxy.js —— 这里不重复实现白名单/限频
 * - 这里只校验 X-Proxy-Token（timingSafeEqual，与 wrangler 同一把 token，防恶意网页直打 127.0.0.1）
 * - 不直连上游：所有请求经 wrangler（本机 loopback ~1ms，换来 wrangler 面板可见流量）
 *
 * IP 隐私（§8）：默认不采集（空串）；请求头带 x-panhub-trace: ip-hash 时存 sha256(clientIp + secret.key hex)
 */
import { createHash, randomUUID } from 'node:crypto';
import { getConfig, loadSecretKey } from './config.js';
import { verifyProxyToken } from './auth.js';
import { log, writeDebugTrace } from './log.js';
import { getDb, audit, findHost, getSetting } from './db.js';
import { pickAccountForPan, mergeSetCookies, accountTag } from './cookies.js';

const UPSTREAM_TIMEOUT_MS = 25_000;

/**
 * URL 特征 → 操作分类（v1.3.1 四类：scan | download | restore | credential-pick | other）。
 * 与 SPA `src/core/transport/types.ts#classifyOperation`、云端 `functions/api/_shared/proxy-core.js#classifyOperation`
 * **同一张表**（三处最小复制，改一处必须同步；冒烟断言防漂移）。
 * legacy：历史 trace 的 `prase` 读作 download（backend stats 侧归一）。
 */
function classifyOperation(url) {
  if (/sharepage\/(token|detail)/.test(url)) return 'scan'; // uc/quark
  if (/\/v2\/share_link\/get_share_token|\/adrive\/v2\/file\/get_by_share|\/adrive\/v2\/file\/list_by_share/.test(url)) return 'scan'; // alipan
  if (/file\/download/.test(url)) return 'download'; // uc/quark
  if (/\/v2\/file\/get_download_url/.test(url)) return 'download'; // alipan
  if (/\/adrive\/v4\/batch/.test(url)) return 'restore'; // alipan 批量转存
  // xunlei（v1.4）：restore 必须先判（/share/restore 会被 scan 的 /share 前缀吃穷）
  if (/\/drive\/v1\/share\/restore/.test(url)) return 'restore'; // 迅雷转存
  if (/\/drive\/v1\/share(\?|$)|\/drive\/v1\/share\/detail/.test(url)) return 'scan'; // 迅雷分享根 / 目录 detail
  if (/\/drive\/v1\/files\//.test(url)) return 'download'; // 迅雷文件详情（取 web_content_link）
  return 'other';
}

/** host → pan：内置后缀 + hosts 表（host 只增不减）双通道 */
function panOfHostname(hostname) {
  const h = String(hostname ?? '').toLowerCase();
  if (h.endsWith('uc.cn')) return 'uc';
  if (h.endsWith('quark.cn')) return 'quark';
  if (h.endsWith('xunlei.com')) return 'xunlei'; // v1.4：api-pan.xunlei.com / xluser-ssl.xunlei.com
  const mapped = findHost(h);
  return mapped ? mapped.pan : null;
}

/* ---------------- IP 哈希化（§8：默认不采集；x-panhub-trace: ip-hash 时启用） ---------------- */

/** salt = secret.key 内容 hex（进程内缓存；与 cookie 加密同密钥文件） */
let ipSalt = null;
function clientIpHash(clientIp) {
  if (ipSalt === null) ipSalt = loadSecretKey().toString('hex');
  return createHash('sha256').update(String(clientIp ?? '') + ipSalt).digest('hex');
}

/* ---------------- file_hits 提取（v1.2.2 §2.2 白名单） ---------------- */

/**
 * 从上游响应 JSON 提取文件列表（批量 N 文件 = N 行 file_hits）。
 * 白名单：fid / file_name / md5（必须，至少 fid 或 md5 其一可追溯才保留）、size / category（可选）；
 * pdir_fid / obj_key 可选但表内无列（不落库）；OSS 直链 / thumbnail / preview / _extra 一律丢弃。
 * 解析失败 → 返回 []（try/catch 不阻断请求）。
 * 响应形状（与 src/adapters/quark 对齐）：
 *   scan  (sharepage/detail)：{ data: { list: [{ fid, file_name, size, category, ... }] } }
 *   prase (file/download)   ：{ data: [{ md5, file_name, size, ... }] }（数组与请求体 fids 按序对应）
 */
function extractFileHits(bodyText, reqBody) {
  if (typeof bodyText !== 'string' || bodyText.length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return [];
  }
  const data = parsed?.data;
  if (!data || typeof data !== 'object') return [];
  const out = [];
  const seen = new Set();
  const collect = (item, fallbackFid) => {
    if (!item || typeof item !== 'object') return;
    const fid = item.fid ?? fallbackFid ?? null;
    const md5 = item.md5 ?? null;
    const file_name = item.file_name ?? null;
    if (!fid && !md5) return; // 无可追溯 key（fid/md5 都无）→ 丢弃
    const dedupeKey = `${String(fid ?? '')}|${String(md5 ?? '')}|${String(file_name ?? '')}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    out.push({
      fid: fid != null ? String(fid).slice(0, 200) : null,
      md5: md5 != null ? String(md5).slice(0, 64) : null,
      file_name: file_name != null ? String(file_name).slice(0, 255) : null,
      size: Number.isFinite(Number(item.size)) && Number(item.size) >= 0 ? Number(item.size) : null,
      category: Number.isFinite(Number(item.category)) ? Number(item.category) : null,
    });
  };
  if (Array.isArray(data)) {
    // prase：download 响应 data 是数组；请求体 fids 按序对应（适配层同序映射）
    const fids = Array.isArray(reqBody?.fids) ? reqBody.fids : [];
    data.forEach((item, i) => collect(item, fids[i] ?? null));
  } else if (Array.isArray(data.list)) {
    // scan：detail 响应 data.list
    for (const item of data.list) collect(item);
  } else if (Array.isArray(data.files)) {
    for (const item of data.files) collect(item);
  }
  return out;
}

/** 批量 INSERT file_hits（单事务；返回插入行数） */
function insertFileHits(rows, frontendId, ts, pan, accountId, clientIp) {
  if (rows.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(
    'INSERT INTO file_hits (frontend_id, ts, pan, account_id, client_ip, fid, md5, file_name, size, category) VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  db.exec('BEGIN');
  try {
    for (const r of rows) stmt.run(frontendId, ts, pan, accountId, clientIp, r.fid, r.md5, r.file_name, r.size, r.category);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
  return rows.length;
}

/**
 * 转发到 wrangler（唯一转发实现在 functions/api/_shared/proxy-core.js，wrangler 侧执行）。
 * v1.3.1 四类拆分：优先发 `${wrangler.port}/api/<类>`；对面是旧部署（404/405）→ 兜底 /api/proxy 重发一次，
 * 行为与拆分前一致（launcher 起的老 wrangler 不需要同步升级）。
 */
async function forwardToWrangler(payload, proxyToken, kind = 'other') {
  const cfg = getConfig();
  const path = kind === 'other' ? '/api/proxy' : `/api/${kind}`;
  const url = `http://127.0.0.1:${cfg.wrangler.port}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' ? `wrangler 超时（>${UPSTREAM_TIMEOUT_MS / 1000}s）` : `wrangler 不可达（${err?.message ?? err}）`;
    throw new Error(`${reason} —— 请确认 wrangler 已启动（launcher start/debug）`);
  }
  const body = await res.text();
  const headers = {};
  // 剥 hop-by-hop 头：undici 自动解压响应体，但 content-encoding/content-length 等头仍留在 headers 里
  // → 透传后下游拿到「gzip 头 + 明文 body」，浏览器/undici 解压直接报错（实测 incorrect header check）
  const HOP_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer']);
  res.headers.forEach((v, k) => {
    if (!HOP_HEADERS.has(k)) headers[k] = v;
  });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return { status: res.status, headers, setCookies, body };
}

/**
 * 处理 POST /api/proxy（单 listener 路由）。
 * @param reqBody 已解析的 JSON body（{ url, method, headers, body, frontend_id? }，与 proxy.js 协议一致）
 * @param clientIp 直连 remoteAddress（XFF 不可信，仅哈希/落库）
 * @param proxyToken X-Proxy-Token 请求头值（与 wrangler 同一把令牌）
 * @param traceHeader x-panhub-trace 请求头值（含 ip-hash → client_ip 哈希化存储）
 * @returns Response 兼容对象 { status, headers, body }
 */
export async function handleProxy(reqBody, clientIp, proxyToken, traceHeader = '') {
  const started = Date.now();
  const fail = (status, message) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: status === 401 ? 'UNAUTHORIZED' : 'HOP_ERROR', message }) });

  // ① 令牌（timingSafeEqual；与 wrangler 同一把）
  if (!verifyProxyToken(proxyToken)) {
    audit('proxy.reject', `token 无效 from ${clientIp}`, 'hop');
    log('warn', `hop：令牌无效，拒绝（${clientIp}）`);
    return fail(401, 'X-Proxy-Token 无效');
  }
  if (!reqBody || typeof reqBody !== 'object' || typeof reqBody.url !== 'string' || !reqBody.url) {
    return fail(400, '请求体必须是 { url, method, headers, body }');
  }

  // ② URL 解析 + 网盘 × 操作分类（仅用于账号注入决策，不做白名单校验——那是 wrangler 的事）
  let target;
  try {
    target = new URL(reqBody.url);
  } catch {
    return fail(400, 'url 不是合法 URL');
  }
  const pan = panOfHostname(target.hostname);
  const operation = classifyOperation(target.href);
  const method = String(reqBody.method ?? 'GET').toUpperCase();

  // ②.5 阶段一写入（trace v2 §3）：请求开始 INSERT —— frontend_id / ts / url / operation / method / client_ip / via
  const frontendId = typeof reqBody.frontend_id === 'string' && reqBody.frontend_id ? reqBody.frontend_id : randomUUID();
  const clientIpStored = String(traceHeader ?? '').toLowerCase().includes('ip-hash') ? clientIpHash(clientIp) : '';
  let logRowId = null;
  try {
    const info = getDb()
      .prepare('INSERT INTO proxy_logs (frontend_id, ts, url, operation, method, client_ip, via) VALUES (?,?,?,?,?,?,?)')
      .run(frontendId, started, target.href.slice(0, 300), operation, method, clientIpStored, 'hop');
    logRowId = Number(info.lastInsertRowid);
  } catch (err) {
    log('error', `hop：阶段一落库失败 — ${err.message}`);
  }

  // ③ 账号注入（v1 分流矩阵：download 注入登录态，scan 保持游客；
  //    无正式账号时回退 guest 账号——随机 __pugs 占位，label guest#xxx 可追溯）
  const outHeaders = {};
  for (const [k, v] of Object.entries(reqBody.headers ?? {})) outHeaders[k.toLowerCase()] = v;
  let hit = null; // { account, tag }
  if (pan && operation === 'download') {
    hit = pickAccountForPan(pan, operation);
    if (hit) {
      const prev = outHeaders.cookie ? `${outHeaders.cookie}; ` : '';
      outHeaders.cookie = prev + hit.cookieString;
    }
  }

  // ④ 转发 wrangler（原样透传协议体；req_ms = 上游耗时）
  const forwardStart = Date.now();
  let upstream;
  try {
    upstream = await forwardToWrangler(
      { url: target.href, method, headers: outHeaders, body: reqBody.body ?? null },
      proxyToken,
      operation,
    );
    // v1.3.1 过渡：wrangler 侧还是旧部署（没有 /api/<类> 路由）→ 用兼容别名重发一次
    if (upstream.status === 404 || upstream.status === 405) {
      upstream = await forwardToWrangler(
        { url: target.href, method, headers: outHeaders, body: reqBody.body ?? null },
        proxyToken,
        'other',
      );
    }
  } catch (err) {
    log('error', `hop：wrangler 转发失败 — ${err.message}`);
    return { status: 502, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'WRANGLER_UNAVAILABLE', message: err.message }) };
  }
  const reqMs = Date.now() - forwardStart;
  const durationMs = Date.now() - started;

  // ⑤ set-cookie 合并回账号池（仅正式账号；guest 占位不参与）+ 回传凭据头
  // 注意：wrangler proxy.js 不回传原始 set-cookie 头，只回传提取值（x-quark-pus/x-quark-puus/x-pugs）
  // → 账号池合并以回传头为准（PAN_KEYS 白名单：quark=__pus/__uid/__puus；__pugs 不在白名单天然跳过）
  const setCookies = upstream.setCookies;
  const headerPatches = [];
  for (const [key, hv] of [['__pus', upstream.headers['x-quark-pus']], ['__puus', upstream.headers['x-quark-puus']]]) {
    if (hv) headerPatches.push(`${key}=${hv}`);
  }
  if (pan && (setCookies.length > 0 || headerPatches.length > 0)) {
    mergeSetCookies(pan, [...setCookies, ...headerPatches]);
  }

  // ⑥ 响应头组装：透传 wrangler 的 CORS/凭据回传头 + 命中账号标识
  const respHeaders = { ...upstream.headers };
  // v1.2.2 fix（09-02）：取号兜底回传 __puus —— 账号池 __puus 仍有效时夸克不刷新
  // （上游无 x-quark-puus，SPA 拿不到大文件 OSS 导出凭据，六种导出方式全缺 __puus）；
  // 回传本次实际下发到上游的 cookie 里的 __puus（同一授权会话，CDN 认这个值）。
  if (pan === 'quark' && operation === 'download' && hit && !respHeaders['x-quark-puus']) {
    const m = hit.cookieString.match(/(?:^|;\s*)__puus=([^;]*)/);
    if (m && m[1]) respHeaders['x-quark-puus'] = m[1];
  }
  // v1.2.2 集成修复：中文账号标签必须 encodeURIComponent —— Node http 会丢弃/乱码非 ASCII 响应头
  if (hit?.tag) respHeaders['x-panhub-account'] = encodeURIComponent(hit.tag);
  // v1.2.2 fix（09-03）：代理托管可用标记 —— 命中**正式账号**才回传 x-panhub-backend: ok；
  // 前端据此区分「代理托管已就绪（无需手动 cookie）」vs「随机游客尝试」（guest 占位不发，话术才准确）。
  // 此前该头全链路无人下发 → 前端 09-02 守卫永不生效：取号成功也误报「未检测到 selfhost」。
  if (hit?.account?.kind === 'real') respHeaders['x-panhub-backend'] = 'ok';
  // v1.3.1 四类规范：托管状态头 x-panhub-credential: hit|guest|none
  // （词表唯一，与 SPA `core/transport/types.ts#CredentialState`、functions `_shared/proxy-core.js` 同表；
  //   旧头 x-panhub-backend 保留一版，兼容未升级的 SPA）
  respHeaders['x-panhub-credential'] = hit?.account?.kind === 'real' ? 'hit' : hit ? 'guest' : 'none';

  // ⑦ 阶段二写入（trace v2 §3）：UPDATE 请求行 + 批量 file_hits + debug 文件（完整 body）
  try {
    const reqBodyText = typeof reqBody.body === 'string' ? reqBody.body : '';
    // v1.3.1 隐私（Tzz 审阅）：文件明细粒度 full | safe | off
    // （名称+大小+哈希可对上游撞库反查文件；共享/公开部署建议 safe 或 off）
    const detail = String(getSetting('trace_file_detail') ?? 'full');
    let files = detail === 'off' ? [] : extractFileHits(upstream.body, reqBody);
    if (detail === 'safe') files = files.map((f) => ({ ...f, name: null, md5: null }));
    const db = getDb();
    if (logRowId != null) {
      db.prepare('UPDATE proxy_logs SET pan=?, account_id=?, req_status=?, req_ms=?, duration_ms=?, body_preview=? WHERE id=?')
        .run(pan, hit?.account?.id ?? null, upstream.status, reqMs, durationMs, upstream.body.slice(0, 500), logRowId);
    }
    const inserted = insertFileHits(files, frontendId, started, pan, hit?.account?.id ?? null, clientIpStored);
    writeDebugTrace({
      via: 'hop',
      ts: started,
      durationMs,
      reqMs,
      frontendId,
      clientIp,
      clientIpStored,
      pan,
      operation,
      method,
      url: target.href,
      account: hit ? { id: hit.account.id, tag: hit.tag, kind: hit.account.kind, label: hit.account.label } : null,
      req_headers: outHeaders,
      req_body: reqBodyText,
      resp_status: upstream.status,
      resp_headers: upstream.headers,
      resp_body: upstream.body,
      set_cookies: setCookies,
      file_hits: files,
    });
    log('info', `hop：${operation} ${pan ?? ''} ${method} ${target.hostname} → ${upstream.status}（${durationMs}ms / 上游 ${reqMs}ms${hit ? `，账号 ${hit.tag}` : ''}${inserted ? `，文件 ${inserted} 个` : ''}）`, {
      pan, operation, durationMs, accountId: hit?.account?.id ?? null,
    });
  } catch (err) {
    log('error', `hop：阶段二落库失败 — ${err.message}`);
  }

  return { status: upstream.status, headers: respHeaders, body: upstream.body };
}
