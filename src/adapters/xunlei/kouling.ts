/**
 * 迅雷口令 → 分享链接（v1.4）
 *
 * 需求（Tzz）：首页选中「迅雷网盘」后，输入框接受**口令文字**（中文/任意词）；
 * 点「获取文件列表」→ 调（**无鉴权**）跳转接口，从响应 location 取出分享链接，等价于用户粘贴该链接。
 *
 * 接口：`GET https://api-shoulei-ssl.xunlei.com/xlppc.searcher.api/jump?noredirect=1&t=10&wd=<口令>`
 *   成功样例：`{"ext":{"kouling_type":"share_page","kouling_word":"张三丰资源"},
 *              "location":"https://pan.xunlei.com/s/VOEs0DLEAfUV9o-JOAqrzgZmA1?...&pwd=nw45&share_userid=478416968&wd=..."}`
 *   失败样例：`{"ext":{},"location":"https://m.sogou.com/web/..."}`
 * 成功判据：`ext.kouling_type === 'share_page'` 且 location 里能解析出 `pan.xunlei.com/s/<id>`；
 * 否则返回 null（调用方提示「口令不存在」）。
 *
 * 走现有 transport（代理可绕 CORS；`xunlei.com` 已在代理白名单），不做浏览器跳转（站内提取链接继续）。
 */
import { getActiveTransport } from '../../core/transport/types';

/** 口令跳转接口（无鉴权） */
export const KOULING_ENDPOINT = 'https://api-shoulei-ssl.xunlei.com/xlppc.searcher.api/jump';

export interface KoulingResult {
  /** 归一化后的分享链接（`https://pan.xunlei.com/s/<id>?pwd=<code>`） */
  url: string;
  shareId: string;
  passcode?: string;
}

/**
 * 口令解析结果（v1.4 错误分类）：
 * - `ok:true` → 拿到分享链接
 * - `ok:false, reason:'offline'` → **请求层失败**（网络异常 / CORS / 非 2xx / 非 JSON）→ UI 弹「后端断线了。。。」
 * - `ok:false, reason:'not-found'` → HTTP 2xx + JSON 解析成功，但 `ext.kouling_type !== 'share_page'`
 *   （或 location 解析不出）→ 才是真的「口令不存在」
 */
export type KoulingOutcome =
  | ({ ok: true } & KoulingResult)
  | { ok: false; reason: 'offline' | 'not-found' };

/**
 * 口令文字 → 分享链接。
 * 注意：location 里的 `&` 在 JSON 里是 `\u0026`，**必须先 JSON.parse 再取字段**（不能拿正则扫原文）。
 */
export async function resolveKouling(word: string): Promise<KoulingOutcome> {
  const wd = String(word ?? '').trim();
  if (!wd) return { ok: false, reason: 'not-found' };
  const url = `${KOULING_ENDPOINT}?noredirect=1&t=10&wd=${encodeURIComponent(wd)}`;
  let res: { status: number; body: string };
  try {
    res = await getActiveTransport().request({ url, method: 'GET', headers: { accept: 'application/json, text/plain, */*' } });
  } catch {
    // 网络异常 / CORS：请求根本没出去（或没回来）
    return { ok: false, reason: 'offline' };
  }
  if (res.status < 200 || res.status >= 300) return { ok: false, reason: 'offline' };
  let data: { ext?: { kouling_type?: string; kouling_word?: string }; location?: unknown } | null = null;
  try {
    data = JSON.parse(res.body) as { ext?: { kouling_type?: string; kouling_word?: string }; location?: unknown };
  } catch {
    return { ok: false, reason: 'offline' }; // 非 JSON：视作后端链路异常
  }
  if (!data || typeof data !== 'object') return { ok: false, reason: 'offline' };
  if (data.ext?.kouling_type !== 'share_page') return { ok: false, reason: 'not-found' };
  const location = typeof data.location === 'string' ? data.location : '';
  const m = /https?:\/\/(?:[a-z0-9-]+\.)*pan\.xunlei\.com\/s\/([A-Za-z0-9_-]+)([^\s"'<>]*)/i.exec(location);
  if (!m) return { ok: false, reason: 'not-found' };
  const shareId = m[1];
  const pwd = /[?&]pwd=([A-Za-z0-9]{4,8})/i.exec(m[2] ?? '')?.[1];
  return { ok: true, url: `https://pan.xunlei.com/s/${shareId}${pwd ? `?pwd=${pwd}` : ''}`, shareId, passcode: pwd };
}
