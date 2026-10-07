/**
 * core 层共享契约（docs/STRUCTURE.md：src/core/types.ts）
 *
 * 定位：treeWalker / linkFetcher / preferences / footprint / tasks 之间的唯一共享类型源。
 * 约束：core/ 零网盘依赖 —— 只引用 adapters/types.ts 的抽象类型（ShareFile/PanAdapter 接口），
 * 不 import 任何具体适配器（如 uc.ts）。
 *
 * 命名：camelCase 字段；kebab-case 文件名。
 */

import type { PanAdapter, ShareFile, Stoken } from '../adapters/types';

/* ============================== 资源列表快照（scanner，原 ls） ============================== */

/**
 * 资源列表快照（ls 产物）：一次「获取资源列表」的完整结果。
 *
 * 语义（v1.1.4 起术语分离）：
 * - ls（获取资源列表）= getToken + 目录树遍历，产物可复用（reuseWindowHours 内）；
 * - prase（解析下载方式）= 按文件打 download 接口取 oss+sig，每次实时捕获 __pugs。
 *
 * 复用安全依据：短时间内分享内容不变、stoken 不过期；目录树携带每个文件的
 * fid + shareFidToken 映射，prase 直接按 fid 取映射再请求 download，无需重新 ls。
 */
export interface ListSnapshot {
  /** 分享 ID */
  shareId: string;
  /** 分享链接 */
  url: string;
  /** 适配器 id */
  adapterId: string;
  /** 分享访问令牌（后续 prase 都要携带） */
  stoken: string;
  /** 目录树（根节点） */
  root: TreeNode;
  /** ls 完成时间 ms */
  fetchedAt: number;
  /** 文件总数 */
  fileCount: number;
  /** 总大小字节 */
  totalSize: number;
  /**
   * 扫描问题清单（v1.3.2 拍板：失败与大宗跳过都要「可见」）。
   * 空数组 = 本次遍历每个目录都加载成功且没有大宗跳过。
   */
  issues: ScanIssue[];
}

/**
 * 扫描问题条目（treeWalker 收集 → ListSnapshot.issues → 结果页 banner/行内提示/全局日志）。
 * 两类语义严格分开，**不允许共用 size=0 表达**（v1.3.2 拍板）：
 * - failed：该目录 list 请求失败（业务码非 0 / HTTP 非 2xx / 网络失败），内容不完整；
 * - bulk：一级对象数超过阈值，按设置主动跳过（不递归），内容未展开。
 */
export interface ScanIssue {
  /** 目录路径（相对分享根，如 "dir1/sub"；根目录为 "/"） */
  path: string;
  /** 目录 fid（结果页跳转/排查用） */
  fid: string;
  /** 类别：failed 加载失败 | bulk 大宗跳过 */
  kind: 'failed' | 'bulk';
  /** failed：供应商业务码（数字码/字符串码；无错误码时为 'unknown'） */
  code?: number | string;
  /** failed：错误文案（适配器已带中文说明） */
  message?: string;
  /** bulk：判定时已知的一级对象数 */
  count?: number;
  /** bulk：判定时生效的阈值（便于用户核对设置） */
  threshold?: number;
}

/* ============================== 目录树 ============================== */

/** 目录树节点（treeWalker 产物；tasks/export/footprint/UI 共用） */
export interface TreeNode {
  /** 网盘条目（fid/fileName/dir/size/标识符等） */
  file: ShareFile;
  /** 相对分享根目录的路径（含文件名），如 "dir1/sub/file.zip"；根节点为 "/" */
  path: string;
  /** 目录深度（根 = 0） */
  depth: number;
  /** 大小：文件 = 自身 size；目录 = 子树递归聚合 */
  size: number;
  /** 子节点（仅目录有） */
  children?: TreeNode[];
  /**
   * 加载失败信息（v1.3.2）：该目录 list 失败（业务码非 0/HTTP 非 2xx/网络失败）。
   * 存在即表示「内容不完整」；UI 行内提示「请求业务码 xxx，内容不完整」+ 转到此文件夹。
   */
  scanError?: { code: number | string; message: string };
  /**
   * 大宗目录跳过（v1.3.2）：该目录一级对象数 > 阈值，按设置不展开（保持折叠）。
   * 与 scanError 互斥（失败优先）；存在时 children 一定为 undefined。
   */
  bulkSkipped?: { count: number; threshold: number };
}

/** 目录遍历配置（treeWalker） */
export interface TreeWalkOptions {
  /** 是否遍历子目录；false 只列根层（默认 true） */
  recursive?: boolean;
  /** 最大深度（根 = 0；默认 0 = 不限） */
  maxDepth?: number;
  /** 并发列表请求数（默认 2，v1.1.6 防风控从 3 降为 2） */
  concurrency?: number;
  /** 同目录翻页间隔 ms（默认 250，v1.1.6 目录翻页节流防风控） */
  pageIntervalMs?: number;
  /** 是否聚合目录大小（默认 true；关掉可省子目录遍历） */
  aggregateSize?: boolean;
  /** 根节点条目（默认分享根占位；jumper 二次获取时传目标文件夹，v1.1.6） */
  rootFile?: ShareFile;
  /** 根节点路径（默认 "/"；jumper 传文件夹绝对路径，v1.1.6） */
  rootPath?: string;
  /** 根节点是否分享根目录（默认 true；jumper 传 false，list 不带 banner/share 扩展字段） */
  rootIsShareRoot?: boolean;
  /**
   * 大宗目录阈值（v1.3.2）：某目录**一级对象数**超过本值时不再展开（保持折叠）。
   * 0/缺省 = 关闭大宗过滤。快通道：一级响应自带 total（uc/quark）= 首屏即可判定；
   * 慢通道：无 total 的网盘（alipan/xunlei）需收齐一级响应体后再计数比较。
   */
  bulkThreshold?: number;
  /** 进度回调：每完成一个节点触发（done/total 为已完成/预估节点数） */
  onProgress?: (done: number, total: number, current: TreeNode) => void;
}

/* ============================== 批量直链 ============================== */

/** 单条直链获取结果（linkFetcher 产物） */
export interface LinkResult {
  /** 对应网盘条目 */
  file: ShareFile;
  /** 直链（ok = false 时为空字符串） */
  url: string;
  /** 成功与否 */
  ok: boolean;
  /** 失败原因（ok = false 时给出中文文案） */
  error?: string;
  /** 失败时的供应商业务错误码（如夸克 23018 超限 / 31001 需登录；core 零网盘依赖，duck-typing 透传） */
  errorCode?: number | string;
  /**
   * 与该直链同响应绑定的下载凭据（§12；UC = __pugs）。
   * 导出 merger 按文件注入各自的值 —— 严禁用全局/跨响应的 cookie 替代。
   */
  cookie?: { key: string; value: string };
  /** 完整 Cookie 头值（多凭据时优先于 cookie；夸克 = 登录态 + __pugs 整串） */
  cookieString?: string;
  /** 文件校验 hash（网盘而异：夸克 = md5；导出时附注释行，用于校验下载完整性） */
  hash?: string;
  /**
   * 直链绝对过期时间 ms（v1.2.x 复用分家）：uc/quark 解析自 URL Expires/auth_key，
   * alipan 取响应 expire_time。linkStatus 以此为主做直链复用判定，偏好窗口不再参与。
   */
  expiresAt?: number;
}

/** 批量直链获取配置（linkFetcher；节流参数参考 LinkSwift：15 个/批 + 1s） */
export interface LinkFetchOptions {
  /** 每批文件数（默认 15） */
  batchSize?: number;
  /** 批间间隔 ms（默认 1000） */
  batchIntervalMs?: number;
  /** 失败时是否继续后续批次（默认 true） */
  continueOnError?: boolean;
  /**
   * v1.4 逐文件进度（可选；**只报不干预**）：原样透传给适配器 DownloadParams.onProgress，
   * 供 UI 动态显示进度。批间节流/顺序/失败策略不受其影响。
   */
  onProgress?: (evt: import('../adapters/types').LinkProgressEvent) => void;
  /** v1.4 取链参数覆盖（可选）：原样透传 DownloadParams.usage（用户弹窗选择）。 */
  usage?: 'CONSUME' | 'PLAY';
}

/* ============================== 偏好设置 ============================== */

/** 夸克网盘专属偏好（v1.1.9.final：qk-guestTurn 游客模拟开关） */
export interface QuarkPrefs {
  /**
   * 模拟游客访问夸克 <50MB 文件（默认关）：
   * 开 = 小文件走游客态（随机/捕获 __pugs，不注入登录态整串），快但依赖 pugs 捕获链路；
   * 关 = 所有文件一律按登录态处理（直接弹 CookieInputModal，最稳妥）。
   * 副标题：配置本地管理面板后不生效（后端账号池会接管游客流转）。
   */
  qkGuestTurn: boolean;
}

/** 迅雷云盘专属偏好（v1.4） */
export interface XunleiPrefs {
  /**
   * scan 单页条数（默认 30 = 官方 web 默认值）。调大能减少翻页次数，但每次都拉更多对象、
   * 更容易触发风控；0/非法值回退 30。
   */
  scanLimit: number;
  /**
   * 单页装不下时是否按「大宗文件判定阈值」（`Preferences.bulkThreshold`）重跑一次首页（默认开）：
   * 例如默认 30 只有 30 条 + next_page_token 时，改用 bulkThreshold（默认 100）再拉一次；
   * 仍是游标就按页续拉。观：大目录少翻几页；关掉则严格逐页拉。
   */
  bulkRetry: boolean;
  /**
   * 解析后是否允许在文件行看「隐秘参数」（默认关；需先解析该文件）：
   * 展示详情接口返回的 params.device_id / share_id / task_id、links 的 expire/token_type 等
   * 脱敏字段，方便定位后端账号是不是会员号。**不含任何凭据本体**。
   */
  fileHiddenVolumn: boolean;
  /**
   * 取链方案规则（多行文本，每行一条；v1.4）——「最后一个接口参数」：
   *   `-regex ".*\.\(xls\|ppt\|docx\|pdf\)$" = CONSUME`（区分大小写）
   *   `-iregex ".*\.\(ts\|mp4\|mov\)$" = PLAY`（不区分大小写）
   * 按**文件名**自上而下匹配，命中即用；无命中 → CONSUME；非法行忽略（UI 浅色提示）。
   * 说明见 docs/xunlei-dl-choices.md。
   */
  dlChoiceRules: string;
}

/** 弹窗开关（HANDOFF 附件 UAC 表底部全局行） */
export interface ModalPrefs {
  /** 读取 cookie 警告弹窗（§10：下载层需 __pugs 游客态 cookie，解析时弹窗预热；默认开，可关） */
  cookieWarn: boolean;
  /** 需要登录 → 跳转提示弹窗 */
  loginJump: boolean;
  /** 自动关闭新标签页（只能关自己打开的标签，见 HANDOFF §7） */
  autoCloseTab: boolean;
  /** 导出任务失败警告弹窗（v1.1.4：未选中有效文件时弹窗，关闭后 toast；默认开） */
  exportFailWarn: boolean;
  /** 单文件解析失败警告弹窗（v1.1.4：解析失败提示刷新资源列表；默认开） */
  parseFailWarn: boolean;
  /** CORS 拦截后是否自动跳转分享页（1.0.3：备用形式，默认关；开=自动跳分享页，退出本站自动清理新标签） */
  corsAutoJump: boolean;
  /** 跳转到文件夹是否提示（v1.1.6：0B 文件夹二次获取前的提示弹窗；默认开） */
  jumpTip: boolean;
  /** export 包含黄色标记是否弹窗提示（v1.1.7：开=弹窗，关=简略 toast） */
  exportYellowWarn: boolean;
  /** 登录态 cookie 填写弹窗（v1.1.9：夸克 23018/31001 强制登录时弹出；默认开） */
  cookieInput: boolean;
}

/** 足迹偏好（仅本地，IndexedDB） */
export interface FootprintPrefs {
  /** 已填入链接查重/历史 */
  keepLinks: boolean;
  /** 自动获取的目录树快照 */
  keepTrees: boolean;
  /** 解析记录是否在目录树呈现（斜体） */
  recordInTree: boolean;
  /** 完整解析日志 */
  keepLogs: boolean;
  /** 日志等级：fatal/info/debug（默认 debug） */
  logLevel: 'fatal' | 'info' | 'debug';
  /** 链接/树快照保留条数（默认 100） */
  linkLimit: number;
  /** 日志最大体积 MB（默认 5） */
  logMaxMB: number;
}

/** 目录树详细程度（附件：全部默认 ✅，仅渲染网盘支持字段） */
export interface TreeDetailPrefs {
  /** file 大小 */
  fileSize: boolean;
  /** etag（md5/sha1） */
  etag: boolean;
  /** 分享时间 */
  shareTime: boolean;
  /** 用户存储时间 */
  saveTime: boolean;
  /** 平台存储时间（部分网盘支持） */
  platformTime: boolean;
}

/** 解析通道配置（1.1）：direct 直连（CORS 受限）| proxy 代理转发（填地址后可用） */
export interface TransportPrefs {
  /** 解析通道：'direct' 浏览器直连 | 'proxy' 用户自填代理转发 */
  mode: 'direct' | 'proxy';
  /** API 转发代理地址（https://xxx.pages.dev 或自托管；空=不可用） */
  proxyUrl: string;
  /** 代理访问令牌（部署时配置的 PROXY_TOKEN；代理未设 token 时可留空） */
  proxyToken: string;
  /** v1.2.2：IP 采集（哈希化后上传），默认关；开时 ProxyTransport 请求带 x-panhub-trace: ip-hash 头 */
  ipHashUpload: boolean;
}

/** 高级功能偏好（v1.1.7：设置面板「高级功能」折叠区，总开关默认关） */
export interface AdvancedPrefs {
  /** 高级功能总开关（默认关） */
  enabled: boolean;
  /** aria2 导出额外参数（默认留空，原样拼进每条命令） */
  aria2Extra: string;
  /** gopeed 导出额外参数（默认留空，JSON 对象合并进 store；非 JSON 忽略） */
  gopeedExtra: string;
  /** 显示隐秘参数按钮（<> 符号；默认开，受总开关控制） */
  showHiddenVolumn: boolean;
  /** 二级：显示按钮功能和部分参数的含义 sub 弹窗提示（默认开；总开关关闭时灰色淡化） */
  hiddenVolumnHint: boolean;
}

/**
 * 主题偏好（v1.3.1：顶栏灯泡三态轮换）
 * 'auto' = 跟随系统（matchMedia prefers-color-scheme）| 'light' 浅色 | 'dark' 深色
 */
export type ThemePref = 'auto' | 'light' | 'dark';

/** 偏好设置（core/preferences.ts，localStorage；默认值见 HANDOFF 附件 §2/§3） */
export interface Preferences {
  /**
   * 主题（v1.3.1）：默认 'auto' 跟随系统。
   * 最终生效值写入 <html data-theme="light|dark">（auto 也解析为最终值），
   * data-theme-pref 保留原始三态。
   */
  theme: ThemePref;
  /**
   * 勾选行自定义底色（v1.3.1）：'' = 用主题默认高亮（--primary-soft）。
   * 仅作用于「打对钩」的行（.file-row--checked）；status 红/黄/绿优先级更高，见 index.css。
   */
  checkColor: string;
  /** 单个文件默认方式：'parse' 解析展示直链 | 'download' 按默认方式直接下载 */
  singleFileMode: 'parse' | 'download';
  /** 同目录批量默认方式（'download' 时逐个按单文件方式处理） */
  sameDirMode: 'parse' | 'download';
  /** 跨目录：是否保留原始目录结构（仅 aria2/gopeed） */
  keepStructure: boolean;
  /** 跨目录：扫描深度（0 = 不限；1 = 只列根层，语义 depth < maxDepth、根 = 0） */
  scanDepth: number;
  /**
   * 大宗文件判定（v1.3.2）：某目录**一级对象数**超过本值时整目录保持折叠（不递归）。
   * 默认 100；0 = 关闭。设置项改动后**下次获取资源列表**生效（已扫出的树不回溯）。
   */
  bulkThreshold: number;
  /** 显示文件夹大小 */
  showDirSize: boolean;
  /** 显示属性：文件夹内部文件和子文件夹个数（v1.1.6；默认开） */
  showDirProps: boolean;
  /** 显示 etag（校验和列，v1.1.7）：单文件的校验和，云服务供应商提供；UC 不支持 */
  showEtag: boolean;
  /** 显示详细的解析时间和有效期（v1.1.7：文件行显示「上次HH:MM剩xHxM」状态文本） */
  showLinkDetail: boolean;
  /**
   * 默认终端类型（v1.1.7）：'' = 不填（使用当前浏览器 UA）；
   * 预设：cmd / powershell / linux-terminal / linux-shell / macos-terminal。
   * 影响导出命令的 shell 语法适配（引号转义/注释分流），不改变下载 UA（UC 客户端 UA 固定）。
   */
  defaultTerminal: string;
  /**
   * 复用期间内恢复上次折叠状态（v1.1.7）：
   * 'discard' 丢弃 / 'restore' 恢复 / 'ask' 每次询问（默认）
   */
  restoreCollapsed: 'discard' | 'restore' | 'ask';
  /** 确认解析弹窗（默认开） */
  confirmParse: boolean;
  /** 显示每个 file 的下载器 ETA 跟踪 */
  trackEta: boolean;
  /** 显示目录树 */
  showTree: boolean;
  /** 目录树格式：'bars' |--- 模式（默认）| 'indent' 缩进模式 */
  treeFormat: 'bars' | 'indent';
  /** 目录树详细程度 */
  treeDetail: TreeDetailPrefs;
  /** 弹窗开关 */
  modals: ModalPrefs;
  /** 解析通道（1.1） */
  transport: TransportPrefs;
  /** 高级功能（v1.1.7：设置面板折叠区，总开关默认关） */
  advanced: AdvancedPrefs;
  /** 夸克网盘专属偏好（v1.1.9.final：qk-guestTurn 游客模拟开关） */
  quark: QuarkPrefs;
  /** 迅雷云盘专属偏好（v1.4：scan 单页条数 / 大宗重跑 / 解析后隐秘参数） */
  xunlei: XunleiPrefs;
  /**
   * 资源复用窗口（小时，v1.1.4）：0 = 不复用。
   * v1.2.x 复用分家：本偏好只决定 **scan（资源列表）快照** 复用 —— 窗口内从历史/足迹
   * 再进同一分享，直接复用缓存目录树 + stoken，不重新拉取；**prase（直链）复用不再看
   * 本窗口**，改按上游过期时间（LinkEntry.expiresAt / 直链 URL Expires/auth_key）判定。
   */
  reuseWindowHours: number;
  /** 足迹偏好 */
  footprint: FootprintPrefs;
}

/* ============================== 足迹记录 ============================== */

/** 足迹：已填链接（明文存储 + 时间，用于查重/历史；默认保留最近 100 条） */
export interface LinkRecord {
  /** 分享链接（主键） */
  url: string;
  /** 识别到的适配器 id（如 "uc"） */
  adapterId: string;
  /** 分享 ID */
  shareId: string;
  /** 首次填入时间 ms */
  addedAt: number;
  /** 最近使用时间 ms */
  lastUsedAt: number;
  /** 使用次数 */
  useCount: number;
  /** 用户备注（1.0.1 历史页可编辑；可选） */
  note?: string;
}

/** 足迹：目录树快照（md 导出用；v1.1.4 起兼作 ls 复用缓存，含 stoken） */
export interface TreeSnapshot {
  /** 分享 ID（主键） */
  shareId: string;
  /** 分享链接 */
  url: string;
  /** 适配器 id */
  adapterId: string;
  /** 序列化目录树（根节点） */
  root: TreeNode;
  /** 快照时间 ms（= ls 完成时间） */
  savedAt: number;
  /** 文件总数 */
  fileCount: number;
  /** 总大小字节 */
  totalSize: number;
  /** 分享访问令牌（v1.1.4：复用快照直接 prase 用；旧快照无此字段 = 不可复用） */
  stoken?: string;
}

/** 足迹：解析记录（在目录树呈现：时间/次数/是否成功，默认斜体） */
export interface ParseRecord {
  /** 自增主键（写入时由 DB 生成） */
  id?: number;
  /** 分享 ID（查询用） */
  shareId: string;
  /** 分享链接 */
  url: string;
  /** 适配器 id */
  adapterId: string;
  /** 解析时间 ms */
  parsedAt: number;
  /** 是否成功 */
  ok: boolean;
  /** 成功解析的文件数 */
  fileCount: number;
  /** 失败原因（ok = false 时） */
  error?: string;
  /** 分享内容标题（1.0.2：解析时记录首个文件（夹）名，历史页展示用，不显示裸 URL） */
  title?: string;
  /**
   * 记录类型（v1.1.7）：'scanner' = 获取资源列表（列表成功，N 个文件）；
   * 'prase' = 解析下载方式（解析文件成功，N 个文件）。旧记录无此字段。
   */
  kind?: 'scanner' | 'prase';
  /** 文件路径+名字（v1.1.7：单文件 prase 记录写入，历史页展示用） */
  filePath?: string;
}

/** 足迹：解析日志条目（日志单独存储；cookie 写入前必须脱敏） */
export interface LogEntry {
  /** 自增主键（写入时由 DB 生成） */
  id?: number;
  /** 时间 ms */
  time: number;
  /** 等级 */
  level: 'fatal' | 'info' | 'debug';
  /** 适配器 id */
  adapterId: string;
  /** 分享链接 */
  url: string;
  /** 日志内容（已脱敏，禁止明文 cookie） */
  message: string;
}

/* ============================== 直链条目（prase 产物，结果页内存态） ============================== */

/**
 * 直链条目（结果页 links 状态元素，v1.1.5 起共享给 DirectoryTree/工具）。
 * 只在内存中（页面刷新即失）；ls 快照落了 IndexedDB 可跨会话复用，oss+sig 不落库
 * （敏感凭据 + 有效期短），刷新后重新 prase 即可。
 */
export interface LinkEntry {
  /** 是否成功 */
  ok: boolean;
  /** OSS 签名直链（ok=false 时为空串） */
  url: string;
  /** 失败原因（ok=false 时） */
  error?: string;
  /** 获取时间 ms */
  fetchedAt: number;
  /** 与该直链同响应绑定的下载凭据（§12；UC = __pugs），导出按文件注入 */
  cookie?: { key: string; value: string };
  /** 完整 Cookie 头值（多凭据时优先于 cookie；夸克 = 登录态 + __pugs 整串） */
  cookieString?: string;
  /** 文件校验 hash（网盘而异：夸克 = md5；导出时附注释行，用于校验下载完整性） */
  hash?: string;
  /**
   * 直链绝对过期时间 ms（v1.2.x）：适配器解析直链 URL Expires/auth_key 或响应
   * expire_time 后填充；linkStatus 以它为主判定可用性（偏好窗口只管 scan 快照）。
   */
  expiresAt?: number;
  /** v1.1.5：cookie 弹窗选「算了吧」手动终止解析的时间戳（仅单文件解析会写） */
  terminatedAt?: number;
}

/* ============================== 任务导出 ============================== */

/** 导出入参：拍平的 {路径, 直链} 列表（tasks/export.ts 统一入口） */
export interface ExportFile {
  /** 相对路径（含文件名）；keepStructure = false 时仅文件名 */
  path: string;
  /** OSS 签名直链（字符敏感，原样透传） */
  url: string;
  /** 大小（字节，可选） */
  size?: number;
  /** 与该直链同响应绑定的下载凭据（§12；UC = __pugs），merger 按文件注入 */
  cookie?: { key: string; value: string };
  /** 完整 Cookie 头值（多凭据时优先于 cookie；夸克 = 登录态 + __pugs 整串） */
  cookieString?: string;
  /** 文件校验 hash（网盘而异：夸克 = md5；导出时附注释行，用于校验下载完整性） */
  hash?: string;
  /**
   * v1.2.x 下载层静态头（各盘声明于适配器 types.ts，ResultPage 组装时从
   * session.adapter.downloadHeaders 合并进每文件）：curl 映射 -A/-e、aria2 映射
   * --user-agent/--referer、gopeed 映射 extra.header；cookie/cookieString 动态头
   * 逻辑保留现状不受影响。缺省 = 该文件命令不带静态头（仅按 cookie 逻辑）。
   */
  headers?: Record<string, string>;
  /**
   * v1.2.2 fix（09-02）：缺凭据提示标签（网盘名 + 应绑定的凭据 key，如夸克大文件 = "quark __puus"）。
   * 调用方按适配器/文件大小标注；任务生成器只在无 cookie 时把提示注释写进导出命令（此前硬编码 UC __pugs，夸克误报）。
   */
  credLabel?: string;
  /** 网盘文件 ID（v1.1.5.2：导出后按 fid 查状态做黄色提醒；任务生成器忽略） */
  fid?: string;
}

/** 导出产物（v1.1.5：aria2 保留目录结构 = 命令 + input-file 两个文件） */
export interface ExportResult {
  /** 主文件名 */
  fileName: string;
  /** 主文件内容 */
  content: string;
  /** 附带文件（需与主文件一起导出，如 aria2 input-file） */
  extraFiles?: Array<{ fileName: string; content: string }>;
}

/** 导出任务类型 */
export type TaskKind = 'aria2' | 'gopeed' | 'curl';

/** 任务生成配置（tasks/*.ts） */
export interface TaskOptions {
  /** 保留原始目录结构（aria2/gopeed/curl 均支持；curl 用 --create-dirs，v1.1.5） */
  keepStructure: boolean;
  /** 下载目录（绝对路径，用于 aria2/curl 的 -d/输出路径） */
  outDir?: string;
  /**
   * v1.1.9.final：aria2 导出额外参数（设置 → 高级功能）—— 原样拼进每条命令
   * --out 之后、URL 之前（用户自担参数合法性；如 --max-connection-per-server=16）。
   */
  aria2Extra?: string;
  /**
   * v1.1.9.final：gopeed 导出额外参数 —— JSON 对象合并进每个任务的 opts
   * （如 {"connections":16}；非合法 JSON 对象忽略）。
   */
  gopeedExtra?: string;
}

/* ============================== 树遍历入参 ============================== */

/** 树遍历入口参数（token 三连之后的上下文） */
export interface TreeContext {
  /** 适配器（调用方从 registry 取，保证 core 零网盘 import） */
  adapter: import('../adapters/types').PanAdapter;
  /** 分享 ID */
  shareId: string;
  /** 分享访问令牌 */
  stoken: Stoken;
}

/* ============================== 直链获取入参 ============================== */

/** 批量直链获取入口参数 */
export interface LinkFetchContext {
  /** 适配器 */
  adapter: import('../adapters/types').PanAdapter;
  /** 分享 ID */
  shareId: string;
  /** 分享访问令牌 */
  stoken: Stoken;
  /**
   * v1.1.9.final：游客模式（qk-guestTurn 开 + 全部 <50MB）——
   * 适配器不注入登录态 cookie，改用游客 __pugs（夸克专用；UC 忽略）。
   */
  guestMode?: boolean;
}

/* ============================== UI 会话 ============================== */

/**
 * 一次解析的完整上下文（HomePage 产出 → ResultPage 消费）
 * 仅引用 PanAdapter 抽象接口，不依赖具体网盘。
 *
 * v1.1.4 术语修正：parsedAt 实为「资源列表获取时间」（ls 完成时间），
 * 与「解析下载方式」（prase）无关 —— 结果页展示用「资源列表获取于」文案。
 */
export interface ParseSession {
  /** 识别到的适配器（registry 分发） */
  adapter: PanAdapter;
  /** 用户输入的分享链接 */
  url: string;
  /** 分享 ID */
  shareId: string;
  /** 分享访问令牌 */
  stoken: string;
  /** 目录树（buildTree 产物） */
  root: TreeNode;
  /** 资源列表获取时间（scanner 完成时间）ms */
  parsedAt: number;
  /**
   * v1.1.6 jumper：本会话由跳转链接（0B 文件夹二次获取）产生；
   * 非空时结果页「获取最新资源列表」按该文件夹重新扫描（而不是分享根）。
   */
  jump?: { url: string; rootFile: ShareFile; rootPath: string };
  /** v1.1.7：本会话目录树来自足迹缓存快照复用（HomePage 快照复用路径写入） */
  fromCache?: boolean;
}
