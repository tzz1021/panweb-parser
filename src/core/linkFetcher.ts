/**
 * 批量直链获取（docs/STRUCTURE.md：src/core/linkFetcher.ts）
 *
 * 节流参考 LinkSwift：15 个/批 + 批间 1s，防网盘风控。
 * 职责：纯编排 —— 按输入顺序把 ShareFile[] 分批调用 adapter.getDownloadLinks，
 * 每个输入文件产出一条 LinkResult，顺序与输入一致。
 *
 * v1.2.x 契约收窄（裁决权下沉，不加新逻辑层）：
 * - 不再自己拼 fids/fidsTokens、不再预判「shareFidToken 缺失即拒绝」——
 *   shareFidToken 是 UC/夸克专属逐文件令牌，阿里没有（契约注释已标明 core 不得依赖）；
 * - 适配器从 files 自行读取所需字段构造请求（uc/quark=download、alipan=copy→取直链两跳），
 *   缺 per-file 令牌/不支持的项（如目录）由适配器在对应下标产出失败（DownloadResult.error）；
 * - 本层只负责：分批 → 调用 → 按输入顺序回填（缺项补失败）→ 单批异常整批失败语义
 *   （continueOnError=false 中止后续批次）。
 */
import type { ShareFile } from '../adapters/types';
import type { LinkFetchContext, LinkFetchOptions, LinkResult } from './types';

/** 批间等待（sleep，用于节流） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 批量获取直链。
 * @param ctx     直链获取上下文（adapter/shareId/stoken，见 core/types.ts）
 * @param files   待获取的文件列表（应只传文件；目录等不支持项由适配器兜底拒绝）
 * @param options 节流与容错配置（batchSize/batchIntervalMs/continueOnError）
 * @returns 与输入 files 一一对应的 LinkResult[]（顺序一致）
 */
export async function fetchLinks(
  ctx: LinkFetchContext,
  files: ShareFile[],
  options?: LinkFetchOptions,
): Promise<LinkResult[]> {
  const batchSize = Math.max(1, options?.batchSize ?? 15);
  const batchIntervalMs = Math.max(0, options?.batchIntervalMs ?? 1000);
  const continueOnError = options?.continueOnError ?? true;

  // 占位结果（整批覆盖；仅 continueOnError=false 中止时后续条目保留中止文案）
  const results: LinkResult[] = files.map((file) => ({
    file,
    url: '',
    ok: false,
    error: '因前序批次失败已中止，未获取直链',
  }));

  // 按输入顺序分批
  for (let start = 0; start < files.length; start += batchSize) {
    const batch = files.slice(start, start + batchSize);
    try {
      // 适配器自行从 files 读取 fid/shareFidToken（uc/quark）或 file_id（alipan）
      const urls = await ctx.adapter.getDownloadLinks({
        files: batch,
        shareId: ctx.shareId,
        stoken: ctx.stoken,
        guestMode: ctx.guestMode, // v1.1.9.final：qk-guestTurn 游客模式透传
        // v1.4 逐文件进度：原样透传（适配器可选实现；未实现则无任何回调，行为不变）
        onProgress: options?.onProgress,
        // v1.4 取链参数覆盖（用户弹窗选择；缺省由适配器按设置规则决定）
        usage: options?.usage,
      });
      // 适配器返回与输入顺序一致（接口契约）；逐一回填，数量不足时补失败项
      for (let j = 0; j < batch.length; j++) {
        const item = urls[j];
        const idx = start + j;
        if (item?.url) {
          results[idx] = {
            file: files[idx],
            url: item.url,
            ok: true,
            cookie: item.cookie,
            cookieString: item.cookieString,
            hash: item.hash,
            expiresAt: item.expiresAt, // v1.2.x：直链绝对过期 ms（复用判定用）
          };
        } else if (item?.error) {
          // 适配器逐项失败（缺令牌/转存失败/取直链失败…）：文案 + 业务码透传
          results[idx] = {
            file: files[idx],
            url: '',
            ok: false,
            error: item.error,
            errorCode: item.errorCode,
          };
        } else {
          results[idx] = { file: files[idx], url: '', ok: false, error: '未返回直链，请重试' };
        }
      }
    } catch (err) {
      // 单批失败：整批标记失败；continueOnError=false 时中止剩余批次
      const message = err instanceof Error ? err.message : String(err);
      // 业务错误码透传（duck-typing：适配器错误对象带 code 字段即可；core 零网盘依赖）
      const errorCode = (err as { code?: number | string } | null | undefined)?.code;
      for (let k = 0; k < batch.length; k++) {
        const idx = start + k;
        results[idx] = { file: files[idx], url: '', ok: false, error: message, errorCode };
      }
      if (!continueOnError) {
        // 中止：剩余未处理条目保持「已中止」文案（占位结果即该文案）
        break;
      }
    }

    // 批间节流（最后一批不必再等）
    if (start + batchSize < files.length) {
      await sleep(batchIntervalMs);
    }
  }

  return results;
}
