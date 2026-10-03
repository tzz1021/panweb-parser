/**
 * 迅雷云盘 ops 编排 + 取直链（docs/STRUCTURE.md：src/adapters/xunlei/download.ts）
 *
 * v1.4 架构（Tzz 2026-10-03 定稿，重要）：
 * - **scan**（share / share/detail）由 SPA 本地发（本地 device_id + 本地自造 captcha）。
 * - **settings / restore / rename / download** 是**账号相关**操作，**不能由前端带凭据/头发** ——
 *   本模块只向 functions 发「请求意图」（`POST /api/xunlei/op`），由 functions 转 backend，
 *   **backend 用自己的 device_id / captcha_sign→captcha_token / authorization 完成上游请求**，
 *   再把结果（url / expiresAt / 映射 / 错误）回传。适配器不再构造任何上游请求头、不再本地算 captcha。
 *   原因：captcha 绑定 device_id，前端冒用后端 device/captcha 会把后端设备甚至账号标记。
 *
 * 编排顺序（Tzz 定稿节奏）：
 *   ① 同号快捷（Tzz 实测：分享 detail 的 file id == 分享者自己盘里的 id）→ **跳过 settings/restore**，
 *      直接对分享 file id 调 download；`NEED_RENAME`（压缩类详情无直链）同样证明文件已在我盘 → 同号。
 *   ② 非同号：settings（设转存目录）→ 等 1s → restore（**批量**，返回 fid → 我盘 file id 映射）。
 *   ③ 逐文件（download 不能批量）：压缩类（zip / 7z / rar）先 rename（`<原名>.<三位补零随机数>`，
 *      伪装分卷）→ 等 1s → download；其他类型直接 download。逐文件之间 1s。
 *
 * 特殊文件类型（§三）：`mime_type ∈ {application/zip, application/x-7z-compressed,
 * application/x-rar-compressed}` 的文件详情**没有 web_content_link / links**（云解压卖点），
 * 必须先 rename 才出直链；其他类型不要 rename。
 *
 * 转存复用（carry-over，本地缓存，v1.4 保留）：`pan-web:xunlei-carry:v1`，
 * `{ '<shareId>|<分享 file id>': { fileId: <我盘 file id>, savedAt } }`，TTL 12h；
 * 命中 → 跳过同号探测与 settings/restore，直接进逐文件阶段。只记成功转存的映射。
 *
 * 账号来源：backend 的设置/凭据池（`xunlei_authorization` + `xunlei_to_parent_id`，或 pan=xunlei 账号）；
 * 池里没有 → op 返回 `NO_ACCOUNT`（中文，指引 README 教程），本层逐文件明确失败，不静默。
 */
import type { DownloadParams, DownloadResult, LinkProgressEvent, ShareFile } from '../types';
import { getActiveTransport, type XunleiOpPayload, type XunleiOpResult } from '../../core/transport/types';
import { XL_CARRY_STORAGE_KEY, XL_CARRY_TTL_MS } from './types';

/** ops 之间的固定间隔（Tzz 定稿：settings→1s→restore；rename→1s→download；逐文件 1s） */
const XL_OP_INTERVAL_MS = 1000;

/** 需要先 rename 才出直链的压缩类 mime（云解压卖点，详情无直链；其他类型不要 rename） */
const COMPRESS_MIMES = new Set(['application/zip', 'application/x-7z-compressed', 'application/x-rar-compressed']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ops 错误（携带 code 供 core 分类；message 已是最终中文，可直接展示） */
export class XunleiOpError extends Error {
  readonly code: number | string;
  constructor(code: number | string, message: string) {
    super(message);
    this.name = 'XunleiOpError';
    this.code = code;
  }
}

/* ============================== ops 调用 ============================== */

/**
 * 发一条 ops 意图并校验结果；业务失败抛 XunleiOpError（携带 backend 给的 code）。
 * 直连（无代理）→ 明确「需要代理托管」错误（不静默）。
 */
async function op(payload: XunleiOpPayload, step: string): Promise<NonNullable<XunleiOpResult['data']>> {
  const transport = getActiveTransport();
  if (!transport.xunleiOp) {
    throw new XunleiOpError(
      'NO_BACKEND',
      '迅雷解析需要代理托管：请在「系统配置 → 传输方式」填写本机管理面板地址（settings/restore/rename/download 由后台代发；scan 仍可直连）',
    );
  }
  const r = await transport.xunleiOp(payload);
  const d = r.data;
  if (!r.ok || !d) {
    throw new XunleiOpError(
      d?.code ?? d?.error ?? `OP_HTTP_${r.status}`,
      `${step}失败：${d?.message ?? d?.error ?? (r.status === 0 ? '代理不可达' : `托管后端 HTTP ${r.status}`)}`,
    );
  }
  if (d.ok === false) {
    throw new XunleiOpError(d.code ?? d.error ?? 'OP_FAILED', `${step}失败：${d.message ?? d.error ?? '迅雷操作失败'}`);
  }
  return d;
}

/* ============================== 详情存档（脱敏，供「隐秘参数」） ============================== */

/**
 * 脱敏详情视图（backend 在 ops 结果里带回，已是脱敏形态）。
 * **不含** Authorization / captcha_token / links[].token 明文（token 只给类型/过期，URL 只报存在性）。
 */
export interface XunleiFileDetailMasked {
  name: string | null;
  mimeType: string | null;
  size: number | null;
  vip: string | null;
  hash: string | null;
  md5Checksum: string | null;
  links: Record<string, { hasUrl: boolean; tokenType: string | null; expire: string | null }>;
  params: { device_id: string | null; share_id: string | null; task_id: string | null };
  webContentLinkPresent: boolean;
}

/** 解析结果里的 fid → 脱敏详情（内存，不落盘；供文件级「隐秘参数」就地查看） */
const detailStore = new Map<string, XunleiFileDetailMasked>();

/** 原始详情留在 backend，SPA 只持脱敏视图；取某 fid 的脱敏详情（未解析返回 null） */
export function getXunleiFileDetail(fid: string): XunleiFileDetailMasked | null {
  return detailStore.get(fid) ?? null;
}

/** 同 getXunleiFileDetail（命名对齐 batch2；语义已收窄为**脱敏**视图） */
export function xunleiFileDetailMasked(fid: string): XunleiFileDetailMasked | null {
  return detailStore.get(fid) ?? null;
}

/** 脱敏详情 → 「隐秘参数」字段行（UI 弹窗用；未解析返回 null） */
export function xunleiFileHiddenRows(fid: string): Array<{ label: string; value: string }> | null {
  const d = detailStore.get(fid);
  if (!d) return null;
  const rows: Array<{ label: string; value: string }> = [
    { label: 'name', value: d.name ?? '-' },
    { label: 'mime_type', value: d.mimeType ?? '-' },
    { label: 'size', value: d.size === null ? '-' : String(d.size) },
    { label: 'vip', value: d.vip ?? '-' },
    { label: 'hash', value: d.hash ?? '-' },
    { label: 'md5_checksum', value: d.md5Checksum ?? '-' },
    { label: 'params.device_id', value: d.params.device_id ?? '-' },
    { label: 'params.share_id', value: d.params.share_id ?? '-' },
    { label: 'params.task_id', value: d.params.task_id ?? '-' },
  ];
  for (const [mime, link] of Object.entries(d.links)) {
    rows.push({
      label: `links.${mime}`,
      value: `url:${link.hasUrl ? '有' : '无'} token_type:${link.tokenType ?? '-'} expire:${link.expire ?? '-'}`,
    });
  }
  if (d.webContentLinkPresent) rows.push({ label: 'web_content_link', value: '有' });
  return rows;
}

function storeDetail(fid: string, detail: unknown): void {
  if (detail && typeof detail === 'object') detailStore.set(fid, detail as XunleiFileDetailMasked);
}

/* ============================== 转存复用缓存（carry-over） ============================== */

interface CarryEntry {
  fileId: string;
  savedAt: number;
}

/** carry 存储：localStorage 优先，node/测试环境内存兜底 */
const memCarry = new Map<string, string>();

function carryGet(): string | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage.getItem(XL_CARRY_STORAGE_KEY);
  } catch {
    // 走内存
  }
  return memCarry.get(XL_CARRY_STORAGE_KEY) ?? null;
}

function carrySet(value: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(XL_CARRY_STORAGE_KEY, value);
      return;
    }
  } catch {
    // 落内存
  }
  memCarry.set(XL_CARRY_STORAGE_KEY, value);
}

function carryKey(shareId: string, fid: string): string {
  return `${shareId}|${fid}`;
}

/** 读取并清理过期的 carry 映射（TTL 12h） */
function readCarry(): Record<string, CarryEntry> {
  const raw = carryGet();
  if (!raw) return {};
  let parsed: Record<string, CarryEntry> = {};
  try {
    const data = JSON.parse(raw) as Record<string, CarryEntry> | null;
    if (data && typeof data === 'object') parsed = data;
  } catch {
    return {};
  }
  const now = Date.now();
  const out: Record<string, CarryEntry> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (v && typeof v.fileId === 'string' && v.fileId && typeof v.savedAt === 'number' && now - v.savedAt < XL_CARRY_TTL_MS) {
      out[k] = v;
    }
  }
  return out;
}

function writeCarry(map: Record<string, CarryEntry>): void {
  try {
    carrySet(JSON.stringify(map));
  } catch {
    // 配额异常静默（复用缓存非必需）
  }
}

/** 查某分享文件的转存命中（未命中返回 null） */
function carriedTargetOf(shareId: string, fid: string): CarryEntry | null {
  const map = readCarry();
  return map[carryKey(shareId, fid)] ?? null;
}

/** 记下本批成功转存的映射（分享 file id → 我盘 file id）；失败/同号不写 */
function rememberCarried(shareId: string, copied: Record<string, string>): void {
  if (Object.keys(copied).length === 0) return;
  const map = readCarry();
  const savedAt = Date.now();
  for (const [fid, fileId] of Object.entries(copied)) {
    if (fileId) map[carryKey(shareId, fid)] = { fileId, savedAt };
  }
  writeCarry(map);
}

/* ============================== 单文件取直链（rename → download） ============================== */

/** 该文件是否需要先 rename（压缩类：详情无直链） */
function isCompress(file: ShareFile): boolean {
  return COMPRESS_MIMES.has((file.formatType ?? '').toLowerCase());
}

function sizeOfBackend(d: { size?: unknown }, file: ShareFile): number {
  const n = Number(d.size);
  return Number.isFinite(n) && n >= 0 ? n : file.size;
}

/** 单文件：压缩类先 rename（+1s）再 download；失败不抛，按下标回填失败项 */
async function fetchOne(
  file: ShareFile,
  fid: string,
  onStage?: (stage: 'rename' | 'download') => void,
): Promise<DownloadResult> {
  try {
    if (isCompress(file)) {
      onStage?.('rename');
      await op({ op: 'rename', fid, name: file.fileName }, '重命名压缩包');
      await sleep(XL_OP_INTERVAL_MS); // rename 与 download 之间间隔 1s
    }
    onStage?.('download');
    const d = await op({ op: 'download', fid }, '获取下载直链');
    if (!d.url) {
      return { url: '', fileName: file.fileName, size: file.size, error: '未返回直链（backend 结果无 url）', errorCode: 'NO_DOWNLOAD_URL' };
    }
    storeDetail(fid, d.detail);
    return { url: d.url, fileName: file.fileName, size: sizeOfBackend(d, file), expiresAt: d.expiresAt };
  } catch (err) {
    return {
      url: '',
      fileName: file.fileName,
      size: file.size,
      error: err instanceof Error ? err.message : '获取直链失败，请重试',
      errorCode: err instanceof XunleiOpError ? err.code : 'DOWNLOAD_FAILED',
    };
  }
}

/* ============================== 主流程 ============================== */

/**
 * 批量获取下载直链（一次调用 = 一批；批间节流归 core/linkFetcher）。
 * 返回顺序与入参一致；逐文件失败在对应下标产出 error/errorCode（不整批 throw，避免 core 中断）；
 * 仅「账号缺失/无托管」这类整批前提缺失也按逐文件失败项返回。
 */
async function getDownloadLinks(params: DownloadParams): Promise<DownloadResult[]> {
  const files = params.files;
  if (files.length === 0) return [];

  const failAll = (error: string, errorCode: number | string): DownloadResult[] =>
    files.map((f) => ({ url: '', fileName: f.fileName, size: f.size, error, errorCode }));

  // v1.4 逐文件进度（只报，不影响结果/顺序）：total = 本批文件数；done = 本批已完成数
  let done = 0;
  const emit = (stage: LinkProgressEvent['stage'], fid: string): void => {
    params.onProgress?.({ done, total: files.length, fid, stage });
  };
  const finish = (i: number): void => {
    done++;
    emit('download', files[i].fid);
  };

  const resultByIdx: Array<DownloadResult | undefined> = new Array<DownloadResult | undefined>(files.length);
  const newIdByIdx: Array<string | undefined> = new Array<string | undefined>(files.length);
  const needCopy: number[] = [];

  // ① carry 命中 → 跳过同号探测与 settings/restore
  for (let i = 0; i < files.length; i++) {
    const carried = carriedTargetOf(params.shareId, files[i].fid);
    if (carried) newIdByIdx[i] = carried.fileId;
    else needCopy.push(i);
  }

  // ② 同号快捷（Tzz 实测：分享 file id == 分享者自己盘 id）：直接 download 探测第一个未命中文件
  let sameAccount = false;
  const probed = new Map<number, DownloadResult>();
  if (needCopy.length > 0) {
    const i0 = needCopy[0];
    try {
      emit('probe', files[i0].fid);
      const d = await op({ op: 'download', fid: files[i0].fid }, '同号探测（直接取直链）');
      sameAccount = true;
      if (d.url) {
        storeDetail(files[i0].fid, d.detail);
        probed.set(i0, { url: d.url, fileName: files[i0].fileName, size: sizeOfBackend(d, files[i0]), expiresAt: d.expiresAt });
      }
    } catch (err) {
      const code = err instanceof XunleiOpError ? err.code : '';
      if (code === 'NEED_RENAME') {
        // 压缩类详情无直链 → 文件确实已在我盘（同号成立），稍后 rename 再 download
        sameAccount = true;
      } else if (code === 'NO_ACCOUNT' || code === 'NO_BACKEND') {
        return failAll(err instanceof Error ? err.message : '迅雷账号不可用', code);
      } else {
        sameAccount = false; // 其他错误 → 按「需转存」继续，由 restore 给最终结论
      }
    }
    if (sameAccount) {
      for (const i of needCopy) newIdByIdx[i] = files[i].fid;
    }
  }

  // ③ 非同号：settings → 1s → 批量 restore（to_parent_id / 凭据由 backend 自己持有）
  if (needCopy.length > 0 && !sameAccount) {
    try {
      emit('settings', files[needCopy[0]].fid);
      await op({ op: 'settings' }, '设置转存目录');
      await sleep(XL_OP_INTERVAL_MS);
      emit('restore', files[needCopy[0]].fid);
      const r = await op(
        { op: 'restore', share_id: params.shareId, pass_code_token: params.stoken, fids: needCopy.map((i) => files[i].fid) },
        '转存到自己的网盘',
      );
      const map = new Map((r.results ?? []).map((x) => [x.fid, x.fileId]));
      const copied: Record<string, string> = {};
      for (const i of needCopy) {
        const nid = map.get(files[i].fid);
        if (nid) {
          newIdByIdx[i] = nid;
          copied[files[i].fid] = nid;
        } else {
          resultByIdx[i] = {
            url: '',
            fileName: files[i].fileName,
            size: files[i].size,
            error: `第 ${i + 1} 个文件转存未返回新 file id（restore 映射缺该文件）`,
            errorCode: 'RESTORE_NO_ID',
          };
        }
      }
      // 只记成功转存的映射（同号/失败走不到这里，天然不写 carry）
      rememberCarried(params.shareId, copied);
    } catch (err) {
      return failAll(
        err instanceof Error ? err.message : '转存失败，请重试',
        err instanceof XunleiOpError ? err.code : 'RESTORE_FAILED',
      );
    }
  }

  // ④ 逐文件（download 不能批量）：压缩类 rename(+1s) → download；文件之间 1s。
  //    每个文件无论成败都记一次完成（进度不卡）
  for (let i = 0; i < files.length; i++) {
    if (resultByIdx[i]) {
      // restore 未返回映射等已判定失败：也算完成
      finish(i);
    } else {
      const hit = probed.get(i);
      if (hit) {
        resultByIdx[i] = hit;
      } else {
        const newId = newIdByIdx[i];
        if (!newId) {
          resultByIdx[i] = {
            url: '',
            fileName: files[i].fileName,
            size: files[i].size,
            error: `第 ${i + 1} 个文件缺少我盘 file id`,
            errorCode: 'NO_FILE_ID',
          };
        } else {
          resultByIdx[i] = await fetchOne(files[i], newId, (stage) => emit(stage, files[i].fid));
        }
      }
      finish(i);
    }
    if (i < files.length - 1) await sleep(XL_OP_INTERVAL_MS);
  }

  return resultByIdx as DownloadResult[];
}

/** download 能力集合（registry.ts 组装成完整 PanAdapter；scan 见 scanner.ts） */
export const xunleiDownload = {
  getDownloadLinks,
};
