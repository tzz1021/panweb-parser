/**
 * 登录态凭据填写/导入弹窗（docs/STRUCTURE.md：src/components/CookieInputModal.tsx）
 *
 * v1.1.9：夸克 >50MB 大文件强制登录（23018 size limit）时弹出，
 * 让用户**手动填写/导入**登录态 cookie（整串），随 download API 请求发送。
 * v1.2.x alipan 泛化：同一弹窗也服务 alipan 的「登录态凭据串」
 * （auth=Bearer xxx;to_parent_file_id=…，非浏览器 cookie）——
 * 检测/拼串改由 cookieInput.keys 驱动；browserCookie:false 时隐藏插件/导入行，
 * intro/wholeStringPlaceholder 允许按网盘定制文案。
 * 与 CookieWarnModal 的区别：那是展示自动捕获的游客态凭据；这是填登录态凭据。
 *
 * 内容（按 Tzz 弹窗规范）：
 * - 供应商名 + 说明行 + 整串输入框（如实展示）
 * - 懒人导入：选择文件（Netscape）/ 粘贴文本自动识别（Netscape / JSON / Header string）
 * - 红色圆点：登录态风险提示（公用代理自担账号安全）
 * - 插件推荐：get cookies.txt locally（chrome/edge/safari）+ 本机插件模式 / 自建代理
 * - 自建代理不显示时排查话术（账号状态 + 代理面板登录态）
 */
import { useRef, useState } from 'react';
import type { JSX } from 'react';
import type { CookieInputRequirement } from '../adapters/types';
import { getLastProxyAccountLabel } from '../core/transport/types';
import { parseCookieText } from '../adapters/quark/cookies';

/** 整串里检测哪些声明键已出现（键值按 `k=` 段定位；值内 ';' 不影响存在性判断）。
 * v1.3：适配器提供 probeKeys 时以它为准（能认裸 `Bearer xxx` 形态，见 alipan/auth.ts）。 */
function detectedKeys(
  text: string,
  keys: Array<{ key: string; label: string }>,
  probe?: (text: string) => string[],
): string[] {
  if (probe) {
    try {
      return probe(text);
    } catch {
      // 适配器检测失败回退内置实现，不影响填写
    }
  }
  const esc = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return keys.map((k) => k.key).filter((k) => new RegExp(`(?:^|;)\\s*${esc(k)}=`).test(text));
}

/** 解析出的 k/v 映射 → 整串（k=v; k2=v2；v2 含 ';' 也原样保留） */
function kvString(map: Record<string, string>): string {
  return Object.entries(map)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

export interface CookieInputModalProps {
  /** 网盘名称（如 "夸克网盘"） */
  panName: string;
  /** 登录态 cookie 输入规格（adapter.cookieInput） */
  cookieInput: CookieInputRequirement;
  /** 已保存的整串 cookie（wholeString 模式）或 key→value 映射（多键模式） */
  value: string | Record<string, string>;
  /** 保存：wholeString 模式给整串；多键模式给映射 */
  onSave: (value: string | Record<string, string>) => void;
  onCancel: () => void;
  /**
   * v1.3 滚动更新：新凭据与缓存账号的**离线**比对（adapter.carryOver.checkNewAuth，不请求接口）。
   * 'same' = 同账号（绿字）/ 'other' = 换号（红字）/ null = 无缓存或无法判定（不显示）。
   */
  carryCheck?: (authString: string) => 'same' | 'other' | null;
  /** v1.3 滚动更新定制话术（adapter.carryOver.messages；缺省 = 不显示提示） */
  carryMessages?: { sameUserHint: string; otherUserHint: string };
  /**
   * v1.3.1 凭据快捷更新：离线规划（adapter.carryOver.planCredentialSave）——
   * 只用于「必填项检查」：missing 非空时小字提示 + 保存按钮置灰（不写入、不惊动 functions）。
   */
  planSave?: (authString: string) => { merged: string; missing: string[] };
  /** v1.3.1：必填项缺失提示前缀（adapter.carryOver.missingHintPrefix，如「缺少必填项：」） */
  missingHintPrefix?: string;
}

/** 插件商店链接（get cookies.txt LOCALLY，社区常用导出插件） */
const PLUGIN_LINKS: Array<{ label: string; href: string; note?: string }> = [
  {
    label: 'chrome',
    href: 'https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc',
  },
  {
    label: 'edge',
    href: 'https://microsoftedge.microsoft.com/addons/search/get%20cookiestxt%20locally',
  },
  {
    label: 'safari',
    href: 'https://github.com/kairi003/Get-cookies.txt-LOCALLY',
    note: '（Safari 无商店版，用 GitHub 版或手动复制）',
  },
];

/** 红色圆点行（登录态风险 / 自建代理排查） */
function RedDot({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--text)' }}>
      <span style={{ color: '#dc3545' }}>●</span> {children}
    </p>
  );
}

export function CookieInputModal({
  panName,
  cookieInput,
  value,
  onSave,
  onCancel,
  carryCheck,
  carryMessages,
  planSave,
  missingHintPrefix,
}: CookieInputModalProps): JSX.Element {
  const wholeString = Boolean(cookieInput.wholeString);
  const initialStr = typeof value === 'string' ? value : '';
  const [fieldStr, setFieldStr] = useState(initialStr);
  const [fields, setFields] = useState<Record<string, string>>(() =>
    typeof value === 'string' ? {} : { ...value },
  );
  const [pasteText, setPasteText] = useState('');
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /**
   * v1.3.1 必填项检查（离线，不请求接口）：planSave 给出 missing 时，
   * 小字改为「缺少必填项：xx」且底部「保存并重试」置灰（Tzz A2 定稿）。
   */
  const missingFields = (text: string): string[] => {
    if (!planSave) return [];
    try {
      return planSave(text).missing ?? [];
    } catch {
      return [];
    }
  };

  /**
   * 行内滚动更新提示（v1.3，右侧嵌入，不新开弹窗）：随输入实时**离线**判定新凭据与缓存账号
   * 是否同一账号 —— 绿 = 同账号（续杯可用）；红 = 换号（缓存 file_id 属旧账号，需重新转存）。
   * 文案全部来自 carryMessages（适配器常量）；无缓存/解不出身份（null）时不显示。
   */
  const renderCarryHint = (text: string): JSX.Element | null => {
    if (!carryCheck || !carryMessages) return null;
    const t = text.trim();
    if (!t) return null;
    let verdict: 'same' | 'other' | null = null;
    try {
      verdict = carryCheck(t);
    } catch {
      return null; // 判定失败不影响填写/保存
    }
    if (!verdict) return null;
    return (
      <span
        style={{
          marginLeft: 'auto',
          fontSize: 12.5,
          fontWeight: 600,
          whiteSpace: 'nowrap',
          color: verdict === 'same' ? 'var(--primary)' : 'var(--danger)',
        }}
      >
        {verdict === 'same' ? carryMessages.sameUserHint : carryMessages.otherUserHint}
      </span>
    );
  };
  // v1.2.2：最近一次代理响应回传的代理托管账号（x-panhub-account，仅 label 不含 cookie 明文）；
  // 弹窗在失败请求之后挂载，此刻拿到的即最近一次响应的值。
  const proxyAccount = getLastProxyAccountLabel();

  /** 把解析结果填进输入（整串模式直接替换；多键模式按声明键合并） */
  const applyParsed = (parsed: Record<string, string>): void => {
    if (wholeString) {
      const joined = kvString(parsed);
      setFieldStr(joined);
      // v1.2.x alipan 泛化：检测键从 cookieInput.keys 取（夸克 __pus 系 / alipan auth 系）
      const found = detectedKeys(joined, cookieInput.keys, cookieInput.probeKeys);
      setImportMsg(
        found.length > 0
          ? { ok: true, text: `识别到登录态 key：${found.join(' / ')}，已填入` }
          : { ok: false, text: `未识别到关键 key（${cookieInput.keys.map((k) => k.key).join(' / ')}），请检查导出内容` },
      );
      return;
    }
    const next = { ...fields };
    let hit = 0;
    for (const { key } of cookieInput.keys) {
      if (parsed[key]) {
        next[key] = parsed[key];
        hit++;
      }
    }
    setFields(next);
    setImportMsg(
      hit > 0
        ? { ok: true, text: `识别到 ${hit} 个必要 cookie（${cookieInput.keys.map((k) => k.key).join('/')}），已自动填入` }
        : { ok: false, text: '未识别到必要 cookie 键，请检查导出的内容（如使用了提取码页的 cookie）' },
    );
  };

  /** 粘贴文本自动识别（Netscape / JSON / Header string 懒人导入） */
  const handlePasteImport = (): void => {
    try {
      applyParsed(parseCookieText(pasteText));
    } catch (err) {
      setImportMsg({ ok: false, text: err instanceof Error ? err.message : '解析失败' });
    }
  };

  /** 选择文件导入（.txt / .json，Netscape 导出文件最常见） */
  const handleFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const text = await file.text();
      setPasteText(text);
      applyParsed(parseCookieText(text));
    } catch (err) {
      setImportMsg({ ok: false, text: err instanceof Error ? err.message : '文件读取失败' });
    }
  };

  /** 保存：整串模式提交整串（去空白）；多键模式提交声明键映射（去空白值） */
  const save = (): void => {
    if (wholeString) {
      if (missingFields(fieldStr).length > 0) return; // 必填项不全：按钮已置灰，兼做兼底
      onSave(fieldStr.trim());
      return;
    }
    const out: Record<string, string> = {};
    for (const { key } of cookieInput.keys) {
      const v = fields[key]?.trim();
      if (v) out[key] = v;
    }
    onSave(out);
  };

  /** 整串模式下的必填项缺失（多键模式不适用：各字段分开填） */
  const wholeStringMissing = wholeString ? missingFields(fieldStr) : [];

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="modal-head">
          <h3 className="modal-title">cookie 登录态鉴权</h3>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>
            <strong>{panName}</strong>{' '}
            {cookieInput.intro ?? '需要 cookie 鉴权，下面是本次获取到的必要 cookie 值 【如实显示】：'}
          </p>

          {/* v1.2.2：代理托管账号提示（响应头 x-panhub-account；仅展示 label，不暴露任何 cookie 明文）
              v1.3.1：前端只保留这一块说明（托管链路已下沉到 functions，不再暴露内部术语） */}
          {proxyAccount && (
            <p
              style={{
                margin: '8px 0 0',
                padding: '8px 10px',
                borderRadius: 6,
                background: 'rgba(23,162,184,0.08)',
                border: '1px solid rgba(23,162,184,0.35)',
                fontSize: 12.5,
                color: 'var(--text)',
              }}
            >
              代理托管账号：<strong>{proxyAccount}</strong>
              <span style={{ color: 'var(--text-faint)' }}>（cookie 由代理托管，不在此显示明文）</span>
              <span style={{ display: 'block', marginTop: 2, color: 'var(--text-faint)' }}>
                此处填写的 cookie 仅在直连模式生效。
              </span>
            </p>
          )}

          {/* 整串模式：单个大输入框（粘贴完整 cookie 字符串，最稳）；多键模式：各 key 填写框 */}
          {wholeString ? (
            <div style={{ margin: '10px 0' }}>
              <textarea
                value={fieldStr}
                onChange={(e) => setFieldStr(e.target.value)}
                placeholder={
                  cookieInput.wholeStringPlaceholder ??
                  '粘贴完整 cookie 字符串（含 __pus 等；\n从已登录浏览器复制，或用下方导入）'
                }
                rows={cookieInput.wholeStringPlaceholder ? 7 : 4}
                style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, boxSizing: 'border-box' }}
              />
              {(() => {
                // v1.2.x alipan 泛化：检测键从 cookieInput.keys 取（不再硬编码夸克 __pus）
                const keys = cookieInput.keys ?? [];
                const found = detectedKeys(fieldStr, keys, cookieInput.probeKeys);
                const required = keys[0]?.key ?? '';
                // v1.3：检测行与滚动更新红/绿提示同一行（右侧嵌入；auth / drive_id /
                // to_parent_file_id 就是本整串输入行里的三个键）
                return (
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    {wholeStringMissing.length > 0 ? (
                      // v1.3.1（Tzz A2）：必填项缺失就用这行小字直接说缺什么
                      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--danger)' }}>
                        {missingHintPrefix ?? ''}
                        {wholeStringMissing.join(' / ')}
                      </p>
                    ) : found.length > 0 ? (
                      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-dim)' }}>
                        已检测到登录态 key：{found.join(' / ')}
                        {required && !found.includes(required) && `（缺少 ${required}，可能无法通过鉴权）`}
                      </p>
                    ) : (
                      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-faint)' }}>
                        未检测到必要 key（{keys.map((k) => k.key).join(' / ')}），请检查粘贴内容
                      </p>
                    )}
                    {renderCarryHint(fieldStr)}
                  </div>
                );
              })()}
            </div>
          ) : (
            <div style={{ margin: '10px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {cookieInput.keys.map(({ key, label }) => (
                <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <code style={{ width: 56, flexShrink: 0, textAlign: 'right', userSelect: 'all' }}>{label}=</code>
                  <input
                    type="text"
                    value={fields[key] ?? ''}
                    onChange={(e) => setFields((prev) => ({ ...prev, [key]: e.target.value }))}
                    placeholder={`填写 ${key} 的值（从已登录浏览器复制）`}
                    style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
                  />
                </label>
              ))}
            </div>
          )}

          {/* 懒人导入（仅浏览器 cookie 类凭据展示；alipan 等凭据串手填即可，v1.2.x） */}
          {cookieInput.browserCookie !== false && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.json,text/plain,application/json"
                style={{ display: 'none' }}
                onChange={(e) => void handleFile(e.target.files?.[0])}
              />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>
                选择文件
              </button>
              <input
                type="text"
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="或粘贴 cookie（Netscape / JSON / Header 任意格式）"
                style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
              />
              <button type="button" className="btn btn-ghost btn-sm" onClick={handlePasteImport}>
                识别导入
              </button>
            </div>
          )}
          {importMsg && (
            <p style={{ margin: 0, fontSize: 12, color: importMsg.ok ? 'var(--text-dim)' : '#dc3545' }}>
              {importMsg.text}
            </p>
          )}

          <div style={{ marginTop: 10, borderTop: '1px solid var(--border, #e5e7eb)', paddingTop: 8 }}>
            <RedDot>{cookieInput.notice ?? '以上选项属于登录态的 cookie'}</RedDot>
            {cookieInput.browserCookie !== false && (
              <RedDot>
                推荐使用插件 get cookies.txt locally 获取
                {PLUGIN_LINKS.map((l) => (
                  <span key={l.label}>
                    {' '}
                    <a href={l.href} target="_blank" rel="noreferrer">
                      {l.label}
                    </a>
                    {l.note ?? ''}
                  </span>
                ))}
              </RedDot>
            )}
            <RedDot>
            更推荐：使用{' '}
            <a href="https://github.com/tzz1021/panweb-parser/tree/dev" target="_blank" rel="noreferrer">
            本机插件模式（dev 分支）
            </a>
            ，或者自建转发代理（参考{' '}
            <a href="https://github.com/tzz1021/panweb-parser/blob/master/docs/wiki-selfhost.md" target="_blank" rel="noreferrer">
            selfhost-Wiki
            </a>
            ）
            </RedDot>
            <RedDot>
              {cookieInput.missingHint ?? '如果你在使用自建代理却没有显示，请检查和账号状态和自建代理面板登录状态否正常，其他问题参阅文档'}
            </RedDot>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            算了吧
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={wholeStringMissing.length > 0}
            title={wholeStringMissing.length > 0 ? `请先补全：${wholeStringMissing.join(' / ')}` : undefined}
          >
            保存并重试
          </button>
        </div>
      </div>
    </div>
  );
}
