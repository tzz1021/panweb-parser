/**
 * 分享链接输入区（docs/STRUCTURE.md：src/components/LinkInput.tsx）
 *
 * 输入 + 自动识别网盘 + 历史下拉 + 提取码提取：
 * - 支持粘贴"整段分享文案"：自动提取 URL 与提取码（pdpb.cn 同款）
 * - detect 命中 → 回调高亮网盘种类；未命中 → "识别失败，请检查格式是否正确"
 */
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { PanAdapter } from '../adapters/types';
import { detectShareUrl } from '../adapters/registry';
import { listLinks } from '../core/footprint/links';
import { useToast } from './Toast';

/** 从分享文案中提取 URL 与提取码（两者都可缺） */
export function extractShare(text: string): { url: string; passcode?: string } {
  const urlMatch = text.match(/https?:\/\/[^\s"'<>，。；、]+/);
  const url = urlMatch ? urlMatch[0] : text.trim();
  const pc =
    // v1.4：链接里的 pwd=xxx（迅雷/夸克等都通用）优先于文案里的「提取码：」
    url.match(/[?&]pwd=([A-Za-z0-9]{4,8})/i)?.[1] ??
    text.match(/提取码[：:]\s*([A-Za-z0-9]{4,8})/)?.[1] ??
    text.match(/密码[：:]\s*([A-Za-z0-9]{4,8})/)?.[1];
  return { url, passcode: pc };
}

/**
 * 把提取码写回 URL（两框简易同步用）：有 `pwd=` 就替换，无则追加；空码则删掉该参数。
 * 不改变其它参数顺序与编码。
 */
export function withPasscodeInUrl(url: string, passcode: string): string {
  const raw = (url ?? '').trim();
  if (!raw) return raw;
  const code = (passcode ?? '').trim();
  const hasPwd = /[?&]pwd=/i.test(raw);
  if (!code) {
    return hasPwd ? raw.replace(/([?&])pwd=[^&#]*/i, '$1').replace(/[?&]$/, '').replace(/\?&/, '?') : raw;
  }
  if (hasPwd) return raw.replace(/([?&])pwd=[^&#]*/i, `$1pwd=${code}`);
  return raw.includes('?') ? `${raw}&pwd=${code}` : `${raw}?pwd=${code}`;
}

export interface LinkInputProps {
  /** URL 变化回调（含识别结果；detect 失败时 adapter 为 null） */
  onDetect: (adapter: PanAdapter | null, url: string) => void;
  /** 提取码变化回调（粘贴文案自动提取时触发） */
  onPasscode?: (passcode: string) => void;
  /** 主按钮点击（二次校验 + 解析由父级负责） */
  onFetchFiles: () => void;
  /** 次按钮点击（连接本地下载器） */
  onOpenDownloader: () => void;
  /** 解析中（禁用输入与按钮） */
  busy: boolean;
  /** 识别失败提示（父级决定文案，默认 "识别失败，请检查格式是否正确"） */
  detectFailText?: string;
  /** 外部预填链接（1.0.1 历史页"重新解析"；变化时触发一次） */
  initialValue?: string;
  /**
   * v1.4 手动选择网盘（首页 pan-chips 点击）：非空时识别提示改为「已选择：<name>」，
   * 输入框接受口令文字（如迅雷口令），placeholder 同步切换。
   */
  manualPanName?: string | null;
}

export function LinkInput({
  onDetect,
  onPasscode,
  onFetchFiles,
  onOpenDownloader,
  busy,
  detectFailText = '识别失败，请检查格式是否正确',
  initialValue,
  manualPanName,
}: LinkInputProps): JSX.Element {
  const [url, setUrl] = useState('');
  const [passcode, setPasscode] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [detectMsg, setDetectMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { toast } = useToast();
  const prevUrl = useRef('');
  const appliedInitial = useRef<string | null>(null);

  // 外部预填（历史页"重新解析"）：值变化时填充并触发一次识别
  useEffect(() => {
    if (initialValue && initialValue !== appliedInitial.current) {
      appliedInitial.current = initialValue;
      setUrl(initialValue);
      prevUrl.current = initialValue;
      const adapter = detectShareUrl(initialValue);
      if (adapter) {
        setDetectMsg({ ok: true, text: `已识别：${adapter.name}` });
        onDetect(adapter, initialValue);
      } else {
        setDetectMsg({ ok: false, text: detectFailText });
        onDetect(null, initialValue);
      }
    }
  }, [initialValue, onDetect, detectFailText]);

  // 加载历史（足迹：已填链接）
  useEffect(() => {
    void listLinks(100).then((links) => setHistory(links.map((l) => l.url)));
  }, []);

  /** 输入/粘贴统一处理：提取 → 识别 → 高亮（v1.4：URL 里的 pwd 同步到右侧提取码框） */
  const handleChange = (raw: string): void => {
    const { url: extracted, passcode: pc } = extractShare(raw);
    setUrl(extracted);
    // v1.4 两框同步：URL 带 pwd 时以 URL 为准（空码不覆盖手填值）；文案里的「提取码：」仅在未填时补
    if (pc && pc !== passcode) {
      setPasscode(pc);
      onPasscode?.(pc);
    }
    if (extracted === prevUrl.current) return;
    prevUrl.current = extracted;
    if (!extracted) {
      setDetectMsg(null);
      onDetect(null, '');
      return;
    }
    const adapter = detectShareUrl(extracted);
    if (adapter) {
      setDetectMsg({ ok: true, text: `已识别：${adapter.name}` });
      onDetect(adapter, extracted);
    } else {
      setDetectMsg({ ok: false, text: detectFailText });
      onDetect(null, extracted);
    }
  };

  /** v1.4 两框同步：改提取码 → 写回左侧 URL 的 pwd= 参数（所有驱动通用；字段始终保留） */
  const handlePasscodeChange = (value: string): void => {
    setPasscode(value);
    onPasscode?.(value);
    const next = withPasscodeInUrl(url, value);
    if (next !== url) {
      setUrl(next);
      prevUrl.current = next;
      onDetect(detectShareUrl(next) ?? null, next);
    }
  };

  const submit = (): void => {
    if (!url.trim()) {
      toast('请先粘贴分享链接', 'error');
      return;
    }
    onFetchFiles();
  };

  return (
    <div className="card">
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="input-row">
          <input
            className="input"
            list="panhub-history"
            placeholder={manualPanName ? '输入口令文字（如：张三丰资源），或直接粘贴分享链接' : '粘贴后自动识别驱动种类，支持长短两种链接'}
            value={url}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            disabled={busy}
            autoFocus
          />
          <datalist id="panhub-history">
            {history.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
          <input
            className="input input-passcode"
            placeholder="提取码（可选；与链接里的 pwd= 双向同步）"
            value={passcode}
            onChange={(e) => handlePasscodeChange(e.target.value)}
            disabled={busy}
          />
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? '解析中…' : '获取文件列表'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onOpenDownloader} disabled={busy}>
            连接本地下载器
          </button>
        </div>
        <div className="detect-hint">
          {manualPanName ? (
            <>
              <span className="ok">✓</span>
              已选择：{manualPanName}（输入口令文字或粘贴该网盘链接）
            </>
          ) : detectMsg ? (
            <>
              <span className={detectMsg.ok ? 'ok' : 'bad'}>{detectMsg.ok ? '✓' : '✗'}</span>
              {detectMsg.text}
            </>
          ) : (
            <span>粘贴链接后自动识别网盘种类</span>
          )}
        </div>
      </div>
    </div>
  );
}
