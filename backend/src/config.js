/**
 * 配置加载/默认值/密钥文件管理（docs/backend-wrangler-plan.md §4.1 重构）
 *
 * - 配置文件：data/period/config.json（端口/令牌/wrangler 参数等）
 * - 密钥文件：data/period/secret.key（AES-256-GCM 加密 cookie 库用，权限 600）
 * - 首启：随机生成 webui 端口 + 令牌；wrangler 端口默认 8787 / inspector 9229
 *
 * v0.1.0-next 重构（Tzz 审稿，设计稿 §2.2 硬约束）：
 * - 校验策略（token/白名单/限频）只属于 functions/api/proxy.js，
 *   backend 不再维护 whitelist / rateLimitPerMin / ipBan / expose 字段
 * - 新增 wrangler 段：{ port, inspectorPort, autoSpawn }（launcher 读取）
 */
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // backend/
export const DATA_DIR = join(ROOT, 'data');
export const TMP_DIR = join(DATA_DIR, 'tmp');
export const PERIOD_DIR = join(DATA_DIR, 'period');
const CONFIG_PATH = join(PERIOD_DIR, 'config.json');
const SECRET_PATH = join(PERIOD_DIR, 'secret.key');

/** 版本标识（v1.2-next 支线，tag 1.2-next1） */
export const BACKEND_VERSION = '0.1.0-next';

/** 默认配置（首启合并写入 config.json） */
const DEFAULTS = {
  proxy: {
    port: null, // 首启随机生成
    host: '127.0.0.1', // 单 listener 硬绑本机
    token: null, // X-Proxy-Token（首启随机生成；与 wrangler --binding 同一把）
  },
  webui: {
    port: null, // 首启随机生成（20000–60000）
    host: '127.0.0.1', // 硬绑本机（代码层强制）
    token: null, // WebUI 门禁令牌（首启打印一次性；可轮换）
  },
  wrangler: {
    port: 8787, // wrangler pages dev 端口（被占时 launcher 递增避让）
    inspectorPort: 9229, // wrangler devtools ws 端口（backend 作 ws 客户端连它做健康监听）
    bind: '0.0.0.0', // launcher 按 PANHUB_BIND 写入（v1.2.2 微调：企业内网默认全接口；仅本机时写 127.0.0.1）
    autoSpawn: true, // backend 启动时是否自动 spawn wrangler（关 = 外部自行启动）
  },
  notify: {
    enabled: false,
    webhooks: [], // [{ id, name, url, type: 'ntfy'|'serverchan'|'pushplus'|'custom' }]
  },
  advanced: {
    terminalEnabled: false, // 严格终端穿透默认关（系统配置 → 高级 开启）
    devtoolsUrl: '', // devtools 绑定地址（默认空 = 自动取 wrangler.inspectorPort 的 ws://127.0.0.1:<port>/ws）
  },
  refresh: {
    intervalMs: 2 * 3600_000, // 正式账号 cookie 刷新周期（默认 2h；v1.2.2 §9 P2，quark 优先）
  },
  // v1.4 迅雷 restore/download：web 身份 captcha（手动录入 sign，长期复用；见 src/xunlei.js）
  xunlei: {
    // 手动录入项（面板可改；此处预置仅在 settings 表为空时生效）
    captcha_sign: '',
    captcha_timestamp: '',
    device_id: '',
    // web 身份默认（必须与录入 sign 配套；一般不用改）
    client_id: 'Xqp0kJBXWhwaTpB6',
    client_version: '1.93.6',
    package_name: 'pan.xunlei.com',
  },
};

/** 当前配置（内存态；写回 config.json） */
let config = structuredClone(DEFAULTS);

function ensureDirs() {
  for (const d of [DATA_DIR, TMP_DIR, PERIOD_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

/** 随机端口（20000–60000；避开常用/易猜端口段） */
function randomPort() {
  return randomInt(20000, 60000);
}

/** 随机令牌（hex） */
export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('hex');
}

/**
 * 读取 config.json（不存在则写默认 + 随机端口/令牌）。
 * 兼容旧版字段：旧 config 里的 whitelist / proxy.expose / proxy.rateLimitPerMin /
 * proxy.ipBan / cdp 一律不再读取（校验策略归 proxy.js），wrangler 段缺失时用默认。
 */
export function loadConfig() {
  ensureDirs();
  let isFirstRun = false;
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      config = {
        proxy: { ...DEFAULTS.proxy, ...(raw.proxy ?? {}) },
        webui: { ...DEFAULTS.webui, ...(raw.webui ?? {}) },
        wrangler: { ...DEFAULTS.wrangler, ...(raw.wrangler ?? {}) },
        notify: { ...DEFAULTS.notify, ...(raw.notify ?? {}) },
        advanced: { ...DEFAULTS.advanced, ...(raw.advanced ?? {}) },
        refresh: { ...DEFAULTS.refresh, ...(raw.refresh ?? {}) },
        xunlei: { ...DEFAULTS.xunlei, ...(raw.xunlei ?? {}) },
      };
    } catch (err) {
      console.error(`[config] config.json 损坏（${err.message}），使用默认值并备份`);
      writeFileSync(`${CONFIG_PATH}.bak-${Date.now()}`, readFileSync(CONFIG_PATH));
    }
  } else {
    isFirstRun = true;
    config.webui.port = randomPort();
    config.webui.token = randomToken();
    config.proxy.port = config.webui.port; // 单 listener：proxy 与 webui 同端口
    config.proxy.token = randomToken();
  }
  // 补全：文件存在但关键字段缺失（半初始化 / 旧版 / 手改）→ 补生成，避免"自己被拦住"
  //（launcher setup 可能先写了端口没写令牌，或用户删了 token 字段）
  let needSave = isFirstRun; // 首启必写回
  if (!config.proxy.token) { config.proxy.token = randomToken(); needSave = true; }
  if (!config.webui.token) { config.webui.token = randomToken(); needSave = true; }
  if (!config.proxy.port) {
    config.proxy.port = config.webui.port ?? randomPort();
    needSave = true;
  }
  if (!config.webui.port) { config.webui.port = config.proxy.port; needSave = true; }
  if (needSave) saveConfig();
  return { config, isFirstRun };
}

/** 同步根 .dev.vars 的 PROXY_TOKEN（轮换 proxy 令牌后调用；wrangler 下次启动生效）
 * 不在此写 TRACE_D1：launcher ensure_dev_vars 会统一生成/更新。 */
export function syncDevVars(proxyToken) {
  try {
    const path = join(ROOT, '..', '.dev.vars');
    let content = '';
    if (existsSync(path)) content = readFileSync(path, 'utf8');
    const lines = content.split('\n').filter((l) => !l.startsWith('PROXY_TOKEN='));
    if (proxyToken) lines.push(`PROXY_TOKEN=${proxyToken}`);
    writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 });
  } catch (err) {
    console.error(`[config] .dev.vars 同步失败：${err.message}`);
  }
}

/** 写回 config.json（600 权限） */
export function saveConfig() {
  ensureDirs();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** 读取（或生成）AES-256-GCM 密钥文件；返回 Buffer（32 字节） */
export function loadSecretKey() {
  ensureDirs();
  if (existsSync(SECRET_PATH)) {
    const buf = readFileSync(SECRET_PATH);
    if (buf.length === 32) return buf;
    console.error('[config] secret.key 长度异常，重新生成（旧 cookie 密文将无法解密）');
  }
  const key = randomBytes(32);
  writeFileSync(SECRET_PATH, key, { mode: 0o600 });
  try {
    chmodSync(SECRET_PATH, 0o600);
  } catch {
    /* 非 POSIX 平台忽略 */
  }
  return key;
}

/** 运行时长（ms） */
let bootAt = Date.now();
export function uptimeMs() {
  return Date.now() - bootAt;
}

export function getConfig() {
  return config;
}
