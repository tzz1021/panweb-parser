/**
 * CDP 浏览器 ↔ 账号绑定锁（backend/src/cdp-bind.js，v1.4.1）
 *
 * 背景：同一个浏览器（CDP port）刷新凭据时会**重复新建账号**（DB 快照里出现过两条一样身份的
 * `quark-refreshed`）——所以给 port 与账号建立一份 **JSON 绑定记录**：
 *   `{ "<port>": { accountId, userId, label, note, updatedAt } }`（存在 settings 键 `cdp_port_bindings`）
 * 刷新时按绑定写回同一账号；port 可手动输入；冲突（port 已绑别的账号）由调用方明确提示并允许改绑。
 */
import { getSetting, setSetting } from './db.js';

export const CDP_BINDINGS_KEY = 'cdp_port_bindings';

/** 全部绑定（数组，按 port 升序） */
export function listPortBindings() {
  const raw = getSetting(CDP_BINDINGS_KEY);
  if (!raw) return [];
  let obj = {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') obj = parsed;
  } catch {
    return [];
  }
  return Object.entries(obj)
    .map(([port, v]) => ({
      port: Number(port),
      accountId: Number(v?.accountId) || null,
      userId: v?.userId ?? null,
      label: v?.label ?? null,
      note: v?.note ?? null,
      updatedAt: Number(v?.updatedAt) || null,
    }))
    .sort((a, b) => a.port - b.port);
}

/** 查某 port 的绑定（无返回 null） */
export function bindingOf(port) {
  const p = Number(port);
  if (!Number.isFinite(p)) return null;
  return listPortBindings().find((b) => b.port === p) ?? null;
}

/** 写入/更新绑定（幂等；返回新记录） */
export function bindPort({ port, accountId, userId, label, note }) {
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0) throw new Error('port 必须是正整数');
  const raw = getSetting(CDP_BINDINGS_KEY);
  let obj = {};
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object') obj = parsed;
  } catch {
    obj = {};
  }
  const record = {
    accountId: Number(accountId) || null,
    userId: userId ?? null,
    label: label ?? null,
    note: note ?? null,
    updatedAt: Date.now(),
  };
  obj[String(p)] = record;
  setSetting(CDP_BINDINGS_KEY, JSON.stringify(obj));
  return { port: p, ...record };
}

/** 解绑（只删绑定记录，不动账号） */
export function unbindPort(port) {
  const p = Number(port);
  const raw = getSetting(CDP_BINDINGS_KEY);
  if (!raw) return { port: p, removed: false };
  let obj = {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') obj = parsed;
  } catch {
    return { port: p, removed: false };
  }
  const had = Object.prototype.hasOwnProperty.call(obj, String(p));
  delete obj[String(p)];
  setSetting(CDP_BINDINGS_KEY, JSON.stringify(obj));
  return { port: p, removed: had };
}

/** 某 port 已绑定的账号身份（用于冲突判定；无绑定返回 null） */
export function boundUserIdOf(port) {
  return bindingOf(port)?.userId ?? null;
}
