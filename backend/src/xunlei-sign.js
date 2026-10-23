/**
 * 迅雷 web 端 captcha_sign —— 模块化签名（v1.4.1-fix）
 *
 * 背景：官方大约每 ~20 天改一次盐（只改盐值与个数，不改「逐盐 md5 链」的逻辑）。
 * linkswift L7430 里那份旧盐已经失效；本模块把「身份三件套 + 盐表」集中成一份可配置 profile，
 * 后台面板可直接改（热加载：每次调用重新读设置，不需要重启）。
 *
 * 算法（与 app 端一致）：
 *   h = client_id + client_version + package_name + device_id + timestamp(ms)
 *   for (salt of salts) h = md5(h + salt)
 *   captcha_sign = '1.' + h
 *
 * 用法：
 *   captchaSign({ timestamp, deviceId })                     // 用默认 profile（当前 1.93.10）
 *   captchaSign({ timestamp, deviceId, profile })            // 用面板/设置里的 profile
 *   自检：signSelfTest() → { ok, got, want }                 // 已知向量（1.93.10）
 */
import { createHash } from 'node:crypto';

const md5 = (s) => createHash('md5').update(s).digest('hex');

/** 当前 web 端身份默认值（官方换 salt 时改这里；面板可在不改代码的情况下覆盖） */
export const SIGN_PROFILE_DEFAULTS = Object.freeze({
  client_id: 'Xqp0kJBXWhwaTpB6',
  client_version: '1.93.10',
  package_name: 'pan.xunlei.com',
  /** 9 条盐，顺序敏感（2026-10 版，来自 web 端 service-captcha + utils-async 剥离） */
  salts: Object.freeze([
    'DVM8BRQfJWDsIE0JbH5GCUM0z0jU1yGymBTj4Eyloazv1F+w0G7ig',
    'T',
    'a1fUxfjOO1/dW++DpGupRgw9P93L',
    'aktKbp+/lQc3MvlMHIupt65LjAgJOL6ttMFvTKK+7+WKubSf9rT',
    'SB/ne9FQUnQmWz4Wuv9KqKfGOBOCUubpHpECxOHfD4hNoMclYA2Yq',
    'sOZFBQ8IMFy3OFjAIf/eA65iqFvS9TIKzLyrhiT6',
    'ZhJdLgL7MGh2GanboB0yk',
    'Osf',
    'v',
  ]),
});

/** 已知自检向量（官方 1.93.10 那一版） */
export const SIGN_SELF_TEST = Object.freeze({
  timestamp: '1792243618981',
  device_id: '550cfe136e9d74e95be5393738639de7',
  want: '1.4181a24198c7edfbbba2afbcf1f4fab0',
});

/**
 * 归一化 profile：字符串字段去空、salts 只留字符串且非空；缺项用默认值。
 * 非法 shape 一律回落默认（不抛错，避免把面板写坏导致整个链路不可用）。
 */
export function normalizeSignProfile(input) {
  const base = SIGN_PROFILE_DEFAULTS;
  const src = input && typeof input === 'object' ? input : {};
  const str = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
  const salts = Array.isArray(src.salts)
    ? src.salts.filter((s) => typeof s === 'string' && s.length > 0)
    : [];
  return {
    client_id: str(src.client_id, base.client_id),
    client_version: str(src.client_version, base.client_version),
    package_name: str(src.package_name, base.package_name),
    salts: salts.length > 0 ? salts : [...base.salts],
  };
}

/**
 * 计算 captcha_sign。
 * @param {{ timestamp: string|number, deviceId: string, profile?: object }} p
 * @returns {string} `1.<md5 hex>`
 */
export function captchaSign({ timestamp, deviceId, profile } = {}) {
  const p = normalizeSignProfile(profile);
  // 服务端签名只认 pan.xunlei.com；test/pre 域名归一化（与 web 端一致）
  const host = p.package_name === 'test-pan.xunlei.com' || p.package_name === 'pre-pan.xunlei.com' ? 'pan.xunlei.com' : p.package_name;
  let h = `${p.client_id}${p.client_version}${host}${String(deviceId)}${String(timestamp)}`;
  for (const salt of p.salts) h = md5(h + salt);
  return `1.${h}`;
}

/** 自检：用已知向量校验当前 profile 是否仍是官方那一版（改盐后一般会 FAIL，属预期） */
export function signSelfTest(profile) {
  const got = captchaSign({ timestamp: SIGN_SELF_TEST.timestamp, deviceId: SIGN_SELF_TEST.device_id, profile });
  return { ok: got === SIGN_SELF_TEST.want, got, want: SIGN_SELF_TEST.want };
}
