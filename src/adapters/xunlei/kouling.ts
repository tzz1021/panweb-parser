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
 * 口令文字 → 分享链接；失败（HTTP 非 2xx / 无 share_page / location 解析不出）返回 null。
 * 不抛错（调用方统一提示「口令不存在」）。
 */
export async function resolveKouling(word: string): Promise<KoulingResult | null> {
  const wd = String(word ?? '').trim();
  if (!wd) return null;
  const url = `${KOULING_ENDPOINT}?noredirect=1&t=10&wd=${encodeURIComponent(wd)}`;
  let res: { status: number; body: string };
  try {
    res = await getActiveTransport().request({ url, method: 'GET', headers: { accept: 'application/json, text/plain, */*' } });
  } catch {
    return null;
  }
  if (res.status < 200 || res.status >= 300) return null;
  let data: { ext?: { kouling_type?: string; kouling_word?: string }; location?: unknown } | null = null;
  try {
    data = JSON.parse(res.body) as { ext?: { kouling_type?: string; kouling_word?: string }; location?: unknown };
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  if (data.ext?.kouling_type !== 'share_page') return null;
  const location = typeof data.location === 'string' ? data.location : '';
  const m = /https?:\/\/(?:[a-z0-9-]+\.)*pan\.xunlei\.com\/s\/([A-Za-z0-9_-]+)([^\s"'<>]*)/i.exec(location);
  if (!m) return null;
  const shareId = m[1];
  const pwd = /[?&]pwd=([A-Za-z0-9]{4,8})/i.exec(m[2] ?? '')?.[1];
  return { url: `https://pan.xunlei.com/s/${shareId}${pwd ? `?pwd=${pwd}` : ''}`, shareId, passcode: pwd };
}
