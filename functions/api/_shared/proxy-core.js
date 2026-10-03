/**
 * panhub_praser —— CF Pages Function 转发**共享核心**（v1.3.1 四类拆分）
 *
 * 本文件不是路由（`_` 前缀目录不生成路由）：被同级四类薄路由引用 ——
 *   functions/api/scan.js / download.js / restore.js （+ 兼容别名 functions/api/proxy.js）
 * 每个路由把自己的类别传进来；转发引擎、白名单、限频、取号、trace 全部在这里一份实现。
 * 类别词表（判据表见下 classifyOperation；与 backend/src/proxy.js 同表，冒烟断言防漂移）：
 *   scan（免登录：分享临时凭据 + 目录 list）· download（取直链/OSS 相关上游请求）·
 *   restore（转存）· credential-pick（取号类自有端点）· other（未识别）
 *   legacy：历史 trace 里的 `prase` 读作 download（见 backend stats 归一）
 *
 * 设计依据：docs/transport.md（传输层协议 §代理协议 / §CF Pages Functions 实现）
 * 职责：SPA 侧绕过 CORS —— 浏览器把网盘 API 请求 POST 到这里，服务端转发。
 *
 * 额外职责（reverse-notes-uc.md §10.2）：捕获 upstream `set-cookie: __pugs=`
 * 并回传 `x-pugs` 响应头 —— SPA 据此拿到 UC 下载层唯一必需的 __pugs 令牌，
 * 注入 curl/aria2/gopeed 导出命令。
 *
 * 安全模型（docs/transport.md §关键设计决策 3）：
 *   1. X-Proxy-Token 校验（env PROXY_TOKEN，部署时生成）→ 401
 *   2. 目标域名白名单（uc.cn / 后续接入的网盘域）→ 403
 *   3. 每 IP 限频（120 req/min，内存滑动窗口，per-isolate 尽力而为）→ 429
 *
 * 边界：
 *   - 只转发 API JSON，不转发文件流（直链是 OSS 签名 URL，用户浏览器直连下载）
 *   - cookie 头放行（v1.1.9 夸克登录态需要，风险由 SPA 弹窗告知）；
 *     v1.2.x alipan 追加 authorization / x-share-token / x-canary / x-device-id：
 *     alipan prase（转存 + 取直链）的登录态是 Authorization: Bearer（非 cookie），
 *     x-share-token 是分享源授权（与 Cookie 同风险级，SPA 弹窗已红点告知公用代理自担）
 *   - 只转发白名单请求头（content-type / accept / accept-language / cookie / user-agent /
 *     authorization / x-share-token / x-canary / x-device-id），其余全部丢弃
 *
 * 部署：
 *   - Pages 项目根目录放本文件 → 自动生成 POST /api/proxy 路由（与静态站同域，SPA 侧无需跨域）
 *   - 环境变量：PROXY_TOKEN（必配，fail-closed：未配置一律 503）
 *   - 本地调试：`wrangler pages dev . -- var PROXY_TOKEN=xxx`（或 dashboard 配好后线上测）
 *
 * v1.2.2 云端分支（设计稿 docs/backend-wrangler-plan.md §1.2/§3；本地无 env 时零行为变化）：
 *   - 协议体新增可选 frontend_id（SPA ProxyTransport 每次请求 crypto.randomUUID()，缺失不报错）
 *   - env.BACKEND_URL 存在时：仅 operation==='prase' 经 {BACKEND_URL}/api/credential-pick 取号
 *     （800ms 短超时 + 模块级可用性缓存 5s；成功 → cookie 追加进转发头并回传 x-panhub-account 标签，
 *     失败/超时 → 照旧用 SPA 自带 cookie；scan 保持游客，与本地 hop 语义一致）
 *   - env.TRACE_D1 === '1' && env.DB 时：ctx.waitUntil 两阶段写 D1（proxy_logs + file_hits，schema 与本地同构），
 *     其余情况整段跳过（本地 launcher 生成的 .dev.vars TRACE_D1=0 天然不触发）
 */

const ALLOWED_HOST_SUFFIXES = [
  'uc.cn', // UC 网盘（token/detail/download 三连全在 pc-api.uc.cn / drive.uc.cn）
  'quark.cn', // 夸克网盘（v1.1.9：token/detail/download 全在 drive-h.quark.cn；大文件需登录 cookie）
  'aliyundrive.com', // 阿里云盘（v1.2.x alipan：scan/prase 全在 api.aliyundrive.com）
  'alipan.com', // 阿里云盘别名域（api.alipan.com 同构；旧域 www.aliyundrive.com 入口也在 alipan 主域下）
  'xunlei.com', // 迅雷云盘（v1.4 xunlei：api-pan.xunlei.com 走分享/转存/详情，xluser-ssl.xunlei.com 走 captcha/init）
];

const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
const MAX_BODY_BYTES = 1024 * 1024; // 1MB，API JSON 足够
const UPSTREAM_TIMEOUT_MS = 20_000; // API JSON 小流量，20s 封顶

const RATE_LIMIT_PER_MIN = 120; // 每 IP 每分钟（v1.3.2 拍板：60 → 120，宽松优先）
// 依据（2026-09/10 讨论）：429 基本不是上游给的，而是本站代理层自己限的；单标签页按 1s 3 次
// 并发 2 算标，60s 全打满也才 ~180 请求，且大多数分享没有这么多子目录 —— 给 120 足够，
// 有人抱怨就请其自建转发代理（见结果页 banner 文案）。
const RATE_WINDOW_MS = 60_000;

/** per-isolate 内存滑动窗口（CF 是分布式隔离，这里只是"简单限频"；
 *  要硬限频请改用 CF Rate Limiting / KV 计数） */
const ipHits = new Map(); // ip -> number[]（时间戳）

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  // v1.2.2：x-panhub-trace（IP 采集 consent 头，默认关）需要进预检白名单才能跨域发送
  'Access-Control-Allow-Headers': 'content-type, x-proxy-token, x-panhub-trace',
  // 跨域部署（如 SPA 在 GitHub Pages、代理在 pages.dev）时，浏览器需要显式放行才能读到 x-pugs 等回传头；
  // v1.2.2：+ x-panhub-account（代理托管账号 label，SPA 展示用）
  // v1.3.1：+ x-panhub-credential（托管状态词表 hit|guest|none，SPA 据此判「是否托管生效」）
  'Access-Control-Expose-Headers':
    'x-pugs, x-quark-pus, x-quark-puus, x-panhub-account, x-panhub-backend, x-panhub-credential',
  'Access-Control-Max-Age': '86400',
};

export function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...extra },
  });
}

/** 校验 X-Proxy-Token（env 未配置 → fail-closed 503，绝不裸奔） */
export function checkToken(request, env) {
  const expected = env.PROXY_TOKEN;
  if (!expected) {
    return json(503, { error: 'PROXY_TOKEN_NOT_CONFIGURED', message: '代理未配置 PROXY_TOKEN，拒绝服务（fail-closed）' });
  }
  const got = request.headers.get('x-proxy-token') ?? '';
  if (got !== expected) {
    return json(401, { error: 'UNAUTHORIZED', message: 'X-Proxy-Token 无效' });
  }
  return null;
}

/** 目标域名白名单：host == 后缀 或 host 以 .后缀 结尾 */
function hostAllowed(hostname) {
  const h = hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

/** 简单限频：返回 null 放行，否则返回 429 Response */
export function checkRateLimit(request) {
  const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const now = Date.now();
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_PER_MIN) {
    ipHits.set(ip, hits);
    return json(429, { error: 'RATE_LIMITED', message: `请求过于频繁（${RATE_LIMIT_PER_MIN}/min/IP）` });
  }
  hits.push(now);
  ipHits.set(ip, hits);
  return null;
}

/**
 * 从 Set-Cookie 响应头里提取 __pugs 值（UC 下载鉴权唯一必需 cookie，§10.1/§12）。
 * 兼容两种运行时：Workers 的 headers.get('set-cookie') 只回第一个值；
 * Node/undici 会把多个 Set-Cookie 用 ", " 拼接 —— 这里按“__pugs= 出现在任意段”匹配。
 */
function extractPugs(setCookie) {
  if (!setCookie) return null;
  // 按逗号分段（cookie 值本身不含逗号/分号，安全）；也可直接用宽松正则兜底
  const m = setCookie.match(/(?:^|,)\s*__pugs=([^;,\s]*)/);
  return m ? m[1] : null;
}

/** 透传前清理请求头：只留白名单；authorization 类凭据与 cookie 同策略放行（见文件头边界说明）。
 * cookie 例外（v1.1.9 夸克）：登录态 cookie（整串 __pus/__uid/__puus）随 download 请求发送，
 * 大文件（>50MB）必需 —— SPA 弹窗已红点警告“公用代理自担账号安全”，代理端放行。
 * v1.2.x alipan 例外：authorization（Bearer 登录态）/ x-share-token（分享源授权）/ x-canary /
 * x-device-id —— alipan 转存与取直链必需（无 cookie 通道），与夸克 cookie 同一风险级。
 *
 * v1.1.9.2 fix2：键名**大小写归一**后再匹配 —— SPA 适配器发的是 'Content-Type'/'Cookie'（大写），
 * JS 对象键区分大小写，直接 headers['cookie'] 会拿不到 → 登录态 cookie 被静默丢弃，
 * 夸克 download 再次 400（23018），wrangler 日志里表现为“modal 的中间变量没发到 transport”。
 * v1.1.9.final：白名单加 user-agent —— 夸克 download 校验 Electron 客户端 UA（非定制 UA → 401），
 * SPA 经 JSON body 传来（浏览器禁改 UA，direct 下无效），代理端透传给上游。 */
function forwardHeaders(headers) {
  const out = {};
  const lower = {};
  for (const k of Object.keys(headers ?? {})) lower[k.toLowerCase()] = headers[k];
  for (const name of [
    'content-type',
    'accept',
    'accept-language',
    'cookie',
    'user-agent',
    'authorization',
    'x-share-token',
    'x-canary',
    'x-device-id',
    // v1.4 迅雷：scan 的本地自造 token / 代理层注入的 token 都必须能到达上游
    'x-captcha-token',
    'x-client-id',
  ]) {
    const v = lower[name];
    if (typeof v === 'string' && v) out[name] = v;
  }
  return out;
}

/* ============ v1.2.2 云端分支：取号 + D1 trace（本地无 env 时全部不触发，零行为变化） ============ */

/**
 * URL 特征 → 操作分类（v1.3.1 四类：scan | download | restore | credential-pick | other）。
 * 与 backend/src/proxy.js#classifyOperation **同一张表**（最小复制 + 冒烟断言防漂移）。
 * legacy：v1.3.1 前写入 trace 的 `prase` 读作 download（历史 uc/quark download 与 alipan 两跳无法再细分）。
 */
export function classifyOperation(url) {
  // scan：免登录的分享凭据 + 分享目录列表
  if (/sharepage\/(token|detail)/.test(url)) return 'scan'; // uc/quark
  if (/\/v2\/share_link\/get_share_token|\/adrive\/v2\/file\/get_by_share|\/adrive\/v2\/file\/list_by_share/.test(url)) return 'scan'; // alipan
  // download：上游取直链 / OSS 相关
  if (/file\/download/.test(url)) return 'download'; // uc/quark
  if (/\/v2\/file\/get_download_url/.test(url)) return 'download'; // alipan
  // restore：转存（旧称 copy）
  if (/\/adrive\/v4\/batch/.test(url)) return 'restore'; // alipan 批量转存（内层 url:/file/copy）
  // xunlei（v1.4）：restore 必须先判（/share/restore 会被 scan 的 /share 前缀吃穷）
  if (/\/drive\/v1\/share\/restore/.test(url)) return 'restore'; // 迅雷转存
  if (/\/drive\/v1\/share(\?|$)|\/drive\/v1\/share\/detail/.test(url)) return 'scan'; // 迅雷分享根 / 目录 detail
  if (/\/drive\/v1\/files\//.test(url)) return 'download'; // 迅雷文件详情（取 web_content_link）
  return 'other';
}

/** host → pan（云端无 hosts 表，内置 uc/quark/alipan 后缀判定；与 backend panOfHostname 同一语义，最小复制） */
function panOfHostname(hostname) {
  const h = String(hostname ?? '').toLowerCase();
  if (h.endsWith('uc.cn')) return 'uc';
  if (h.endsWith('quark.cn')) return 'quark';
  if (h.endsWith('aliyundrive.com') || h.endsWith('alipan.com')) return 'alipan';
  if (h.endsWith('xunlei.com')) return 'xunlei'; // v1.4：api-pan / xluser-ssl 都在 xunlei.com
  return null;
}

/* ============ v1.4 架构说明：迅雷账号相关请求不再走本转发链路 ============
 * settings / restore / rename / download 属账号相关操作，由 backend 用自己的
 * device_id / captcha_token / authorization 代发（functions/api/xunlei-op.js → backend runOp）。
 * SPA 只发 ops 意图；本链路仅服务 scan（SPA 本地自造 captcha）与其他网盘。
 * 不要用后端 device/captcha 替换前端请求 —— captcha 绑定 device_id，冒用会把后端设备甚至账号标记（Tzz 2026-10-03）。
 */

/** BACKEND_URL 可用性缓存（模块级；成功/失败都缓存 5s，避免每请求探测宕机后端） */
let backendAvail = { ok: true, at: 0 };

function backendKnownDown(now) {
  return !backendAvail.ok && now - backendAvail.at < 5000;
}

function rememberBackend(ok, now) {
  backendAvail = { ok, at: now };
}

/**
 * 云端取号（credential-pick）：POST {BACKEND_URL}/api/credential-pick（800ms 短超时，设计稿 §1.2）。
 * v1.3.1 改名（旧端点 cookie-pick → credential-pick；旧路径仍兜底一版以兼容未升级的 backend）。
 * 成功 → { cookie, account_id, tag, kind, userId? }；失败/超时/后端不可用 → null（回落 SPA 自带 cookie）。
 */
async function pickAccountFromBackend(env, pan, operation) {
  const now = Date.now();
  if (backendKnownDown(now)) return null; // 已知不可用，5s 内不再探测
  const base = String(env.BACKEND_URL ?? '').replace(/\/+$/, '');
  if (!base) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  let res;
  const callPick = (path) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-proxy-token': env.PROXY_TOKEN ?? '' },
      body: JSON.stringify({ pan, operation }),
      signal: controller.signal,
    });
  try {
    res = await callPick('/api/credential-pick');
    // v1.3.1 过渡：老 backend（0.1.0-next / 1.2.2）只有 /api/proxy/cookie-pick
    if (res.status === 404) res = await callPick('/api/proxy/cookie-pick');
  } catch {
    rememberBackend(false, now); // 超时/网络失败 → 缓存不可用
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    rememberBackend(false, now);
    return null;
  }
  let data;
  try {
    data = await res.json();
  } catch {
    rememberBackend(false, now);
    return null;
  }
  rememberBackend(true, now);
  return data && typeof data === 'object' ? data : null;
}

/** D1 建表（幂等 CREATE TABLE IF NOT EXISTS；模块级标志位，首次写入时执行一次即可） */
let d1TablesReady = false;
let d1TablesLock = null;

async function ensureD1Tables(db) {
  if (d1TablesReady) return;
  if (!d1TablesLock) {
    d1TablesLock = (async () => {
      try {
        await db.exec(`
          CREATE TABLE IF NOT EXISTS proxy_logs (
            id INTEGER PRIMARY KEY,
            frontend_id TEXT,
            ts INTEGER,
            pan TEXT,
            account_id INTEGER,
            operation TEXT,
            method TEXT,
            url TEXT,
            req_status INTEGER,
            duration_ms INTEGER,
            req_ms INTEGER,
            client_ip TEXT,
            via TEXT,
            req_headers TEXT,
            resp_headers TEXT,
            body_preview TEXT
          );
          CREATE TABLE IF NOT EXISTS file_hits (
            id INTEGER PRIMARY KEY,
            frontend_id TEXT,
            ts INTEGER,
            pan TEXT,
            account_id INTEGER,
            client_ip TEXT,
            fid TEXT,
            md5 TEXT,
            file_name TEXT,
            size INTEGER,
            category INTEGER
          );
          CREATE INDEX IF NOT EXISTS idx_fh_fid ON file_hits(fid);
          CREATE INDEX IF NOT EXISTS idx_fh_md5 ON file_hits(md5);
          CREATE INDEX IF NOT EXISTS idx_fh_ts ON file_hits(ts);
        `);
        d1TablesReady = true;
      } finally {
        d1TablesLock = null; // 失败也重置，下次请求重试
      }
    })();
  }
  return d1TablesLock;
}

/** consent 头 x-panhub-trace: ip-hash 存在时才哈希化 IP（sha256(ip+salt)，salt = env.IP_HASH_SALT）；否则 null */
async function hashClientIp(request, env) {
  if (request.headers.get('x-panhub-trace') !== 'ip-hash') return null;
  const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + (env.IP_HASH_SALT ?? '')));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 响应体文件级白名单提取（fid / file_name / md5 必须；pdir_fid / size / category / obj_key 可选）；解析失败不阻断 */
function extractFileHits(bodyText) {
  const hits = [];
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return hits;
  }
  if (!parsed || typeof parsed !== 'object') return hits;
  const data = parsed.data;
  let items = null;
  if (Array.isArray(data)) items = data;
  else if (data && typeof data === 'object') {
    if (Array.isArray(data.items)) items = data.items;
    else if (Array.isArray(data.list)) items = data.list;
  }
  if (!items) return hits;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const fid = it.fid;
    const file_name = it.file_name;
    const md5 = it.md5;
    if (!fid || !file_name || !md5) continue; // 白名单三件套缺一不可
    const hit = { fid, file_name, md5 };
    for (const k of ['pdir_fid', 'size', 'category', 'obj_key']) {
      if (it[k] !== undefined && it[k] !== null) hit[k] = it[k];
    }
    hits.push(hit);
  }
  return hits;
}

/**
 * 云端两阶段 trace（设计稿 §2/§3：D1 与本地 SQLite 同构；完整 body 不落库，只落 body_preview）。
 * 阶段一（后台立即执行）：INSERT proxy_logs（frontend_id/ts/url/operation/method/via='cloud'/client_ip）；
 * 阶段二（complete() 后）：UPDATE（pan/account_id/req_status/req_ms/duration_ms/body_preview）+
 *   解析响应体批量 INSERT file_hits。上游失败 complete({status:null}) → 行留 req_status NULL（看板标严重警告）。
 *   v1.3.2：operation === 'scan' 时 body_preview 置空且不落 file_hits（目录树不记录，兑现结果页承诺）。
 * 错误分支只落 warning 日志，不阻断请求。
 */
function makeCloudTrace({ env, request, started, frontendId, pan, accountId, operation, method, url }) {
  const db = env.DB;
  let resolveComplete;
  const completePromise = new Promise((r) => {
    resolveComplete = r;
  });
  const task = (async () => {
    let clientIp = null;
    try {
      clientIp = await hashClientIp(request, env);
    } catch {
      clientIp = null;
    }
    try {
      await ensureD1Tables(db);
      await db
        .prepare('INSERT INTO proxy_logs (frontend_id, ts, url, operation, method, via, client_ip) VALUES (?,?,?,?,?,?,?)')
        .bind(frontendId, started, url.slice(0, 300), operation, method, 'cloud', clientIp)
        .run();
    } catch (err) {
      console.warn('[proxy] D1 trace 阶段一失败：', err?.message ?? String(err));
    }
    const done = await completePromise;
    if (!done) return;
    const { status, bodyText, reqMs, durationMs } = done;
    // v1.3.2 隐私承诺（结果页 banner 文案兑现）：scan（目录树）不落内容 ——
    // body_preview 置空、file_hits 整体跳过，只保留行级统计（分类/状态码/耗时）。
    // 理由：scan 响应体就是目录树本身（fid/文件名/md5/size），正是我们承诺不记录的东西。
    const recordContent = operation !== 'scan';
    try {
      await db
        .prepare(
          "UPDATE proxy_logs SET pan=?, account_id=?, req_status=?, req_ms=?, duration_ms=?, body_preview=? WHERE frontend_id=? AND via='cloud'",
        )
        .bind(pan, accountId, status, reqMs, durationMs, recordContent ? (bodyText ?? '').slice(0, 500) : null, frontendId)
        .run();
    } catch (err) {
      console.warn('[proxy] D1 trace 阶段二 UPDATE 失败：', err?.message ?? String(err));
    }
    try {
      // v1.3.1 隐私：文件明细粒度（env.TRACE_FILE_DETAIL = full | safe | off，缺省 full）
      // v1.3.2：scan（目录树）一律不落 file_hits，见上方 recordContent 注释
      const detail = String(env.TRACE_FILE_DETAIL ?? 'full');
      const hits = !recordContent || detail === 'off' ? [] : extractFileHits(bodyText ?? '');
      const safeHits = detail === 'safe' ? hits.map((h) => ({ ...h, name: null, md5: null })) : hits;
      for (const h of safeHits) {
        await db
          .prepare(
            'INSERT INTO file_hits (frontend_id, ts, pan, account_id, client_ip, fid, md5, file_name, size, category) VALUES (?,?,?,?,?,?,?,?,?,?)',
          )
          .bind(frontendId, started, pan, accountId, clientIp, h.fid, h.md5, h.file_name, h.size ?? null, h.category ?? null)
          .run();
      }
    } catch (err) {
      console.warn('[proxy] D1 trace 阶段二 file_hits 失败：', err?.message ?? String(err));
    }
  })();
  return {
    done: task,
    complete(data) {
      resolveComplete(data);
    },
  };
}

/** OPTIONS 预检：SPA 与代理跨域部署时（如 SPA 在 GitHub Pages）需要；四类薄路由直接再导出 */
export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * 转发入口（四类薄路由与 /api/proxy 兼容别名共用）。
 * @param context Pages Functions 上下文
 * @param kind    该路由声明的类别（scan/download/restore/credential-pick）；
 *                省略 = 兼容别名 /api/proxy（按目标 URL 自动分类，行为与 v1.3.1 前一致）
 */
export async function handleProxyRequest(context, kind = null) {
  const { request, env, ctx } = context;
  const started = Date.now();

  const denied = checkToken(request, env);
  if (denied) return denied;

  const limited = checkRateLimit(request);
  if (limited) return limited;

  // 解析代理协议体 { url, method, headers, body, frontend_id? }（见 docs/transport.md §代理协议）
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: 'BAD_BODY', message: '请求体必须是 JSON（{ url, method, headers, body }）' });
  }
  if (!payload || typeof payload !== 'object' || typeof payload.url !== 'string') {
    return json(400, { error: 'BAD_BODY', message: '缺少 url 字段' });
  }

  // v1.2.2：请求级 ID（可选字段，缺失不报错；服务端 trace 用它关联两阶段写入，缺失时兜底生成）
  const frontendId =
    typeof payload.frontend_id === 'string' && payload.frontend_id ? payload.frontend_id : crypto.randomUUID();

  // 目标 URL 校验：仅 http(s) + 白名单域 + 无内嵌凭据
  let target;
  try {
    target = new URL(payload.url);
  } catch {
    return json(400, { error: 'BAD_URL', message: 'url 不是合法 URL' });
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return json(400, { error: 'BAD_URL', message: '仅支持 http(s) 目标' });
  }
  if (!hostAllowed(target.hostname)) {
    return json(403, { error: 'DOMAIN_NOT_ALLOWED', message: `目标域名不在白名单：${target.hostname}` });
  }
  if (target.username || target.password) {
    return json(400, { error: 'BAD_URL', message: 'url 不允许携带用户名/密码' });
  }

  const method = (typeof payload.method === 'string' ? payload.method.toUpperCase() : 'GET');
  if (!ALLOWED_METHODS.includes(method)) {
    return json(405, { error: 'METHOD_NOT_ALLOWED', message: `仅支持 ${ALLOWED_METHODS.join('/')}` });
  }

  // body 只允许字符串（JSON 原样透传），GET 不带 body
  const body = typeof payload.body === 'string' ? payload.body : null;
  if (body && body.length > MAX_BODY_BYTES) {
    return json(413, { error: 'BODY_TOO_LARGE', message: `body 超过 ${MAX_BODY_BYTES} 字节` });
  }

  // v1.2.2：网盘 × 操作分类（云端取号 + D1 trace 共用；纯字符串判断，无 env 时无任何副作用）
  const pan = panOfHostname(target.hostname);
  const operation = classifyOperation(target.href);
  // v1.3.1：四类路由声明与目标 URL 分类必须一致（防前端误用；不一致直接 400 并回报实际分类）
  if (kind && kind !== operation) {
    return json(400, {
      error: 'OP_MISMATCH',
      message: `请求目标属于 ${operation}，但发到了 /api/${kind}`,
      classified: operation,
    });
  }

  // v1.4 架构纠正（Tzz 2026-10-03）：不再向 SPA 的 restore/download 请求自动注入 x-captcha-token。
  // 账号相关操作改由 backend 代发（functions/api/xunlei-op.js → backend runOp）。

  // v1.2.2 云端取号（仅 env.BACKEND_URL 存在 + uc/quark + operation==='download'（旧名 prase）；
  // scan 保持游客，与本地 hop 语义一致）：
  // 成功 → cookie 追加进转发头（保留 SPA 自带 cookie 的合并逻辑）+ 记住 tag/account_id；
  // 失败/超时/后端不可用 → 照旧用 SPA 自带 cookie（= 现状行为）。
  // v1.2.x alipan：不参与账号池取号 —— 其登录态是 SPA 自带的 Authorization Bearer（非 cookie），
  // 账号池（uc/quark）也没有 alipan 账号；pan 只用于 trace 标签。
  let accountTag = null;
  let accountId = null;
  let pickedCookie = null;
  let pickedReal = false; // v1.2.2 fix（09-03）：取到正式账号（kind=real）才回传托管可用标记
  if (env.BACKEND_URL && pan && pan !== 'alipan' && operation === 'download') {
    const pick = await pickAccountFromBackend(env, pan, operation);
    if (pick && typeof pick.cookie === 'string' && pick.cookie) {
      accountTag = typeof pick.tag === 'string' && pick.tag ? pick.tag : null;
      accountId = typeof pick.account_id === 'number' ? pick.account_id : null;
      pickedReal = pick.kind === 'real';
      pickedCookie = pick.cookie;
      const merged = {};
      for (const [k, v] of Object.entries(payload.headers ?? {})) merged[k.toLowerCase()] = v;
      merged.cookie = merged.cookie ? `${merged.cookie}; ${pick.cookie}` : pick.cookie;
      payload.headers = merged;
    }
  }

  // 转发（丢弃 cookie/authorization，只留白名单头；无 UA 兜底避免被网盘风控误判）
  const upstreamInit = {
    method,
    headers: forwardHeaders(payload.headers ?? {}),
    ...(body && method !== 'GET' ? { body } : {}),
  };

  // v1.2.2 D1 trace（仅 env.TRACE_D1 === '1' && env.DB；本地 launcher 生成的 .dev.vars TRACE_D1=0 天然不触发）
  let trace = null;
  if (env.TRACE_D1 === '1' && env.DB) {
    trace = makeCloudTrace({ env, request, started, frontendId, pan, accountId, operation, method, url: target.href });
    ctx.waitUntil(trace.done);
  }

  // 超时：AbortController + 手动计时（兼容性优先）
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const fetchStartedAt = Date.now();
  let upstream;
  try {
    upstream = await fetch(target.toString(), { ...upstreamInit, signal: controller.signal });
  } catch (err) {
    if (trace) {
      // 上游失败：complete({status:null}) → 行留 req_status NULL（看板标严重警告）；两阶段天然留痕，不做错误分支处理
      trace.complete({ status: null, bodyText: '', reqMs: 0, durationMs: Date.now() - started });
    }
    return json(502, {
      error: 'UPSTREAM_FAILED',
      message: err instanceof Error && err.name === 'AbortError'
        ? `上游超时（>${UPSTREAM_TIMEOUT_MS / 1000}s）`
        : `上游请求失败：${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    clearTimeout(timer);
  }

  // 响应体统一缓冲（API JSON 小流量；顺带给 trace 提供 body_preview / file_hits 提取源，完整 body 不落库）
  let bodyText;
  try {
    bodyText = await upstream.text();
  } catch {
    bodyText = '';
  }
  const now = Date.now();
  if (trace) {
    trace.complete({ status: upstream.status, bodyText, reqMs: now - fetchStartedAt, durationMs: now - started });
  }

  // 原样透传状态码 + body（API JSON）；content-type 保留
  const respHeaders = {
    ...CORS_HEADERS,
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
  };
  // 捕获 __pugs（UC/夸克下载鉴权唯一必需 cookie）回传 SPA（§10.2 代理捕获通道）
  const pugs = extractPugs(upstream.headers.get('set-cookie'));
  if (pugs) {
    respHeaders['x-pugs'] = pugs;
  }
  // v1.1.9.1：夸克登录态 __pus/__puus 服务端会定期刷新（__puus 3h 会话），回传供 SPA 自动合并
  for (const name of ['__pus', '__puus']) {
    const m = (upstream.headers.get('set-cookie') ?? '').match(new RegExp(`(?:^|,)\\s*${name}=([^;,\\s]*)`));
    if (m) respHeaders[`x-quark-${name.replace(/^__/, '')}`] = m[1];
  }
  // v1.2.2 fix（09-02）：取号兜底回传 __puus —— 夸克仅在 __puus 过期/缺失时才 Set-Cookie 刷新
  // （账号池会话仍有效时上游不下发 x-quark-puus，SPA 就拿不到大文件 OSS 导出凭据）；
  // 回传本次实际下发给上游的 cookie 里的 __puus（同一授权会话，CDN 认这个值）。
  if (pan === 'quark' && !respHeaders['x-quark-puus'] && pickedCookie) {
    const puusMatch = pickedCookie.match(/(?:^|;\s*)__puus=([^;]*)/);
    if (puusMatch && puusMatch[1]) respHeaders['x-quark-puus'] = puusMatch[1];
  }
  // v1.2.2：命中代理托管账号 → 回传标签（SPA 展示「代理托管账号」，不暴露 cookie 明文）
  // 与本地 hop 同一约定：encodeURIComponent（兼容 Node http 非 ASCII 头限制）
  if (accountTag) {
    respHeaders['x-panhub-account'] = encodeURIComponent(accountTag);
  }
  // v1.2.2 fix（09-03）：代理托管可用标记 —— 仅正式账号（取号 kind=real，非 guest 占位）时回传 ok；
  // 此前该头从未被任何服务端下发 → SPA 的 09-02 toast 守卫（getLastProxyBackendOk）永不生效。
  // v1.3.1 四类规范：托管状态用 x-panhub-credential: hit|guest|none 表达
  // （词表与 SPA `core/transport/types.ts#CredentialState`、backend `src/proxy.js` 同表；
  //   旧头 x-panhub-backend: ok 同时保留一版，兼容未升级的 SPA；语义改为「取到正式账号」）
  const credentialState = pickedReal ? 'hit' : accountTag ? 'guest' : 'none';
  respHeaders['x-panhub-credential'] = credentialState;
  if (pickedReal) {
    respHeaders['x-panhub-backend'] = 'ok';
  }
  return new Response(bodyText, { status: upstream.status, headers: respHeaders });
}
