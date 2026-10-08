/**
 * 系统配置（v1.2.2）：账号池（cookie）/ 校验策略（proxy.js 只读）/ 通知与高级 / 日志
 *
 * 账号池字段名与 SPA CookieInputModal 对齐（v1.2 约定，勿改）：
 * - pan：'quark' | 'uc'（= src/adapters/registry.ts 的 adapter id）
 * - quark：整串 cookie（关键 key __pus / __uid / __puus，与 quark/cookies.ts 一致）
 * - uc：__pugs（下载层游客态凭据，208 字符）
 * 高危操作（账号池增删改）→ 二次输入 WebUI 令牌确认（秘钥语义）。
 *
 * v1.2.2 变更：白名单/限频校验归 functions/api/proxy.js（backend 只读展示 policy）；
 * 日志：保留天数 log_retention_days（定时清理重启后生效）+ 手动清理（立即生效）。
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, fmtTime, getSettings, postSettings, purgeLogs } from '../api.js';
import { parseCookieText, looksStructured, toHeaderString } from '../cookieText.js';

// v1.4.1：与 backend/src/cookies.js#PAN_KEYS 对齐（补 xunlei / alipan，面板不再报「未知网盘」）
const PAN_KEYS = {
  quark: ['__pus', '__uid', '__puus'],
  uc: ['__pugs'],
  xunlei: ['authorization', 'to_parent_id', 'user_id'],
  alipan: ['authorization', 'drive_id', 'to_parent_file_id'],
};

const PAN_LABELS = { quark: 'quark（夸克）', uc: 'uc（UC）', xunlei: 'xunlei（迅雷）', alipan: 'alipan（阿里云盘）' };

/** 转存类驱动的「特别参数」（可选）：随凭据串一起入库（PAN_KEYS 同名键） */
const PAN_EXTRA_FIELDS = {
  xunlei: [
    { key: 'to_parent_id', label: '转存目标目录 fid（to_parent_id）', placeholder: '你自己网盘里目标文件夹的 file_id' },
    { key: 'user_id', label: '账号 user_id（可空）', placeholder: '登录账号 user_id（captcha meta 用）' },
  ],
  alipan: [
    { key: 'drive_id', label: 'drive_id', placeholder: '你的 drive_id（F12 抓包）' },
    { key: 'to_parent_file_id', label: '转存目标目录（to_parent_file_id）', placeholder: '目标文件夹 file_id' },
  ],
};

const PAN_PLACEHOLDER = {
  quark: '粘贴完整 cookie 整串（含 __pus=…; __uid=…; __puus=…；或从已登录浏览器复制，支持 Netscape/JSON/Header 导入）',
  uc: '粘贴 __pugs 值（下载层游客态凭据，208 字符）',
  xunlei: '粘贴 authorization（Bearer xxx）或凭据串 authorization=…;to_parent_id=…;user_id=…（支持 Netscape/JSON/Header 导入，可直接粘贴 F12 里整段 Header）',
  alipan: '粘贴凭据串 auth=Bearer xxx;drive_id=…;to_parent_file_id=…（支持 Netscape/JSON/Header 导入）',
};

/** 与 SPA quark/cookies.ts 同构：整串里已有关键 key（发现是按 网盘键 检测，含 authorization 类） */
function keysPresent(cookieString, pan) {
  const stripped = String(cookieString ?? '').replace(/^cookie\s*:\s*/i, '');
  const keys = PAN_KEYS[pan] ?? [];
  return keys.filter((k) => {
    for (const pair of stripped.split(';')) {
      const eq = pair.indexOf('=');
      if (eq > 0 && pair.slice(0, eq).trim() === k && pair.slice(eq + 1).trim()) return true;
    }
    return false;
  });
}

/**
 * v1.4.1：输入即解析 —— Netscape / JSON 自动转成请求头格式（对齐 SPA parseCookieText），
 * 面板不再只认 header string（之前要 Ctrl+F 才能发现已识别的键）。
 */
function normalizeCredentialInput(raw) {
  if (!looksStructured(raw)) return { text: raw, note: '' };
  try {
    const parsed = parseCookieText(raw);
    const n = Object.keys(parsed).length;
    return { text: toHeaderString(parsed), note: `已识别 ${n} 个 cookie（Netscape/JSON）并转为请求头格式` };
  } catch (err) {
    return { text: raw, note: String(err?.message ?? '识别失败') };
  }
}

function AccountForm({ initial, panKeys, onDone, toast, ttlDefault = 30 }) {
  const [pan, setPan] = useState(initial?.pan ?? 'quark');
  const [label, setLabel] = useState(initial?.label ?? '');
  // v1.3.1：编辑**不回填凭据**（写新不读旧）；保存即覆盖，留空会被服务端拒绝
  const [cookieString, setCookieString] = useState('');
  const [isTemp, setIsTemp] = useState(Boolean(initial?.isTemp));
  const [ttlMinutes, setTtlMinutes] = useState(initial?.ttlMinutes ?? ttlDefault);
  const [expiresAt, setExpiresAt] = useState(initial?.expiresAt ? new Date(initial.expiresAt).toISOString().slice(0, 16) : '');
  const [confirmToken, setConfirmToken] = useState('');
  const [busy, setBusy] = useState(false);
  // v1.4.1：特别参数（转存类驱动）+ 粘贴格式识别提示 + 按键级临时/长期（遗留#1）
  const [extras, setExtras] = useState({});
  const [importNote, setImportNote] = useState('');
  const [keyTemps, setKeyTemps] = useState({});
  const found = useMemo(() => keysPresent(cookieString, pan), [cookieString, pan]);

  /** 输入即解析：Netscape / JSON 自动转 header 串（并给一行提示） */
  const onCredentialChange = (raw) => {
    const { text, note } = normalizeCredentialInput(raw);
    setCookieString(text);
    setImportNote(note);
  };

  /** 凭据串 = 粘贴的主凭据 + 特别参数（k=v，与 PAN_KEYS 同名） */
  const credentialFull = () => {
    const extra = (PAN_EXTRA_FIELDS[pan] ?? [])
      .map((f) => [f.key, String(extras[f.key] ?? '').trim()])
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    return [String(cookieString ?? '').trim(), extra].filter(Boolean).join('; ');
  };

  const save = async () => {
    if (!confirmToken.trim()) {
      toast('账号池修改属高危操作：请二次输入 WebUI 令牌确认', 'err');
      return;
    }
    setBusy(true);
    const r = await api('/api/web/accounts', {
      method: 'POST',
      body: {
        id: initial?.id,
        pan,
        label,
        cookieString: credentialFull(),
        // v1.4.1 遗留#1：按键级临时（只提交标「临时」的键；其余按长期写入，服务端清其临时记录）
        keyTemps: Object.fromEntries(
          Object.entries(keyTemps)
            .filter(([, t]) => t?.temp)
            .map(([k, t]) => [k, { ttlMinutes: Number(t.minutes) || undefined }]),
        ),
        expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
        temp: isTemp, // v1.3.1：临时写入（到期自动清除凭据，审计保留）
        ttlMinutes: Number(ttlMinutes) || undefined,
      },
      confirmToken: confirmToken.trim(),
    });
    setBusy(false);
    if (r.ok) {
      toast(initial ? '账号已更新' : '账号已添加', 'ok');
      onDone(true);
    } else {
      toast(r.data?.message ?? '保存失败', 'err');
    }
  };

  return (
    <div className="card" style={{ borderColor: 'var(--primary)' }}>
      <h3>{initial ? `覆盖写入账号（${initial.label || initial.userId || `#${initial.id}`}）` : '添加账号'}</h3>
      {initial && (
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          出于安全**不回填**已有凭据（写新不读旧）：请粘贴新凭据后保存（保存即覆盖）。
        </p>
      )}
      <div className="row" style={{ marginBottom: 8 }}>
        <select className="input" style={{ width: 150 }} value={pan} onChange={(e) => { setPan(e.target.value); setCookieString(''); setExtras({}); setImportNote(''); }}>
          {Object.keys(PAN_KEYS).map((id) => (
            <option key={id} value={id}>{PAN_LABELS[id] ?? id}</option>
          ))}
        </select>
        <input className="input grow" placeholder="备注名（如 家庭-1号）" value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <textarea
        className="input"
        rows={3}
        placeholder={PAN_PLACEHOLDER[pan] ?? '粘贴凭据'}
        value={cookieString}
        onChange={(e) => onCredentialChange(e.target.value)}
      />
      {importNote && (
        <p className="muted" style={{ margin: '4px 0 0', fontSize: 12 }}>{importNote}</p>
      )}
      {(PAN_EXTRA_FIELDS[pan] ?? []).length > 0 && (
        <div style={{ marginTop: 10 }}>
          <p className="muted" style={{ margin: '0 0 6px', fontSize: 12 }}>
            特别参数（可选；随凭据串入库，键名与后端 PAN_KEYS 一致）：
            {pan === 'xunlei' ? ' captcha_sign / device_id 等 captcha 身份在「凭据刷新」页的迅雷卡片里设置。' : ''}
          </p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {(PAN_EXTRA_FIELDS[pan] ?? []).map((f) => (
              <input
                key={f.key}
                className="input mono"
                style={{ width: 280 }}
                placeholder={`${f.label}${f.placeholder ? `（${f.placeholder}）` : ''}`}
                value={extras[f.key] ?? ''}
                onChange={(e) => setExtras((prev) => ({ ...prev, [f.key]: e.target.value }))}
              />
            ))}
          </div>
        </div>
      )}
      <p style={{ margin: '6px 0 0', fontSize: 12 }}>
        {found.length > 0 ? (
          <span className="tag">已检测到：{found.join(' / ')}</span>
        ) : (
          <span className="muted">未检测到 {PAN_KEYS[pan].join(' / ')} —— 保存会被拒绝</span>
        )}
      </p>
      {/* v1.4.1 遗留#1：按键级临时/长期（临时到期**恢复该键旧值**；不选 = 长期写入） */}
      {found.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <p className="muted" style={{ margin: '0 0 6px', fontSize: 12 }}>
            按键级临时/长期：临时键到期会**恢复该键写入前的旧值**（不是清空）；不选 = 长期写入（优先级最高，会清掉该键的临时记录）
            {initial?.tempKeys?.length ? `。当前已挂临时：${initial.tempKeys.map((t) => `${t.key}（剩 ${Math.max(0, Math.round((t.expiresAt - Date.now()) / 60000))}m）`).join('、')}` : ''}
          </p>
          {found.map((k) => {
            const t = keyTemps[k] ?? { temp: false, minutes: ttlDefault };
            return (
              <div className="row" key={k} style={{ gap: 6, marginBottom: 4, alignItems: 'center' }}>
                <code className="mono" style={{ width: 140 }}>{k}</code>
                <select
                  className="input"
                  style={{ width: 96 }}
                  value={t.temp ? 'temp' : 'long'}
                  onChange={(e) => setKeyTemps((p) => ({ ...p, [k]: { ...t, temp: e.target.value === 'temp' } }))}
                >
                  <option value="long">长期</option>
                  <option value="temp">临时</option>
                </select>
                <input
                  className="input mono"
                  style={{ width: 90 }}
                  type="number"
                  min="1"
                  disabled={!t.temp}
                  value={t.minutes}
                  onChange={(e) => setKeyTemps((p) => ({ ...p, [k]: { ...t, minutes: Number(e.target.value) } }))}
                />
                <span className="muted">分钟</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <input className="input mono" style={{ width: 210 }} type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        <span className="muted">过期时间（可空）</span>
      </div>
      {/* v1.3.1：临时写入（Tzz：临时写入算新号，按时清除凭据、审计保留；TTL 可自己写） */}
      <div className="row" style={{ marginTop: 10, alignItems: 'center' }}>
        <label className="row" style={{ fontSize: 13, gap: 6 }}>
          <input type="checkbox" checked={isTemp} onChange={(e) => setIsTemp(e.target.checked)} />
          临时写入（到期自动清除凭据，审计保留）
        </label>
        <input
          className="input mono"
          style={{ width: 90 }}
          type="number"
          min="1"
          max="10080"
          value={ttlMinutes}
          disabled={!isTemp}
          onChange={(e) => setTtlMinutes(Number(e.target.value))}
        />
        <span className="muted">分钟（默认 {ttlDefault}；不同上游过期时间不同，过期前清掉即可）</span>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <input className="input mono grow" type="password" placeholder="二次确认：输入 WebUI 令牌" value={confirmToken} onChange={(e) => setConfirmToken(e.target.value)} />
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        <button className="btn" onClick={() => onDone(false)}>取消</button>
      </div>
    </div>
  );
}

export default function Settings({ toast }) {
  const [tab, setTab] = useState('accounts'); // accounts | policy | misc | logs
  const [accounts, setAccounts] = useState(null);
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null); // null | { id?, ... } | 'new'

  const loadAccounts = async () => {
    const r = await api('/api/web/accounts');
    if (r.ok) setAccounts(r.data);
  };
  const loadSettings = async () => {
    const r = await getSettings();
    if (r.ok) {
      setSettings(r.data);
      if (r.data.log_retention_days != null) setLogDays(r.data.log_retention_days);
    }
  };
  useEffect(() => { loadAccounts(); loadSettings(); }, []);

  const removeAccount = async (a) => {
    if (!window.confirm(`删除账号 ${a.pan}/${a.label || a.userId || a.id}？`)) return;
    // v1.3.1：删除与写入同级高危 —— 服务端要二次确认令牌（秘钥语义，不只是前端拦）
    const confirmToken = window.prompt('删除属高危操作：请输入 WebUI 令牌确认');
    if (!confirmToken) return;
    const r = await api(`/api/web/accounts/${a.id}`, { method: 'DELETE', body: {}, confirmToken: confirmToken.trim() });
    if (r.ok) { toast('账号已删除', 'ok'); loadAccounts(); }
    else toast(r.data?.message ?? '删除失败', 'err');
  };

  /* ---------- 通知 / 高级 ---------- */
  const saveMisc = async (patch) => {
    const r = await postSettings(patch);
    if (r.ok) { toast('已保存', 'ok'); loadSettings(); }
    else toast(r.data?.message ?? '保存失败', 'err');
  };

  /* ---------- 日志（保留天数 + 手动清理） ---------- */
  const [logDays, setLogDays] = useState(30);
  const [purgeBusy, setPurgeBusy] = useState(false);

  const saveLogDays = async () => {
    const r = await postSettings({ log_retention_days: logDays });
    if (r.ok) { toast('保留天数已保存（定时清理重启后生效）', 'ok'); loadSettings(); }
    else toast(r.data?.message ?? '保存失败', 'err');
  };

  const doPurge = async () => {
    if (!Number.isFinite(logDays)) return;
    if (!window.confirm(`手动清理：立即删除 ${logDays} 天之前的全部代理/文件日志（两表）？不可恢复。`)) return;
    setPurgeBusy(true);
    const r = await purgeLogs(logDays);
    setPurgeBusy(false);
    if (r.ok) toast(`日志已手动清理（${logDays} 天之前，立即生效）`, 'ok');
    else toast(r.data?.message ?? '清理失败', 'err');
  };

  // v1.2.2 微调：默认值 30 天导致「手动清理」对近期记录像没生效 —— 加显式「全清两表」
  const doPurgeAll = async () => {
    if (!window.confirm('全清两表（proxy_logs + file_hits 全部记录）？不可恢复。')) return;
    setPurgeBusy(true);
    const r = await purgeLogs(undefined); // days 省略 → 服务端 purgeAllLogs
    setPurgeBusy(false);
    if (r.ok) toast(`日志已全清（proxy_logs ${r.data.deleted?.proxy_logs ?? 0} / file_hits ${r.data.deleted?.file_hits ?? 0} 行）`, 'ok');
    else toast(r.data?.message ?? '清理失败', 'err');
  };

  if (!accounts || !settings) return <p className="muted">加载中…</p>;

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>系统配置</h2>
      <div className="row" style={{ marginBottom: 12 }}>
        {[['accounts', '账号池'], ['policy', '校验策略'], ['misc', '通知 / 高级'], ['logs', '日志']].map(([id, label]) => (
          <button key={id} className={`btn btn-sm ${tab === id ? 'btn-primary' : ''}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === 'accounts' && (
        <div>
          <div className="card">
            <div className="row">
              <h3 style={{ margin: 0 }}>账号 cookie 池</h3>
              <span className="muted">字段与 SPA 弹窗对齐：quark 整串（__pus/__uid/__puus）· uc __pugs</span>
              <button className="btn btn-sm btn-primary" onClick={() => setForm('new')}>+ 添加账号</button>
            </div>
            {form && (
              <div style={{ marginTop: 12 }}>
                <AccountForm
                  initial={form === 'new' ? null : form}
                  ttlDefault={Number(settings.accountTempTtlMinutes ?? 30)}
                  panKeys={PAN_KEYS}
                  onDone={(changed) => { setForm(null); if (changed) loadAccounts(); }}
                  toast={toast}
                />
              </div>
            )}
            <table className="tbl" style={{ marginTop: 12 }}>
              <thead>
                <tr><th>ID</th><th>网盘</th><th>备注</th><th>状态</th><th>账号身份（userId）</th><th>过期</th><th>临时到期</th><th>最近使用</th><th>操作</th></tr>
              </thead>
              <tbody>
                {accounts.accounts.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">#{a.id}</td>
                    <td><span className="tag gray">{a.pan}</span></td>
                    <td>{a.label || <span className="muted">-</span>}</td>
                    <td><span className={`tag ${a.status === 'ok' ? '' : 'red'}`}>{a.status}</span></td>
                    <td className="mono" style={{ fontSize: 12 }}>{a.userId || <span className="muted">-</span>}</td>
                    <td className="mono">{a.expiresAt ? fmtTime(a.expiresAt) : <span className="muted">-</span>}</td>
                    <td className="mono">
                      {a.tempExpiresAt ? fmtTime(a.tempExpiresAt) : <span className="muted">-</span>}
                      {a.tempKeys?.length ? (
                        <div className="muted" style={{ fontSize: 11 }}>
                          按键：{a.tempKeys.map((t) => `${t.key}（剩 ${Math.max(0, Math.round((t.expiresAt - Date.now()) / 60000))}m）`).join('、')}
                        </div>
                      ) : null}
                    </td>                    <td className="mono">{a.lastUsedAt ? fmtTime(a.lastUsedAt) : <span className="muted">-</span>}</td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        <button className="btn btn-sm" onClick={() => setForm({ id: a.id, pan: a.pan, label: a.label, kind: a.kind, expiresAt: a.expiresAt, isTemp: a.isTemp })}>覆盖写入</button>
                        <button className="btn btn-sm btn-danger" onClick={() => removeAccount(a)}>删</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {accounts.accounts.length === 0 && (
                  <tr><td colSpan={9} className="muted">暂无账号 —— 添加后代理会按网盘自动注入登录态 cookie（夸克大文件 23018 解锁）</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h3>各网盘账号数</h3>
            {accounts.counts.length === 0 && <p className="muted" style={{ margin: 0 }}>暂无</p>}
            <div className="row">
              {accounts.counts.map((c) => <span key={c.pan} className="tag">{c.pan} × {c.n}</span>)}
            </div>
          </div>
        </div>
      )}

      {tab === 'policy' && (
        <div className="card">
          <h3>校验策略（proxy.js 单一实现，backend 只读展示）</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            v1.2.2 起白名单 / 限频 / token 校验统一在 functions/api/proxy.js（本地 wrangler 与云端 CF 同一份代码），backend 不再重复维护。
          </p>
          <table className="tbl">
            <tbody>
              <tr><td style={{ width: 160 }}>白名单</td><td className="mono">{settings.policy?.whitelist ?? '-'}</td></tr>
              <tr><td>限频</td><td className="mono">{settings.policy?.rateLimit ?? '-'}</td></tr>
              <tr><td>归属</td><td className="mono">{settings.policy?.owner ?? '-'}</td></tr>
            </tbody>
          </table>
          <p className="muted" style={{ marginBottom: 0 }}>调整白名单 / 限频请编辑 functions/api/proxy.js 后重启 wrangler。</p>
        </div>
      )}

      {tab === 'misc' && (
        <div>
          <div className="card">
            <h3>通知渠道（monitor 插件用，v2）</h3>
            <p className="muted" style={{ marginTop: 0 }}>
              webhook / ntfy / Server酱 / pushplus / 自定义 URL + 浏览器系统通知（Notification API）。v2 与 monitor 插件一起开放。
            </p>
            <label className="row" style={{ fontSize: 13 }}>
              <input type="checkbox" checked={Boolean(settings.notify?.enabled)} onChange={(e) => saveMisc({ notify: { ...(settings.notify ?? {}), enabled: e.target.checked } })} />
              启用通知（当前状态：{settings.notify?.enabled ? '开' : '关'}）
            </label>
            <p className="muted" style={{ marginBottom: 0 }}>已配置 {settings.notify?.webhooks?.length ?? 0} 个 webhook（webhook 明细需直接编辑 data/period/config.json）。</p>
          </div>
          <div className="card">
            <h3>临时凭据 / trace 明细粒度（v1.3.1）</h3>
            <div className="row">
              <span className="muted">临时写入默认 TTL</span>
              <input
                className="input mono"
                style={{ width: 90 }}
                type="number"
                min="1"
                max="10080"
                defaultValue={settings.accountTempTtlMinutes ?? 30}
                onBlur={(e) => saveMisc({ account_temp_ttl_minutes: Number(e.target.value) })}
              />
              <span className="muted">分钟（面板勾选「临时写入」时使用，可单独覆盖）</span>
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <span className="muted">trace 文件明细</span>
              <select
                className="input"
                style={{ width: 140 }}
                value={settings.traceFileDetail ?? 'full'}
                onChange={(e) => saveMisc({ trace_file_detail: e.target.value })}
              >
                <option value="full">full（名称+大小+哈希）</option>
                <option value="safe">safe（只留大小）</option>
                <option value="off">off（不记文件）</option>
              </select>
              <span className="muted">名称+大小+哈希可对上游撞库反查文件 —— 共享/公开部署建议 safe 或 off</span>
            </div>
          </div>
          <div className="card">
            <h3>高级（严格终端穿透）</h3>
            <label className="row" style={{ fontSize: 13 }}>
              <input type="checkbox" checked={Boolean(settings.advanced?.terminalEnabled)} onChange={(e) => saveMisc({ advanced: { ...(settings.advanced ?? {}), terminalEnabled: e.target.checked } })} />
              开启终端穿透（/api/web/terminal/ws，xterm.js 严格 Host + Origin + 令牌校验）
            </label>
            <p className="muted" style={{ marginBottom: 0 }}>默认关。开启后终端页可穿透到本机 shell（风险自担）。</p>
          </div>
        </div>
      )}

      {tab === 'logs' && (
        <div className="card">
          <h3>日志</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            proxy_logs + file_hits 两表。保留天数用于定时清理：<b>重启后生效</b>（backend 启动时执行一次 + 每小时定时）；
            「手动清理」<b>立即生效</b>，不受重启影响（输入天数前的记录；输入 0 = 全清）。
          </p>
          <div className="row">
            <input
              className="input"
              style={{ width: 140 }}
              type="number"
              min="0"
              max="365"
              value={logDays}
              onChange={(e) => setLogDays(Number(e.target.value))}
            />
            <span className="muted">天</span>
            <button className="btn btn-sm btn-primary" onClick={saveLogDays}>保存保留天数</button>
            <button className="btn btn-sm btn-danger" onClick={doPurge} disabled={purgeBusy || !Number.isFinite(logDays)}>
              {purgeBusy ? '清理中…' : '手动清理日志'}
            </button>
            <button className="btn btn-sm btn-danger" onClick={doPurgeAll} disabled={purgeBusy}>
              {purgeBusy ? '清理中…' : '全清两表'}
            </button>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>手动清理 = 立即删除输入天数之前的数据（输入 0 = 全清）；「全清两表」不读输入框，立即清空全部代理/文件日志。</p>
        </div>
      )}
    </div>
  );
}
