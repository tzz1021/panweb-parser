/**
 * 凭据刷新预设（backend/src/presets.js，v1.3.1 P4）
 *
 * Tzz 定稿：**自动执行全部改手动预设** —— 就那几个常用操作，由人在面板上点；
 * 不做定时自动刷新、不做宏录制（宏 = 任意页面操作能力，风控与误操作代价都高）。
 *
 * 每个预设 = 一段固定脚本化流程（打开上游页面 → 等页面自己把凭据发下来 → 读出 → 写账号池），
 * 全部走 cdp.js（真实浏览器 9222，比 node 模拟更少风控）。
 *
 * 安全与隐私（硬约束）：
 *   - 凭据只在内存流通：读出来 → cookies.js upsertAccount（加密落库）→ 立即丢弃；**绝不经 HTTP 返回面板**
 *   - 面板只看得到：是否在跑、上次结果、身份（userId，非敏感）、到期时间
 *   - 频率限制：每个预设 minIntervalMs（默认 5min）+ 全局单飞（同时只允许一个预设跑）
 *   - 每次运行都写审计（谁、哪个预设、成功失败、身份），失败原因原样回报（便于排障）
 *
 * 取值表达式（extraction）：
 *   各上游页面把凭据放在哪，随版本变动；这里用**可配置的探测式取值**（storageKeys + cookieNames + 正则），
 *   默认值是常见形态。取不到时按失败回报并提示「请在 backend/data/period/config.json 的
 *   browser.presetProbes.<id> 里填写实际取值」，不猜、不硬闯。
 */
import { evaluateOnPage, probeCdp, getAllCookies, DEFAULT_CDP_PORT } from './cdp.js';
import { upsertAccount, accountIdentity, getAccount } from './cookies.js';
import { buildNetscape, parseCookieText, cookieStringFrom } from './cookie-text.js';
import { getConfig } from './config.js';
import { audit } from './db.js';
import { log } from './log.js';

/** 取值探测的表达式模板：依次尝试 localStorage/sessionStorage 命中 + cookie 拼接 */
function probeExpression({ storageKeys = [], cookieNames = [] }) {
  return `(() => {
    const out = {};
    const tryKeys = ${JSON.stringify(storageKeys)};
    for (const k of tryKeys) {
      try {
        const v = window.localStorage.getItem(k) || window.sessionStorage.getItem(k);
        if (v) { out.storage = { key: k, value: v }; break; }
      } catch (e) { /* ignore */ }
    }
    const names = ${JSON.stringify(cookieNames)};
    if (names.length) {
      const jar = document.cookie || '';
      const parts = [];
      for (const n of names) {
        const m = jar.match(new RegExp('(?:^|;\\\\s*)' + n + '=([^;]*)'));
        if (m) parts.push(n + '=' + m[1]);
      }
      if (parts.length) out.cookie = parts.join('; ');
    }
    return JSON.stringify(out);
  })()`;
}

/** 内置预设（就那几个常用的；Tzz 定稿不做自动执行） */
export const PRESETS = [
  {
    id: 'alipan-auth-refresh',
    title: '阿里云盘 · 刷新凭据',
    pan: 'alipan',
    url: 'https://www.alipan.com/drive/file/all',
    desc: '打开阿里云盘网页→ 读出 Authorization 写回账号池',
    minIntervalMs: 5 * 60_000,
    settleMs: 7000,
    // 阿里 web 端 token 常见落点（找不到时按失败回报，不猜）
    probes: { storageKeys: ['token', 'aliyundrive_token', 'authorization', 'auth', 'aliyundrive_web_token'], cookieNames: [] },
    /** 从取回结果里挑选凭据串（返回 null = 取不到） */
    pick(payload) {
      const raw = payload?.storage?.value;
      if (!raw) return null;
      // 页面可能存 JSON（{ access_token, ... }）或纯串
      try {
        const obj = JSON.parse(raw);
        const token = obj?.access_token || obj?.accessToken || obj?.token;
        if (typeof token === 'string' && token.split('.').length === 3) return `auth=Bearer ${token}`;
      } catch {
        /* 非 JSON，继续 */
      }
      if (typeof raw === 'string' && raw.split('.').length === 3) return `auth=Bearer ${raw}`;
      return null;
    },
  },
  {
    id: 'quark-cookie-refresh',
    title: '夸克网盘 · 刷新登录 cookie',
    pan: 'quark',
    url: 'https://pan.quark.cn/list',
    desc: '打开夸克网盘网页 → 读出当前登录 cookie 整串（__pus/__uid/__puus）→ 写回账号池',
    minIntervalMs: 5 * 60_000,
    settleMs: 6000,
    probes: { storageKeys: [], cookieNames: ['__pus', '__uid', '__puus', '__sdid', '__kp', '__kps', '__ktd', '_UP_A4A_11_'] },
    pick(payload) {
      return payload?.cookie || null;
    },
  },
  {
    id: 'uc-pugs-refresh',
    title: 'UC 网盘 · 刷新 __pugs',
    pan: 'uc',
    url: 'https://drive.uc.cn/',
    desc: '打开 UC 网盘页面 → 读出当前登录 cookie 整串（__pus/__uid/__puus） → 写回账号池',
    minIntervalMs: 5 * 60_000,
    settleMs: 6000,
    probes: { storageKeys: [], cookieNames: ['__pus', '__uid', '__puus', '__sdid'] },
    pick(payload) {
      return payload?.cookie || null;
    },
  },
];

/** 运行状态（内存态；面板只读这些字段，绝不含凭据） */
const runtime = new Map(); // id -> { state, lastRunAt, lastOk, lastMessage, lastIdentity, running }

function stateOf(id) {
  return runtime.get(id) ?? { state: 'idle', lastRunAt: null, lastOk: null, lastMessage: '', lastIdentity: null, running: false };
}

/** 列出预设（含状态 + CDP 端口 + 下次可运行时间）—— 面板用 */
export function listPresets(cdpPort = defaultCdpPort()) {
  const now = Date.now();
  return PRESETS.map((p) => {
    const st = stateOf(p.id);
    const nextAllowedAt = st.lastRunAt ? st.lastRunAt + p.minIntervalMs : 0;
    return {
      id: p.id,
      title: p.title,
      pan: p.pan,
      desc: p.desc,
      minIntervalMs: p.minIntervalMs,
      nextAllowedAt: nextAllowedAt > now ? nextAllowedAt : null,
      cdpPort,
      ...st,
      enabled: true,
    };
  });
}

/** 浏览器 health（面板显示「浏览器是否连着」） */
export async function browserHealth(cdpPort = defaultCdpPort()) {
  return probeCdp(cdpPort);
}

function defaultCdpPort() {
  const cfg = getConfig();
  return Number(cfg?.browser?.cdpPort ?? process.env.PANHUB_CDP_PORT ?? DEFAULT_CDP_PORT) || DEFAULT_CDP_PORT;
}

/** 全局单飞：同一时刻只允许一个预设跑（防连点/并发打上游） */
let inFlight = null;

/**
 * 手动运行一个预设（面板按钮 → 这里）。
 * @returns {Promise<{ok:boolean, message:string, identity?:string|null, expiresAt?:number|null}>}
 */
export async function runPreset(id, via = 'webui') {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return { ok: false, message: `未知预设：${id}` };
  const st = stateOf(id);
  const now = Date.now();
  // 限频（Tzz：注意操作限频）
  if (st.lastRunAt && now - st.lastRunAt < preset.minIntervalMs) {
    const wait = Math.ceil((preset.minIntervalMs - (now - st.lastRunAt)) / 1000);
    return { ok: false, message: `该预设限频：请 ${wait} 秒后再试（每 ${Math.round(preset.minIntervalMs / 1000)} 秒最多一次）` };
  }
  if (inFlight) {
    return { ok: false, message: `已有预设正在运行（${inFlight}），请等它结束（同时只允许一个，避免顶着上游打）` };
  }

  const cdpPort = defaultCdpPort();
  runtime.set(id, { ...st, state: 'running', running: true, lastRunAt: now, lastMessage: '运行中…' });
  inFlight = id;
  audit('preset.run', `${preset.id}（${preset.pan}）手动触发`, via);
  try {
    const health = await probeCdp(cdpPort);
    if (!health.ok) {
      const msg = `浏览器未连接（127.0.0.1:${cdpPort}）：${health.reason ?? '不可达'}。请先在服务器上启动带 --remote-debugging-port 的 Chromium（或跑安装脚本）`;
      runtime.set(id, { ...stateOf(id), state: 'error', running: false, lastOk: false, lastMessage: msg, lastRunAt: now });
      log('warn', `预设 ${id}：${msg}`);
      return { ok: false, message: msg };
    }

    const payload = await evaluateOnPage({
      url: preset.url,
      expression: probeExpression(preset.probes),
      port: cdpPort,
      settleMs: preset.settleMs,
      reload: true,
    });
    // v1.4.1：cookie 类预设 —— 再用 CDP 抓**全量** cookie（含 HttpOnly）→ Netscape → 统一解析（不截断）
    if (preset.probes?.cookieNames?.length) {
      try {
        const cookies = await getAllCookies({ port: cdpPort });
        const netscape = buildNetscape(cookies);
        const parsed = parseCookieText(netscape);
        const cookie = cookieStringFrom(parsed, preset.probes.cookieNames);
        if (cookie) {
          payload.cookies = cookies;
          payload.netscape = netscape;
          payload.parsed = parsed;
          payload.cookie = cookie;
        }
      } catch (err) {
        // 抓全量失败不致命：回落 evaluateOnPage 的 document.cookie 结果（但会记一条提示）
        runtime.set(id, { ...stateOf(id), lastMessage: `全量 cookie 抓取失败，已回落页面 document.cookie：${err?.message ?? err}` });
        log('warn', `预设 ${id}：全量 cookie 抓取失败（${err?.message ?? err}），回落页面 document.cookie`);
      }
    }
    const credential = preset.pick(payload);
    if (!credential) {
      const msg = `没读到凭据（页面结构可能变了）：请在 config.json 的 browser.presetProbes.${id} 填写实际取值键（当前探测：${JSON.stringify(preset.probes)}）`;
      runtime.set(id, { ...stateOf(id), state: 'error', running: false, lastOk: false, lastMessage: msg, lastRunAt: now });
      log('warn', `预设 ${id}：${msg}`);
      return { ok: false, message: msg };
    }

    // 写账号池（cookies.js 内部加密落库 + 审计）；凭据本体不外传
    const accountId = upsertAccount(
      { pan: preset.pan, label: `${preset.pan}-refreshed`, cookieString: credential, kind: 'real' },
      `preset:${preset.id}`,
    );
    // 身份（userId，非敏感）供面板显示账号是否换号；凭据本体不出这一层
    const saved = getAccount(Number(accountId));
    const identity = saved ? accountIdentity(saved) : null;
    const msg = `已刷新并写回账号池（账号 #${accountId}）`;
    runtime.set(id, {
      state: 'ok',
      running: false,
      lastOk: true,
      lastMessage: msg,
      lastIdentity: identity,
      lastRunAt: now,
    });
    log('info', `预设 ${id}：${msg}`, { console: true });
    return { ok: true, message: msg, identity };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    runtime.set(id, { ...stateOf(id), state: 'error', running: false, lastOk: false, lastMessage: msg, lastRunAt: now });
    log('warn', `预设 ${id} 失败：${msg}`);
    return { ok: false, message: msg };
  } finally {
    inFlight = null;
  }
}
