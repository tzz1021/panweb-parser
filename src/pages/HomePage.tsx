/**
 * 输入页（docs/STRUCTURE.md：src/pages/HomePage.tsx）
 *
 * 流程：粘贴链接 → detect 高亮网盘 → 点"获取文件列表"→ token 二次校验
 * → buildTree 目录树 → 足迹落库（链接/树快照/解析记录/日志）→ 进入结果页。
 */
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { PanAdapter } from '../adapters/types';
import type { ShareFile } from '../adapters/types';
import { detectShareUrl } from '../adapters/registry';
import { resolveKouling } from '../adapters/xunlei/kouling';
import { LinkInput, extractShare } from '../components/LinkInput';
import { PanTable } from '../components/PanTable';
import { DownloaderModal } from '../components/DownloaderModal';
import { LoginJumpModal } from '../components/LoginJumpModal';
import { CorsJumpModal } from '../components/CorsJumpModal';
import { useToast } from '../components/Toast';
import { fetchListSnapshot, renderTreeText, hhmmss } from '../core/listFetcher';
import { classifyError, isCorsError } from '../core/errors';
import { getPreferences } from '../core/preferences';
import { addGlobalLog, listGlobalLogs } from '../core/footprint/globalLog';
import { addLink } from '../core/footprint/links';
import { getTree, saveTree } from '../core/footprint/trees';
import { addRecord } from '../core/footprint/records';
import { appendLog } from '../core/footprint/logs';
import type { ListSnapshot, ParseSession, ScanIssue } from '../core/types';

/**
 * v1.3.2：扫描问题写全局日志（失败/大宗各一条；本地转发限频排查靠它）。
 * 格式：`scanner：目录 /xxx 未加载成功（业务码 45001）：message` /
 *       `scanner：大宗目录 /yyy（250 项 > 阈值 100）已跳过`
 * 结果页（手动刷新资源列表）复用同一个函数，保证两边日志格式一致。
 *
 * 去重：失败目录的日志已由 core/listFetcher 在 fetchListSnapshot 内集中写入（契约 §1），
 * 这里按“同文案已在最近日志里出现”跳过，避免同一失败目录在日志里出现两行。
 */
export function logScanIssues(issues: readonly ScanIssue[]): void {
  const recent = new Set(listGlobalLogs().slice(0, 20).map((e) => e.message));
  for (const it of issues) {
    const msg =
      it.kind === 'failed'
        ? `scanner：目录 ${it.path} 未加载成功（业务码 ${it.code ?? 'unknown'}）${it.message ? `：${it.message}` : ''}`
        : `scanner：大宗目录 ${it.path}（${it.count ?? '?'} 项 > 阈值 ${it.threshold ?? 0}）已跳过`;
    if (recent.has(msg)) continue;
    addGlobalLog(msg);
    recent.add(msg);
  }
}

/** 分享链接缩写（日志/足迹命名用，如 uc-dd2ad2345e124） */
export function linkAbbr(url: string, adapterId: string): string {
  const m = url.match(/\/(?:s|share)\/([A-Za-z0-9_-]+)/);
  return `${adapterId}-${m ? m[1] : url.slice(-8)}`;
}

export interface HomePageProps {
  onParsed: (session: ParseSession) => void;
  /** 打开设置面板（CORS 弹窗引导填代理，1.1） */
  onOpenSettings: () => void;
  /** 历史页"重新解析"带入的链接（1.0.1）：变化时自动填充，autoParse=true 时自动触发解析 */
  pending?: { url: string; autoParse?: boolean } | null;
}

export function HomePage({ onParsed, onOpenSettings, pending }: HomePageProps): JSX.Element {
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [detected, setDetected] = useState<PanAdapter | null>(null);
  const [passcode, setPasscode] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [downloaderOpen, setDownloaderOpen] = useState(false);
  const [loginJump, setLoginJump] = useState<{ message: string } | null>(null);
  const [corsJump, setCorsJump] = useState<{ message: string } | null>(null);
  const { toast } = useToast();
  const [initialValue, setInitialValue] = useState('');
  // v1.4 手动选盘（首页 pan-chips 点击；选中迅雷时输入框接受口令文字）与口令解析出的链接
  const [manualPan, setManualPan] = useState<string | null>(null);
  const [resolvedUrl, setResolvedUrl] = useState<string | undefined>(undefined);
  const lastPending = useRef('');

  /**
   * CORS 兑底跳转（备用形式，1.0.3）：打开分享页新标签供书签解析用，
   * 退出本站（pagehide）时执行清理函数自动关闭新标签（JS 只能关自己 open 的窗口）。
   * 不再定时关闭（1.0.2 的 30s 自动关会让解析进行中被打断）。
   */
  const openShareFallback = (shareUrl: string): void => {
    const win = window.open(shareUrl, '_blank');
    if (!win) {
      toast('浏览器拦截了弹窗，请手动打开分享页或开启书签', 'error');
      return;
    }
    const cleanup = (): void => {
      try {
        if (!win.closed) win.close(); // 只关我们打开的标签
      } catch {
        /* 跨域/已接管时忽略 */
      }
      window.removeEventListener('pagehide', cleanup);
    };
    window.addEventListener('pagehide', cleanup);
  };

  // 历史页"重新解析"：填充输入框，必要时自动触发解析
  useEffect(() => {
    if (!pending || pending.url === lastPending.current) return;
    lastPending.current = pending.url;
    setInitialValue(pending.url);
    if (pending.autoParse) {
      const adapter = detectShareUrl(pending.url);
      if (adapter) {
        const pc = extractShare(pending.url).passcode ?? '';
        setPasscode(pc);
        // 等 React 提交后触发（detect 已由 LinkInput 回调同步）
        setTimeout(() => void handleFetch({ adapter, url: pending.url, passcode: pc }), 200);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  const handleDetect = (adapter: PanAdapter | null, u: string): void => {
    setDetected(adapter);
    setUrl(u);
    setHighlightId(adapter ? adapter.id : null);
  };

  const handleFetch = async (overrides?: { adapter?: PanAdapter; url?: string; passcode?: string }): Promise<void> => {
    // v1.4 口令 → 链接：首页选中迅雷网盘且输入不是链接时，先调（无鉴权）jump 接口解析
    if (!overrides?.url && manualPan === 'xunlei' && url.trim() && !/^https?:\/\//i.test(url.trim())) {
      const word = url.trim();
      setBusy(true);
      const resolved = await resolveKouling(word);
      setBusy(false);
      if (!resolved) {
        toast('口令不存在', 'error');
        setManualPan(null); // 提示位置从「已选择：迅雷网盘」换回默认文案
        return;
      }
      addGlobalLog(`口令「${word}」已解析为分享链接：${resolved.url}`);
      setResolvedUrl(resolved.url);
      await handleFetch({ adapter: detectShareUrl(resolved.url) ?? undefined, url: resolved.url, passcode: resolved.passcode ?? '' });
      return;
    }
    const adapter = overrides?.adapter ?? detected;
    const shareUrl = overrides?.url ?? url;
    const pc = overrides?.passcode ?? passcode;
    if (!adapter) {
      toast('识别失败，请检查格式是否正确', 'error');
      return;
    }
    const shareId = adapter.parseShareId(shareUrl);
    if (!shareId) {
      toast('识别失败，请检查格式是否正确', 'error');
      return;
    }
    // §12/顺序固化：获取资源列表（scanner，原 ls 术语）= 游客态浏览（不需要 cookie），直接解析目录树；
    // cookie（UC __pugs）只在结果页“解析下载方式”（prase）阶段才需要
    // v1.1.6 jumper：长链接（跳转链接）→ 二次获取分享内某文件夹，日志头不同
    const jump = adapter.parseJumpUrl?.(shareUrl) ?? null;
    if (jump) {
      const path = '/' + jump.segments.map((s) => s.name).join('/');
      addGlobalLog(`=====${hhmmss(Date.now())}，跳转到'${path}'=====`);
    } else {
      addGlobalLog('=====获取资源列表（scanner）=====');
    }
    await runParse(adapter, shareUrl, pc);
  };

  /**
   * 获取资源列表（scanner，原 ls 术语）：优先复用缓存快照（reuseWindowHours 窗口内，v1.1.4），
   * 未命中/过期才走 getToken + 目录树遍历（游客态请求，不需要 cookie，§12）。
   */
  const runParse = async (adapter: PanAdapter, shareUrl: string, pc: string): Promise<void> => {
    const shareId = adapter.parseShareId(shareUrl);
    if (!shareId) {
      toast('识别失败，请检查格式是否正确', 'error');
      return;
    }
    const prefs = getPreferences();
    const abbr = linkAbbr(shareUrl, adapter.id);
    // v1.1.6 jumper：长链接（跳转链接）→ 二次获取分享内某文件夹（0B 文件夹风控救回）
    const jump = adapter.parseJumpUrl?.(shareUrl) ?? null;
    if (jump) {
      return runJumpParse(adapter, shareUrl, jump, pc);
    }
    addGlobalLog(`scanner：供应商 ${adapter.name} · 分享 ${abbr}`);
    if (adapter.cookie) {
      addGlobalLog(`scanner：${adapter.cookie.displayName}（未登录态cookie）在 prase 阶段才需要，本阶段不涉及`);
    }
    addGlobalLog(`scanner：复用窗口 ${prefs.reuseWindowHours}h · cookie 提示 ${prefs.modals.cookieWarn ? '开启' : '关闭'} · 通道 ${prefs.transport.mode === 'proxy' ? 'proxy代理' : 'direct直连'}`);
    setBusy(true);
    setProgress({ done: 0, total: 1 });
    const now = Date.now();
    try {
      // ① 快照复用：窗口内命中足迹缓存（目录树 + stoken）→ 跳过整轮 scanner
      const reuseWinMs = prefs.reuseWindowHours > 0 ? prefs.reuseWindowHours * 3600_000 : 0;
      let snap: ListSnapshot | null = null;
      // v1.1.7 折叠状态恢复：快照复用的会话标记 fromCache，结果页据此恢复上次折叠状态/弹窗询问
      let fromCache = false;
      if (reuseWinMs > 0 && prefs.footprint.keepTrees) {
        const cached = await getTree(shareId);
        if (cached?.stoken && now - cached.savedAt < reuseWinMs) {
          const mins = Math.max(1, Math.round((now - cached.savedAt) / 60000));
          addGlobalLog(`scanner：命中缓存资源列表（${mins} 分钟前，窗口 ${prefs.reuseWindowHours}h），复用目录树 + stoken，跳过遍历`);
          snap = {
            shareId,
            url: shareUrl,
            adapterId: adapter.id,
            stoken: cached.stoken,
            root: cached.root,
            fetchedAt: cached.savedAt,
            fileCount: cached.fileCount,
            totalSize: cached.totalSize,
            // 复用路径行为不变：缓存快照不存问题清单（目录树节点自带 scanError/bulkSkipped，结果页可从树派生展示）
            issues: [],
          };
          fromCache = true;
        } else if (cached) {
          addGlobalLog(`scanner：缓存快照过期或缺少 stoken（${Math.round((now - cached.savedAt) / 60000)} 分钟前），重新拉取`);
        }
      }
      // ② 未命中：完整 scanner（token 校验 + 目录树递归）
      if (!snap) {
        addGlobalLog('scanner：开始拉取目录树（并发 2，分页 50/页，同目录翻页节流 250ms）…');
        snap = await fetchListSnapshot(adapter, shareId, shareUrl, {
          passcode: pc,
          // v1.3.2：扫描深度 + 大宗判定透传给 treeWalker（0 = 不限 / 关闭）
          maxDepth: prefs.scanDepth,
          bulkThreshold: prefs.bulkThreshold,
          onProgress: (done, total) => setProgress({ done, total }),
        });
        if (prefs.footprint.keepTrees) {
          await saveTree({
            shareId,
            url: shareUrl,
            adapterId: adapter.id,
            root: snap.root,
            savedAt: snap.fetchedAt,
            fileCount: snap.fileCount,
            totalSize: snap.totalSize,
            stoken: snap.stoken,
          });
        }
        // 目录树打印到全局日志（UI 侧对过长树自动折叠）+ 刷新标记（v1.1.4 规范日志）
        addGlobalLog(`=====目录树（${snap.fileCount} 个文件 / ${snap.totalSize} 字节）=====\n${renderTreeText(snap.root)}\n=====目录树结束=====`);
        addGlobalLog(`=====资源列表已刷新，当前${hhmmss(snap.fetchedAt)}=====`);
        // v1.3.2：失败目录/大宗跳过写全局日志（结果不完整的可见入口）
        if (snap.issues?.length) logScanIssues(snap.issues);
      }
      // 足迹落库（复用与全量都记：链接查重 / 解析记录 / 日志）
      if (prefs.footprint.keepLinks) {
        await addLink({ url: shareUrl, adapterId: adapter.id, shareId });
      }
      await addRecord({
        shareId,
        url: shareUrl,
        adapterId: adapter.id,
        parsedAt: snap.fetchedAt,
        ok: true,
        fileCount: snap.fileCount,
        title: snap.root.children?.[0]?.file.fileName, // 首个文件（夹）名，历史页标题用（1.0.2）
      });
      if (prefs.footprint.keepLogs) {
        await appendLog({ time: snap.fetchedAt, level: 'info', adapterId: adapter.id, url: shareUrl, message: `获取资源列表成功：${abbr}，共 ${snap.fileCount} 个文件（${snap.totalSize} 字节）` });
      }
      onParsed({ adapter, url: shareUrl, shareId, stoken: snap.stoken, root: snap.root, parsedAt: snap.fetchedAt, fromCache });
      addGlobalLog(`scanner：已就绪 — ${snap.fileCount} 个文件可勾选，解析下载方式（prase）在结果页进行`);
    } catch (err) {
      const { category, message } = classifyError(err);
      const now = Date.now();
      await addRecord({ shareId, url: shareUrl, adapterId: adapter.id, parsedAt: now, ok: false, fileCount: 0, error: message });
      const prefs = getPreferences();
      if (prefs.footprint.keepLogs) {
        await appendLog({ time: now, level: 'fatal', adapterId: adapter.id, url: shareUrl, message: `解析失败：${message}` });
      }
      if (isCorsError(err)) {
        // CORS 拦截：PC 端无书签时兑底（1.0.1）；自动跳转改为"备用"形式，默认弹窗（1.0.3）
        if (prefs.modals.corsAutoJump) {
          openShareFallback(shareUrl);
          toast('CORS 拦截：已跳转分享页，新标签页用于解析请勿关闭，退出本站自动清理', 'info');
        } else {
          setCorsJump({ message });
        }
      } else if (category === 'need-login' && prefs.modals.loginJump) {
        setLoginJump({ message });
      } else {
        toast(message, 'error');
      }
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  /**
   * v1.1.6 jumper：长链接（跳转链接）二次获取分享内某文件夹的资源列表。
   *
   * 与普通 scanner 的区别：
   * - stoken 从大宗 scanner 入库数据（足迹 trees 快照）获取，没有才调 token 接口
   *   （detail 接口没有 stoken 全部 401）；
   * - 根节点是目标文件夹（rootFile/rootPath/rootIsShareRoot=false，list 不带 banner/share 扩展字段）；
   * - 不覆盖 trees 快照（子树的根不是分享根，复用会污染整棵目录树）；
   * - 依旧一次性解析完毕，不使用懒加载（游客态批量 scanner 风控会集群出现）。
   */
  const runJumpParse = async (
    adapter: PanAdapter,
    shareUrl: string,
    jump: { shareId: string; segments: Array<{ fid: string; name: string }> },
    pc: string,
  ): Promise<void> => {
    const { shareId, segments } = jump;
    const rootPath = '/' + segments.map((s) => s.name).join('/');
    const folder = segments[segments.length - 1];
    const prefs = getPreferences();
    const abbr = linkAbbr(shareUrl, adapter.id);
    const now = Date.now();
    addGlobalLog(`${hhmmss(now)} jumper：扫描暂存区，寻找唯一标识符`);
    addGlobalLog(`scanner：收到jumper任务'${adapter.id}-${shareId}'内部文件夹。开始拉取目录树（并发 2，分页 50/页，同目录翻页节流 250ms）…`);
    setBusy(true);
    setProgress({ done: 0, total: 1 });
    try {
      // stoken 从刚才完成的大宗 scanner 入库数据获取（没有这个 detail 全部 401）
      let stoken = '';
      if (prefs.footprint.keepTrees) {
        const cached = await getTree(shareId);
        stoken = cached?.stoken ?? '';
      }
      if (!stoken) {
        addGlobalLog(`scanner：jumper 未命中缓存 stoken，调用 token 接口获取`);
        ({ stoken } = await adapter.getToken({ shareId, passcode: pc }));
      }
      // v1.3.3 深链没有 fid：按名字链逐层下钻解析出目标文件夹 fid（找不到 → 明确报错，不回退到根）
      let targetFid = folder.fid;
      if (!targetFid && adapter.resolveJumpPath) {
        addGlobalLog(`jumper：深链未带 fid，按名字逐层解析（${segments.map((s) => s.name).join(' / ')}）…`);
        const resolved = await adapter.resolveJumpPath({ shareId, stoken, path: segments.map((s) => s.name) });
        targetFid = resolved.fid;
        addGlobalLog(`jumper：已解析到目标文件夹 fid=${resolved.fid}（${resolved.name}）`);
      }
      const rootFile: ShareFile = { fid: targetFid, fileName: folder.name, dir: true, size: 0 };
      const snap = await fetchListSnapshot(adapter, shareId, shareUrl, {
        passcode: pc,
        stoken, // 预置 stoken，跳过 token 接口（jumper 复用缓存）
        rootFile,
        rootPath,
        rootIsShareRoot: false, // 文件夹不是分享根，不带 _fetch_banner/_fetch_share
        // v1.3.2：jumper 二次获取同样受扫描深度/大宗判定约束（深度从 0 重算）
        maxDepth: prefs.scanDepth,
        bulkThreshold: prefs.bulkThreshold,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      // 足迹落库：链接查重 + 解析记录 + 日志（不覆盖 trees 快照，见函数注释）
      if (prefs.footprint.keepLinks) {
        await addLink({ url: shareUrl, adapterId: adapter.id, shareId });
      }
      await addRecord({
        shareId,
        url: shareUrl,
        adapterId: adapter.id,
        parsedAt: snap.fetchedAt,
        ok: true,
        fileCount: snap.fileCount,
        title: folder.name, // 标题 = 目标文件夹名（历史页不显示裸 URL）
      });
      if (prefs.footprint.keepLogs) {
        await appendLog({ time: snap.fetchedAt, level: 'info', adapterId: adapter.id, url: shareUrl, message: `获取资源列表成功（jumper ${rootPath}）：${abbr}，共 ${snap.fileCount} 个文件（${snap.totalSize} 字节）` });
      }
      onParsed({
        adapter,
        url: shareUrl,
        shareId,
        stoken: snap.stoken,
        root: snap.root,
        parsedAt: snap.fetchedAt,
        // v1.1.6：jumper 会话标记（结果页刷新时按此文件夹重新扫描，而不是分享根）
        jump: { url: shareUrl, rootFile, rootPath },
      });
      // 目录树打印到全局日志（UI 侧对过长树自动折叠 + 复制；含 fid）
      addGlobalLog(`=====${hhmmss(snap.fetchedAt)}，已找到目录'${rootPath}'=====\n${renderTreeText(snap.root)}\n=====目录树结束=====`);
      // v1.3.2：失败目录/大宗跳过写全局日志
      if (snap.issues?.length) logScanIssues(snap.issues);
    } catch (err) {
      const { category, message } = classifyError(err);
      const ts = Date.now();
      await addRecord({ shareId, url: shareUrl, adapterId: adapter.id, parsedAt: ts, ok: false, fileCount: 0, error: message });
      const prefs2 = getPreferences();
      if (prefs2.footprint.keepLogs) {
        await appendLog({ time: ts, level: 'fatal', adapterId: adapter.id, url: shareUrl, message: `解析失败（jumper ${rootPath}）：${message}` });
      }
      if (isCorsError(err)) {
        if (prefs2.modals.corsAutoJump) {
          openShareFallback(shareUrl);
          toast('CORS 拦截：已跳转分享页，新标签页用于解析请勿关闭，退出本站自动清理', 'info');
        } else {
          setCorsJump({ message });
        }
      } else if (category === 'need-login' && prefs2.modals.loginJump) {
        setLoginJump({ message });
      } else {
        toast(message, 'error');
      }
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <>
      {/* 分享链接填写栏（上） */}
      <LinkInput
        onDetect={handleDetect}
        onPasscode={setPasscode}
        onFetchFiles={() => void handleFetch()}
        onOpenDownloader={() => setDownloaderOpen(true)}
        busy={busy}
        initialValue={resolvedUrl ?? initialValue}
        manualPanName={manualPan === 'xunlei' ? '迅雷网盘' : null}
      />
      {/* 解析进度（可选展示） */}
      {busy && progress && (
        <div className="card">
          <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 13, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
              解析目录中 {progress.done}/{progress.total}
            </span>
            <div className="progress">
              <div
                className="progress-bar"
                style={{
                  width: progress.total > 0 ? `${Math.min(100, (progress.done / progress.total) * 100)}%` : '10%',
                }}
              />
            </div>
          </div>
        </div>
      )}
      {/* 网盘种类横向表格（下；v1.4 首页可点：选迅雷后在输入框输口令文字） */}
      <PanTable
        highlightId={highlightId}
        selectedId={manualPan}
        onSelect={(id) => setManualPan(id === 'xunlei' ? (manualPan === 'xunlei' ? null : 'xunlei') : null)}
      />

      {downloaderOpen && <DownloaderModal onClose={() => setDownloaderOpen(false)} />}
      {loginJump && (
        <LoginJumpModal
          message={loginJump.message}
          onClose={() => setLoginJump(null)}
          onJump={() => {
            setLoginJump(null);
            if (detected && url) window.open(url, '_blank');
          }}
        />
      )}
      {corsJump && (
        <CorsJumpModal
          message={corsJump.message}
          onClose={() => setCorsJump(null)}
          onOpenSettings={onOpenSettings}
        />
      )}
    </>
  );
}

