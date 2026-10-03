/**
 * 迅雷云盘扫描器（docs/STRUCTURE.md：src/adapters/xunlei/scanner.ts）
 *
 * 负责 scan 两接口（免登录，但需 captcha_token）：
 * - GET /drive/v1/share        分享根（拿 pass_code_token 与一级文件列表）
 * - GET /drive/v1/share/detail 子目录（parent_id 递归）
 * 实现依据：主线程 2026-10-02/03 真机只读实测（分享根 200；大宗分享 limit=50 → 36 条全出）。
 * 接口契约：src/adapters/types.ts（PanAdapter）
 *
 * 逆向结论（改动前必读，勿凭感觉改）：
 * - getToken = 调分享根接口拿 `pass_code_token` 作 stoken（带提取码时必需；无提取码可能为空串）
 * - 分页是**游标制**（next_page_token）：core/treeWalker 原样传 ListParams.marker，
 *   返回 ListResult.nextMarker；空串 → undefined
 * - **一级对象数只对分享根可信**（= 响应 `file_num`）；子目录**拿不到** —— 2026-10-02 真机核对：
 *   detail 响应的 `parent.params` 只有 platform/platform_icon/share_id，没有 file_property_count；
 *   而 `files[i].params.file_property_count` 出现在「父目录列出的子对象」上且语义未证实
 *   （样本里一个文件夹报 5、它的一级对象只有 2），**不能**当一级对象数用
 *   → 子目录 total 留 undefined，让 core 走慢通道（收齐后自行计数）
 * - **单页条数由设置决定**（`prefs.xunlei.scanLimit`，默认 30 = 官方 web 默认）：
 *   首页装不下（返回 next_page_token）且开关 `prefs.xunlei.bulkRetry` 打开时，
 *   改用「大宗文件判定阈值」（`prefs.bulkThreshold`，默认 100）重跑一次首页，少翻几页
 * - **pass_code 必须随分享根列表一起发**（Tzz 2026-10-03 真机：只带 pass_code_token 不带 pass_code
 *   会得到 `PASS_CODE_EMPTY`）——本模块用「本次 getToken 缓存（shareId→passcode）」
 *   + 「localStorage 覆盖式记录（只存最近一次）」两份来源；见 `passcodeOf()`。
 *   jumper / 复用 stoken 的路径**不会**走 getToken，靠后者拿 pwd。
 * - size 是**字符串**；hash 部分文件是 40 位 SHA1（且详情接口的 hash 其实是内部值）——
 *   本适配器**有意丢弃**（Tzz 拍板），ShareFile.md5 不填
 * - 迅雷无需 per-file 令牌：ShareFile.shareFidToken 不填，转存直接用 file_ids
 *
 * 注意：本模块只做分享读；转存/取直链见 download.ts（需登录态）。
 */
import type { ListParams, ListResult, ShareFile, TokenParams, TokenResult } from '../types';
import { getPreferences } from '../../core/preferences';
import { xlApiRequest, XunleiApiError } from './captcha';
import {
  XL_PAGE_SIZE,
  XL_SHARE_TOKEN_LIMIT,
  type XlShareFileRaw,
  type XlShareListResponse,
} from './types';

/** 首页默认条数（官方 web 默认 30；设置里没有/非法时回退） */
const DEFAULT_SCAN_LIMIT = 30;

/* ============================== pass_code 传递（shareId → 提取码） ============================== */

/** 本次会话内 shareId → passcode（getToken 时写入；list 分享根优先用它） */
const passcodeCache = new Map<string, string>();

/** localStorage 覆盖式记录（**只存最近一次**；jumper / 复用 stoken 路径不调 getToken，靠它取 pwd） */
export const XL_SHARE_RECORD_KEY = 'pan-web:xunlei-share:v1';

/** 最近一次分享记录（覆盖式；shareUserId 供后续同号判定用，可空） */
export interface XlShareRecord {
  shareId: string;
  passCode: string;
  shareUserId?: string;
  savedAt: number;
}

/** 覆盖式记录：localStorage 优先，node/测试环境内存兜底 */
let memShareRecord: string | null = null;

function readShareRecord(): XlShareRecord | null {
  let raw: string | null = null;
  try {
    if (typeof localStorage !== 'undefined') raw = localStorage.getItem(XL_SHARE_RECORD_KEY);
  } catch {
    raw = null;
  }
  if (raw === null) raw = memShareRecord;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<XlShareRecord> | null;
    if (parsed && typeof parsed.shareId === 'string' && typeof parsed.passCode === 'string') {
      return { shareId: parsed.shareId, passCode: parsed.passCode, shareUserId: parsed.shareUserId, savedAt: Number(parsed.savedAt) || 0 };
    }
  } catch {
    // 损坏按无记录处理
  }
  return null;
}

function writeShareRecord(rec: XlShareRecord): void {
  const raw = JSON.stringify(rec);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(XL_SHARE_RECORD_KEY, raw);
      return;
    }
  } catch {
    // 隐私模式/配额 → 落内存
  }
  memShareRecord = raw;
}

/** 记下本次分享的提取码（getToken 成功后调用；进程内缓存 + localStorage 覆盖式记录） */
export function rememberSharePasscode(shareId: string, passCode: string, shareUserId?: string): void {
  if (!shareId) return;
  const code = String(passCode ?? '');
  passcodeCache.set(shareId, code);
  writeShareRecord({ shareId, passCode: code, shareUserId: shareUserId !== undefined ? String(shareUserId) : undefined, savedAt: Date.now() });
}

/**
 * 取某分享应带的 pass_code：本次 getToken 缓存优先 → localStorage 覆盖式记录（同 shareId 才用）→ ''。
 * 保证「jumper / 复用 stoken（不走 getToken）」也能拿到 pwd。
 */
export function passcodeOf(shareId: string): string {
  if (!shareId) return '';
  const cached = passcodeCache.get(shareId);
  if (cached !== undefined && cached !== '') return cached;
  const rec = readShareRecord();
  if (rec && rec.shareId === shareId) return rec.passCode;
  return cached ?? '';
}

/** 分享状态异常时抛错（share_status 非 'OK'）。
 * PASS_CODE_EMPTY 单独出中文文案（Tzz 2026-10-03 真机复现：分享根列表必须带 pass_code，
 * 否则返回 PASS_CODE_EMPTY / file_num 0 / files 空）——不把状态码吞掉，其他状态照旧。 */
function assertShareOk(data: XlShareListResponse): void {
  const st = data.share_status;
  if (!st || st === 'OK') return;
  if (st === 'PASS_CODE_EMPTY') {
    throw new XunleiApiError(st, '该分享需要提取码（pwd=），请填写提取码后重试');
  }
  throw new XunleiApiError(st, `分享状态异常（${st}），请检查提取码或分享是否失效`);
}

/** 数字字段归一（file_num 等可能是数字或字符串） */
function toNumberOrUndefined(v: number | string | undefined): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 首页条数：设置优先（scanLimit，默认 30），非法回退 */
function scanPageLimit(): number {
  const n = Number(getPreferences().xunlei?.scanLimit);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SCAN_LIMIT;
}

/** 重跑首页时用的条数：大宗判定阈值（> 当前条数才有意义），否则 0 = 不重跑 */
function bulkRetryLimit(currentLimit: number): number {
  const prefs = getPreferences();
  if (!prefs.xunlei?.bulkRetry) return 0;
  const bulk = Number(prefs.bulkThreshold);
  return Number.isFinite(bulk) && bulk > currentLimit ? Math.floor(bulk) : 0;
}

/** 原始字段 → 接口 ShareFile（迅雷 snake_case → camelCase） */
function toShareFile(item: XlShareFileRaw): ShareFile {
  const sizeRaw = item.size;
  const size = sizeRaw === undefined || sizeRaw === '' ? NaN : Number(sizeRaw);
  return {
    fid: item.id,
    fileName: item.name ?? '',
    dir: item.kind === 'drive#folder',
    size: Number.isFinite(size) ? size : 0,
    formatType: item.mime_type,
    modifiedAt: item.modified_time ? Date.parse(item.modified_time) || undefined : undefined,
    // md5 不填：迅雷的 hash 是内部值（分享态那个 40 位 SHA1 也不采用），本项目有意丢弃（etagNote）
    // shareFidToken 不填：迅雷转存用 file_ids，无需逐文件令牌
  };
}

/** 拉一页（root = 分享根接口；否则 detail） */
async function fetchPage(
  params: ListParams,
  limit: number,
  pageToken: string,
): Promise<XlShareListResponse> {
  const rootMode = params.pdirFid === '0';
  if (rootMode) {
    return xlApiRequest<XlShareListResponse>({
      method: 'GET',
      path: '/drive/v1/share',
      query: {
        share_id: params.shareId,
        pass_code: passcodeOf(params.shareId),
        limit,
        pass_code_token: params.stoken,
        page_token: pageToken,
        scene: 'NORMAL',
        order: 'DEFAULT_ORDER',
        thumbnail_size: 'SIZE_MEDIUM',
      },
      step: '获取目录列表',
    });
  }
  return xlApiRequest<XlShareListResponse>({
    method: 'GET',
    path: '/drive/v1/share/detail',
    query: {
      share_id: params.shareId,
      parent_id: params.pdirFid,
      pass_code_token: params.stoken,
      limit,
      keyword: '',
      page_token: pageToken,
      scene: 'NORMAL',
      order: 'MODIFY_TIME_DESC_V2',
      thumbnail_size: 'SIZE_MEDIUM',
    },
    step: '获取目录列表',
  });
}

/**
 * 第 1 步：获取分享访问令牌 stoken（= 分享根响应的 pass_code_token）。
 * 带提取码的分享用它授权后续 detail 请求；无提取码的公开分享可能返回空串（本层不视为失败）。
 */
async function getToken(params: TokenParams): Promise<TokenResult> {
  const data = await xlApiRequest<XlShareListResponse>({
    method: 'GET',
    path: '/drive/v1/share',
    query: {
      share_id: params.shareId,
      pass_code: params.passcode ?? '',
      limit: XL_SHARE_TOKEN_LIMIT,
      pass_code_token: '',
      page_token: '',
      scene: 'NORMAL',
      order: 'DEFAULT_ORDER',
      thumbnail_size: 'SIZE_MEDIUM',
    },
    step: '获取分享令牌',
  });
  assertShareOk(data);
  // 记下提取码：list() 分享根 / jumper / 复用 stoken 路径都要带 pass_code（Tzz 2026-10-03）
  rememberSharePasscode(params.shareId, params.passcode ?? '', data.user_info?.user_id as string | undefined);
  return { stoken: data.pass_code_token ?? '' };
}

/**
 * 第 2 步：单层目录/文件列表（目录遍历由 core/treeWalker 递归调用）。
 * - 分享根（pdirFid === '0'）：total = file_num（该值真机核对 = 根一级对象数）
 * - 子目录：**不提供 total**（上游不回，详见文件头注释）→ core 走慢通道自行计数
 * 游标分页：marker（= 上页 next_page_token）原样带上；空 next_page_token → undefined。
 * 首页条数走设置（scanLimit，默认 30），装不下且开关打开时按大宗阈值重跑一次。
 */
async function list(params: ListParams): Promise<ListResult> {
  const pageToken = params.marker ?? '';
  const isFirstPage = pageToken === '';
  const limit = isFirstPage ? scanPageLimit() : params.size ?? XL_PAGE_SIZE;
  const rootMode = params.pdirFid === '0';

  let data = await fetchPage(params, limit, pageToken);
  if (isFirstPage) {
    const retryLimit = bulkRetryLimit(limit);
    if (retryLimit && data.next_page_token) {
      // 重跑失败（例如上游不接受这么大的 limit / 风控）不能拖垮整次遍历 → 吞掉异常、用原页
      try {
        const bigger = await fetchPage(params, retryLimit, '');
        if ((bigger.files?.length ?? 0) >= (data.files?.length ?? 0)) data = bigger;
      } catch {
        // 保留首页结果，后续按页续拉
      }
    }
  }
  assertShareOk(data);
  return {
    files: (data.files ?? []).map(toShareFile),
    // total 只有分享根可信；子目录有意留空（上游不回，见文件头注释）
    total: rootMode ? toNumberOrUndefined(data.file_num) : undefined,
    nextMarker: data.next_page_token || undefined,
  };
}

/** scanner 能力集合（registry.ts 组装成完整 PanAdapter；转存/取直链见 download.ts） */
export const xunleiScanner = {
  getToken,
  list,
};
