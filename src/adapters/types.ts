/**
 * PanAdapter 接口 —— 网盘适配层统一契约（docs/STRUCTURE.md：src/adapters/types.ts）
 *
 * 设计约束（HANDOFF §4）：
 * - UI 永不 import 具体适配器，只走 registry + PanAdapter 接口
 * - core/ 零网盘依赖：treeWalker/linkFetcher 只操作本接口
 * - 所有方法签名显式、TS strict 可编译；新增网盘按 src/adapters/README.md 接入
 *
 * 命名：kebab-case 文件、camelCase 字段/方法。
 */

/** 分享链接解析出的分享 ID（UC 的 pwd_id） */
export type ShareId = string;

/** 分享访问令牌（UC 的 stoken），后续接口都要携带 */
export type Stoken = string;

/** 网盘文件/目录条目（对应 UC detail 接口 list[] 元素） */
export interface ShareFile {
  /** 文件/目录 ID（下载、遍历子目录用） */
  fid: string;
  /** 文件名 */
  fileName: string;
  /** 是否为目录 */
  dir: boolean;
  /** 大小（字节）；目录为 0 */
  size: number;
  /**
   * UC/夸克专属可选字段（分享文件令牌，下载用；目录无）。
   * v1.2.x 契约收窄：core 不得依赖本字段 —— 是否必需由各适配器自行判定
   * （uc/quark 缺它=该文件解析失败；alipan 无此字段，文件标识统一用 fid=file_id）。
   */
  shareFidToken?: string;
  /** 格式（application/zip 等） */
  formatType?: string;
  /** 修改时间戳（ms，网盘支持时提供） */
  modifiedAt?: number;
  /** 标识符（md5/sha1，网盘支持时提供） */
  md5?: string;
  sha1?: string;
}

/** 获取分享令牌参数（UC：POST sharepage/token） */
export interface TokenParams {
  /** 分享 ID（pwd_id） */
  shareId: ShareId;
  /** 提取码；无提取码时传空字符串 */
  passcode?: string;
}

/** 获取分享令牌结果 */
export interface TokenResult {
  stoken: Stoken;
}

/** 列目录参数（UC：GET sharepage/detail，pdir_fid 递归即目录遍历） */
export interface ListParams {
  shareId: ShareId;
  stoken: Stoken;
  /** 父目录 fid；根目录用 "0" */
  pdirFid: string;
  /** 页码，默认 1 */
  page?: number;
  /** 每页数量，默认 50 */
  size?: number;
  /** 是否为根目录（UC 根目录需带 _fetch_banner/_fetch_share 扩展字段） */
  isRoot?: boolean;
  /**
   * v1.2.x alipan：分页游标（next_marker 制网盘用）。treeWalker 把上一次响应的
   * nextMarker 原样传回，适配器翻页时带上；页码制网盘（uc/quark）忽略本字段，行为不变。
   */
  marker?: string;
}

/** 列目录结果 */
export interface ListResult {
  files: ShareFile[];
  /** 总数（网盘返回时提供） */
  total?: number;
  /**
   * v1.2.x alipan：下一页游标（next_marker 制网盘返回；空串/缺省 = 无更多页）。
   * 有值时 treeWalker 优先按游标继续翻页（total 制逻辑只对页码制网盘生效）。
   */
  nextMarker?: string;
}

/**
 * 批量取直链参数（v1.2.x 契约收窄：只传 files + 会话上下文，不再传 fids/fidsTokens）。
 *
 * 裁决权下沉：本层不预判 per-file 令牌（shareFidToken 是 UC/夸克专属，阿里没有）——
 * 适配器从 files 里自行读取 fid / shareFidToken 构造自己的请求：
 * uc=sharepage/download（fids+fids_token）、quark=同 UC 系、alipan=copy→get_download_url 两跳。
 * 缺 per-file 令牌 / 不支持的文件（如目录）由适配器在对应下标产出失败项
 * （DownloadResult.error + errorCode，core linkFetcher 原样回填）。
 */
/**
 * 解析进度事件（v1.4）：**只报进度，不影响结果与顺序**。
 * `total` = 本批文件数；`done` = 本批已完成数（失败也算完成，保证进度不卡）。
 */
export interface LinkProgressEvent {
  done: number;
  total: number;
  fid: string;
  stage?: 'probe' | 'settings' | 'restore' | 'rename' | 'download';
}

export interface DownloadParams {
  /** 本批待解析的文件（顺序即回填顺序；调用方保证只传文件，目录由适配器兜底拒绝） */
  files: ShareFile[];
  shareId: ShareId;
  stoken: Stoken;
  /**
   * v1.1.9.final：游客模式（qk-guestTurn）—— 适配器不注入登录态整串，
   * 改用游客 __pugs 发起请求（夸克 <50MB 小文件；其他网盘忽略）。
   */
  guestMode?: boolean;
  /**
   * v1.4 逐文件进度（可选；适配器**只报**，不得据此改变结果与顺序）。
   * 由 core/linkFetcher 从 LinkFetchOptions.onProgress 原样透传（UI 动态进度条用）。
   */
  onProgress?: (evt: LinkProgressEvent) => void;
}

/** 单文件直链结果 */
export interface DownloadResult {
  /** OSS 签名直链（字符敏感，复制必须走原生剪贴板 API） */
  url: string;
  fileName?: string;
  size?: number;
  /**
   * 文件校验 hash（网盘而异：夸克 dl 响应给 md5，其他网盘可能是 sha1 等；
   * 导出时附注释行供下载后校验完整性，算法随网盘而异）
   */
  hash?: string;
  /**
   * 与该直链**同响应绑定**的下载凭据（§12 实测：跨响应/跨环境混用一律
   * 403 ucidMd5 invalid）。UC = 本次 download 响应 Set-Cookie 下发的 __pugs。
   * 缺省（响应未下发/直连拿不到）= 导出时该文件命令不注入 cookie 并附提示。
   */
  cookie?: { key: string; value: string };
  /**
   * 完整 Cookie 头值（多凭据时优先于 cookie）：如夸克 = 登录态 __pus 整串
   * + 同响应 __pugs 拼成的整串；任务生成器原样注入 `Cookie: <值>`。
   */
  cookieString?: string;
  /**
   * 失败原因（url 为空时给出中文文案；适配器对缺 per-file 令牌等单项问题
   * 在此产出失败，core linkFetcher 透传到 LinkResult）。
   */
  error?: string;
  /** 失败时的供应商业务错误码（uc/quark 数字码 / alipan 字符串码；透传给 core 展示用） */
  errorCode?: number | string;
  /**
   * 直链绝对过期时间 ms（v1.2.x 复用分家）：uc/quark 从直链 URL 的
   * Expires/auth_key 参数解析，alipan 取 get_download_url 响应 expire_time。
   * core/linkStatus 以此为主做直链复用判定（偏好窗口不再参与直链判定）。
   */
  expiresAt?: number;
}

/**
 * 网盘特性表（偏好设置 UAC 表数据源，见 HANDOFF 附件「1.UAC选项」）
 * 各字段默认值按「不误导用户」原则：v1 UC 零 cookie，needsCookie 默认 false。
 */
export interface PanLimits {
  /** 是否需要转存才能操作 */
  needsTransfer: boolean;
  /** 是否需要登录（游客可用的网盘此项 false） */
  needsLogin: boolean;
  /** 登录阈值说明（如夸克 "200mb+才需要"） */
  loginThresholdNote?: string;
  /** 能否移除限速 */
  canRemoveSpeedLimit: boolean;
  /** 是否需要读取 cookie（默认 false；v1 UC API 零 cookie） */
  needsCookie: boolean;
  /** 完全不需要登录 */
  noLoginNeeded: boolean;
  /** 批量解析是否仅支持 aria2/gopeed（跨文件夹批量时） */
  batchOnlyAriaGopeed: boolean;
  /** 游客大小限制说明（如 UC "4G 文件都不需要，临界未知"） */
  sizeLimitNote?: string;
  /** oss/sig 较小有效期说明（如 UC "直链 3-6h/Cookie 3h"；未知不填显示 —） */
  linkExpiryNote?: string;
  /** etag 种类/支持情况（v1.1.7：如 UC "不支持"；未知不填显示 —） */
  etagNote?: string;
  /* ---------- v1.3.2：UAC 表扩展行（同一数据源，来源 Tzz 2026-09-25 表）---------- */
  /** 分享凭据有效期说明（stoken / share_token） */
  shareCredTtlNote?: string;
  /** 登录凭据有效期说明（pus / auth(JWT) 等） */
  loginCredTtlNote?: string;
  /** web 会话激活 / 通用 CDP 续期方式（cookie / 仅 localStorage …） */
  sessionRenewNote?: string;
  /** 其他续期方案（Alist OAuth / 反代等；失败经验也写在这里） */
  altRenewNote?: string;
  /** 获取目录树（scan）策略说明 */
  scanStrategyNote?: string;
  /** 转存（restore）策略说明（是否支持复用、接收者限制） */
  restoreStrategyNote?: string;
  /** 下载（download）批量策略说明 */
  downloadStrategyNote?: string;
  /** download_url 额外说明（需要的 cookie / referer 等） */
  downloadUrlNote?: string;
}

/**
 * v1.4：文件级「隐秘参数」能力（目前仅迅雷）。
 * 与 `hiddenVolumn`（文件夹版，开新标签直连官方 API）的区别：
 * **不发任何请求、不开外部链接**，就地展示最近一次 prase 详情响应的**脱敏**视图，
 * 供开发者判断后端账号是不是会员号（vip / token_type）等。
 */
export interface FileHiddenVolumnView {
  /** 弹窗标题 */
  readonly title: string;
  /** 点按钮但该文件还没解析时的提示（如「请先解析该文件」） */
  readonly emptyHint: string;
  /** 取某文件的脱敏字段行；未解析返回 null */
  view(fid: string): Array<{ label: string; value: string }> | null;
}

/**
 * 网盘适配器统一接口（detect / token / tree / download / limits）
 *
 * 「tree」由 core/treeWalker 调用本接口的 list() 递归完成（深度/并发/聚合归 core），
 * 适配器只负责单层目录列表 —— 与 STRUCTURE.md 职责划分一致。
 */
/** 网盘下载层需要的 cookie 规格（reverse-notes-uc.md §10；null/缺省 = 不需要） */
export interface CookieRequirement {
  /** cookie 名（如 "__pugs"） */
  key: string;
  /** 展示名（如 "双下划线pugs"） */
  displayName: string;
  /** 未捕获到值时的供应商专属排查话术 */
  missingHint: string;
  /** 标准长度（v1.1.5：弹窗展示「标准长度 xxx」供用户核对；未知可不填） */
  standardLength?: number;
}

/**
 * 登录态 cookie 输入规格（需要用户**手动提供**登录 cookie 的网盘，如夸克）。
 * 与 CookieRequirement 的区别：那是解析时自动捕获的游客态凭据（弹窗只展示）；
 * 这是解析失败（强制登录/超限）时弹窗让用户**填写/导入**的登录态凭据，随 API 请求发送。
 * v1.1.9.1：改为整串模式为主 —— 夸克真实 key 是 __pus/__uid/__puus（且服务端会刷新
 * __puus），社区实践（alist/boxplayer/nfd/linkswift）都是整串 cookie 原样发送最稳。
 */
export interface CookieInputRequirement {
  /** 整串模式：true = 弹窗显示单个大输入框（粘贴/导入完整 cookie 字符串）；
   * false/缺省 = 按 keys 渲染多个填写框（旧行为） */
  wholeString?: boolean;
  /**
   * v1.2.x alipan：整串模式存取钩子 —— 各网盘凭据串的 localStorage 键不同
   * （夸克 pan-web:quark-cookie:v1 / alipan pan-web:alipan-auth:v1），由各适配器
   * 自己的 auth/cookies 模块提供，UI 不需要知道存储键。缺省 = 不预设（回填空）。
   */
  load?: () => string;
  /** 与 load 对应的保存钩子（用户点「保存并重试」后落库）；缺省 = 丢弃。 */
  save?: (value: string) => void;
  /** 各 cookie 键（整串模式下用于展示/校验“已检测到哪些关键 key”；多键模式下渲染填写框） */
  keys: Array<{ key: string; label: string }>;
  /**
   * v1.2.x alipan：弹窗顶部说明行文案（覆盖默认“需要 cookie 鉴权…”）——
   * alipan 的凭据不是浏览器 cookie，需说明 token + 转存目标目录的填写方式。
   */
  intro?: string;
  /**
   * v1.3：检测“已有哪些关键键”的适配器钩子（缺省 = UI 按 `k=` 标记自行检测）。
   * alipan 用：裸 `Bearer xxx` / 纯 token 形态没有 `auth=` 键标记，需适配器侧的解析结果补报，
   * 否则弹窗会误报「未检测到必要 key」（见 alipan/auth.ts 的 alipanAuthKeysPresent）。
   */
  probeKeys?: (text: string) => string[];
  /** 整串模式大输入框的 placeholder（缺省 = 夸克默认文案） */
  wholeStringPlaceholder?: string;
  /**
   * 凭据是否为浏览器 cookie（v1.2.x alipan 传 false）：
   * true = 展示「get cookies.txt 插件」推荐与懒人导入行；false = 隐藏（凭据串手填即可）。
   */
  browserCookie?: boolean;
  /**
   * 大文件登录阈值（字节）：选中文件里有 ≥ 该大小（如夸克 50MB）时，prase 直接弹
   * 登录态填写窗、跳过游客态 cookie 警告 —— 反正 download 必返回 23018，
   * 提前弹窗可避免一次必然失败的请求（400 会污染代理日志看板）。缺省 = 不预判。
   */
  sizeThreshold?: number;
  /** 供应商专属提示（如登录态风险说明） */
  notice?: string;
  /** 未提供时的排查话术 */
  missingHint?: string;
}

/**
 * v1.3 alipan：滚动更新（carry-over）能力规格（登录态过期后的续杯决策 + 新凭据离线校验）。
 * 实现细节（缓存/解码/hop 探测）全在适配器侧（adapters/alipan/carry.ts），
 * UI 只读本对象 —— 包括定制话术（messages），组件不得硬编码文案。
 */
export interface CarryOverRequirement {
  /** 判定「登录态过期」的业务码（已发出的一次请求失败即判定，不重试） */
  expiredCodes: ReadonlyArray<number | string>;
  /**
   * 过期后的决策（适配器侧实现；UI 只消费结果）：
   * - action 'silent' = 不打扰用户（本地无缓存 / hop 命中同账号 → 静默续杯）
   * - action 'notify' = 提示填入上次同账号的新凭据（红色 toast，文案 = messages.expiredToast）
   * - reason = 判定原因（进解析日志，便于排查；非用户可见文案）
   */
  onExpired?(): Promise<{ action: 'silent' | 'notify'; reason: string }>;
  /**
   * 用户填入新凭据后的**离线**校验（不请求任何接口）：
   * 'same' = 与本地缓存同账号（绿字 hints）/ 'other' = 换号（红字）/ null = 无缓存或无法判定（不提示）
   */
  checkNewAuth?(authString: string): 'same' | 'other' | null;
  /**
   * v1.3.1 凭据快捷更新：写入前的**离线**规划（合并上次暂存的 drive_id/to_parent_file_id +
   * 必填项检查 + 账号判定）。UI 只消费结果：missing 非空 → 提示 + 保存按钮置灰；
   * verdict 'changed' → 弹 accountSwitchPrompt 确认是否覆盖暂存区。
   */
  planCredentialSave?(authString: string): CarryOverCredentialPlan;
  /**
   * v1.3.1：应用写入决策（在用户确认/提交后调用）：
   * 'persist' = 覆盖暂存记录（换号则作废旧账号的映射）；'session' = 仅本次有效（内存态，刷新即失效）。
   */
  applyCredentialSave?(plan: CarryOverCredentialPlan, mode: 'persist' | 'session'): void;
  /** v1.3.1：账号变化确认弹窗话术（title/context/按钮；缺省 = 不弹） */
  readonly accountSwitchPrompt?: { title: string; context: string; confirm: string; cancel: string };
  /** v1.3.1：必填项缺失提示前缀（如「缺少必填项：」；与 missing 拼接展示） */
  readonly missingHintPrefix?: string;
  /** 定制话术（集中在适配器侧常量区，UI 只引用） */
  readonly messages: {
    /** 凭据过期 + hop 未命中时的红色 toast */
    expiredToast: string;
    /** 新凭据与缓存同账号（绿字） */
    sameUserHint: string;
    /** 新凭据换了账号（红字） */
    otherUserHint: string;
  };
}

/**
 * v1.3.1：凭据写入规划（适配器产出，UI 只消费 —— 不 import 具体适配器）。
 * 对应 adapters/alipan/carry.ts#planAlipanCredentialSave。
 */
export interface CarryOverCredentialPlan {
  /** 'new' 首次写入 / 'same' 与上次同账号（静默合并）/ 'changed' 换了账号（需确认） */
  verdict: 'new' | 'same' | 'changed';
  /** 合并后的凭据串（已用上次暂存补齐同账号缺字段） */
  merged: string;
  /** 仍缺失的必填项（如 auth / drive_id / to_parent_file_id）；非空 = 禁止保存 */
  missing: string[];
  /** 本次凭据的账号身份（解不出 null） */
  account: string | null;
}

export interface PanAdapter {
  /** 唯一标识（kebab-case，如 "uc"） */
  readonly id: string;
  /** 展示名（如 "UC 网盘"） */
  readonly name: string;
  /** 网盘特性表 */
  readonly limits: PanLimits;
  /**
   * 下载层静态头（v1.2.x）：导出/推送命令按文件注入（ExportFile.headers）。
   * 各网盘在 types.ts 与 *_LIMITS 并列声明（如 uc: 客户端 UA + drive.uc.cn Referer；
   * alipan: 精确 Referer https://www.alipan.com/，签名 x-oss-additional-headers 绑定）。
   * 动态凭据（每文件 cookie/cookieString 同响应绑定）不进这里，走 DownloadResult。
   */
  readonly downloadHeaders: Record<string, string>;
  /** 该网盘是否识别此分享链接 */
  detect(url: string): boolean;
  /** 下载层 cookie 规格（UC 需要 __pugs；无 = 不需要 cookie） */
  readonly cookie?: CookieRequirement;
  /** 登录态 cookie 输入规格（夸克 __pus 整串；无 = 不需要用户填 cookie） */
  readonly cookieInput?: CookieInputRequirement;
  /**
   * v1.3 滚动更新（carry-over）能力规格（无 = 该网盘无此机制）。
   * 语义：prase 需先转存（copy）再取直链的网盘，在登录态凭据生命期内重解析时
   * 复用上次转存得到的 file_id 直接取直链（「续杯」），跳过 copy。
   */
  readonly carryOver?: CarryOverRequirement;
  /** 从分享链接提取分享 ID；无法识别返回 null */
  parseShareId(url: string): ShareId | null;
  /**
   * 0B 文件夹跳转链接（v1.1.6）：fid 链 → 分享页跳转长链接；不支持返回 null。
   * 风控集群导致目录树拉取失败时，用它二次获取该文件夹的资源列表。
   */
  buildJumpUrl?(shareId: ShareId, segments: Array<{ fid: string; name: string }>): string | null;
  /** 解析跳转长链接：返回 shareId + fid 链；非跳转链接返回 null */
  parseJumpUrl?(url: string): { shareId: ShareId; segments: Array<{ fid: string; name: string }> } | null;
  /**
   * v1.3.3 深链（按名字路径）→ 目标文件夹 fid 解析（可选；缺省 = 该网盘不支持深链解析）。
   * 语义：`path` 是名字段（如 ['软件整合包','录屏神器 bandicam']）；实现逐层 list 按 fileName
   * **精确匹配**下钻，命中最后一段返回其 fid。找不到 → 抛可读中文错误（不得静默回退到根）。
   * 用途：HomePage 的 jump 流程（深链不带 fid 时，先解析出 rootFile.fid 再走现有快照拉取）。
   */
  resolveJumpPath?(params: { shareId: ShareId; stoken: string; path: string[] }): Promise<{ fid: string; name: string }>;
  /**
   * 隐秘参数静态话术（v1.1.7）：开发者功能弹窗展示的各网盘字段说明；
   * 属于静态资源（放各网盘子目录），缺省 = 不提供该功能。
   */
  readonly hiddenVolumn?: { title: string; body: string };
  /**
   * v1.4：文件级「隐秘参数」（解析后可就地查看脱敏详情字段，不发请求）；缺省 = 不提供。
   */
  readonly fileHiddenVolumn?: FileHiddenVolumnView;
  /**
   * v1.1.7 隐秘参数：构造官方 API 查询 URL（浏览器直连，**不走代理**）；
   * 用缓存 stoken + 文件夹 fid 当 pdir_fid；缺省 = 不提供。
   */
  buildHiddenVolumnUrl?(params: { shareId: ShareId; stoken: string; pdirFid: string }): string | null;
  /** 获取分享访问令牌（token 三连第一步） */
  getToken(params: TokenParams): Promise<TokenResult>;
  /** 获取单层目录/文件列表（目录遍历由 core/treeWalker 递归调用） */
  list(params: ListParams): Promise<ListResult>;
  /** 批量获取下载直链（core/linkFetcher 按 15 个/批 + 1s 节流调用） */
  getDownloadLinks(params: DownloadParams): Promise<DownloadResult[]>;
}
