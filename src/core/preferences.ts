/**
 * 偏好设置（docs/STRUCTURE.md：src/core/preferences.ts）
 *
 * 存储：localStorage，key 'pan-web:prefs:v1'，JSON 序列化。
 * 默认值严格按 HANDOFF 附件 §2/§3（v1 UC 零 cookie → cookieWarn 默认关）。
 * 读：与 DEFAULTS 深合并，缺字段用默认；JSON 损坏/配额异常 try/catch 兜底回默认。
 * 写：setPreferences 顶层浅合并 + 嵌套分组逐组浅合并后写回。
 */
import type { Preferences } from './types';
import { addGlobalLog } from './footprint/globalLog';

/** localStorage 键名 */
const STORAGE_KEY = 'pan-web:prefs:v1';

/**
 * 默认偏好（HANDOFF 附件 §2 默认下载方式 / §3 默认足迹保留）：
 * - 单文件、同目录批量默认都是“解析”；跨目录默认不保留结构、深度不限
 * - 弹窗：cookieWarn 默认开（§10：UC 下载层需 __pugs，游客态 cookie 预热；可关），其余默认开
 * - 足迹：全保留默认开，日志等级 debug、链接/树限 100 条、日志 5MB
 */
export const DEFAULTS: Preferences = {
  theme: 'auto', // v1.3.1：主题三态（顶栏灯泡轮换）默认跟随系统
  checkColor: '', // v1.3.1：勾选行自定义底色，'' = 主题默认高亮
  singleFileMode: 'parse',
  sameDirMode: 'parse',
  keepStructure: false,
  scanDepth: 0,
  bulkThreshold: 100, // v1.3.2：大宗文件判定（一级对象数 > 100 则不展开该目录；0 = 关闭）
  showDirSize: true,
  showDirProps: true, // v1.1.6：文件夹内部文件和子文件夹个数
  showEtag: false, // v1.1.7：校验和列（UC 的 md5 来自 download/列表响应，需 base64 转码；默认关）
  showLinkDetail: false, // v1.1.7：显示详细的解析时间和有效期
  defaultTerminal: '', // v1.1.7：默认终端类型（空 = 浏览器 UA）
  restoreCollapsed: 'ask', // v1.1.7：复用期间恢复上次折叠状态（丢弃/恢复/每次询问）
  confirmParse: true,
  trackEta: true,
  showTree: true,
  treeFormat: 'bars',
  treeDetail: {
    fileSize: true,
    etag: true,
    shareTime: true,
    saveTime: true,
    platformTime: true,
  },
  modals: {
    cookieWarn: true, // §10：下载层需 __pugs（游客态），解析时弹窗预热；可关
    loginJump: true,
    autoCloseTab: true,
    exportFailWarn: true, // v1.1.4：导出任务失败警告弹窗（默认开）
    parseFailWarn: true, // v1.1.4：单文件解析失败警告弹窗（默认开）
    corsAutoJump: false, // CORS 拦截默认弹窗提示（1.0.3：自动跳转改为"备用"，默认关；开=自动跳分享页）
    jumpTip: true, // v1.1.6：跳转到文件夹是否提示（0B 文件夹二次获取）
    exportYellowWarn: true, // v1.1.7：export 包含黄色标记是否弹窗提示（关=简略 toast）
    cookieInput: true, // v1.1.9：登录态 cookie 填写弹窗（夸克强制登录时）
  },
  transport: {
    mode: 'direct', // 解析通道：direct 直连（CORS 受限）| proxy 代理转发（1.1 新增）
    proxyUrl: '', // 用户填写的 API 转发代理地址（最好是自己的）
    proxyToken: '', // 代理访问令牌（部署时配置的 PROXY_TOKEN；代理未设 token 时可留空）
    ipHashUpload: false, // v1.2.2：IP 采集（哈希化后上传）默认关
  },
  advanced: {
    enabled: false, // v1.1.7：高级功能总开关（默认关）
    aria2Extra: '',
    gopeedExtra: '',
    showHiddenVolumn: true,
    hiddenVolumnHint: true,
  },
  // v1.1.9.final：夸克专属偏好（qk-guestTurn 游客模拟，默认关 = 最稳妥）
  quark: {
    qkGuestTurn: false,
  },
  // v1.4：迅雷专属偏好（scan 单页 30 = 官方默认；大宗重跑开；解析后隐秘参数关）
  xunlei: {
    scanLimit: 30,
    bulkRetry: true,
    fileHiddenVolumn: false,
  },
  /** v1.1.4：资源复用窗口（小时）；0 = 不复用 */
  reuseWindowHours: 1,
  footprint: {
    keepLinks: true,
    keepTrees: true,
    recordInTree: true,
    keepLogs: true,
    logLevel: 'debug',
    linkLimit: 100,
    logMaxMB: 5,
  },
};

/** 深拷贝默认值：防止调用方意外改动共享的 DEFAULTS 常量 */
function cloneDefaults(): Preferences {
  return {
    ...DEFAULTS,
    treeDetail: { ...DEFAULTS.treeDetail },
    modals: { ...DEFAULTS.modals },
    transport: { ...DEFAULTS.transport },
    footprint: { ...DEFAULTS.footprint },
    advanced: { ...DEFAULTS.advanced },
    quark: { ...DEFAULTS.quark },
    xunlei: { ...DEFAULTS.xunlei },
  };
}

/** 过滤 undefined 字段（存储侧可能写入 null/undefined，不允许覆盖默认值） */
function filterUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(obj) as Array<keyof T>) {
    if (obj[key] !== undefined) {
      out[key] = obj[key];
    }
  }
  return out;
}

/**
 * 偏好变更订阅（v1.3.1）：主题灯泡 / 勾选底色这类需要实时跟随偏好的组件用。
 * 只做「写后通知」，不改存储格式；跨标签页靠同键 storage 事件转发。
 */
const preferenceListeners = new Set<() => void>();

/** 通知所有订阅者（setPreferences / resetPreferences 写后调用） */
function notifyPreferenceListeners(): void {
  for (const listener of [...preferenceListeners]) {
    try {
      listener();
    } catch {
      // 单个订阅者抛错不影响其它订阅者与写入流程
    }
  }
}

/** storage 事件：仅同键（其它标签页写入偏好）时通知 */
function onStorageChange(event: StorageEvent): void {
  if (event.key === null || event.key === STORAGE_KEY) {
    notifyPreferenceListeners();
  }
}

/**
 * 订阅偏好变更（返回退订函数）。
 * 触发时机：本页 setPreferences / resetPreferences，或其它标签页写同一键（storage）。
 */
export function subscribePreferences(listener: () => void): () => void {
  preferenceListeners.add(listener);
  if (preferenceListeners.size === 1 && typeof window !== 'undefined') {
    window.addEventListener('storage', onStorageChange);
  }
  return () => {
    preferenceListeners.delete(listener);
    if (preferenceListeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorageChange);
    }
  };
}

/**
 * 合并一个嵌套分组：以 base 为准，stored 只覆盖其中存在的字段；
 * stored 不是普通对象（null/数组/原始值）时整体回退 base，防脏数据。
 */
function mergeGroup<T extends object>(base: T, stored: unknown): T {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return { ...base };
  }
  const out: T = { ...base };
  const record = stored as Record<string, unknown>;
  for (const key of Object.keys(record) as Array<keyof T>) {
    const value = record[key as string];
    if (value !== undefined) {
      out[key] = value as T[keyof T];
    }
  }
  return out;
}

/** 合并偏好：顶层浅合并 + 五个嵌套分组（treeDetail/modals/transport/footprint/advanced）逐组浅合并 */
function mergePrefs(base: Preferences, patch: Partial<Preferences>): Preferences {
  const merged: Preferences = { ...base, ...filterUndefined(patch) };
  merged.treeDetail = mergeGroup(base.treeDetail, patch.treeDetail);
  merged.modals = mergeGroup(base.modals, patch.modals);
  merged.transport = mergeGroup(base.transport, patch.transport);
  merged.footprint = mergeGroup(base.footprint, patch.footprint);
  merged.advanced = mergeGroup(base.advanced, patch.advanced);
  merged.quark = mergeGroup(base.quark, patch.quark);
  merged.xunlei = mergeGroup(base.xunlei, patch.xunlei);
  return merged;
}

/**
 * 读取偏好设置：localStorage 有值则与 DEFAULTS 深合并（缺字段用默认），
 * 无值/JSON 损坏/配额异常一律兜底返回默认值副本。
 */
export function getPreferences(): Preferences {
  // 非浏览器环境（如 SSR/测试）直接回默认
  if (typeof window === 'undefined') {
    return cloneDefaults();
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return cloneDefaults();
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return cloneDefaults();
    }
    return mergePrefs(cloneDefaults(), parsed as Partial<Preferences>);
  } catch {
    // JSON 损坏 / 配额或隐私模式异常：兜底回默认
    return cloneDefaults();
  }
}

/**
 * 更新偏好设置：以当前值（含已存储项）为基础做浅合并，写回 localStorage。
 * 写失败（配额等）静默忽略，内存合并结果照常返回。
 * 变更写入全局日志（开发调试用，不过滤隐私）。
 */
export function setPreferences(patch: Partial<Preferences>): Preferences {
  const merged = mergePrefs(getPreferences(), patch);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      // 全局日志：记录偏好变更的关键字段（不落值，只落键，避免敏感信息刷屏）
      const keys = Object.keys(patch).join(',');
      addGlobalLog(`修改了偏好设置：${keys}`);
    } catch {
      // 写失败静默忽略（隐私模式/配额超限），不影响本次返回值
    }
  }
  // v1.3.1：通知订阅者（主题灯泡 / 勾选底色等实时跟随）
  notifyPreferenceListeners();
  return merged;
}

/** 重置偏好设置：删除存储项，之后 getPreferences() 回到 DEFAULTS */
export function resetPreferences(): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略移除异常（如隐私模式禁用存储）
  }
  // v1.3.1：重置也要通知订阅者（回到 DEFAULTS 的 theme/checkColor）
  notifyPreferenceListeners();
}
