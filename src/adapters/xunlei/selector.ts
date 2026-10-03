/**
 * 迅雷云盘链接识别（docs/STRUCTURE.md：src/adapters/xunlei/selector.ts）
 *
 * 负责辨认 xunlei 分享链接并取分享 ID：
 * - 短链接（分享根）：`https://pan.xunlei.com/s/<share_id>`，可能带 `?pwd=xxxx` 提取码后缀
 * - **分享内子目录深链**（Tzz 2026-10-03 提供）：`.../s/<share_id>?pwd=<提取码>&path=<URL 编码的路径>`
 *   例：`?pwd=gb8f&path=%2F%E8%BD%AF%E4%BB%B6%E6%95%B4%E5%90%88%E5%8C%85%2F%E5%BD%95%E5%B1%8F%E7%A5%9E%E5%99%A8%20bandicam`
 *   —— path 是**用名字拼的路径**（不是 fid），目前未见过无提取码的分享
 *
 * jumper：暂未启用（PanAdapter 里可选）。要做的话需要「按名字逐层下钻解析出 fid」，
 * 属于额外一次目录遍历，先留 TODO（`parseSharePath()` 已把 path 段解好，可直接用）。
 */
import { SHARE_URL_RE } from './types';

/** 该链接是否属于迅雷云盘（短链与 path 深链都能识别 —— SHARE_URL_RE 不锚定结尾） */
export function detect(url: string): boolean {
  return SHARE_URL_RE.test(url);
}

/** 提取分享 ID（`/s/<id>` 段，`?pwd=` / `&path=` 均忽略）；无法识别返回 null */
export function parseShareId(url: string): string | null {
  return SHARE_URL_RE.exec(url)?.[1] ?? null;
}

/**
 * 提取深链里的 `path` 参数并拆成名字段（解码后）；无 path / 解析失败返回 null。
 * 用于未来的 jumper（转到此文件夹）：需要再按名字逐层 list 才能拿到 fid（TODO）。
 */
export function parseSharePath(url: string): string[] | null {
  if (!detect(url)) return null;
  const m = /[?&]path=([^&#]+)/.exec(url);
  if (!m) return null;
  let decoded = '';
  try {
    decoded = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  const segs = decoded.split('/').filter((s) => s !== '');
  return segs.length > 0 ? segs : null;
}
