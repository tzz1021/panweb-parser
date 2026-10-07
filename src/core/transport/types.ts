/**
 * 传输层抽象（1.1 核心：docs/transport.md）
 *
 * 现状：adapter 直接 fetch 网盘 API，非 drive.uc.cn 域直连被 CORS 白名单拦死。
 * 1.1 目标：把"浏览器直连"变成可切换的传输方式，UI/adapter 逻辑零改动。
 *
 * 三种传输（对应三种用户方案，见 docs/transport.md）：
 * - direct：浏览器直连（现状，受 CORS 限制；书签注入=同源直连，同一实现）
 * - proxy：用户配置的 API 转发代理（CF Pages Function / Worker / 家庭内网），
 *   代理在服务端转发请求，天然无 CORS；直链下载仍走 OSS CDN，代理只过 JSON 小流量
 * - plugin：浏览器扩展桥（v2.0，不做）；扩展请求不受页面 CORS 限制，可读 cookie
 *
 * 约束：core/ 零网盘依赖 —— 本层只认识 HTTP，不认识任何网盘。
 */

/** 结构化网络错误（替代现在 adapter 里“猜 message 含 CORS”的方式） */
export class TransportError extends Error {
  /** cors：被浏览器 CORS 拦截（direct 下才会发生） */
  readonly kind: 'cors' | 'network' | 'http' | 'invalid';
  /** HTTP 状态码（http 类才有） */
  readonly status?: number;

  constructor(kind: TransportError['kind'], message: string, status?: number) {
    super(message);
    this.name = 'TransportError';
    this.kind = kind;
    this.status = status;
  }
}

/* ============ v1.3.1 四类操作词表（与 functions/_shared/proxy-core.js + backend/src/proxy.js 同表） ============ */

/**
 * URL 特征 → 操作分类（四类：scan | download | restore | credential-pick | other）。
 * 与云端 `functions/api/_shared/proxy-core.js#classifyOperation`、
 * 后端 `backend/src/proxy.js#classifyOperation` **同一张表**（三处最小复制，改动必须同步；
 * 自测 `panhub-1.3.1-selfcheck` 里有同一批用例断言防漂移）。
 */
export function classifyOperation(url: string): 'scan' | 'download' | 'restore' | 'credential-pick' | 'other' {
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

/** 传输层请求（adapter 用） */
export interface TransportRequest {
  /** 完整目标 URL（含 query，原样透传） */
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** 请求头（Content-Type 等；Cookie 类凭据禁止进 proxy，见 docs/transport.md） */
  headers?: Record<string, string>;
  /** 请求体（JSON 字符串；GET 不带） */
  body?: string;
}

/** 传输层响应（统一为文本，由 adapter 自行 JSON.parse） */
export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  /** 原始响应文本（非 JSON 也原样给） */
  body: string;
}

/* ===================== v1.3.1·D1 凭据探测（下沉到 functions） ===================== */

/**
 * 凭据状态词表（**唯一词表**，三处同表：本文件 / functions `_shared/proxy-core.js` /
 * backend `src/proxy.js`）：
 *   hit   = 命中该网盘的**正式账号**（可用：滚动更新可静默续杯）
 *   guest = 后端在，但没有这个账号（只能游客态 / 占位账号）
 *   none  = 无托管（未配置后端 / 不可达 / 未实现 / 该网盘无号）
 * 与转发链路的 `x-panhub-credential` 响应头**同一个词表**（旧头 `x-panhub-backend: ok` 兼容一版）。
 */
export type CredentialState = 'hit' | 'guest' | 'none';

/**
 * 凭据探测端点 = **functions 上的自有路由**（不是 hop/backend 端点）。
 * v1.3.1·D1 定稿：SPA 只跟 functions 说话，由 functions 去问 backend
 * （Tzz：凭据不下发 SPA；SPA 也永远拿不到账号集合/凭据本体）。
 *
 * 形态：`POST {proxyBase}{CREDENTIAL_PICK_PATH}`
 *   body `{ provider: <网盘 id>, account?: <账号身份，非敏感> }`
 *   → `{ backend: boolean, credential: 'hit' | 'guest' | 'none' }`
 * 直连（无代理）没有该能力 → 调用方按「无托管」处理（安全降级，不阻断主流程）。
 */
export const CREDENTIAL_PICK_PATH = '/api/credential-pick';

/* ===================== v1.4 迅雷账号相关 ops（由 backend 执行） ===================== */

/**
 * 迅雷 ops 端点 = **functions 自有路由**（不是 hop 转发路由）。
 * 形态：`POST {proxyBase}{XUNLEI_OP_PATH}`，body `{ op, ... }`（X-Proxy-Token 鉴权）
 *   → `{ ok, results?, url?, expiresAt?, error?, code? }`（functions 透传 backend，原样回前端）。
 *
 * 语义（Tzz 2026-10-03 定稿）：settings/restore/rename/download 属**账号相关**操作，
 * **不能由前端带凭据/头去发** —— 前端只发「请求意图」，backend 用自己的
 * device_id / captcha_sign→captcha_token / authorization 完成上游请求。
 * scan（share / share/detail）仍由 SPA 本地发（本地 device_id + 自造 captcha）。
 * 直连（无代理）没有该能力 → 调用方按「需要代理托管」明确失败（不静默）。
 */
export const XUNLEI_OP_PATH = '/api/xunlei/op';

/** ops 名（与 backend `runOp` 同一词表） */
export type XunleiOpName = 'settings' | 'restore' | 'rename' | 'download';

/** 发给 /api/xunlei/op 的请求体（前端只发意图，不带凭据/头） */
export interface XunleiOpPayload {
  op: XunleiOpName;
  share_id?: string;
  pass_code_token?: string;
  to_parent_id?: string;
  /** restore 批量 */
  fids?: string[];
  /** rename / download 单文件 */
  fid?: string;
  /** rename 的原始文件名（backend 追加 3 位补零随机数伪装分卷） */
  name?: string;
  /**
   * v1.3.3（五批）取链参数：`CONSUME`（默认）/ `PLAY`（流式）。
   * 影响 `/files/{id}?space=&usage=` 返回的直链集合（PLAY 常比 CONSUME 快，压缩包有奇效）。
   * backend 只认这两个值，其他一律回落 CONSUME。
   */
  usage?: 'CONSUME' | 'PLAY';
}

/** ops 结果（backend 形状：{ ok, results?, url?, expiresAt?, error?, code? }） */
export interface XunleiOpResult {
  /** HTTP 状态（网络层；0 = 未发出/不可达） */
  status: number;
  /** 端点可达且返回合法 JSON（HTTP 2xx） */
  ok: boolean;
  data: {
    ok?: boolean;
    /** restore 映射：分享 file id → 我盘 file id */
    results?: Array<{ fid: string; fileId: string }>;
    url?: string;
    expiresAt?: number;
    /** 文件大小（backend 从详情读到的；缺省用分享值） */
    size?: number | string;
    /**
     * 脱敏文件详情（backend 构造；下载直链时带回供「隐秘参数」就地查看）。
     * 仅含字段名 + 安全值（token 类型/过期、URL 存在性），**永不含** token/凭据明文。
     */
    detail?: unknown;
    error?: string;
    /** 结构化错误码（如 NO_ACCOUNT / NOT_FOUND / NEED_RENAME） */
    code?: string;
    message?: string;
  } | null;
}

/** 凭据探测结果：ok=false 时 reason 说明为何拿不到状态（调用方安全降级，不视作致命错误） */
export type CredentialProbeResult =
  | { ok: true; credential: CredentialState }
  | { ok: false; reason: 'unavailable' | 'unreachable' | 'unimplemented' };

/** 传输实现（direct / proxy / plugin） */
export interface Transport {
  readonly id: 'direct' | 'proxy' | 'plugin';
  /** 发起请求；网络/CORS 错误抛 TransportError（adapter 捕获后转中文文案） */
  request(req: TransportRequest): Promise<TransportResponse>;
  /** 当前是否可用（proxy 未填地址 = 不可用） */
  available(): boolean;
  /**
   * v1.3.1·D1 凭据探测（**可选能力**：只有代理类传输实现，直连 = undefined = 「无托管」）。
   * 语义：问 **functions**（由它去问 backend）「这个 provider 的这个账号是什么状态」，
   * 供适配器做滚动更新（carry-over）判定；端点未实现/不可达一律返回 ok:false
   * （**安全降级**，调用方转「提示用户填新凭据」）。
   * @param provider 网盘 id（如 'alipan'）
   * @param account  账号身份（非敏感；命中判定用，可省）
   */
  credentialProbe?(provider: string, account?: string): Promise<CredentialProbeResult>;
  /**
   * v1.4 迅雷账号相关 ops（settings/restore/rename/download）——
   * 只有代理类传输提供（functions 转 backend 执行）；直连 = undefined = 不可用
   * （调用方转「需代理托管」明确错误，不静默）。
   */
  xunleiOp?(payload: XunleiOpPayload): Promise<XunleiOpResult>;
}

/** 直连实现：浏览器 fetch（现状逻辑搬移，错误结构化） */
export class DirectTransport implements Transport {
  readonly id = 'direct' as const;

  available(): boolean {
    return true;
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    let res: Response;
    try {
      res = await fetch(req.url, {
        method: req.method ?? 'GET',
        headers: req.headers,
        body: req.body,
      });
    } catch (err) {
      // fetch TypeError：CORS 拦截 / 断网 / DNS 失败（浏览器层拿不到具体原因）
      throw new TransportError('cors', `网络请求失败：${err instanceof Error ? err.message : String(err)}`);
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return {
      status: res.status,
      headers,
      body: await res.text(),
    };
  }
}

/** v1.2.2：最近一次代理响应回传的 x-panhub-account（代理托管账号 label；无则 null）。
 * 只记 label 不记 cookie 明文 —— 供 CookieInputModal 展示「代理托管账号」，服务端不回传真实凭据。 */
let lastProxyAccountLabel: string | null = null;

/** v1.2.2（wip2 修正）：x-panhub-account-id —— 命中账号的数字 id（后端 cookie-pick / hop 回传；无则 null）。 */
let lastProxyAccountId: number | null = null;

/** v1.2.2（wip2 修正）：x-panhub-backend: ok —— functions 检测到 backend 可取号（代理托管生效；无则 false）。 */
let lastProxyBackendOk = false;

/** 取最近一次代理响应回传的代理托管账号 label（无则 null；仅 label，不含任何 cookie 明文） */
export function getLastProxyAccountLabel(): string | null {
  return lastProxyAccountLabel;
}

/** 取最近一次代理响应回传的命中账号数字 id（无则 null；审计/判重用，不含 cookie 明文） */
export function getLastProxyAccountId(): number | null {
  return lastProxyAccountId;
}

/** 最近一次代理响应是否带 x-panhub-backend: ok（functions 已从 backend 取到号；无则 false） */
export function getLastProxyBackendOk(): boolean {
  return lastProxyBackendOk;
}

/** 代理实现：POST {proxyUrl}/api/proxy 转发（协议见 docs/transport.md §协议） */
export class ProxyTransport implements Transport {
  readonly id = 'proxy' as const;
  private readonly base: string;
  private readonly token: string;
  /** v1.2.2：IP 采集（哈希化后上传）——开时请求带 x-panhub-trace: ip-hash 头，服务端 sha256(ip+salt) 后落库 */
  private readonly ipHash: boolean;
  /** v1.3.1：已知对面是旧部署（无四类路由）→ 本会话直接用兼容别名 /api/proxy */
  private legacyRoute: boolean | null = null;

  constructor(base: string, token = '', ipHash = false) {
    this.base = base;
    this.token = token;
    this.ipHash = ipHash;
  }

  available(): boolean {
    return Boolean(this.base);
  }

  /**
   * v1.3.1 四类拆分：目标 URL → 代理路由。
   * other（未识别的上游端点，如 token 之外的辅助接口）仍走兼容别名，避免误判导致 400。
   */
  private routeOf(url: string): string {
    const kind = classifyOperation(url);
    if (kind === 'other' || this.legacyRoute === true) return '/api/proxy';
    return `/api/${kind}`;
  }

  /**
   * v1.3.1·D1 凭据探测（滚动更新用）：只问 **functions** 拿 hit|guest|none，
   * 不直连 hop/backend，也拿不到账号集合或凭据本体（Tzz 定稿）。
   * 端点不存在（404/501，老部署）/不可达/返回非法 → ok:false，调用方安全降级到
   * 「提示用户填新凭据」——绝不因探测失败阻断主流程。
   */
  async credentialProbe(provider: string, account?: string): Promise<CredentialProbeResult> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${CREDENTIAL_PICK_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { 'X-Proxy-Token': this.token } : {}),
        },
        body: JSON.stringify({ provider, ...(account ? { account } : {}) }),
      });
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
    if (res.status === 404 || res.status === 501) return { ok: false, reason: 'unimplemented' };
    if (!res.ok) return { ok: false, reason: 'unreachable' };
    let data: { credential?: unknown } | null = null;
    try {
      data = (await res.json()) as { credential?: unknown };
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
    const state = data?.credential;
    if (state !== 'hit' && state !== 'guest' && state !== 'none') return { ok: false, reason: 'unreachable' };
    return { ok: true, credential: state };
  }

  /**
   * v1.4 迅雷 ops：把「请求意图」POST 给 functions（再转 backend 代发）。
   * 只负责传输与 JSON 解析；业务失败（ok:false / 非 2xx）原样返回，由适配器转中文。
   */
  async xunleiOp(payload: XunleiOpPayload): Promise<XunleiOpResult> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${XUNLEI_OP_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { 'X-Proxy-Token': this.token } : {}),
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return {
        status: 0,
        ok: false,
        data: {
          error: 'PROXY_UNREACHABLE',
          message: `代理请求失败：${err instanceof Error ? err.message : String(err)}（请检查代理地址或网络）`,
        },
      };
    }
    let data: XunleiOpResult['data'] = null;
    try {
      data = (await res.json()) as XunleiOpResult['data'];
    } catch {
      data = null;
    }
    return { status: res.status, ok: res.ok, data };
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${this.routeOf(req.url)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { 'X-Proxy-Token': this.token } : {}),
          // v1.2.2：IP 采集开关（默认关）；开时服务端按 consent 头哈希化 IP 落 trace，不落明文
          ...(this.ipHash ? { 'x-panhub-trace': 'ip-hash' } : {}),
        },
        body: JSON.stringify({
          url: req.url,
          method: req.method ?? 'GET',
          headers: req.headers ?? {},
          body: req.body ?? null,
          // v1.2.2：请求级 ID，供服务端 trace 两阶段关联（直连无服务端日志，DirectTransport 不加）
          frontend_id: crypto.randomUUID(),
        }),
      });
      // v1.3.1 四类拆分：新部署走 /api/<类>；若对面是未升级的部署（无该类路由）→
      // 落回兼容别名 /api/proxy 重发一次（行为与拆分前完全一致），并记住本会话不再尝试
      if ((res.status === 404 || res.status === 405) && this.legacyRoute !== true) {
        this.legacyRoute = true;
        res = await fetch(`${this.base}/api/proxy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.token ? { 'X-Proxy-Token': this.token } : {}),
            ...(this.ipHash ? { 'x-panhub-trace': 'ip-hash' } : {}),
          },
          body: JSON.stringify({
            url: req.url,
            method: req.method ?? 'GET',
            headers: req.headers ?? {},
            body: req.body ?? null,
            frontend_id: crypto.randomUUID(),
          }),
        });
      }
    } catch (err) {
      // 代理地址不可达 / 代理没带 CORS 头
      throw new TransportError('network', `代理请求失败：${err instanceof Error ? err.message : String(err)}（请检查代理地址或网络）`);
    }
    // 代理**原样透传**上游状态码 + body（与直连同规格）：
    // 网盘业务错误（夸克 23018/31001 走 HTTP 400/403 + JSON body code）必须由 adapter
    // 从 body 里解析，这里不能因 !res.ok 提前抛错丢掉业务码 —— 否则登录态弹窗永远不触发。
    // 代理自身错误（401 令牌无效/403 白名单/429 限频）同样是 JSON body，
    // adapter 的 status 检查会兜底展示 message（见 adapters/*/scanner.ts request）。
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    // v1.2.2：代理托管账号 label（云端 cookie-pick / 本地 hop 命中账号时回传；经 headers 透传通道到达）
    // 服务端统一 encodeURIComponent（Node http 非 ASCII 头限制），这里解码回可读标签
    if (headers['x-panhub-account']) {
      try {
        lastProxyAccountLabel = decodeURIComponent(headers['x-panhub-account']);
      } catch {
        lastProxyAccountLabel = headers['x-panhub-account'];
      }
    }
    // v1.2.2（wip2 修正）：命中账号数字 id + backend 可用标记（functions cookie-pick 成功才回传；
    // 缺失 = 未取到号/未配置 BACKEND_URL，保持旧值不覆盖，避免误报）
    const accountIdRaw = headers['x-panhub-account-id'];
    if (accountIdRaw !== undefined && accountIdRaw !== null && accountIdRaw !== '') {
      const n = Number(accountIdRaw);
      if (Number.isFinite(n)) lastProxyAccountId = n;
    }
    if (headers['x-panhub-backend'] === 'ok') {
      lastProxyBackendOk = true;
    }
    // v1.3.1 四类规范：托管状态头 x-panhub-credential: hit|guest|none
    // （旧头 x-panhub-backend: ok 仍兼容一版，见上）
    const credState = headers['x-panhub-credential'];
    if (credState === 'hit') lastProxyBackendOk = true;
    else if (credState === 'guest' || credState === 'none') lastProxyBackendOk = false;
    return {
      status: res.status,
      headers,
      body: await res.text(),
    };
  }
}

/* ============ 单例（类定义之后再初始化，避免 TDZ） ============ */

let active: Transport = new DirectTransport();

/** 设置当前传输（设置面板切换时调用；null = 回退直连） */
export function setActiveTransport(t: Transport | null): void {
  active = t ?? new DirectTransport();
  // v1.2.2（wip2 修正）：切换传输时重置托管状态，避免旧代理的账号/可用性标记串到新传输
  lastProxyAccountLabel = null;
  lastProxyAccountId = null;
  lastProxyBackendOk = false;
}

/** 取当前传输（adapter 内部用；缺省直连） */
export function getActiveTransport(): Transport {
  return active;
}

/** 根据偏好创建传输（preferences.transport 配置 → 实例） */
export function transportFromPrefs(prefs: { mode: 'direct' | 'proxy'; proxyUrl: string; proxyToken?: string; ipHashUpload?: boolean }): Transport {
  if (prefs.mode === 'proxy' && prefs.proxyUrl.trim()) {
    return new ProxyTransport(prefs.proxyUrl.trim().replace(/\/+$/, ''), prefs.proxyToken ?? '', prefs.ipHashUpload ?? false);
  }
  return new DirectTransport();
}
