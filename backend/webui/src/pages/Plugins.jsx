/**
 * 凭据刷新预设（v1.3.1 P4）
 *
 * Tzz 定稿：**自动执行全部改手动预设** —— 就那几个常用操作，由人在这里点；
 * 不做定时自动刷新、不做宏录制。每个预设自带限频（默认 5 分钟一次），同时只允许跑一个。
 *
 * 隐私：面板只看得到「是否在跑 / 上次结果 / 账号身份（userId）」——
 * **凭据本体与任何指纹都不回面板**（读取 → 加密落账号池 → 立即丢弃）。
 * 触发前要二次输入 WebUI 令牌（写入账号池属高危操作）。
 */
import { useEffect, useState } from 'preact/hooks';
import { api, getSettings, postSettings } from '../api.js';

function fmtTs(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function Plugins({ toast }) {
  const [data, setData] = useState(null);
  const [busyId, setBusyId] = useState(null);
  // v1.4：迅雷凭据（CDP 一条龙）——状态 + 抓取/刷新
  const [xl, setXl] = useState(null);
  const [xlBusy, setXlBusy] = useState(false);
  // v1.4.1：CDP 端口（可手动输入）+ port↔账号绑定列表
  const [xlPort, setXlPort] = useState(9222);
  const [bindings, setBindings] = useState([]);
  // v1.4.1：CDP 只能抓 authorization，其余特别参数得手动录（不能每次 cli 敲）
  const [manual, setManual] = useState({ to_parent_id: '', user_id: '', captcha_sign: '', captcha_timestamp: '', device_id: '' });
  const [manualBusy, setManualBusy] = useState(false);

  const load = async () => {
    const r = await api('/api/web/plugins');
    if (r.ok) setData(r.data);
    const sx = await api('/api/xunlei/credential/status');
    if (sx.ok) {
      setXl(sx.data?.status ?? null);
      setBindings(sx.data?.portBindings ?? []);
    }
  };
  useEffect(() => {
    load();
  }, []);

  /** v1.4.1：手动写入特别参数/ captcha 身份（**长期**写入；只提交填写的键，不覆盖空值） */
  const saveManual = async () => {
    const patch = {};
    for (const [k, v] of Object.entries(manual)) {
      if (String(v ?? '').trim()) patch[k] = String(v).trim();
    }
    if (Object.keys(patch).length === 0) {
      toast('没有要保存的项（留空表示不改）', 'err');
      return;
    }
    setManualBusy(true);
    const r = await postSettings({ xunlei: patch });
    setManualBusy(false);
    toast(r.ok ? `已保存：${Object.keys(patch).join(' / ')}` : (r.data?.message ?? '保存失败'), r.ok ? 'ok' : 'err');
    if (r.ok) setManual({ to_parent_id: '', user_id: '', captcha_sign: '', captcha_timestamp: '', device_id: '' });
    load();
  };

  /** v1.4 迅雷：用 CDP 从已登录浏览器抓 authorization 并落库（幂等 = 刷新） */
  const captureXunlei = async () => {
    const confirmToken = window.prompt('抓取迅雷凭据会写账号池/设置：请输入 WebUI 令牌确认');
    if (!confirmToken) return;
    setXlBusy(true);
    const r = await api('/api/xunlei/credential/cdp', { method: 'POST', body: { port: Number(xlPort) || 9222 }, confirmToken: confirmToken.trim() });
    setXlBusy(false);
    const msg = r.ok
      ? `已获取迅雷凭据${r.data?.userId ? `（userId ${r.data.userId}）` : ''}${r.data?.hasCaptchaSign ? ' · 含 captcha 身份' : ''}${r.data?.note ? ` · ${r.data.note}` : ''}`
      : (r.data?.message ?? '抓取失败');
    toast(msg, r.ok ? 'ok' : 'err');
    load();
  };

  const run = async (preset) => {
    const confirmToken = window.prompt(`运行「${preset.title}」会写账号池：请输入 WebUI 令牌确认`);
    if (!confirmToken) return;
    setBusyId(preset.id);
    const r = await api(`/api/web/plugins/${encodeURIComponent(preset.id)}/run`, {
      method: 'POST',
      body: {},
      confirmToken: confirmToken.trim(),
    });
    setBusyId(null);
    toast(r.data?.message ?? (r.ok ? '已刷新' : '运行失败'), r.ok ? 'ok' : 'err');
    load();
  };

  if (!data) return <p className="muted">加载中…</p>;
  const browserOk = Boolean(data.browser?.ok);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>凭据刷新（手动预设）</h2>
      <p className="muted" style={{ marginTop: -6 }}>
        真实浏览器：打开上游页面 → 等页面下发新凭据 → 写回账号池。
      </p>

      <div className="card">
        <div className="row">
          <h3 style={{ margin: 0 }}>浏览器 health</h3>
          <span className={`tag ${browserOk ? '' : 'red'}`}>{browserOk ? '已连接' : '未连接'}</span>
          <span className="muted mono">127.0.0.1:{data.browser?.port}</span>
          {browserOk ? <span className="muted">{data.browser.browser}</span> : <span className="muted">{data.browser?.reason}</span>}
        </div>
        {!browserOk && (
          <p className="muted" style={{ margin: '8px 0 0' }}>
        不建议使用无头服务器，可能因为图形节流渲染不出现二维码。正式版后端将会识别通过插件连接的浏览器实现去中心化，从而物理隔离帐号环境与转发环境
          </p>
        )}
      </div>

      {data.plugins.map((p) => (
        <div className="card" key={p.id}>
          <div className="row">
            <h3 style={{ margin: 0 }}>{p.title}</h3>
            <span className="tag gray">{p.pan}</span>
            <span className={`tag ${p.state === 'ok' ? '' : p.state === 'error' ? 'red' : 'gray'}`}>{p.state}</span>
            {p.lastIdentity && <span className="muted mono">身份 {p.lastIdentity}</span>}
          </div>
          <p className="dim" style={{ margin: '8px 0 0' }}>{p.desc}</p>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            上次运行：{fmtTs(p.lastRunAt)} · 限频 {Math.round(p.minIntervalMs / 1000)}s
            {p.nextAllowedAt ? ` · 下次可运行 ${fmtTs(p.nextAllowedAt)}` : ''}
          </p>
          {p.lastMessage && <p className="muted" style={{ margin: '4px 0 0' }}>{p.lastMessage}</p>}
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => run(p)}
              disabled={busyId === p.id || p.running || Boolean(p.nextAllowedAt)}
            >
              {busyId === p.id || p.running ? '运行中…' : p.nextAllowedAt ? '限频中' : '手动运行'}
            </button>
            <span className="muted">写入账号池需要二次输入 WebUI 令牌</span>
          </div>
        </div>
      ))}

      {/* v1.4 迅雷凭据：面板一条龙（CDP 抓 authorization → 账号池 + 设置；面板只看脱敏状态） */}
      <div className="card">
        <div className="row">
          <h3 style={{ margin: 0 }}>迅雷凭据</h3>
          <span className="tag gray">xunlei</span>
          <span className={`tag ${xl?.authorizationSet ? (xl?.valid === false ? 'red' : '') : 'red'}`}>
            {xl?.authorizationSet ? (xl?.valid === false ? '已过期' : '已配置') : '未配置'}
          </span>
          {xl?.userId && <span className="muted mono">userId {xl.userId}</span>}
          {xl?.hasCaptchaSign && <span className="tag">captcha 身份</span>}
        </div>
        <p className="muted" style={{ margin: '8px 0 0' }}>
        先在指定浏览器登录 pan.xunlei.com点击后打开该页面 → 读页面localstorage存储的authorization。
        你需要手动填写chaptcha，to_parent_id，不读cookie。
        </p>
        <p className="muted" style={{ margin: '6px 0 0' }}>
          上次刷新：{fmtTs(xl?.lastRefreshedAt)}
          {xl?.expiresAt ? ` · 凭据到期 ${fmtTs(xl.expiresAt)}` : ''}
          {xl?.toParentId ? ` · 转存目录 ${xl.toParentId}` : ' · 未设转存目录（to_parent_id）'}
          {xl?.deviceId ? ` · device ${String(xl.deviceId).slice(0, 8)}…` : ''}
        </p>
        <div className="row" style={{ marginTop: 10 }}>
          <input
            className="input mono"
            style={{ width: 110 }}
            type="number"
            value={xlPort}
            onChange={(e) => setXlPort(Number(e.target.value))}
            title="浏览器 port"
          />
          <button className="btn btn-sm btn-primary" onClick={captureXunlei} disabled={xlBusy || Boolean(xl?.nextAllowedAt)}>
            {xlBusy ? '抓取中…' : xl?.nextAllowedAt ? '限频中' : xl?.authorizationSet ? '[CDP]刷新' : '[CDP]获取'}
          </button>
          <span className="muted">
            写入账号池需二次输入 WebUI 令牌；限频 {Math.round((xl?.minIntervalMs ?? 300000) / 1000)}s
            {xl?.nextAllowedAt ? `（下次可运行 ${fmtTs(xl.nextAllowedAt)}）` : ''}
          </span>
        </div>
        {bindings.length > 0 && (
          <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
            浏览器绑定：
            {bindings.map((b) => `port ${b.port} → #${b.accountId ?? '-'}${b.userId ? `（${b.userId}）` : ''}${b.note ? ` · ${b.note}` : ''}`).join('　｜　')}
          </p>
        )}
        <div style={{ marginTop: 12, borderTop: '1px solid var(--border, #e5e7eb)', paddingTop: 10 }}>
          <p className="muted" style={{ margin: '0 0 6px' }}>
            特别参数 / captcha 身份（这些需手动录入；长期写入，留空=不改）
            {xl?.captchaSignSet === false || xl?.hasCaptchaSign === false ? '：当前 captcha_sign 未配置' : ''}
          </p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <input className="input mono" style={{ width: 240 }} placeholder={`to_parent_id（转存目标目录 fid）${xl?.toParentId ? ' · 已配置' : ''}`} value={manual.to_parent_id} onChange={(e) => setManual((p) => ({ ...p, to_parent_id: e.target.value }))} />
            <input className="input mono" style={{ width: 160 }} placeholder={`user_id${xl?.userId ? ` · 当前 ${xl.userId}` : ''}`} value={manual.user_id} onChange={(e) => setManual((p) => ({ ...p, user_id: e.target.value }))} />
            <input className="input mono" style={{ width: 260 }} placeholder={`captcha_sign${xl?.hasCaptchaSign ? ' · 已配置' : ' · 未配置'}`} value={manual.captcha_sign} onChange={(e) => setManual((p) => ({ ...p, captcha_sign: e.target.value }))} />
            <input className="input mono" style={{ width: 200 }} placeholder="captcha_timestamp（与 sign 配套）" value={manual.captcha_timestamp} onChange={(e) => setManual((p) => ({ ...p, captcha_timestamp: e.target.value }))} />
            <input className="input mono" style={{ width: 240 }} placeholder={`device_id${xl?.deviceId ? ` · 当前 ${String(xl.deviceId).slice(0, 8)}…` : ''}`} value={manual.device_id} onChange={(e) => setManual((p) => ({ ...p, device_id: e.target.value }))} />
            <button className="btn btn-sm btn-primary" onClick={saveManual} disabled={manualBusy}>{manualBusy ? '保存中…' : '保存特别参数'}</button>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>插件加载器</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          第三方压缩包插件（package.json  + install.sh）与 webui 配置注入后续开放；
          当前凭据刷新预设走同一份运行/限频/审计基础设施。
        </p>
      </div>
    </div>
  );
}
