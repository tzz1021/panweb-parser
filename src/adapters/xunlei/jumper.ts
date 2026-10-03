/**
 * 迅雷云盘 jumper（深链按 path 逐层深入；docs/STRUCTURE.md：src/adapters/xunlei/jumper.ts）
 *
 * 深链形态（Tzz 2026-10-03）：
 *   `https://pan.xunlei.com/s/<share_id>?pwd=<提取码>&path=%2F软件整合包%2F录屏神器%20bandicam`
 * path 是**用名字拼的路径**（不是 fid）→ 想「转到该文件夹」必须按名字逐层 list 换出真 fid。
 *
 * 本模块提供 PanAdapter 的可选方法：
 * - `buildJumpUrl(shareId, segments)`：用 segments 的 name 拼 `path=`（逐段 encodeURIComponent，
 *   空格编码为 %20 而非 '+'）；pwd 取「本次 getToken 缓存 / localStorage 覆盖式记录」（见 scanner#passcodeOf）。
 *   segments 有缺 name → 返回 null（不猜）。
 * - `parseJumpUrl(url)`：解出 `{ shareId, segments: [{ fid: '', name }] }`（fid 留空，待解析）。
 * - `resolveJumpPath({ shareId, stoken, path })`：从分享根开始逐层 `/share/detail` list，
 *   按 fileName **精确匹配**逐段下钻；命中最后一段返回其 fid。找不到 → 明确报错（不回退到根）。
 *
 * 约束（Tzz 定调）：
 * - 逐层 list 走 scanner 的现有实现（同目录翻页沿用 250ms 节流）；**不写 carry**、不缓存解析结果。
 * - 深链里没有 fid，不能凭空造；解析失败就是失败（UI 会展示中文错误）。
 */
import type { ShareId } from '../types';
import type { ListResult } from '../types';
import { XunleiApiError } from './captcha';
import { parseShareId, parseSharePath } from './selector';
import { passcodeOf, xunleiScanner } from './scanner';

/** 逐层下钻时的翻页节流（与既有「同目录翻页 250ms」同节奏） */
const XL_JUMP_PAGE_INTERVAL_MS = 250;

/** 单层最多翻页次数（护栏：异常 nextMarker 死循环） */
const XL_JUMP_MAX_PAGES = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 用名字段拼深链：`.../s/<shareId>?pwd=<码>&path=<整体 encodeURIComponent 的 /a/b>`。
 * **只编码一次**（`/` → %2F、空格 → %20、CJK 按 UTF-8 百分号编码）——早期版本「逐段编码后再整体编码」会双重编码，
 * 导致 parseJumpUrl 解出仍是 %XX 形态。缺 name / 无 shareId → null。
 */
export function buildJumpUrl(shareId: ShareId, segments: Array<{ fid: string; name: string }>): string | null {
  const names = (segments ?? []).map((s) => (s?.name ?? '').trim()).filter((n) => n !== '');
  if (!shareId || names.length === 0) return null;
  const encodedPath = encodeURIComponent('/' + names.join('/'));
  const pwd = passcodeOf(shareId);
  const prefix = pwd ? `pwd=${encodeURIComponent(pwd)}&` : '';
  return `https://pan.xunlei.com/s/${shareId}?${prefix}path=${encodedPath}`;
}

/** 解深链：`{ shareId, segments: [{ fid: '', name }] }`；非深链/无法识别 → null */
export function parseJumpUrl(url: string): { shareId: ShareId; segments: Array<{ fid: string; name: string }> } | null {
  const shareId = parseShareId(url);
  if (!shareId) return null;
  const names = parseSharePath(url);
  if (!names || names.length === 0) return null;
  return { shareId, segments: names.map((name) => ({ fid: '', name })) };
}

/**
 * 名字链 → 目标文件夹 fid：从分享根（pdirFid='0'）逐层 list，按 `fileName` 精确匹配目录。
 * 每层按 nextMarker 翻页（250ms 节流，最多 50 页护栏）；找不到 → 抛 XunleiApiError（含已解析前缀路径）。
 * 注：不读/写 carry，不缓存结果（Tzz 约束）。
 */
export async function resolveJumpPath(params: {
  shareId: ShareId;
  stoken: string;
  path: string[];
}): Promise<{ fid: string; name: string }> {
  const { shareId, stoken } = params;
  const path = (params.path ?? []).map((s) => String(s ?? '').trim()).filter((s) => s !== '');
  if (!shareId) throw new XunleiApiError('JUMP_BAD_PARAM', '跳转解析缺少 shareId');
  if (path.length === 0) throw new XunleiApiError('JUMP_BAD_PARAM', '跳转解析缺少 path（名字段为空）');

  let parentId = '0';
  let hitFid = '';
  let hitName = '';
  const walked: string[] = [];

  for (const name of path) {
    const found = await findFolderByName(shareId, stoken, parentId, name);
    if (!found) {
      throw new XunleiApiError('JUMP_NOT_FOUND', `分享内找不到该文件夹：/${[...walked, name].join('/')}`);
    }
    walked.push(name);
    parentId = found.fid;
    hitFid = found.fid;
    hitName = found.fileName;
  }
  return { fid: hitFid, name: hitName };
}

/** 在某层目录里精确匹配目录名（按 nextMarker 翻页，250ms 节流） */
async function findFolderByName(
  shareId: ShareId,
  stoken: string,
  parentId: string,
  name: string,
): Promise<{ fid: string; fileName: string } | null> {
  let marker = '';
  for (let page = 0; page < XL_JUMP_MAX_PAGES; page++) {
    const res: ListResult = await xunleiScanner.list({ shareId, stoken, pdirFid: parentId, marker: marker || undefined });
    const hit = res.files.find((f) => f.dir && f.fileName === name);
    if (hit) return { fid: hit.fid, fileName: hit.fileName };
    if (!res.nextMarker) return null;
    marker = res.nextMarker;
    await sleep(XL_JUMP_PAGE_INTERVAL_MS);
  }
  return null;
}
