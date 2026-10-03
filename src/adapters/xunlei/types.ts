/**
 * 迅雷云盘（xunlei）静态属性（docs/STRUCTURE.md：src/adapters/xunlei/types.ts）
 *
 * 存放 xunlei 的静态常量与原始类型：API 地址、客户端身份（in-the-wild alist SDK 身份）、
 * captcha 盐表、错误码映射、特性表、share/detail/restore/files 原始响应元素等。
 * 云端策略变动（错误码/参数/限制）只需改这里。
 *
 * 实现依据：主线程 2026-10-02 真机只读实测（share 读链路 200 零登录；restore/download 需
 * Bearer 登录态，无 Authorization → 401 unauthenticated）。身份常量借用 alist 的在野身份：
 * web 端盐表已失效/混淆，实测复现不出其 sign，故照 alist 的 client_id/版本/盐表实现。
 * 约束：本文件零运行时依赖（纯常量/类型），可被 selector/captcha/scanner/download 共用。
 *
 * 契约速记（改动前必读）：
 * - 分享 URL：https://pan.xunlei.com/s/<share_id>（可带 ?pwd=xxxx；只认 pan.xunlei.com）
 * - scan（GET /drive/v1/share、GET /drive/v1/share/detail）免登录，但每个 action 需先
 *   POST xluser-ssl.xunlei.com/v1/shield/captcha/init 拿 captcha_token（见 captcha.ts），
 *   请求头带 x-client-id / x-device-id / x-captcha-token（见 XL_CLIENT / captchaHeaders）
 * - restore/download 需 `Authorization: <token_type> <access_token>`：
 *   settings（设转存目录）→ share/restore（批量转存，params.trace_file_ids 是 JSON 字符串）
 *   → GET /drive/v1/files/<新 file_id> 取 web_content_link（另有 medias[].link.url 备选）
 * - 迅雷不允许接收者是分享者（分享者 user_id 在分享响应 user_info.user_id）
 */

/** 分享 ID 形如 https://pan.xunlei.com/s/<share_id>（短链可能带 ?pwd=xxxx；仅认 pan.xunlei.com） */
export const SHARE_URL_RE = /^https?:\/\/(?:[a-z0-9-]+\.)*pan\.xunlei\.com\/s\/([A-Za-z0-9_-]+)/i;

/** 迅雷云盘业务 API 前缀（share / share/detail / settings / share/restore / files） */
export const API_BASE = 'https://api-pan.xunlei.com';

/** 迅雷账号/验证码服务前缀（captcha init 专用） */
export const XLUSER_BASE = 'https://xluser-ssl.xunlei.com';

/**
 * 客户端身份（in-the-wild alist SDK 身份；web 端盐表已失效/混淆，实测复现不出其 sign）。
 * 盐表 10 条用于 captcha_sign 的 md5 链（见 captcha.ts#captchaSign）。
 */
export const XL_CLIENT = {
  clientId: 'Xp6vsxz_7IYVw2BB',
  clientVersion: '8.31.0.9726',
  packageName: 'com.xunlei.downloadprovider',
  /** alist 的 android UA 串（分享链路与 captcha 头共用） */
  ua: 'ANDROID-com.xunlei.downloadprovider/8.31.0.9726 netWorkType/5G appid/40 deviceName/Xiaomi_M2004j7ac deviceModel/M2004J7AC OSVersion/12 protocolVersion/301 platformVersion/10 sdkVersion/512000 Oauth2Client/0.9 (Linux 4_14_186-perf-gddfs8vbb238b) (JAVA 0)',
  /** captcha_sign 盐表（照抄 alist；顺序敏感） */
  salts: [
    '9uJNVj/wLmdwKrJaVj/omlQ',
    'Oz64Lp0GigmChHMf/6TNfxx7O9PyopcczMsnf',
    'Eb+L7Ce+Ej48u',
    'jKY0',
    'ASr0zCl6v8W4aidjPK5KHd1Lq3t+vBFf41dqv5+fnOd',
    'wQlozdg6r1qxh0eRmt3QgNXOvSZO6q/GXK',
    'gmirk+ciAvIgA/cxUUCema47jr/YToixTT+Q6O',
    '5IiCoM9B1/788ntB',
    'P07JH0h6qoM6TSUAK2aL9T5s2QBVeY9JWvalf',
    '+oK0AN',
  ],
} as const;

/**
 * 下载层静态头：**空**（2026-10-03 真机 Range 探针核准）。
 * 实测：无任何请求头（无 UA / 无 Referer）也 206；错 Referer 也 206；响应无 content-disposition
 * ⇒ CDN 不校验防盗链/UA，直链本身也不带文件名（导出必须用我们自己的路径名）。
 * alist 那个 Dalvik UA 没必要（实测也不更快）→ 不再注入任何下载头。
 */
export const XL_DOWNLOAD_HEADERS = {} as const;

/**
 * web 端身份常量（**文档/后端默认值**；只有 backend 用它去 captcha/init，SPA 不使用）。
 * 出处：Tzz 2026-10-02 浏览器抓包（workspace/xunlei-probe.mjs#PROFILES.web）+ 逆向笔记 §2.1。
 * web 端 captcha_sign 算法被混淆、前端算不出 ⇒ 由 backend 保存一份手动录入的 sign 长期复用。
 */
export const XL_WEB_CLIENT = {
  clientId: 'Xqp0kJBXWhwaTpB6',
  clientVersion: '1.93.6',
  packageName: 'pan.xunlei.com',
} as const;

/** 分享根/子目录单页条数：主线程真机实测 limit=50 → 大宗分享 36 条全出（limit=30 → 30+游标） */
export const XL_PAGE_SIZE = 50;
/** getToken 阶段分享根请求条数（官方 web 默认 30；我们直接取 50，避免根层 >30 个对象时截断） */
export const XL_SHARE_TOKEN_LIMIT = 50;

/** 存储键（本项目其它键同风格，见 alipan/quark 的 pan-web:* ） */
export const XL_DEVICE_STORAGE_KEY = 'pan-web:xunlei-device:v1';
export const XL_CAPTCHA_STORAGE_KEY = 'pan-web:xunlei-captcha:v1';
export const XL_CARRY_STORAGE_KEY = 'pan-web:xunlei-carry:v1';

/** captcha_token 剩余有效期 > 该值才复用（否则重新 init；scan 一次 60s 足够） */
export const XL_CAPTCHA_REUSE_MARGIN_MS = 60_000;

/** 转存复用（carry-over）记录有效期：12h（超出视为失效，重新转存） */
export const XL_CARRY_TTL_MS = 12 * 60 * 60 * 1000;

/** captcha init 默认有效期（响应未给 expires_in 时兜底，秒） */
export const XL_CAPTCHA_DEFAULT_TTL_S = 300;

/** captcha init 的重定向 URI（照抄真机参数） */
export const XL_CAPTCHA_REDIRECT_URI = 'xlaccsdk01://xunlei.com/callback?state=harbor';

/**
 * 错误码/错误标识 → 中文文案（迅雷业务错误 = HTTP 4xx + body 的 error/error_description，
 * 或 body 数值码 error_code；字符串标识与数字码并存）。
 * 依据：主线程真机给出的错误码表：captcha_invalid / invalid captcha_sign / 9（captcha 过期）/
 * 4121·4122·10·16（login token 过期，照 alist 容错）。
 */
export const ERROR_MESSAGES: Record<string, string> = {
  captcha_invalid: '验证码令牌已失效（captcha_invalid），请重试',
  'invalid captcha_sign': '客户端签名无效（invalid captcha_sign），请刷新页面后重试',
  9: '验证码已过期，请重试',
  4121: '登录态已过期，请重新填写授权头',
  4122: '登录态已过期，请重新填写授权头',
  10: '登录态已过期，请重新填写授权头',
  16: '登录态已过期，请重新填写授权头',
  401: '登录态无效（401），请重新填写授权头',
};

/**
 * 「登录态过期」数值码（照 alist 容错：alist 收到这些码会刷新 access token）。
 * 本适配器登录态由用户手填（无 refresh_token），故只作为**过期判定**：
 * 抛错时保留该码 + ERROR_MESSAGES 文案，由 UI 提示重新填写。
 */
export const XL_LOGIN_EXPIRED_CODES: readonly number[] = [4121, 4122, 10, 16];

/** captcha 过期（业务码 9）：请求层清缓存 + 同 action 重新 init 后重试一次 */
export const XL_CAPTCHA_EXPIRED_CODE = 9;

/** 迅雷云盘特性表（偏好设置 UAC 表数据源，Tzz 2026-09-25/10-02 表） */
export const XL_LIMITS = {
  needsTransfer: true, // 取直链必须先转存到自己的网盘
  needsLogin: true, // restore/download 硬前提
  canRemoveSpeedLimit: false, // 未知，按「不误导」原则
  needsCookie: false, // 登录态是 Authorization 头，不是 cookie
  noLoginNeeded: false,
  batchOnlyAriaGopeed: false,
  sizeLimitNote: '游客可 scan；restore/download 必须登录态（无大小分级）',
  // v1.4：直链实测（Range 探针）——无防盗链、不带文件名；hash 是内部标识值
  linkExpiryNote: '直链 6h（e= / links[].expire）',
  downloadUrlNote: '无需任何请求头（实测裸 Range 206）；直链不带文件名',
  loginCredTtlNote: 'auth(JWT) 1d',
  etagNote: 'hash 是内部标识值（非内容摘要），本项目不采用',
  sessionRenewNote: 'cookie',
  altRenewNote: 'Alist(SDK) 反代，会与手机 app 互踢',
  scanStrategyNote: '单页条数按设置（默认 30，官方同值）',
  restoreStrategyNote: '不允许接收者是分享者',
  downloadStrategyNote: '需登录态 + 转存（批量转存后逐个取详情）',
} as const;

/* ============================== 原始响应类型（只列适配器用到的字段） ============================== */

/** share / share/detail 响应的 files[] 原始元素 */
export interface XlShareFileRaw {
  /** 'drive#folder' = 目录；'drive#file' = 文件 */
  kind?: string;
  id: string;
  name?: string;
  /** 大小（**字符串**） */
  size?: string;
  /** 部分文件是 40 位 SHA1；本适配器有意丢弃（见 etagNote / toShareFile 注释） */
  hash?: string;
  /** ISO+08:00 */
  modified_time?: string;
  created_time?: string;
  file_extension?: string;
  mime_type?: string;
  parent_id?: string;
  params?: {
    /** 语义未证实：出现在「父目录列出的子对象」上（样本里 folder 报 5、其一级对象仅 2），**不得**当一级对象数 */
    file_property_count?: number;
    platform_icon?: string;
    task_id?: string;
    url_info_id?: string;
  };
}

/** GET /drive/v1/share 与 /drive/v1/share/detail 响应 */
export interface XlShareListResponse {
  share_status?: string;
  /** 分享根的一级对象数（根响应用作 ListResult.total） */
  file_num?: number | string;
  files?: XlShareFileRaw[];
  next_page_token?: string;
  pass_code_token?: string;
  /** 分享者信息（user_id 用于「不允许接收者是分享者」比对） */
  user_info?: { user_id?: string | number; [k: string]: unknown };
  /**
   * 子目录响应里的父对象。**注意**：真机核对（2026-10-02）它的 params 只有
   * `platform/platform_icon/share_id`，**没有** file_property_count —— 不要用它当一级对象数。
   */
  parent?: { id?: string; params?: { [k: string]: unknown }; [k: string]: unknown };
  params?: { share_file_order?: string; [k: string]: unknown };
}

/** POST /v1/shield/captcha/init 响应 */
export interface XlCaptchaInitResponse {
  captcha_token?: string;
  expires_in?: number;
  url?: string;
}

/** POST /drive/v1/share/restore 响应（params.trace_file_ids 是 JSON 字符串：分享 file id → 我盘 file id） */
export interface XlRestoreResponse {
  share_status?: string;
  file_id?: string;
  restore_status?: string;
  restore_task_id?: string;
  params?: { trace_file_ids?: string; [k: string]: unknown };
}

/** links[<mime>] 条目（真机 2026-10-03：url / token / expire / token_type） */
export interface XlFileLink {
  url?: string;
  /** 加速令牌 JWT（TOKEN_TYPE_ACCELERATION，免费号无用）；**敏感**，读取后由 download.ts 脱敏 */
  token?: string;
  /** ISO 时间（≈6h 后过期）；== 直链 URL 里的 `e=` 秒值 */
  expire?: string;
  token_type?: string;
}

/** GET /drive/v1/files/<id> 响应（直链首选 links[<mime>]，备选 web_content_link / medias[].link.url） */
export interface XlFileResponse {
  id?: string;
  name?: string;
  size?: string;
  mime_type?: string;
  web_content_link?: string;
  /** 按 mime 分组的直链（首选来源；key 即 mime_type） */
  links?: Record<string, XlFileLink>;
  medias?: Array<{ link?: { url?: string } }>;
  /** 直链参数：device_id（**不是**请求头的 x-device-id）、share_id、task_id…（「隐秘参数」用） */
  params?: { device_id?: string; share_id?: string; task_id?: string; [k: string]: unknown };
  /** 直链 URL 里的 vip 标记（如 FREE）；hash 是内部值（Tzz 拍板丢弃）；md5_checksum 实测为空 */
  vip?: string;
  hash?: string;
  md5_checksum?: string;
  [k: string]: unknown;
}

/** 业务错误 body（迅雷错误 = { error, error_description } 或 { error_code }） */
export interface XlApiErrorBody {
  error?: string | number;
  error_description?: string;
  error_code?: number | string;
}
