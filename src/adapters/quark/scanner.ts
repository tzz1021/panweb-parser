/**
 * 夸克网盘扫描器（docs/STRUCTURE.md：src/adapters/quark/scanner.ts）
 *
 * 负责 token / detail / download 三个 API 步骤（"scanner" = 获取资源列表的能力）。
 * 实现依据：docs/reverse-notes-quark.md（2026-08-23 真机实测，分享链接）
 * 接口契约：src/adapters/types.ts（PanAdapter）
 *
 * 逆向结论（改动前必读，勿凭感觉改）：
 * - scanner 三连全部零 cookie（游客可读目录树）：token → detail（pdir_fid 递归）→ download
 * - detail 根目录必须 _fetch_banner=1&_fetch_share=1，否则 metadata（_total）不返回，
 *   treeWalker 会当成单页截断（>50 文件的目录树不完整）
 * - download 必带 `?entry=ft&fr=pc&pr=ucpro`；凭据按**实际请求态**绑定（v1.2.2 fix 09-03，与 size 无关）：
 *   游客请求 → 响应 Set-Cookie 下发 __pugs（3h，Domain=quark.cn），dl-guest-* 直链必带同响应 __pugs
 *   （否则 CDN 412）；登录请求（账号池注入/本地整串）→ 响应旋转 __puus（3h 会话），dl-pc-* 直链
 *   只认 __puus（OSS 鉴权，gopeed 实测与 size 无关）
 * - 大文件（>50MB 实测区间）**游客**请求返回 HTTP 400 + code 23018 size limit，
 *   需登录态（整串/托管账号池）后重试；登录态下 size 不再决定凭据种类
 * - 直链是签名 URL（auth_key 6h），字符敏感：本层原样透传，不做任何加工
 * - 批量节流（15 个/批 + 1s 间隔）归 core/linkFetcher 管，本文件单次调用只发一批
 */
import type {
  DownloadParams,
  DownloadResult,
  ListParams,
  ListResult,
  ShareFile,
  TokenParams,
  TokenResult,
} from '../types';
import { getActiveTransport, TransportError, type TransportResponse } from '../../core/transport/types';
import { ossUrlExpiryMs } from '../../utils/linkStatus';
import {
  capturePugsFromHeaders,
  cookieValueOf,
  getQuarkCookieString,
  getQuarkPugs,
  mergeQuarkSetCookies,
  setQuarkCookieString,
} from './cookies';
import { API_BASE, DL_QUERY, ERROR_MESSAGES, PC_QUERY, QUARK_DL_UA, type QuarkDetailItem, type QuarkDownloadItem } from './types';

/**
 * 最近一次夸克响应的 __pugs（§12 同响应绑定，与 UC 同一机制）：
 * 每次 getDownloadLinks 调用前重置，若该次响应用 x-pugs 回传了值，
 * 则绑定到该次返回的每一个 DownloadResult。
 */
let lastResponsePugs: string | null = null;

/**
 * 最近一次夸克响应的 __puus（v1.2.2 fix 09-02：登录态直链 OSS 校验令牌，3h 会话）：
 * 代理托管（selfhost/云端取号）路径下登录态 cookie 由 backend 账号池注入、前端整串不参与，
 * 服务端若刷新会话会经 x-quark-puus 回传 —— 收口捕获后绑定到 DownloadResult（登录态直链
 * 都认 __puus，与文件 size 无关，见 09-03 修正）。与 lastResponsePugs 同生命周期。
 */
let lastResponseQuarkPuus: string | null = null;

/** 夸克接口错误（携带 code 供 core/errors 分类；文案已是最终中文，可直接展示） */
export class QuarkApiError extends Error {
  readonly code: number | string;

  constructor(code: number | string, message: string) {
    super(message);
    this.name = 'QuarkApiError';
    this.code = code;
  }
}

/** 抛错误码对应文案；无映射时用 fallback 兜底 */
function fail(code: number | string, fallback?: string): never {
  const message =
    typeof code === 'number'
      ? ERROR_MESSAGES[code] ?? fallback ?? `夸克接口错误（code: ${code}）`
      : fallback ?? `夸克接口错误（${String(code)}）`;
  throw new QuarkApiError(code, message);
}

/**
 * 夸克 API 请求封装：经传输层 → 响应解析（**先解析 JSON body 取业务码**）。
 * 与 UC 不同：夸克业务错误（23018/41020/31001）走 HTTP 400/403 + JSON body，
 * 必须优先读 body 里的 code，否则只看到 HTTP 400 丢失分类。
 * 成功约定：`{ code: 0, data: T }`；返回 { data, metadata }（metadata 为顶层兄弟节点）。
 */
async function request<T, M = unknown>(
  url: string,
  init?: RequestInit,
  step = '夸克接口',
): Promise<{ data: T; metadata?: M }> {
  let res: TransportResponse;
  try {
    res = await getActiveTransport().request({
      url,
      method: init?.method as 'GET' | 'POST' | undefined,
      headers: init?.headers as Record<string, string> | undefined,
      body: init?.body as string | undefined,
    });
  } catch (err) {
    if (err instanceof TransportError) {
      if (err.kind === 'cors') {
        const hint =
          typeof window !== 'undefined' && !/pan\.quark\.cn$/i.test(window.location.hostname)
            ? '；非 pan.quark.cn 域直连被 CORS 拦截，请在设置中填写代理地址，或通过书签在网盘分享页使用'
            : '';
        throw new Error(`网络请求失败（${step}）：${err.message}${hint}`);
      }
      throw new Error(`网络请求失败（${step}）：${err.message}`);
    }
    throw err instanceof Error ? err : new Error(`网络请求失败（${step}）：${String(err)}`);
  }
  // §12 代理捕获通道：夸克响应 Set-Cookie 下发的 __pugs 经代理回传为 x-pugs（与 UC 同键）
  const pugs = capturePugsFromHeaders(res.headers);
  if (pugs) {
    lastResponsePugs = pugs;
  }
  // v1.2.2 fix（09-02）：__puus 同通道捕获（x-quark-puus）——托管模式下登录态整串在前端不可见，
  // 大文件导出凭据只能靠这里拿到（见 lastResponseQuarkPuus 注释）
  const quarkPuus = res.headers['x-quark-puus'];
  if (quarkPuus) {
    lastResponseQuarkPuus = quarkPuus;
  }
  // v1.1.9.1：登录态 __pus/__puus 服务端会定期刷新（__puus 3h 会话）——
  // 代理回传 x-quark-pus/x-quark-puus，这里自动合并回本地整串（alist 同款）
  // v1.2.2 微调：代理托管模式（selfhost）下 set-cookie 由 backend 账号池合并（保险箱语义），
  // 前端不复用/合并（拿不到新 set-cookie 也没有意义），直接跳过
  if ((res.headers['x-quark-pus'] || res.headers['x-quark-puus']) && getActiveTransport().id !== 'proxy') {
    const merged = mergeQuarkSetCookies(getQuarkCookieString(), res.headers);
    if (merged !== getQuarkCookieString()) setQuarkCookieString(merged);
  }
  // 先解析 body（业务错误码在 JSON 里，HTTP 状态只是外壳）
  let body: { code?: number | string; message?: string; data?: T; metadata?: M } | null = null;
  try {
    body = JSON.parse(res.body) as { code?: number | string; message?: string; data?: T; metadata?: M };
  } catch {
    body = null;
  }
  // 业务码优先：code 非 0（含 HTTP 400/403 壳内的 23018/41020/31001）
  if (body && typeof body.code === 'number' && body.code !== 0) {
    fail(body.code, body.message);
  }
  if (res.status < 200 || res.status >= 300) {
    fail(res.status, body?.message ?? (res.body?.trim() ? res.body.slice(0, 120) : `夸克接口 HTTP ${res.status}`));
  }
  if (!body || body.data === undefined) {
    fail('empty-response', body?.message ?? '夸克接口返回异常（非 JSON 或为空），请稍后重试');
  }
  return { data: body.data, metadata: body.metadata };
}

/** 原始字段 → 接口 ShareFile（snake_case → camelCase） */
function toShareFile(item: QuarkDetailItem): ShareFile {
  return {
    fid: item.fid,
    fileName: item.file_name ?? '',
    dir: Boolean(item.dir),
    size: item.size ?? 0,
    shareFidToken: item.share_fid_token,
    formatType: item.format_type,
    modifiedAt: item.updated_at ?? item.created_at,
  };
}

/** 第 1 步：获取分享访问令牌 stoken（reverse-notes-quark §2.1；与 UC 同构） */
async function getToken(params: TokenParams): Promise<TokenResult> {
  const { data } = await request<{ stoken?: string }>(
    `${API_BASE}/share/sharepage/token?${PC_QUERY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pwd_id: params.shareId,
        passcode: params.passcode ?? '',
      }),
    },
    '获取分享令牌',
  );
  if (!data?.stoken) {
    fail('no-stoken', '获取分享令牌失败，分享可能已失效');
  }
  return { stoken: data.stoken };
}

/**
 * 构造 detail 接口查询 URL（v1.1.7 隐秘参数：浏览器直连官方 API，不经过代理）。
 * @param pdirFid 目标文件夹 fid（根目录 "0"）
 */
export function buildDetailUrl(shareId: string, stoken: string, pdirFid: string): string {
  const query = new URLSearchParams({
    pr: 'ucpro',
    fr: 'pc',
    uc_param_str: '',
    ver: '2',
    pwd_id: shareId,
    stoken,
    pdir_fid: pdirFid,
    force: '0',
    _page: '1',
    _size: '50',
    _fetch_banner: pdirFid === '0' ? '1' : '0',
    _fetch_share: pdirFid === '0' ? '1' : '0',
    fetch_relate_conversation: '0',
    _fetch_total: '1',
    _sort: 'file_type:asc,file_name:asc',
  });
  return `${API_BASE}/share/sharepage/detail?${query.toString()}`;
}

/** v1.1.7 隐秘参数：构造官方 API 查询 URL（浏览器直连，不走代理） */
export function buildHiddenVolumnUrl(params: { shareId: string; stoken: string; pdirFid: string }): string {
  return buildDetailUrl(params.shareId, params.stoken, params.pdirFid);
}

/** 第 2 步：单层目录/文件列表（reverse-notes-quark §2.2；目录遍历由 core/treeWalker 递归调用）
 *
 * 夸克分享根有包装层：pdir_fid=0 返回分享文件夹本身（分享标题），网页端是从
 * 文件夹**内容**开始展示的。因此根目录且只返回 1 个目录时自动下钻一层（等价网页视图，
 * 避免目录树多出一层“分享标题”）；多条目/单文件根保持原样。
 */
async function list(params: ListParams): Promise<ListResult> {
  const fetchOnce = async (pdirFid: string, isRoot: boolean): Promise<ListResult> => {
    const query = new URLSearchParams({
      pr: 'ucpro',
      fr: 'pc',
      uc_param_str: '',
      ver: '2',
      pwd_id: params.shareId,
      stoken: params.stoken,
      pdir_fid: pdirFid, // 根目录传 "0"
      force: '0',
      _page: String(params.page ?? 1),
      _size: String(params.size ?? 50),
      // v1.1.9 实测：根目录不带这两个 metadata（_total）不返回，treeWalker 分页会截断
      _fetch_banner: isRoot ? '1' : '0',
      _fetch_share: isRoot ? '1' : '0',
      fetch_relate_conversation: '0',
      _fetch_total: '1',
      _sort: 'file_type:asc,file_name:asc',
    });
    const { data, metadata } = await request<
      { list?: QuarkDetailItem[] },
      { _total?: number; _count?: number }
    >(`${API_BASE}/share/sharepage/detail?${query.toString()}`, {
      headers: { 'Content-Type': 'application/json' },
    }, '获取目录列表');
    return {
      files: (data.list ?? []).map(toShareFile),
      total: metadata?._total,
    };
  };

  let res = await fetchOnce(params.pdirFid, Boolean(params.isRoot));
  // 根包装层下钻：根目录 && 单条目 && 是目录 → 直接返回其内容（网页等价视图）
  if (params.isRoot && res.files.length === 1 && res.files[0].dir) {
    res = await fetchOnce(res.files[0].fid, false);
  }
  return res;
}

/** 第 3 步：批量获取下载直链（reverse-notes-quark §2.3；每次调用 = 一批，节流归 linkFetcher）
 *
 * v1.2.x 契约收窄：files 由调用方保证顺序；shareFidToken 是 UC/夸克专属逐文件令牌
 * （alipan 无此字段）—— 缺令牌的文件在**对应下标**产出失败项、不进请求，
 * 其余带令牌文件照常整批发（linkFetcher 按输入顺序回填）。 */
async function getDownloadLinks(params: DownloadParams): Promise<DownloadResult[]> {
  // 占位数组（下标 = 输入顺序）；缺 shareFidToken 的文件在原下标产出失败项、不进请求
  const results: DownloadResult[] = new Array(params.files.length);
  const pending: Array<{ idx: number; fid: string; token: string }> = [];
  params.files.forEach((file, idx) => {
    if (file.shareFidToken) {
      pending.push({ idx, fid: file.fid, token: file.shareFidToken });
    } else {
      results[idx] = { url: '', error: '文件令牌缺失，请重新解析', errorCode: 'missing-token' };
    }
  });
  if (pending.length === 0) {
    return results;
  }
  // §12 同响应绑定：本次调用开始时重置，只有本次响应的 __pugs/__puus 才能配本次的直链
  lastResponsePugs = null;
  lastResponseQuarkPuus = null;
  // v1.1.9.final：游客模式（qk-guestTurn 开 + 全部 <50MB）——
  // 不注入登录态整串（否则夸克返回登录态 CDN 直链、导出却配 __pugs → 下载掐断），
  // 改用捕获/随机 __pugs 模拟游客（无则不带，让响应下发新的）；默认模式才用登录整串。
  const guestMode = Boolean(params.guestMode);
  // v1.2.2 微调：代理托管模式（selfhost）下登录态 cookie 默认由 backend 账号池注入（hop 合并 SPA 头）；
  // v1.4.1 修正：代理模式下**本地显式粘贴的凭据也要生效**——
  // Tzz 实测：杀掉 backend、只用 wrangler 独立代理时，前台填的整串 cookie 根本没进请求（被这里置空）；
  // 后端命中账号池时仍按其回传头合并，不冲突。guestMode（游客模拟）仍不带登录整串。
  const inProxyMode = getActiveTransport().id === 'proxy';
  const localCookie = getQuarkCookieString();
  const loginCookie = guestMode ? '' : localCookie;
  const guestPugs = guestMode && !inProxyMode ? (getQuarkPugs() ?? '') : '';
  const requestCookie = loginCookie || (guestPugs ? `__pugs=${guestPugs}` : '');
  const { data } = await request<QuarkDownloadItem[]>(
    `${API_BASE}/file/download?${DL_QUERY}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // v1.1.9.final：夸克 download 校验 Electron 客户端 UA（非定制 UA → 401 unsafe-url 风控），
        // 与 linkswift 同款；浏览器禁改 User-Agent，经代理 JSON body 透传后在服务端注入（direct 模式无效）
        'User-Agent': QUARK_DL_UA,
        ...(requestCookie ? { Cookie: requestCookie } : {}),
      },
      body: JSON.stringify({
        fids: pending.map((p) => p.fid),
        fids_token: pending.map((p) => p.token),
        pwd_id: params.shareId,
        stoken: params.stoken,
      }),
    },
    '获取下载直链',
  );
  // v1.2.2 fix（09-03）：凭据绑定改为**响应驱动、与文件 size 无关** ——
  // 托管模式（hop/云端取号）对 quark prase 一律注入正式账号 → 无论大小返回的都是登录态直链
  // （dl-pc-*），只认 __puus（OSS 鉴权）；真正的游客请求响应才下发 __pugs。
  // 此前按 isBig 分流：<50MB 的登录态直链只查 __pugs → 漏绑 __puus → 导出/推送六式全缺
  // oss 凭据（09-03 真机 41.65MB 文件复现：上游回传了 __puus 也被小文件分支丢弃）。
  // __puus 来源双通道（09-02 定）：直连 = 本地登录整串里的值；代理托管 = backend 注入账号后
  // 响应回传的 x-quark-puus（09-02 起 hop/取号在上游未刷新时还会兜底回传账号池当前值）。
  const puus = cookieValueOf(loginCookie, '__puus') ?? lastResponseQuarkPuus;
  const pugs = lastResponsePugs;
  data.forEach((item, j) => {
    if (!item.download_url) {
      fail('no-download-url', '下载接口未返回直链，请重试');
    }
    const target = pending[j];
    if (!target) return; // 响应条数 > 请求条数（上游异常）：多余条目丢弃
    const result: DownloadResult = {
      url: item.download_url, // 签名 URL，原样透传，禁止任何加工
      // v1.2.x 复用分家：直链绝对过期 ms（URL auth_key/Expires 参数解析），linkStatus 以此判定
      expiresAt: ossUrlExpiryMs(item.download_url) ?? undefined,
      hash: item.md5, // 夸克 dl 响应给 md5（v1.1.9.final：字段通用化 hash，导出注释行校验下载完整性）
    };
    // 凭据只拼单 key（__puus / __pugs），绝不带登录整串 —— 导出文件可能被分享/上传，
    // 整串或 __pus（长期凭证）泄露即账号被盗风险。无凭据则不注入，导出命令附软提示注释。
    if (puus) {
      result.cookieString = `__puus=${puus}`;
      result.cookie = { key: '__puus', value: puus };
    } else if (pugs) {
      result.cookieString = `__pugs=${pugs}`;
      result.cookie = { key: '__pugs', value: pugs };
    }
    results[target.idx] = result;
  });
  // 响应条数 < 请求条数（服务端异常/截断）→ 未回填项补失败，保持与输入顺序一致
  for (const p of pending) {
    if (!results[p.idx]) results[p.idx] = { url: '', error: '未返回直链，请重试' };
  }
  return results;
}

/** scanner 能力集合（registry.ts 组装成完整 PanAdapter） */
export const quarkScanner = {
  getToken,
  list,
  getDownloadLinks,
};
