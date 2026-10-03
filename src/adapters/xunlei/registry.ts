/**
 * 迅雷云盘适配器注册（docs/STRUCTURE.md：src/adapters/xunlei/registry.ts）
 *
 * 组装 xunlei/ 子目录各能力模块（scanner/download/selector/auth/captcha）成完整 PanAdapter，
 * 顶部 src/adapters/registry.ts 从这里 import 注册。
 *
 * 与 alipan 注册的差异：
 * - scan 免登录但需 captcha_token（每个 action 先 init）；列表是 next_page_token 游标制
 * - **captcha 分工（v1.4 Tzz 定稿）**：scan 由 SPA 本地 device_id + 本地自造 captcha；
 *   settings/restore/rename/download 属账号相关，**不由前端发**（前端只发 ops 意图，backend 代发）——
 *   故适配器不再本地算 captcha、也不持账号凭据
 * - 直链取 links[<mime>].url → web_content_link → medias[].link.url；expiresAt 优先 links[].expire
 * - **cookieInput 只作纯提示**（v1.4：前台关闭个人账号注入渠道）——无输入框、无存取钩子；
 *   教程指向仓库自述
 * - 无 carryOver 能力对象（内部转存复用见 download.ts；TODO 待定是否需要 UI 侧能力）
 * - v1.4：jumper 已实现（深链 `?pwd=&path=<名字链>` → `buildJumpUrl` / `parseJumpUrl` / `resolveJumpPath` 逐层下钻换 fid）
 * - v1.4：提供**文件级隐秘参数**能力（解析后就地展示脱敏详情；不发请求、不开外链）
 */
import type { PanAdapter } from '../types';
import { XL_DOWNLOAD_HEADERS, XL_LIMITS } from './types';
import { xunleiScanner } from './scanner';
import { xunleiDownload, xunleiFileDetailMasked } from './download';
import { detect, parseShareId } from './selector';
import { buildJumpUrl, parseJumpUrl, resolveJumpPath } from './jumper';

/** 文件级隐秘参数：解析后可见的脱敏字段（不发请求；数据来自最近一次 prase 的详情响应） */
const xunleiFileHiddenVolumn = {
  title: '文件隐秘参数（开发者）',
  emptyHint: '请先解析该文件，再查看它的隐秘参数',
  view(fid: string): Array<{ label: string; value: string }> | null {
    const m = xunleiFileDetailMasked(fid);
    if (!m) return null;
    const links = Object.entries(m.links).map(([mime, l]) => ({
      label: `links[${mime}]`,
      value: `url=${l.hasUrl ? '有' : '无'} token_type=${l.tokenType ?? '-'} expire=${l.expire ?? '-'}`,
    }));
    return [
      { label: 'name', value: m.name ?? '-' },
      { label: 'size', value: m.size === null ? '-' : String(m.size) },
      { label: 'mime_type', value: m.mimeType ?? '-' },
      { label: 'vip', value: m.vip ?? '-' },
      { label: 'web_content_link', value: m.webContentLinkPresent ? '有' : '无' },
      { label: 'hash', value: m.hash ?? '-' },
      { label: 'md5_checksum', value: m.md5Checksum ?? '-' },
      { label: 'params.device_id', value: m.params.device_id ?? '-' },
      { label: 'params.share_id', value: m.params.share_id ?? '-' },
      { label: 'params.task_id', value: m.params.task_id ?? '-' },
      ...links,
    ];
  },
};

/** 迅雷云盘适配器实例（注册进 registry 后即启用，UI 侧按接口驱动） */
export const xunleiAdapter: PanAdapter = {
  id: 'xunlei',
  name: '迅雷云盘',
  limits: XL_LIMITS,
  // 下载层静态头：**空**（真机实测裸 Range 也 206、无防盗链/UA 校验，见 types.ts#XL_DOWNLOAD_HEADERS）
  downloadHeaders: XL_DOWNLOAD_HEADERS,
  // 账号相关操作由后台代发（Tzz 2026-10-03）：前台**关闭个人账号注入渠道**，
  // cookieInput 退化为纯提示（keys 空、无 load/save/probeKeys）；整串输入框不再渲染。
  cookieInput: {
    wholeString: false,
    keys: [],
    browserCookie: false,
    intro: '迅雷 web 端很开放：你可以无需客户端直接下载文件，请去仓库自述（README）查看教程。',
    notice: '迅雷的转存/取直链由后台托管账号代发，本页不接受个人账号粘贴；若未配置托管请参照 README 教程。',
    missingHint: '解析失败常见原因：后台未维护迅雷账号（见 README 教程）、分享失效，或稍后重试。',
  },
  detect,
  parseShareId,
  // v1.3.3 jumper：深链按 path（名字链）逐层下钻 → 目标文件夹 fid
  buildJumpUrl,
  parseJumpUrl,
  resolveJumpPath,
  fileHiddenVolumn: xunleiFileHiddenVolumn,
  ...xunleiScanner,
  ...xunleiDownload,
};
