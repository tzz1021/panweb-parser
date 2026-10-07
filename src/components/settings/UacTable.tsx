/**
 * UAC 偏好表（docs/STRUCTURE.md：src/components/settings/UacTable.tsx）
 *
 * 上半：10 盘 × {转存/登录/限速} 只读数据（来自已注册适配器的 limits，UC 有值，其余适配中）
 * 下半：全局弹窗开关（HANDOFF 附件 UAC 表底部行），开关样式：开启内部绿色/关闭灰色/按键白色，
 *       相邻开关边框不重色（.switch-row 分隔线实现）。
 */
import type { JSX } from 'react';
import { useState } from 'react';
import { getAdapterById, getAdapters } from '../../adapters/registry';
import type { PanLimits } from '../../adapters/types';
import { PAN_LIST } from '../PanTable';
import type { ModalPrefs, TransportPrefs } from '../../core/types';
import { useToast } from '../Toast';
import { getActiveTransport, setActiveTransport, transportFromPrefs } from '../../core/transport/types';
import { ProxyTransport } from '../../core/transport/types';
import { listAllRecords } from '../../core/footprint/records';
import { extractShare } from '../LinkInput';
import { mergeUacLimits, UAC_EXTRA_LIMITS, UAC_ROWS } from './uacData';

/** 开关 */
export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }): JSX.Element {
  return (
    <button
      type="button"
      className={`switch ${on ? 'switch--on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    />
  );
}

export interface UacTableProps {
  modals: ModalPrefs;
  onModalsChange: (patch: Partial<ModalPrefs>) => void;
  transport: TransportPrefs;
  onTransportChange: (patch: Partial<TransportPrefs>) => void;
}

export function UacTable({ modals, onModalsChange, transport, onTransportChange }: UacTableProps): JSX.Element {
  // 只取已注册适配器的 limits（v1 只有 UC）；v1.3.2 起叠加未适配网盘的补充数据（uacData.ts）
  const limitsById = new Map<string, Partial<PanLimits>>();
  for (const a of getAdapters()) {
    limitsById.set(a.id, mergeUacLimits(a.limits, UAC_EXTRA_LIMITS[a.id]) ?? a.limits);
  }
  /** 某盘的 UAC 数据：适配器 limits + 补充数据（未适配网盘只有补充数据） */
  const limitsOf = (panId: string): Partial<PanLimits> | undefined =>
    limitsById.get(panId) ?? UAC_EXTRA_LIMITS[panId];
  /** v1.3.2：UAC 表两形态（收起 = 精简表 6 行；展开 = 详细表 13 行）。
   *  纯前端状态：两份数据都在包里，切换不触发任何请求（只为看表就不该联网）。 */
  const [uacExpanded, setUacExpanded] = useState(false);
  const uacRows = uacExpanded ? UAC_ROWS : UAC_ROWS.filter((r) => r.brief);
  const { toast } = useToast();
  const [proxyDraft, setProxyDraft] = useState(transport.proxyUrl);
  const [tokenDraft, setTokenDraft] = useState(transport.proxyToken);
  const [testing, setTesting] = useState(false);

  const modalRows: Array<{ key: keyof ModalPrefs; label: string; sub?: string }> = [
    { key: 'cookieWarn', label: '读取 Cookie 警告弹窗' },
    { key: 'loginJump', label: '需要登录但未登录/过期 → 跳转提示弹窗' },
    // v1.1.7：自动关闭标签页设置选项移除（原有功能代码不动），日后单独做 node 转发代理
    { key: 'corsAutoJump', label: 'CORS 拦截后自动跳转', sub: '备用形式：跳分享页供书签解析，退出本站自动清理；默认关=先弹窗' },
    { key: 'exportFailWarn', label: '导出任务失败警告弹窗', sub: '未选中有效文件时弹出；关闭后以 toast 提示' },
    { key: 'parseFailWarn', label: '单文件解析失败警告弹窗', sub: '解析失败提示刷新资源列表；关闭后以 toast 提示' },
    { key: 'jumpTip', label: '跳转到文件夹是否提示', sub: '对于风控造成的0B文件夹支持二次获取资源目录，此时会新建一个相关联的链接任务' },
    { key: 'exportYellowWarn', label: 'export 包含黄色标记是否弹窗提示', sub: '打开显示弹窗关闭显示简略 toast' },
    { key: 'cookieInput', label: '登录态 Cookie 填写弹窗', sub: '夸克大文件强制登录时弹出填写/导入 __pus/__uid（v1.1.9）' },
  ];

  return (
    <div className="settings-section">
      <div
        className="settings-section-title"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
      >
        <span>UAC 选项</span>
        {/* v1.3.2：两形态切换小按钮（右侧）；行定义见 settings/uacData.ts，切换不发请求 */}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setUacExpanded((v) => !v)}
          title={
            uacExpanded
              ? '收起为精简表（6 行）'
              : '展开详细表（13 行：凭据有效期/续期方案/scan·restore·download 策略）'
          }
        >
          {uacExpanded ? '收起' : '展开'}
        </button>
      </div>
      <div className="table-wrap">
        <table className="uac-table">
          <thead>
            <tr>
              <th>网盘</th>
              {PAN_LIST.map((p) => (
                <th key={p.id}>{p.short}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* v1.3.2：行集合由 uacData.UAC_ROWS 提供（收起 6 行 / 展开 13 行），
                单元格值 = 适配器 limits（已适配）+ UAC_EXTRA_LIMITS（未适配），缺省 — */}
            {uacRows.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                {PAN_LIST.map((p) => (
                  <td key={p.id}>{row.cell(limitsOf(p.id))}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="settings-section-title" style={{ marginTop: 10 }}>
        弹窗开关
      </div>
      {modalRows.map((r) => (
        <div className="switch-row" key={r.key}>
          <div>
            <div className="switch-label">{r.label}</div>
            {r.sub && <div className="switch-sub">{r.sub}</div>}
          </div>
          <Switch on={modals[r.key]} onChange={(v) => onModalsChange({ [r.key]: v })} label={r.label} />
        </div>
      ))}

      {/* API 转发代理（1.1）：CORS 拦截后自动跳转下方 */}
      <div className="settings-section-title" style={{ marginTop: 10 }}>
        API 转发代理（绕过 CORS）
      </div>
      <div className="switch-row">
        <div style={{ flex: 1 }}>
          <div className="switch-label">解析通道</div>
          <div className="switch-sub">direct=浏览器直连（CORS 受限）；proxy=走你填的代理</div>
        </div>
        <select
          className="input"
          style={{ width: 110, padding: '6px 10px' }}
          value={transport.mode}
          onChange={(e) => {
            const mode = e.target.value as TransportPrefs['mode'];
            onTransportChange({ mode });
            setActiveTransport(transportFromPrefs({ ...transport, mode }));
            toast(mode === 'proxy' ? '已切换代理通道（请填写并测试地址）' : '已切换直连通道', 'info');
          }}
        >
          <option value="direct">direct 直连</option>
          <option value="proxy">proxy 代理</option>
        </select>
      </div>
      <div className="switch-row">
        <div style={{ flex: 1 }}>
          <div className="switch-label">代理地址</div>
          <div className="switch-sub">最好是自己的哦，测试按钮使用最新的一次链接，请确保分享有效</div>
          <input
            className="input"
            style={{ width: '100%', marginTop: 6, padding: '6px 10px', boxSizing: 'border-box' }}
            value={proxyDraft}
            placeholder="https://xxx.pages.dev"
            onChange={(e) => setProxyDraft(e.target.value)}
          />
          <input
            className="input"
            style={{ width: '100%', marginTop: 6, padding: '6px 10px', boxSizing: 'border-box' }}
            value={tokenDraft}
            placeholder="代理令牌（部署时设置的 PROXY_TOKEN，代理未设可留空）"
            onChange={(e) => setTokenDraft(e.target.value)}
          />
          <div className="switch-row" style={{ marginTop: 8 }}>
            <div style={{ flex: 1 }}>
              <div className="switch-label">IP 采集（哈希化后上传）</div>
              <div className="switch-sub">已加密后上传到 proxy，这是企业内辅助判断滥用行为的，日用不需要开</div>
            </div>
            <Switch
              on={Boolean(transport.ipHashUpload)}
              onChange={(v) => onTransportChange({ ipHashUpload: v })}
              label="IP 采集（哈希化后上传）"
            />
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={testing}
          onClick={() => {
            void (async () => {
              const url = proxyDraft.trim().replace(/\/+$/, '');
              if (!url) {
                toast('请先填写代理地址', 'error');
                return;
              }
              // 真实链路测试：取历史最近一次解析记录（含失败），经代理走 token 接口（首环即全链路）
              // 注意：失败解析只写 ParseRecord（records store），不写 LinkRecord（links store），故不能用 listLinks
              const records = await listAllRecords(1).catch(() => []);
              const rec = records[0];
              if (!rec) {
                toast('历史记录为空，请先解析一条链接再来测试', 'error');
                return;
              }
              const adapter = getAdapterById(rec.adapterId);
              const shareId = rec.shareId || adapter?.parseShareId(rec.url);
              if (!adapter || !shareId) {
                toast('历史链接已无法识别，请重新解析', 'error');
                return;
              }
              setTesting(true);
              const prev = getActiveTransport();
              setActiveTransport(new ProxyTransport(url, tokenDraft.trim()));
              try {
                // v1.4 fix：测试也要带提取码（从历史链接里取 pwd=xxx），否则需要码的分享会空发
                const pc = extractShare(rec.url).passcode ?? '';
                await adapter.getToken({ shareId, passcode: pc });
                toast('代理连通，最新分享链接解析成功 ✅', 'success');
              } catch (err) {
                toast(`测试失败：${err instanceof Error ? err.message : String(err)}`, 'error');
              } finally {
                setActiveTransport(prev);
                setTesting(false);
              }
            })();
          }}
        >
          {testing ? '测试中…' : '测试'}
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => {
            const url = proxyDraft.trim().replace(/\/+$/, '');
            const token = tokenDraft.trim();
            onTransportChange({ proxyUrl: url, proxyToken: token, mode: url ? 'proxy' : transport.mode });
            setActiveTransport(transportFromPrefs({ ...transport, proxyUrl: url, proxyToken: token, mode: url ? 'proxy' : transport.mode }));
            toast(url ? '代理地址已保存并启用' : '已清空代理地址（回退直连）', 'success');
          }}
        >
          保存
        </button>
      </div>
      {/* v1.2.2：IP 采集开关（默认关；开时 ProxyTransport 带 x-panhub-trace: ip-hash，代理端 sha256 哈希化后落库） */}
      <div className="switch-row" style={{ marginTop: 10 }}>
        <div style={{ flex: 1 }}>
          <div className="switch-label">IP 采集（哈希化后上传）</div>
          <div className="switch-sub">已加密后上传到 proxy，这是企业内辅助判断滥用行为的，日用不需要开</div>
        </div>
        <Switch
          on={Boolean(transport.ipHashUpload)}
          onChange={(v) => {
            onTransportChange({ ipHashUpload: v });
            setActiveTransport(transportFromPrefs({ ...transport, ipHashUpload: v }));
          }}
        />
      </div>
    </div>
  );
}
