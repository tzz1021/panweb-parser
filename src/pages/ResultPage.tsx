/**
 * 结果页（docs/STRUCTURE.md：src/pages/ResultPage.tsx）—— 核心页
 *
 * 目录树 + 勾选 → prase 批量直链（15/批 + 1s 节流，窗口内复用已解析直链）→ 导出。
 * v1.1.4：术语分离 —— scanner（获取资源列表，原 ls）与 prase（解析下载方式）分开；
 * 头部「资源列表获取于 xx」+ 绿按钮「获取最新资源列表」强制刷新 scanner。
 * v1.1.5：直链状态标签下沉到文件行，移除顶部倒计时。
 * v1.1.5.3：移除每行 status 文本（保留行底色）；prase 产物按 fid 落库（足迹恢复复用）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, JSX } from 'react';
import type { ShareFile } from '../adapters/types';
import type { CarryOverCredentialPlan } from '../adapters/types';
import { DirectoryTree, collectLeaves, flattenTree } from '../components/DirectoryTree';
import type { TreeRow } from '../components/DirectoryTree';
import { FileCheckbox } from '../components/FileCheckbox';
import { CookieWarnModal } from '../components/CookieWarnModal';
import { DownloaderModal } from '../components/DownloaderModal';
import { ExportFailModal } from '../components/ExportFailModal';
import { ParseFailModal } from '../components/ParseFailModal';
import { CloudflareWarnModal } from '../components/CloudflareWarnModal';
import { JumptoFolderTipModal } from '../components/JumptoFolderTipModal';
import { HiddenVolumnModal } from '../components/HiddenVolumnModal';
import { ExportYellowModal } from '../components/ExportYellowModal';
import { RestoreCollapsedModal } from '../components/RestoreCollapsedModal';
import { CheckColorPicker } from '../components/CheckColorPicker';
import { useToast } from '../components/Toast';
import { fetchLinks } from '../core/linkFetcher';
import { getActiveTransport, getLastProxyAccountLabel, getLastProxyBackendOk } from '../core/transport/types';
import { isXunleiOfflineCode } from '../adapters/xunlei/download';
import { fetchListSnapshot, renderTreeText, hhmmss } from '../core/listFetcher';
import { getPreferences, subscribePreferences } from '../core/preferences';
import { addRecord } from '../core/footprint/records';
import { appendLog, listLogs, exportLogsMd } from '../core/footprint/logs';
import { addGlobalLog } from '../core/footprint/globalLog';
import { saveTree } from '../core/footprint/trees';
import { savePraseEntries, listPraseByShareId, clearPraseByShareId } from '../core/footprint/prase';
import { getPugs } from '../adapters/uc/cookies';
import { getQuarkPugs } from '../adapters/quark/cookies';
import { QUARK_LOGIN_SIZE } from '../adapters/quark/types';
import { CookieInputModal } from '../components/CookieInputModal';
import { AccountOverwriteModal } from '../components/AccountOverwriteModal';
import { exportTask, exportTreeMd } from '../tasks/export';
import { DOWNLOADER_PRESETS, loadDownloaderConfig, pushFilesToDownloader } from '../utils/downloader';
import { formatRemain, formatSize, formatTime } from '../utils/format';
import { entryExpiryMs, isLinkGreen, isLinkUsable, isLinkYellow, linkDetailOf } from '../utils/linkStatus';
import type { ExportFile, LinkEntry, LinkResult, ParseSession, ScanIssue, TaskKind, TreeNode } from '../core/types';
import { linkAbbr, logScanIssues } from './HomePage';

/**
 * v1.3.2：扫描问题提示「不再弹出」的本机记忆键（localStorage）。
 * 只是宽松提示的免打扰开关——失败/大宗目录的**行内提示不受它影响**。
 */
const ISSUES_DISMISSED_KEY = 'pan-web:scan-issues-banner:v1';

/** 读取「不再弹出」记忆（隐私模式/配额异常时当作未勾选） */
function readIssuesDismissed(): boolean {
  try {
    return window.localStorage.getItem(ISSUES_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * v1.3.2：从目录树派生扫描问题清单（failed / bulk）。
 * 会话（ParseSession）未携带 ListSnapshot.issues，而失败/大宗两类语义已落在
 * TreeNode.scanError / TreeNode.bulkSkipped 上（互斥，失败优先），因此从树派生与快照
 * issues 等价；能拿到快照 issues 的路径（手动刷新）优先用快照值。
 */
function deriveIssues(root: TreeNode): ScanIssue[] {
  const out: ScanIssue[] = [];
  const walk = (n: TreeNode): void => {
    if (n.scanError) {
      out.push({ path: n.path, fid: n.file.fid, kind: 'failed', code: n.scanError.code, message: n.scanError.message });
    } else if (n.bulkSkipped) {
      out.push({ path: n.path, fid: n.file.fid, kind: 'bulk', count: n.bulkSkipped.count, threshold: n.bulkSkipped.threshold });
    }
    if (n.children) for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

/** 文件相对路径的父目录 */
function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '/';
}

/** 下载文件（Blob 直存，文件名来自导出器） */
function downloadFile(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

export interface ResultPageProps {
  session: ParseSession;
  onBack: () => void;
  /** v1.1.6 jumper：跳转文件夹（回输入页自动触发新任务） */
  onJump: (url: string) => void;
}

const KIND_LABEL: Record<TaskKind, string> = { aria2: 'aria2', gopeed: 'Gopeed', curl: 'cURL' };

export function ResultPage({ session, onBack, onJump }: ResultPageProps): JSX.Element {
  const { adapter, shareId, url } = session;
  // v1.2.x alipan：登录态输入规格缓存为 const —— 闭包内直接引用不会丢 narrowing
  // （quark __pus 整串 / alipan auth 凭据串共用同一弹窗与流程，存取走各适配器 load/save 钩子）
  const cookieInputReq = adapter.cookieInput;
  // v1.3 alipan：滚动更新（carry-over）规格 —— 过期判定/hop 探测/离线校验与话术均由适配器提供，
  // 本页只消费结果（toast/行内提示），不硬编码任何文案
  const carryReq = adapter.carryOver;
  const { toast } = useToast();

  const prefs = useMemo(() => getPreferences(), []);
  // v1.3.1：勾选行自定义底色（'' = 主题默认高亮）—— 立即生效（注入 --check-bg）+ 持久化在 CheckColorPicker 内
  const [checkColor, setCheckColor] = useState(prefs.checkColor);
  // 偏好被别处改动（设置面板导入/重置/其它标签页）时跟随
  useEffect(() => subscribePreferences(() => setCheckColor(getPreferences().checkColor)), []);
  /** 注入给目录树的 --check-bg（空值时不下发，由 CSS 回退到主题默认高亮 --primary-soft） */
  const checkColorStyle = useMemo(
    () => (checkColor ? ({ '--check-bg': checkColor } as CSSProperties) : undefined),
    [checkColor],
  );
  // v1.1.8：弹窗保存后重读配置（tick 变化触发 memo 重算，避免推送用旧地址）
  const [dlCfgTick, setDlCfgTick] = useState(0);
  const downloader = useMemo(() => loadDownloaderConfig(), [dlCfgTick]);

  // v1.1.4：资源列表（ls）在结果页可刷新 —— 目录树/stoken/获取时间改为本地状态
  const [root, setRoot] = useState<TreeNode>(session.root);
  const [stoken, setStoken] = useState(session.stoken);
  const [listAt, setListAt] = useState(session.parsedAt);
  const [refreshingList, setRefreshingList] = useState(false);
  // v1.3.2：本次扫描的问题清单（失败/大宗）+ 提示免打扰开关（仅本机）
  const [issues, setIssues] = useState<ScanIssue[]>(() => deriveIssues(session.root));
  const [issuesDismissed, setIssuesDismissed] = useState<boolean>(() => readIssuesDismissed());
  // 会话树换了一份（同一个 ResultPage 实例被复用）时同步问题清单；刷新树走 refreshList 自己的 setIssues
  useEffect(() => {
    setIssues(deriveIssues(session.root));
  }, [session.root]);

  // 全部叶子文件（一次计算，树固定）
  const allLeaves = useMemo(() => collectLeaves(root), [root]);
  const allDirIds = useMemo(() => {
    const set = new Set<string>();
    const walk = (n: { file: ShareFile; children?: unknown[] }): void => {
      if (n.file.dir && n.children) {
        set.add(n.file.fid);
        for (const c of n.children) walk(c as never);
      }
    };
    walk(root);
    return set;
  }, [root]);

  // v1.1.7：目录折叠状态本地保存（按分享），复用期间可恢复
  const collapsedKey = `panhub:collapsed:${session.shareId}`;
  const readCollapsed = (): { fids: string[]; savedAt: number } | null => {
    try {
      const raw = window.localStorage.getItem(collapsedKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { fids: string[]; savedAt: number };
      if (!Array.isArray(parsed?.fids)) return null;
      return parsed;
    } catch {
      return null;
    }
  };
  const writeCollapsed = (fids: ReadonlySet<string>): void => {
    try {
      window.localStorage.setItem(collapsedKey, JSON.stringify({ fids: [...fids], savedAt: Date.now() }));
    } catch {
      /* 配额/隐私模式静默 */
    }
  };
  // 折叠状态初始：复用会话（fromCache）且非「丢弃」时优先恢复上次状态，否则默认全展开
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const saved = readCollapsed();
    if (session.fromCache && saved && prefs.restoreCollapsed !== 'discard') {
      return new Set(saved.fids.length > 0 ? saved.fids : allDirIds);
    }
    return new Set(allDirIds);
  });
  // 保存折叠状态（任何展开/收起变化都记；同值重复保存无害）
  useEffect(() => {
    writeCollapsed(expanded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);
  // 复用 + 「每次询问」→ 弹窗询问是否恢复上次折叠状态
  useEffect(() => {
    if (!session.fromCache || prefs.restoreCollapsed !== 'ask') return;
    const saved = readCollapsed();
    if (!saved || saved.fids.length === 0) return;
    const d = new Date(saved.savedAt);
    const p = (n: number): string => String(n).padStart(2, '0');
    setRestoreAsk({ savedAtLabel: `${p(d.getHours())}:${p(d.getMinutes())}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.fromCache]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState('');
  const [links, setLinks] = useState<Map<string, LinkEntry> | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchProgress, setFetchProgress] = useState<{ done: number; total: number } | null>(null);
  // v1.4 迅雷取链方案弹窗（批量只弹一次）：自动（按设置规则）/ CONSUME / PLAY
  const [usageChoice, setUsageChoice] = useState<{ files: ShareFile[] } | null>(null);
  // v1.4 后端断线专属弹窗（op NO_BACKEND / 405 / 501 / 502 等）
  const [backendDown, setBackendDown] = useState(false);
  const [exportKind, setExportKind] = useState<TaskKind>('aria2');
  const [keepStructure, setKeepStructure] = useState(prefs.keepStructure);
  const [exportFail, setExportFail] = useState(false);
  const [parseFail, setParseFail] = useState<{ fileName: string } | null>(null);
  // v1.1.5.2 兜底：pages.dev 代理 + 同分秒重复解析 → 强制提示
  const [cloudflareWarn, setCloudflareWarn] = useState(false);
  // v1.1.6 jumper：0B 文件夹「转到此文件夹」提示弹窗
  const [jumpWarn, setJumpWarn] = useState<{ jumpUrl: string; folderPath: string; originalTitle: string } | null>(null);
  // v1.1.7 隐秘参数：<> 按钮弹窗（确认后新标签直连官方 API，url 在 open 时算好）
  const [hiddenVolumn, setHiddenVolumn] = useState<{ url: string; title: string; body: string } | null>(null);
  /** v1.4：文件级隐秘参数（解析后可就地看的脱敏详情；不发请求） */
  const [fileHidden, setFileHidden] = useState<{ title: string; rows: Array<{ label: string; value: string }> } | null>(null);
  // v1.1.7 导出包含黄色标记 → 弹窗模式（设置开关控制，关=简略 toast）
  const [exportYellow, setExportYellow] = useState(false);
  // v1.1.7 折叠状态恢复询问弹窗
  const [restoreAsk, setRestoreAsk] = useState<{ savedAtLabel: string } | null>(null);
  // v1.1.7 资源列表首次获取时间：会话内固定不变（刷新只更新 listAt），
  // 头部显示「首次获取于 xx · 最后刷新于 xx」时 firstAt 即本次会话的初始获取时间
  const [firstAt] = useState(session.parsedAt);
  const [downloaderOpen, setDownloaderOpen] = useState(false);
  const [pushing, setPushing] = useState(false);
  // §12 顺序固化：prase（解析下载方式）阶段才需要 cookie —— 弹窗确认后预热 + 继续
  const [cookieWarn, setCookieWarn] = useState<{ files: ShareFile[] } | null>(null);
  // v1.1.9：登录态 cookie 填写弹窗（夸克 23018/31001 时弹出，保存后自动重试失败文件）
  const [cookieInputWarn, setCookieInputWarn] = useState(false);
  // v1.3.1 alipan：换号 → 弹「是否覆盖当前暂存区的 userid」（等用户选择后再落库/重试）
  const [accountSwitch, setAccountSwitch] = useState<{ plan: CarryOverCredentialPlan } | null>(null);
  const cookieRetryFiles = useRef<ShareFile[]>([]);
  const pendingFetch = useRef<ShareFile[] | null>(null);
  // v1.2.2（wip2 修正）：代理托管 toast 一次性标志（已提示过就不再刷屏）
  const backendOkToastShown = useRef(false);
  const [, setTick] = useState(0); // 倒计时刷新

  // 倒计时：链接存在时每 30s 刷新
  useEffect(() => {
    if (!links) return;
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, [links]);

  // v1.1.5.3：进入结果页从足迹恢复本分享已解析的直链（按 fid 复用）——
  // 未过期直链直接可导出/标绿，不再请求接口（proxy 被恶意刷爆时尤为重要）；读不到就正常显示解析按钮。
  useEffect(() => {
    let alive = true;
    void listPraseByShareId(session.shareId)
      .then((restored) => {
        if (!alive || restored.size === 0) return;
        setLinks((prev) => {
          const next = new Map(prev ?? []);
          for (const [fid, entry] of restored) {
            if (!next.has(fid)) next.set(fid, entry);
          }
          return next;
        });
        addGlobalLog(`scanner：从足迹恢复 ${restored.size} 条已解析直链（按 fid 复用，过期/失败项自动走原状态）`);
      })
      .catch(() => {
        /* 读不到就正常显示解析按钮，不影响主流程 */
      });
    return () => {
      alive = false;
    };
  }, [session.shareId]);

  // 过滤可见文件
  const visibleLeaves = useMemo(() => {
    if (!filterText) return allLeaves;
    const kw = filterText.toLowerCase();
    return allLeaves.filter((f) => f.fileName.toLowerCase().includes(kw));
  }, [allLeaves, filterText]);

  // 勾选集合与可见集合的交集（保证过滤后全选只影响可见）
  const selectedFiles = useMemo(() => {
    const set = new Set(checked);
    return visibleLeaves.filter((f) => set.has(f.fid));
  }, [checked, visibleLeaves]);

  // 树扁平行（按展开状态）+ fid → 树节点查找（先声明，后续 useMemo 使用）
  const flatRows: TreeRow[] = useMemo(() => flattenTree(root, expanded), [root, expanded]);
  const leafNodeOf = (fid: string): TreeNode | undefined =>
    flatRows.find((r) => r.node.file.fid === fid && !r.node.file.dir)?.node;

  // v1.1.6 显示属性：每个目录的直接文件数 / 子文件夹数（单次遍历预计算，避免逐行递归）
  const dirProps = useMemo(() => {
    const map = new Map<string, { files: number; dirs: number }>();
    const walk = (n: TreeNode): void => {
      if (!n.file.dir || !n.children) return;
      let files = 0;
      let dirs = 0;
      for (const c of n.children) {
        if (c.file.dir) {
          dirs++;
          walk(c);
        } else {
          files++;
        }
      }
      map.set(n.file.fid, { files, dirs });
    };
    walk(root);
    return map;
  }, [root]);

  // 跨文件夹判断：选中文件父目录数 > 1
  const crossFolder = useMemo(() => {
    const parents = new Set<string>();
    for (const f of selectedFiles) {
      const node = leafNodeOf(f.fid);
      if (node) parents.add(parentOf(node.path));
    }
    return parents.size > 1;
  }, [selectedFiles, flatRows]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedSize = selectedFiles.reduce((s, f) => s + (f.size ?? 0), 0);

  /* ---------- 勾选操作 ---------- */
  const toggleFile = (fid: string): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(fid)) next.delete(fid);
      else next.add(fid);
      return next;
    });
  };

  const toggleDirAll = (node: { file: ShareFile; children?: unknown[] }): void => {
    const leaves = collectLeaves(node as never);
    setChecked((prev) => {
      const next = new Set(prev);
      const allChecked = leaves.every((f) => next.has(f.fid));
      for (const f of leaves) {
        if (allChecked) next.delete(f.fid);
        else next.add(f.fid);
      }
      return next;
    });
  };

  const selectVisible = (mode: 'all' | 'invert' | 'none'): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const f of visibleLeaves) {
        if (mode === 'all') next.add(f.fid);
        else if (mode === 'none') next.delete(f.fid);
        else if (next.has(f.fid)) next.delete(f.fid);
        else next.add(f.fid);
      }
      return next;
    });
  };

  // v1.1.7：按直链状态批量勾选（绿/黄/红/未解析/已过期；基于当前解析结果离线判定）
  const selectByStatus = (kind: 'green' | 'yellow' | 'red' | 'unparsed' | 'expired'): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const f of visibleLeaves) {
        const detail = linkDetailOf(links?.get(f.fid), f.size);
        const match =
          kind === 'green'
            ? detail.kind === 'green'
            : kind === 'yellow'
              ? detail.kind === 'yellow'
              : kind === 'red'
                ? detail.kind === 'failed' || detail.kind === 'terminated'
                : kind === 'expired'
                  ? detail.kind === 'expired'
                  : detail.kind === 'none';
        if (match) next.add(f.fid);
        else next.delete(f.fid);
      }
      return next;
    });
  };

  /* ---------- 批量直链（prase：解析下载方式） ---------- */
  /**
   * prase 入口（§12 顺序固化：ls 不需要 cookie，prase 才需要）：
   * 需 cookie 的网盘（UC）→ 先弹窗展示捕获状态（明文，默认开），确认后拉直链。
   * v1.1.4：窗口内已解析且未过期的文件直接复用（oss+sig），全部命中时跳过 cookie 弹窗。
   * 不做“跳转取 cookie”预热 —— §12 实测：oss 直链与 __pugs 必须同响应绑定，
   * 跨环境取值无意义（跳转只影响浏览器 jar，与导出链路无关）。
   */
  const requestFetchLinks = (files: ShareFile[]): void => {
    if (files.length === 0) {
      toast('请先勾选要解析的文件', 'error');
      return;
    }
    if (fetching) return;
    // v1.4 迅雷：先弹「取链方案」选择（自动/CONSUME/PLAY），选定后本批次全部文件用该 usage；批量只弹一次
    if (adapter.id === 'xunlei') {
      // v1.4：先探活 op 端点（POST {op:'ping'}，backend 直接回 {ok:true}，不碰上游）。
      // 探测失败（网络异常/CORS/404/405/501/502/非 JSON）→ 立即弹「后端断线了。。。」并**中止本批**，
      // 不逐文件失败、不出「单文件解析失败」。
      void (async () => {
        const t = getActiveTransport();
        let pong = false;
        try {
          const r = t.xunleiOp ? await t.xunleiOp({ op: 'ping' }) : null;
          pong = Boolean(r && r.ok && r.data?.ok === true);
        } catch {
          pong = false;
        }
        if (!pong) {
          setBackendDown(true);
          toast('后端断线了：取链端点探测失败，请检查代理地址/后台是否在线', 'error');
          return;
        }
        setUsageChoice({ files });
      })();
      return;
    }
    pendingFetch.current = files;
    addGlobalLog('=====解析下载方式（prase）=====');
    // v1.2.x 复用分家：直链复用按上游过期时间判定（linkStatus），不再看 reuseWindowHours
    addGlobalLog(`prase：选中 ${files.length} 个文件（缓存直链未过期自动复用，其余请求接口）`);
    // 全部命中缓存直链 → 无需 cookie，直接走复用合并
    if (files.every((f) => isReusable(f.fid))) {
      addGlobalLog('prase：全部命中缓存直链，跳过 cookie 弹窗');
      void doFetchLinks(files);
      return;
    }
    // v1.1.9.2 fix1：智能分流 —— 选中含大文件（≥ adapter.cookieInput.sizeThreshold，
    // 夸克约 50MB 实测必 23018）时直接弹登录态填写窗，跳过 cookieWarn（游客态 __pugs
    // 对 23018 无意义）；填完保存即带登录态 cookie 请求，避免一次必然失败的 400 污染代理日志看板。
    // v1.1.9.final：前置条件 qk-guestTurn —— 开关关（默认）= 所有文件一律按登录态处理（最稳妥）；
    // 开关开 = 正常 size 判断，全部 <50MB 时走游客态（不弹窗、不注入登录态整串，随机 __pugs）。
    const loginThreshold = cookieInputReq?.sizeThreshold;
    const guestTurn = prefs.quark?.qkGuestTurn === true;
    if (cookieInputReq && prefs.modals.cookieInput && loginThreshold) {
      const bigFiles = guestTurn ? files.filter((f) => !f.dir && (f.size ?? 0) >= loginThreshold) : files;
      if (bigFiles.length > 0) {
        addGlobalLog(
          guestTurn
            ? `prase：检测到 ${bigFiles.length}/${files.length} 个大文件（≥${Math.round(loginThreshold / 1024 / 1024)}MB，需登录态）—— 直接弹出登录态 cookie 填写窗`
            : `prase：qk-guestTurn 关（默认）—— 全部文件按登录态处理，直接弹出登录态 cookie 填写窗`,
        );
        cookieRetryFiles.current = files;
        setCookieInputWarn(true);
        return;
      }
      // guestTurn 开 + 全部 <50MB：走游客态（scanner 侧不注入登录态整串）
      addGlobalLog('prase：qk-guestTurn 开 + 全部 <50MB —— 模拟游客（随机/捕获 __pugs），不注入登录态 cookie');
      void doFetchLinks(files, true);
      return;
    }
    if (adapter.cookie && prefs.modals.cookieWarn) {
      addGlobalLog(`prase：需要 ${adapter.cookie.displayName} —— 弹窗已出现，等待用户选择（当前捕获 ${getPugs() ? '有值' : '为空'}，解析后代理捕获自动更新）`);
      setCookieWarn({ files });
      return;
    }
    void doFetchLinks(files);
  };

  /**
   * 是否可复用缓存直链（v1.1.5.2）：绿 + 黄（窗口内且 oss 未过期）都可复用/导出，
   * 黄色只是剩余时间不够完整下载（导出后会有提示 toast）。
   */
  const isReusable = (fid: string): boolean => {
    const f = leafNodeOf(fid)?.file;
    return isLinkUsable(links?.get(fid), f?.size);
  };

  /** 真正执行 prase（每个下载响应下发的 __pugs 与该响应的直链绑定，§12）
   * @param guestMode v1.1.9.final：qk-guestTurn 游客模式（不注入登录态整串） */
  const doFetchLinks = async (files: ShareFile[], guestMode = false, usage?: 'CONSUME' | 'PLAY'): Promise<void> => {
    setFetching(true);
    setFetchProgress({ done: 0, total: files.length });
    let backendDownDetected = false;
    try {
      // ① 窗口内复用：未过期直链直接并入结果，不请求接口
      const toFetch: ShareFile[] = [];
      const reused = new Map<string, LinkEntry>();
      for (const f of files) {
        if (isReusable(f.fid)) {
          reused.set(f.fid, links!.get(f.fid)!);
        } else {
          toFetch.push(f);
        }
      }
      if (reused.size > 0) {
        addGlobalLog(`prase：复用缓存直链 ${reused.size}/${files.length}（按上游过期时间判定未过期，不再请求接口）`);
      }
      // ② 新文件走接口（15/批 + 1s 节流）
      let results: LinkResult[] = [];
      if (toFetch.length > 0) {
        addGlobalLog(`prase：发起接口请求 ${toFetch.length} 个（15/批 + 1s 节流）`);
        // v1.4 逐文件进度：onProgress 的 total 是**本批**文件数（core 内部 15/批），
        // 这里按「批切换时把上一批 done 累加为偏移」换算成整体进度（沿用现有进度条，不新造 UI）。
        let progBase = 0;
        let progLastDone = 0;
        results = await fetchLinks(
          { adapter, shareId, stoken, guestMode },
          toFetch,
          {
            batchSize: 15,
            batchIntervalMs: 1000,
            continueOnError: true,
            usage, // v1.4 迅雷取链方案（弹窗选择；undefined = 适配器按设置规则）
            onProgress: (e) => {
              if (e.done < progLastDone) progBase += progLastDone; // 新批：本批 done 归零 → 累加偏移
              progLastDone = e.done;
              setFetchProgress({ done: Math.min(progBase + e.done, toFetch.length), total: toFetch.length });
            },
          },
        );
        addGlobalLog(`prase：接口完成 — ${results.filter((r) => r.ok).length}/${toFetch.length} 成功`);
        // v1.4 后端断线：op 路由 404/405/501/502、网络/CORS、非 JSON、未配置等 →
        // 专属弹窗（一次，不逐文件弹）。分类集中到适配器的 isXunleiOfflineCode。
        backendDownDetected = adapter.id === 'xunlei' && results.some((r) => !r.ok && isXunleiOfflineCode(r.errorCode));
        if (backendDownDetected) {
          setBackendDown(true);
          toast('后端断线了：无法自动取链，请手动转存后自行选择 CONSUME / PLAY 方式取链（见 docs/xunlei-dl-choices.md）', 'error');
        }
      }
      const map = new Map<string, LinkEntry>();
      let okCount = 0;
      reused.forEach((entry, fid) => {
        okCount++;
        map.set(fid, entry);
      });
      results.forEach((r, i) => {
        const f = toFetch[i];
        if (r.ok) okCount++;
        map.set(f.fid, {
          ok: r.ok,
          url: r.url,
          error: r.error,
          fetchedAt: Date.now(),
          cookie: r.cookie, // §12：与该直链同响应的 __pugs
          cookieString: r.cookieString, // v1.1.9：多凭据整串（夸克登录态 + __pugs）
          hash: r.hash, // v1.1.9.final：文件校验 hash（夸克 = md5），导出注释行校验下载完整性
          expiresAt: r.expiresAt, // v1.2.x：直链绝对过期 ms（上游 Expires/expire_time），复用判定主依据
        });
      });
      setLinks((prev) => new Map([...(prev ?? []), ...map]));
      // v1.1.5.3：prase 产物按 fid 落库（开发日志足迹），下次进来自动恢复复用；
      // 失败/终止条目也落库（红色状态跨刷新保留），过期条目由 linkDetailOf 判定后走正常解析按钮
      if (prefs.footprint.keepLogs) {
        await savePraseEntries(shareId, map).catch(() => undefined);
      }
      // v1.1.9：夸克强制登录（23018 超限 / 31001 需登录）→ 弹登录态 cookie 填写窗，保存后自动重试；
      // v1.2.x alipan：缺凭据/过期同样是 31001 哨兵码或 AccessTokenInvalid 串码（auth≈2h 过期常见）
      if (cookieInputReq) {
        const needLogin = toFetch.filter((_, i) => {
          const r = results[i];
          return !r.ok && (r.errorCode === 23018 || r.errorCode === 31001 || r.errorCode === 'AccessTokenInvalid' || r.errorCode === 'AccessTokenExpired');
        });
        if (needLogin.length > 0 && prefs.modals.cookieInput) {
          addGlobalLog(`prase：${needLogin.length} 个文件需要登录态 cookie（${cookieInputReq.keys.map((k) => k.key).join('/')}），弹出填写窗`);
          cookieRetryFiles.current = needLogin;
          setCookieInputWarn(true);
        }
      }
      // v1.3.1·D1（Tzz 定稿）：探测**下沉到 functions**（`POST {代理}/api/credential-pick`，
      // 词表只暴露 hit|guest|none，SPA 拿不到账号集合与凭据本体）；
      // hit → 静默续杯（不提示），guest/none/未配置/未实现 → 弹红色 toast（文案来自适配器常量），
      // 用户填入同账号新凭据后即可复用缓存的转存 file_id，无需再次 copy。
      if (carryReq?.onExpired) {
        const expired = results.some(
          (r) => !r.ok && r.errorCode !== undefined && carryReq.expiredCodes.includes(r.errorCode),
        );
        if (expired) {
          const outcome = await carryReq.onExpired();
          addGlobalLog(
            `prase：滚动更新判定 — ${outcome.reason}（${outcome.action === 'silent' ? '静默续杯，不提示' : '提示用户填入同账号新凭据'}）`,
          );
          if (outcome.action === 'notify') toast(carryReq.messages.expiredToast, 'error');
        }
      }
      // 捕获状态反馈（弹窗已展示过，这里给个结果）：
      if (adapter.cookie) {
        const withCookie = [...map.values()].filter((l) => l.ok && l.cookie).length;
        addGlobalLog(`prase：下载凭据已按文件绑定（${withCookie}/${map.size} 个链接携带同响应 ${adapter.cookie.key}）`);
        if (withCookie === 0) {
          addGlobalLog(`prase：未捕获到 ${adapter.cookie.key} —— 请检查代理通道（x-pugs 头）是否可用，否则导出命令将缺下载凭据`);
        }
      }
      // v1.1.5：解析结果留痕到全局日志（折叠块，仅追踪用，本日志可随时删除；不参与恢复）
      {
        const lines = files.map((f) => {
          const entry = map.get(f.fid);
          const node = leafNodeOf(f.fid);
          const path = node?.path ?? f.fileName;
          const size = f.size ? formatSize(f.size) : '大小未知';
          const type = f.formatType ? ` · ${f.formatType}` : '';
          const cred = entry?.cookie ? `${entry.cookie.key} 有(${entry.cookie.value.length}字符)` : `${adapter.cookie?.key ?? 'cookie'} 无`;
          if (!entry?.ok) return `${path} · ${size}${type} · 失败${entry?.error ? `（${entry.error}）` : ''}`;
          const remain = (() => {
            const exp = entryExpiryMs(entry);
            if (exp === null) return '无过期时间'; // 罕见：直链 URL 无签名过期参数且适配器未填充
            return exp <= Date.now() ? '已过期' : `剩${formatRemain(exp - Date.now())}`;
          })();
          // v1.1.5.3：附直链 URL（分析用），折叠块可一键复制
          return `${path} · ${size}${type} · ${cred} · ${remain} · ${entry.url}`;
        });
        addGlobalLog(`=====解析结果（${files.length} 个文件 · 留痕追踪，本日志可随时删除）=====\n${lines.join('\n')}\n=====解析结果结束=====`);
      }
      const abbr = linkAbbr(url, adapter.id);
      await addRecord({
        shareId,
        url,
        adapterId: adapter.id,
        parsedAt: Date.now(),
        ok: okCount === files.length,
        fileCount: okCount,
        error: okCount === files.length ? undefined : `${files.length - okCount} 个文件失败`,
        kind: 'prase', // v1.1.7：历史页按记录类型显示「解析文件成功」
        filePath: files.length === 1 ? (leafNodeOf(files[0].fid)?.path ?? files[0].fileName) : undefined,
      });
      if (prefs.footprint.keepLogs) {
        await appendLog({
          time: Date.now(),
          level: okCount === files.length ? 'info' : 'debug',
          adapterId: adapter.id,
          url,
          message: `解析下载方式：${abbr}，${okCount}/${files.length} 成功（复用 ${reused.size}）`,
        });
      }
      // ③ 单文件解析失败 → 醒目弹窗（v1.1.4 规范：打开发 modal，关闭发 toast）
      if (files.length === 1 && okCount === 0 && !backendDownDetected) {
        if (prefs.modals.parseFailWarn) {
          setParseFail({ fileName: files[0].fileName });
        } else {
          toast('解析失败，该文件可能已经与供应商断开连接或者在分享中被删除，请刷新资源列表后再试', 'error');
        }
      } else {
        toast(
          okCount === files.length
            ? `解析完成：${okCount} 个文件全部成功`
            : `部分失败：${okCount}/${files.length} 成功，可重试失败项`,
          okCount === files.length ? 'success' : 'error',
        );
      }
      // v1.2.2（wip2 修正）→ v1.3.1：托管状态由响应头 x-panhub-credential: hit|guest|none 表达
      // （旧头 x-panhub-backend: ok 兼容一版）→ 命中正式账号时提示「代理托管账号」已生效，
      // 避免用户在弹窗里白填 cookie（proxy 模式下 localStorage 不参与注入）
      if (!backendOkToastShown.current && getLastProxyBackendOk()) {
        backendOkToastShown.current = true;
        const label = getLastProxyAccountLabel();
        toast(
          label ? `已使用代理托管账号 ${label}（cookie 由后端管理，无需手动填写）` : '已使用代理托管账号（cookie 由后端管理，无需手动填写）',
          'info',
        );
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '批量解析失败', 'error');
    } finally {
      setFetching(false);
      setFetchProgress(null);
    }
  };

  /**
   * v1.3.1：凭据保存后的统一收尾（原「空保存」分支逻辑抽出，供直接落库与覆盖弹窗两条路径共用）
   */
  const retryAfterCredentialSave = (filled: boolean): void => {
    const retry = cookieRetryFiles.current;
    addGlobalLog(`prase：登录态 cookie 已保存（${filled ? '有值' : '清空'}），重试 ${retry.length} 个失败文件`);
    if (filled && retry.length > 0) {
      void doFetchLinks(retry);
    } else if (retry.length > 0) {
      // v1.2.2 拍板之四：未填 cookie → 重试（代理托管/取号模式下后端自动注入账号，重试即成功；
      // 直连无托管才是名副其实的随机游客试探）。
      // v1.2.2 fix（09-03）：预判式 toast 只在**直连**（不存在 selfhost）时准确 —— 代理模式下
      // 后端是否托管就绪只有请求结果能证明：成功 → doFetchLinks 末尾「已使用代理托管账号」toast
      // （backendOkToastShown 去重）；失败 → 行内红 + 弹窗重试入口。此前守卫用
      // getLastProxyBackendOk() 读**上一次**响应头预判：首次 prase 弹窗取消时上一次响应必然
      // 没有该头（09-03 前服务端压根没下发过 x-panhub-backend），取号成功也误报「随机游客」。
      if (getActiveTransport().id !== 'proxy') {
        toast(
          '未检测到 selfhost 也未手动填写 cookie：已按随机游客尝试（大概率直接失败，可用于试探网盘是否支持游客）',
          'info',
        );
      } else {
        addGlobalLog('prase：未手动填写 cookie —— 代理通道已配置，重试结果以服务端实际注入为准');
      }
      void doFetchLinks(retry);
    }
  };

  const retryFailed = (): void => {
    // v1.1.5.2：不可用直链（无/失败/过期）算失败项，可一键重试；绿色/黄色不重试
    const failed = selectedFiles.filter((f) => {
      const l = links?.get(f.fid);
      return !isLinkUsable(l, f.size);
    });
    requestFetchLinks(failed);
  };

  /* ---------- 刷新资源列表（scanner，v1.1.4）：强制重拉目录树，作废全部直链 ---------- */
  const refreshList = async (): Promise<void> => {
    if (refreshingList) return;
    setRefreshingList(true);
    setFetchProgress({ done: 0, total: 1 });
    addGlobalLog('=====获取资源列表（scanner）=====');
    addGlobalLog(`scanner：手动刷新 — ${adapter.name} · ${linkAbbr(url, adapter.id)}${session.jump ? `（jumper ${session.jump.rootPath}）` : ''}`);
    try {
      // v1.1.6 jumper：按目标文件夹重新扫描（不是分享根）；stoken 复用当前会话的（避免额外 token 接口）
      const snap = await fetchListSnapshot(adapter, shareId, url, {
        // v1.3.2：扫描深度 + 大宗判定透传（刷新同样受设置约束）
        maxDepth: prefs.scanDepth,
        bulkThreshold: prefs.bulkThreshold,
        onProgress: (done, total) => setFetchProgress({ done, total }),
        stoken: session.jump ? stoken : undefined,
        rootFile: session.jump?.rootFile,
        rootPath: session.jump?.rootPath,
        rootIsShareRoot: session.jump ? false : undefined,
      });
      setRoot(snap.root);
      setStoken(snap.stoken);
      setListAt(snap.fetchedAt);
      // v1.3.2：刷新后的扫描问题（优先用快照 issues，没有就从新树派生）+ 写全局日志
      const nextIssues = snap.issues?.length ? snap.issues : deriveIssues(snap.root);
      setIssues(nextIssues);
      logScanIssues(nextIssues);
      setLinks(null); // 映射可能变化（增删文件/令牌失效），全部作废重新解析
      // v1.1.5.3：足迹里的直链结果同步作废（fid 映射可能已变化）
      await clearPraseByShareId(shareId).catch(() => undefined);
      // v1.1.6 jumper 不覆盖 trees 快照（子树根不是分享根，复用会污染整棵目录树）
      if (prefs.footprint.keepTrees && !session.jump) {
        await saveTree({
          shareId,
          url,
          adapterId: adapter.id,
          root: snap.root,
          savedAt: snap.fetchedAt,
          fileCount: snap.fileCount,
          totalSize: snap.totalSize,
          stoken: snap.stoken,
        });
      }
      await addRecord({
        shareId,
        url,
        adapterId: adapter.id,
        parsedAt: snap.fetchedAt,
        ok: true,
        fileCount: snap.fileCount,
        title: snap.root.children?.[0]?.file.fileName,
        kind: 'scanner', // v1.1.7：历史页按记录类型显示「获取列表成功」
      });
      if (prefs.footprint.keepLogs) {
        await appendLog({
          time: snap.fetchedAt,
          level: 'info',
          adapterId: adapter.id,
          url,
          message: `手动刷新资源列表：${linkAbbr(url, adapter.id)}，共 ${snap.fileCount} 个文件`,
        });
      }
      // 目录树打印到全局日志（过长自动折叠）+ 刷新标记（v1.1.4 规范日志）
      addGlobalLog(`=====目录树（${snap.fileCount} 个文件 / ${snap.totalSize} 字节）=====\n${renderTreeText(snap.root)}\n=====目录树结束=====`);
      addGlobalLog(`=====资源列表已刷新，当前${hhmmss(snap.fetchedAt)}=====`);
      toast('资源列表已刷新，直链已作废请重新解析', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addGlobalLog(`scanner：刷新失败 — ${message}`);
      toast(`刷新失败：${message}（分享可能已失效）`, 'error');
    } finally {
      setRefreshingList(false);
      setFetchProgress(null);
    }
  };

  /* ---------- 单文件解析（§12：原来“复制直链”的位置改成解析按钮） ---------- */
  /** 代理是否 pages.dev 结尾（v1.1.5.2 兜底防暴力刷 proxy 的启用条件） */
  const isPagesDevProxy = (): boolean =>
    prefs.transport.mode === 'proxy' && prefs.transport.proxyUrl.trim().toLowerCase().endsWith('pages.dev');

  const parseSingleFile = (fid: string): void => {
    const node = leafNodeOf(fid);
    if (!node || node.file.dir) {
      toast('仅支持解析文件', 'error');
      return;
    }
    const existing = links?.get(fid);
    if (existing?.ok && !fetching) {
      // 已解析成功：窗口内未过期 → 直接提示可导出（避免重复请求）；过期 → 重新解析
      if (isReusable(fid)) {
        toast('该文件已解析，勾选后可导出下载命令', 'info');
        return;
      }
      addGlobalLog(`prase：${node.file.fileName} 缓存直链已过期（上游过期时间已到），重新请求接口`);
    }
    // v1.1.5.2 兜底：手动终止后重试单文件 + pages.dev 代理 —— 与上次终止同分同秒 = 高频循环，强制提示
    // v1.1.5.3：同分秒判定太苛刻（真实点击必然跨秒导致 modal 不出现），改为「终止后 5s 内重试」窗口
    if (existing?.terminatedAt && isPagesDevProxy() && Date.now() - existing.terminatedAt < 5000) {
      addGlobalLog('prase：检测到手动终止后短时间内重复解析（疑似高频请求），已拦截并弹出提示');
      setCloudflareWarn(true);
      return;
    }
    requestFetchLinks([node.file]);
  };

  /* ---------- v1.1.6 jumper：0B 文件夹「转到此文件夹」→ 二次获取（新建相关联的链接任务） ---------- */
  /** 收集从分享根到目标文件夹的 fid 链（分享根不入链） */
  const collectFolderChain = (target: TreeNode): Array<{ fid: string; name: string }> => {
    const chain: Array<{ fid: string; name: string }> = [];
    const walk = (n: TreeNode): boolean => {
      if (n.file.fid === target.file.fid) {
        chain.push({ fid: n.file.fid, name: n.file.fileName });
        return true;
      }
      if (!n.children) return false;
      for (const c of n.children) {
        if (walk(c)) {
          chain.push({ fid: n.file.fid, name: n.file.fileName });
          return true;
        }
      }
      return false;
    };
    walk(root);
    chain.reverse(); // 根 → 目标
    if (chain[0]?.fid === root.file.fid) chain.shift(); // 分享根不入链
    return chain;
  };

  const jumpToFolder = (node: TreeNode): void => {
    if (!adapter.buildJumpUrl) {
      toast('该网盘暂不支持文件夹跳转', 'error');
      return;
    }
    const chain = collectFolderChain(node);
    const jumpUrl = adapter.buildJumpUrl(shareId, chain);
    if (!jumpUrl) {
      toast('生成跳转链接失败，请刷新资源列表后重试', 'error');
      return;
    }
    const folderPath = node.path; // 文件夹绝对路径（日志/提示展示）
    const originalTitle = root.children?.[0]?.file.fileName ?? linkAbbr(url, adapter.id); // 原任务 banner 标题
    addGlobalLog(`=====${hhmmss(Date.now())}，跳转到'${folderPath}'=====`);
    addGlobalLog(`${hhmmss(Date.now())} jumper：扫描暂存区，寻找唯一标识符`);
    if (prefs.modals.jumpTip) {
      setJumpWarn({ jumpUrl, folderPath, originalTitle });
    } else {
      doJump(jumpUrl, folderPath, originalTitle);
    }
  };

  /** 真正跳转：历史记录 link 日志最早写入 from/in，然后回输入页自动解析新任务 */
  const doJump = (jumpUrl: string, folderPath: string, originalTitle: string): void => {
    if (prefs.footprint.keepLogs) {
      void appendLog({
        time: Date.now(),
        level: 'info',
        adapterId: adapter.id,
        url: jumpUrl,
        message: `${hhmmss(Date.now())} from '${folderPath}' in '${originalTitle}'`,
      });
    }
    onJump(jumpUrl);
  };

  /* ---------- 隐秘参数（v1.1.7）：<> 按钮 → （可选弹窗）→ 新标签直连官方 API ---------- */
  const openHiddenVolumn = (node: TreeNode): void => {
    if (!adapter.hiddenVolumn || !adapter.buildHiddenVolumnUrl) {
      toast('该网盘暂不支持隐秘参数', 'error');
      return;
    }
    const url = adapter.buildHiddenVolumnUrl({ shareId, stoken, pdirFid: node.file.fid });
    if (!url) {
      toast('构造查询 URL 失败（缺少缓存信息？请刷新资源列表后再试）', 'error');
      return;
    }
    addGlobalLog(`${hhmmss(Date.now())} 隐秘参数：${node.path}（新标签直连官方 API，no-referer，不经过代理）`);
    // v1.1.7 hiddenVolumnHint：开=先弹窗说明字段含义（网盘静态话术）再跳转；关=直接新标签跳转
    if (prefs.advanced.hiddenVolumnHint) {
      setHiddenVolumn({ url, title: adapter.hiddenVolumn.title, body: adapter.hiddenVolumn.body });
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  /* ---------- v1.4 文件级隐秘参数（迅雷）：解析后展示脱敏详情，不发请求 ---------- */
  const openFileHiddenVolumn = (fid: string): void => {
    const cap = adapter.fileHiddenVolumn;
    if (!cap) {
      toast('该网盘暂不支持文件级隐秘参数', 'error');
      return;
    }
    const rows = cap.view(fid);
    if (!rows) {
      toast(cap.emptyHint, 'info');
      return;
    }
    addGlobalLog(`${hhmmss(Date.now())} 隐秘参数（文件）：${leafNodeOf(fid)?.path ?? fid}（就地展示脱敏字段，不发请求）`);
    setFileHidden({ title: cap.title, rows });
  };

  /* ---------- 导出（浏览器直连/复制直链已移除：UC referer 白名单拒绝第三方源，§10.1.4） ---------- */
  const buildExportFiles = (): ExportFile[] => {
    // v1.1.5：curl 也支持保留目录结构（--create-dirs）；仅导出可用的直链（绿+黄，上游过期时间内）
    const keep = keepStructure;
    return selectedFiles
      .filter((f) => isLinkUsable(links?.get(f.fid), f.size))
      .map((f) => {
        const node = leafNodeOf(f.fid);
        const path = node?.path ?? f.fileName;
        const entry = links!.get(f.fid)!;
        // v1.2.2 fix（09-02）：缺凭据提示按网盘/大小标注 —— 夸克大文件 OSS 校验是 __puus，
        // 小文件与 UC 同机制是 __pugs；此前导出命令硬编码 UC __pugs，夸克文件误报且不精准。
        // v1.2.x：alipan 无下载层 cookie（直链 = OSS 签名 + 固定 Referer）→ credLabel 为空，
        // 任务生成器只在 credLabel 存在且缺 cookie 时才写提示注释。
        const credLabel =
          adapter.id === 'quark'
            ? `quark ${(f.size ?? 0) >= QUARK_LOGIN_SIZE ? '__puus' : '__pugs'}`
            : adapter.id === 'uc'
              ? 'UC __pugs'
              : undefined;
        return {
          path: keep ? path : path.split('/').pop() ?? f.fileName,
          url: entry.url,
          size: f.size,
          // v1.2.x 下载层静态头：本会话适配器声明值合并进每文件（curl -A/-e、aria2 --user-agent/--referer、
          // gopeed extra.header 由任务生成器映射）；cookie/cookieString 动态凭据逻辑不受影响
          headers: adapter.downloadHeaders,
          cookie: entry.cookie, // §12：每文件与其直链同响应的 __pugs，merger 按文件注入
          cookieString: entry.cookieString, // v1.1.9：多凭据整串（夸克登录态 + __pugs）
          hash: entry.hash, // v1.1.9.final：文件校验 hash（夸克 = md5），导出注释行校验下载完整性
          credLabel, // v1.2.2 fix（09-02）：缺凭据时 curl 注释里的精准话术
          fid: f.fid, // v1.1.5.2：导出后按 fid 查状态做黄色提醒
        };
      });
  };

  const handleExport = (kind: TaskKind): void => {
    if (fetching) {
      toast('正在解析中，请稍候', 'error');
      return;
    }
    // v1.1.5：curl 已支持保留目录结构（--create-dirs），跨文件夹不再拦截；BatchWarnModal 移除
    doExport(kind);
  };

  const EXPORT_FAIL_MSG = '未选中任何文件或者选中部分含有未解析、已解析但过期的文件';

  const doExport = (kind: TaskKind): void => {
    const files = buildExportFiles();
    if (files.length === 0) {
      // v1.1.4 规范：打开按钮发 modal（醒目），关闭发 toast
      if (prefs.modals.exportFailWarn) {
        addGlobalLog(`task：导出失败 — ${EXPORT_FAIL_MSG}`);
        setExportFail(true);
      } else {
        toast(EXPORT_FAIL_MSG, 'error');
      }
      return;
    }
    addGlobalLog(`=====导出任务（task）=====\ntask：类型 ${kind} · ${files.length} 个文件${keepStructure ? '（保留目录结构）' : ''}`);
    addGlobalLog('task：扫描已解析文件，按文件注入同响应下载凭据（__pugs）');
    const { fileName, content } = exportTask(kind, files, {
      keepStructure,
      outDir: downloader.savePath || undefined,
      // v1.1.9.final：高级设置 → 导出额外参数（此前是假把戏，现在真正拼进任务）
      aria2Extra: prefs.advanced.aria2Extra || undefined,
      gopeedExtra: prefs.advanced.gopeedExtra || undefined,
    });
    downloadFile(fileName, content);
    addGlobalLog(`task：合并完成，已生成 ${fileName}（下载命令已就绪）`);
    toast(`已导出 ${fileName}`, 'success');
    // v1.1.5.2：导出的直链里有黄色（有效但剩余时间不够完整下载）→ 提醒用户
    // v1.1.7：设置 → 弹窗开关 exportYellowWarn：开=弹窗，关=简略 toast（话术不变）
    const exportedWithFid = files.filter((f) => f.fid !== undefined);
    const yellowFiles = exportedWithFid.filter((f) => isLinkYellow(links?.get(f.fid as string), f.size));
    if (yellowFiles.length > 0) {
      addGlobalLog(`task：${yellowFiles.length}/${exportedWithFid.length} 个直链剩余有效期不足以支撑完整下载（黄色状态），已提示用户`);
      if (prefs.modals.exportYellowWarn) {
        setExportYellow(true);
      } else {
        setTimeout(() => {
          toast('部分直链可能无法支持到下载完成了。。建议尽快开始下载或重新解析（一键续杯）', 'warning');
        }, 3200);
      }
    }
  };

  const exportTreeMdFile = (): void => {
    const content = exportTreeMd(root, { format: prefs.treeFormat, detail: prefs.treeDetail });
    downloadFile(`tree-${linkAbbr(url, adapter.id)}.md`, content);
  };

  const exportLogsFile = async (): Promise<void> => {
    const logs = await listLogs(200);
    const abbr = linkAbbr(url, adapter.id);
    const status = logs.length === 0 ? 'u' : links && [...links.values()].every((l) => l.ok) ? 's' : 'm';
    const { fileName, content } = exportLogsMd(abbr, status, logs);
    downloadFile(fileName, content);
    toast(`已导出 ${fileName}`, 'success');
  };

  /* ---------- 推送下载器（v1.1.8：连接&直推，aria2/motrix JSON-RPC、gopeed REST API） ---------- */
  const handlePush = async (): Promise<void> => {
    if (fetching) {
      toast('正在解析中，请稍候', 'error');
      return;
    }
    const files = buildExportFiles();
    if (files.length === 0) {
      // 与导出同一套空选处理：按钮发 modal，关闭发 toast（v1.1.4 规范）
      if (prefs.modals.exportFailWarn) {
        addGlobalLog(`task：推送失败 — ${EXPORT_FAIL_MSG}`);
        setExportFail(true);
      } else {
        toast(EXPORT_FAIL_MSG, 'error');
      }
      return;
    }
    const label = DOWNLOADER_PRESETS[downloader.type].label;
    addGlobalLog(
      `=====推送下载器（push）=====\npush：类型 ${label} · ${files.length} 个文件${keepStructure ? '（保留目录结构）' : ''}`,
    );
    setPushing(true);
    try {
      const r = await pushFilesToDownloader(downloader, files, {
        keepStructure,
        outDir: downloader.savePath || undefined,
      });
      addGlobalLog(`push：${label} 返回 — 成功 ${r.success} / 失败 ${r.failed}`);
      if (!r.ok) addGlobalLog(`push：失败原因 — ${r.message}`);
      toast(r.message, r.ok ? 'success' : 'error');
    } finally {
      setPushing(false);
    }
  };

  /* ---------- 渲染 ---------- */
  // v1.3.2：仅统计可用直链（绿+黄）；选中含绿色文件时批量解析按钮置灰（防重复刷 prase）
  const linkedOkCount = links ? selectedFiles.filter((f) => isLinkUsable(links.get(f.fid), f.size)).length : 0;
  const hasGreenSelected = selectedFiles.some((f) => isLinkGreen(links?.get(f.fid), f.size));

  // v1.3.2：扫描问题 banner（失败/大宗）—— 明细计数 + 去重业务码
  const failedIssues = issues.filter((i) => i.kind === 'failed');
  const bulkIssues = issues.filter((i) => i.kind === 'bulk');
  const failedCodes = [...new Set(failedIssues.map((i) => String(i.code ?? 'unknown')))];
  const failedCodesLabel = failedCodes.slice(0, 5).join('、') + (failedCodes.length > 5 ? '…' : '');
  const bulkThresholdLabel = bulkIssues[0]?.threshold ?? prefs.bulkThreshold;
  const showIssuesBanner = issues.length > 0 && !issuesDismissed;

  return (
    <>
      {/* v1.3.2：本次扫描不完整提示（宽松提示，非错误；「不再弹出」只关本 banner，不动行内提示） */}
      {showIssuesBanner && (
        <div className="card" style={{ borderLeft: '3px solid var(--warn)' }}>
          <div className="card-body">
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 280 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-strong)' }}>扫描结果不完整</div>
                <div className="field-hint" style={{ fontSize: 12.5, marginTop: 4 }}>
                  {failedIssues.length > 0 && (
                    <span style={{ color: 'var(--danger)' }}>
                      {failedIssues.length} 个目录未加载成功（业务码 {failedCodesLabel}），结果不完整
                    </span>
                  )}
                  {failedIssues.length > 0 && bulkIssues.length > 0 && ' · '}
                  {bulkIssues.length > 0 && (
                    <span style={{ color: 'var(--warn)' }}>
                      {bulkIssues.length} 个大宗目录已跳过（阈值 {bulkThresholdLabel}）
                    </span>
                  )}
                </div>
                <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7, color: 'var(--text-dim)' }}>
                  <li>已放宽本地转发限制（120 次/分/IP）：若大量文件夹出现业务码非 200，多半是本站转发层限频，不是上游风控。</li>
                  <li>请打开浏览器 devtools → Network，找到 scan 响应体以确认。</li>
                  <li>隐私：总部后端不记录目录树，只做限频。</li>
                  <li>有大宗目录树查看需求请自建转发代理；scan 完毕后切回原有后端不影响使用（总部公共账号池不受影响）。</li>
                </ul>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setIssuesDismissed(true);
                  try {
                    window.localStorage.setItem(ISSUES_DISMISSED_KEY, '1');
                  } catch {
                    /* 配额/隐私模式静默 */
                  }
                }}
                title="本机不再自动显示该提示（失败/大宗目录的行内提示不受影响）"
              >
                不再弹出
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 工具条：返回 + 链接信息 + 资源列表获取时间（v1.1.5：直链倒计时下沉到文件行标签） */}
      <div className="card">
        <div className="card-head">
          <div className="card-title-row">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
              ← 返回
            </button>
            <h2 className="card-title" style={{ fontSize: 15 }}>
              {adapter.name} · {shareId}
            </h2>
            <span className="field-hint">
              {/* v1.1.7：刷新后显示「首次获取于 xx · 最后刷新于 xx」 */}
              {listAt > firstAt
                ? `资源列表首次获取于 ${formatTime(firstAt)} · 最后刷新于 ${formatTime(listAt)}`
                : `资源列表获取于 ${formatTime(listAt)}`}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-emerald-soft btn-sm"
              onClick={() => void refreshList()}
              disabled={refreshingList || fetching}
              title="重新拉取目录树（作废全部已解析直链）"
            >
              {refreshingList ? `刷新中 ${fetchProgress?.done ?? 0}/${fetchProgress?.total ?? 0}` : '获取最新资源列表'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={exportTreeMdFile} title="导出目录树 md">
              导出目录树
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void exportLogsFile()} title="导出解析日志">
              导出日志
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDownloaderOpen(true)}>
              连接本地下载器
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => requestFetchLinks(selectedFiles)}
              disabled={fetching || refreshingList || hasGreenSelected}
              title={hasGreenSelected ? '选中部分文件直链仍有效（绿色），无需重复解析；如需解析其他文件请取消勾选绿色文件' : undefined}
            >
              {fetching ? `解析中 ${fetchProgress?.done ?? 0}/${fetchProgress?.total ?? 0}` : '批量获取下载链接'}
            </button>
          </div>
        </div>
        <div className="card-body" style={{ paddingTop: 12 }}>
          <FileCheckbox
            selectedCount={selectedFiles.length}
            totalFiles={allLeaves.length}
            onSelectAll={() => selectVisible('all')}
            onSelectInvert={() => selectVisible('invert')}
            onSelectNone={() => selectVisible('none')}
            onSelectByStatus={selectByStatus}
            filterText={filterText}
            onFilterChange={setFilterText}
          />
        </div>
      </div>

      {/* 资源列表 */}
      <div className="card" style={checkColorStyle}>
        <div className="card-head">
          <div className="card-title-row">
            <h2 className="card-title">资源列表</h2>
            <span className="field-hint" style={{ fontSize: 12 }}>
              已选 {selectedFiles.length} 个文件 · {formatSize(selectedSize)}
              {crossFolder && ' · 跨文件夹'}
            </span>
            {/* v1.3.1：勾选行底色调色盘（小 🎨 按钮，插入树面板标题行末尾；不改动其它按钮语义） */}
            <CheckColorPicker value={checkColor} onChange={setCheckColor} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {linkedOkCount > 0 && selectedFiles.length > linkedOkCount && (
              <button type="button" className="btn btn-emerald-soft btn-sm" onClick={retryFailed}>
                重试失败项（{selectedFiles.length - linkedOkCount}）
              </button>
            )}
            <span className="field-hint">导出：</span>
            <div className="segment">
              {(Object.keys(KIND_LABEL) as TaskKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={exportKind === k ? 'active' : ''}
                  onClick={() => setExportKind(k)}
                  disabled={fetching}
                >
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-emerald-soft btn-sm"
              onClick={() => void handlePush()}
              disabled={fetching || pushing}
              title={`推送到本地下载器（${DOWNLOADER_PRESETS[downloader.type].label}：${downloader.rpc}），点击「连接本地下载器」可改`}
            >
              {pushing ? '推送中…' : `推送到${DOWNLOADER_PRESETS[downloader.type].label}`}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => handleExport(exportKind)}
              disabled={fetching}
            >
              导出 {KIND_LABEL[exportKind]} 任务
            </button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12.5, color: 'var(--text-dim)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={keepStructure}
                onChange={(e) => setKeepStructure(e.target.checked)}
              />
              保留目录结构
            </label>
          </div>
        </div>
        <div className="card-body" style={{ paddingTop: 0 }}>
          <DirectoryTree
            rows={flatRows}
            expanded={expanded}
            checked={checked}
            links={links ?? new Map()}
            onToggleDir={(fid) =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(fid)) next.delete(fid);
                else next.add(fid);
                return next;
              })
            }
            onToggleFile={toggleFile}
            onToggleDirAll={toggleDirAll}
            onParseFile={parseSingleFile}
            busy={fetching}
            onJumpToFolder={jumpToFolder}
            showDirProps={prefs.showDirProps}
            dirProps={dirProps}
            onHiddenVolumn={openHiddenVolumn}
            showHiddenVolumn={prefs.advanced.enabled && prefs.advanced.showHiddenVolumn}
            showFileHiddenVolumn={prefs.xunlei.fileHiddenVolumn && Boolean(adapter.fileHiddenVolumn)}
            onFileHiddenVolumn={openFileHiddenVolumn}
            showEtag={prefs.showEtag}
            showLinkDetail={prefs.showLinkDetail}
          />
        </div>
      </div>

      {exportFail && (
        <ExportFailModal
          onClose={() => {
            setExportFail(false);
            // 关闭发 toast（v1.1.4 规范：打开按钮发 modal，关闭发 toast）
            toast(EXPORT_FAIL_MSG, 'error');
          }}
        />
      )}
      {parseFail && (
        <ParseFailModal
          fileName={parseFail.fileName}
          onClose={() => {
            setParseFail(null);
            toast('解析失败，该文件可能已经与供应商断开连接或者在分享中被删除，请刷新资源列表后再试', 'error');
          }}
          onRefresh={() => {
            setParseFail(null);
            void refreshList();
          }}
        />
      )}
      {cloudflareWarn && <CloudflareWarnModal onClose={() => setCloudflareWarn(false)} />}
      {jumpWarn && (
        <JumptoFolderTipModal
          folderPath={jumpWarn.folderPath}
          onConfirm={() => {
            const j = jumpWarn;
            setJumpWarn(null);
            doJump(j.jumpUrl, j.folderPath, j.originalTitle);
          }}
          onCancel={() => setJumpWarn(null)}
        />
      )}
      {downloaderOpen && (
        <DownloaderModal
          onClose={() => {
            setDownloaderOpen(false);
            setDlCfgTick((t) => t + 1); // 重读配置（保存后立即生效）
          }}
        />
      )}
      {cookieWarn && adapter.cookie && (
        <CookieWarnModal
          panName={adapter.name}
          cookie={adapter.cookie}
          capturedValue={adapter.id === 'quark' ? (getQuarkPugs() ?? '') : (getPugs() ?? '')}
          onCancel={() => {
            // v1.1.5：算了吧 = 主动终止本次解析（不再是跳过继续）
            // v1.1.5.3：批量同样标红 —— 整批请求用的是同一个 cookie，终止即整批失败（status:red 手动终止）
            const files = pendingFetch.current ?? [];
            setCookieWarn(null);
            const terminated = new Map<string, LinkEntry>();
            const now = Date.now();
            for (const f of files) {
              // 已解析且仍可用的文件不受影响（复用直链不因终止作废）
              if (isReusable(f.fid)) continue;
              terminated.set(f.fid, { ok: false, url: '', error: '手动终止', fetchedAt: now, terminatedAt: now });
            }
            if (terminated.size > 0) {
              setLinks((prev) => {
                const next = new Map(prev ?? []);
                for (const [fid, entry] of terminated) next.set(fid, entry);
                return next;
              });
              // 终止标记也落库（红色状态跨刷新保留）
              if (prefs.footprint.keepLogs) {
                void savePraseEntries(shareId, terminated).catch(() => undefined);
              }
            }
            addGlobalLog(
              files.length === 1
                ? `prase：用户主动终止解析 — ${files[0].fileName}（cookie 弹窗选“算了吧”，已标红）`
                : `prase：用户主动终止解析 — ${files.length} 个文件的批量任务（cookie 弹窗选“算了吧”，已全部标红）`,
            );
            toast('用户主动终止解析', 'info');
          }}
          onConfirm={() => {
            setCookieWarn(null);
            addGlobalLog('prase：用户已确认，继续解析');
            void doFetchLinks(pendingFetch.current ?? []);
          }}
        />
      )}
      {/* v1.1.9 登录态凭据填写弹窗（夸克 23018/31001 强制登录 / alipan 缺登录态；保存后自动重试失败文件） */}
      {cookieInputWarn && cookieInputReq && (
        <CookieInputModal
          panName={adapter.name}
          cookieInput={cookieInputReq}
          value={cookieInputReq.load ? cookieInputReq.load() : cookieInputReq.wholeString ? '' : {}}
          carryCheck={carryReq?.checkNewAuth}
          carryMessages={carryReq?.messages}
          planSave={carryReq?.planCredentialSave}
          missingHintPrefix={carryReq?.missingHintPrefix}
          onCancel={() => {
            setCookieInputWarn(false);
            const files = cookieRetryFiles.current;
            // 智能分流路径（未发请求）：未请求过的文件标「手动终止」红（与 cookieWarn 算了吧一致）；
            // 失败重试路径：文件已有失败记录，保持红色不动（原行为）。
            const terminated = new Map<string, LinkEntry>();
            const now = Date.now();
            for (const f of files) {
              if (isReusable(f.fid)) continue; // 已解析可用直链不受影响
              if (links?.has(f.fid)) continue; // 已有记录（失败/成功），保持现状
              terminated.set(f.fid, { ok: false, url: '', error: '手动终止', fetchedAt: now, terminatedAt: now });
            }
            if (terminated.size > 0) {
              setLinks((prev) => {
                const next = new Map(prev ?? []);
                for (const [fid, entry] of terminated) next.set(fid, entry);
                return next;
              });
              if (prefs.footprint.keepLogs) {
                void savePraseEntries(shareId, terminated).catch(() => undefined);
              }
            }
            addGlobalLog(
              files.length === 1
                ? `prase：用户放弃填写登录态 cookie — ${files[0].fileName}${terminated.size > 0 ? '（未请求，已标红手动终止）' : '（保持红色可重试）'}`
                : `prase：用户放弃填写登录态 cookie — ${files.length} 个文件${terminated.size > 0 ? '（未请求，已标红手动终止）' : '（保持红色可重试）'}`,
            );
          }}
          onSave={(value) => {
            setCookieInputWarn(false);
            // v1.3.1 凭据快捷更新（alipan）：先离线规划（合并上次暂存 + 必填项 + 账号判定）——
            // 同账号 → 静默合并写入；换号 → 弹「是否覆盖当前暂存区的 userid」等用户选；
            // 必填项不全 → 直接不写、不发请求（A2，按钮本应已置灰，这里兼底）
            if (typeof value === 'string' && carryReq?.planCredentialSave) {
              const plan = carryReq.planCredentialSave(value);
              addGlobalLog(
                `prase：凭据规划 — 账号判定 ${plan.verdict}${plan.missing.length ? `，缺失必填项 ${plan.missing.join(' / ')}` : ''}（合并后长度 ${plan.merged.length}）`,
              );
              if (plan.missing.length > 0) return;
              if (plan.verdict === 'changed' && carryReq.accountSwitchPrompt) {
                setAccountSwitch({ plan });
                return;
              }
              carryReq.applyCredentialSave?.(plan, 'persist');
              retryAfterCredentialSave(Boolean(plan.merged));
              return;
            }
            const filled = typeof value === 'string' ? value.trim().length > 0 : Object.keys(value).length > 0;
            // v1.2.x alipan：整串落库走各适配器 save 钩子（quark 仍存 pan-web:quark-cookie:v1）
            if (typeof value === 'string' && cookieInputReq.save) cookieInputReq.save(value);
            retryAfterCredentialSave(filled);
          }}
        />
      )}
      {/* v1.3.1 账号覆盖确认（阿里云盘特设、强制开启；仅「本次账号 ≠ 上次暂存账号」时出现） */}
      {accountSwitch && carryReq?.accountSwitchPrompt && (
        <AccountOverwriteModal
          title={carryReq.accountSwitchPrompt.title}
          context={carryReq.accountSwitchPrompt.context}
          confirmText={carryReq.accountSwitchPrompt.confirm}
          cancelText={carryReq.accountSwitchPrompt.cancel}
          onConfirm={() => {
            const plan = accountSwitch.plan;
            setAccountSwitch(null);
            carryReq.applyCredentialSave?.(plan, 'persist');
            addGlobalLog(
              `prase：账号变化 — 用户选「${carryReq.accountSwitchPrompt?.confirm}」，覆盖暂存区记录（旧账号的转存映射作废）`,
            );
            retryAfterCredentialSave(Boolean(plan.merged));
          }}
          onCancel={() => {
            const plan = accountSwitch.plan;
            setAccountSwitch(null);
            carryReq.applyCredentialSave?.(plan, 'session');
            addGlobalLog('prase：账号变化 — 用户选「否」，本次输入仅本次有效（内存态，不写 localStorage、不进后端统计）');
            retryAfterCredentialSave(Boolean(plan.merged));
          }}
        />
      )}
      {/* v1.4 文件级隐秘参数弹窗（脱敏字段就地表，不发请求） */}
      {fileHidden && (
        <div className="modal-mask" onClick={() => setFileHidden(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
            <div className="modal-head">
              <h3 className="modal-title">{fileHidden.title}</h3>
              <button type="button" className="modal-close" onClick={() => setFileHidden(null)} aria-label="关闭">
                ✕
              </button>
            </div>
            <div className="modal-body">
              <p style={{ margin: 0, color: 'var(--text-dim)' }}>
                以下字段来自该文件最近一次解析（prase）的详情响应，已脱敏：不含 Authorization、captcha_token，
                直链只报存在性与过期时间。可用于判断后端账号是不是会员号（vip / token_type）。
              </p>
              <div className="table-wrap" style={{ marginTop: 8 }}>
                <table className="uac-table">
                  <tbody>
                    {fileHidden.rows.map((r) => (
                      <tr key={r.label}>
                        <td style={{ whiteSpace: 'nowrap' }}>{r.label}</td>
                        <td style={{ wordBreak: 'break-all' }}>{r.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* v1.1.7 隐秘参数弹窗（确认后新标签直连官方 API，no-referer） */}
      {hiddenVolumn && (
        <HiddenVolumnModal
          title={hiddenVolumn.title}
          body={hiddenVolumn.body}
          onOpen={() => {
            window.open(hiddenVolumn.url, '_blank', 'noopener,noreferrer');
            setHiddenVolumn(null);
          }}
          onClose={() => setHiddenVolumn(null)}
        />
      )}
      {/* v1.4 迅雷取链方案选择（批量只弹一次；默认自动 = 按设置规则） */}
      {usageChoice && (
        <div className="modal-mask" onClick={() => setUsageChoice(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <div className="modal-head">
              <h3 className="modal-title">选择取链方案，暂不支持云解压</h3>
              <button type="button" className="modal-close" onClick={() => setUsageChoice(null)} aria-label="关闭">
                ✕
              </button>
            </div>
            <div className="modal-body">
              <p style={{ margin: 0, color: 'var(--text-dim)' }}>
                影响取直链接口的 usage 参数：<strong>PLAY</strong> 通常更快（压缩包有奇效），<strong>CONSUME</strong> 为默认。
                选定后本次批次全部文件使用该方案；更多差异见{' '}
                <a
                  href="https://github.com/tzz1021/panweb-parser/blob/master/docs/xunlei-dl-choices.md"
                  target="_blank"
                  rel="noreferrer"
                >
                  docs/xunlei-dl-choices.md
                </a>
                。
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const f = usageChoice.files;
                    setUsageChoice(null);
                    void doFetchLinks(f, false);
                  }}
                >
                  自动（按设置规则）
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const f = usageChoice.files;
                    setUsageChoice(null);
                    void doFetchLinks(f, false, 'CONSUME');
                  }}
                >
                  CONSUME（默认）
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const f = usageChoice.files;
                    setUsageChoice(null);
                    void doFetchLinks(f, false, 'PLAY');
                  }}
                >
                  PLAY（流式，通常更快）
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* v1.4 后端断线专属弹窗（一次即可，不逐文件弹） */}
      {backendDown && (
        <div className="modal-mask" onClick={() => setBackendDown(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <div className="modal-head">
              <h3 className="modal-title">后端断线了。。。</h3>
              <button type="button" className="modal-close" onClick={() => setBackendDown(false)} aria-label="关闭">
                ✕
              </button>
            </div>
            <div className="modal-body">
              <p style={{ margin: 0, color: 'var(--text-dim)' }}>
                无法自动取链（托管后端未连接 / 未配置）。请<strong>手动转存</strong>后，自行选择{' '}
                <strong>CONSUME</strong> / <strong>PLAY</strong> 方式取链；方案差异见{' '}
                <a
                  href="https://github.com/tzz1021/panweb-parser/blob/master/docs/xunlei-dl-choices.md"
                  target="_blank"
                  rel="noreferrer"
                >
                  docs/xunlei-dl-choices.md
                </a>
                。
              </p>
            </div>
          </div>
        </div>
      )}
      {/* v1.1.7 导出包含黄色标记 → 弹窗（设置开关 exportYellowWarn，关=简略 toast） */}
      {exportYellow && <ExportYellowModal onClose={() => setExportYellow(false)} />}
      {/* v1.1.7 复用会话恢复折叠状态询问弹窗 */}
      {restoreAsk && (
        <RestoreCollapsedModal
          savedAtLabel={restoreAsk.savedAtLabel}
          onRestore={() => {
            // 好的：显式恢复已保存的折叠状态（初始展开态已应用，这里再应用一次兜底）
            const saved = readCollapsed();
            if (saved) setExpanded(new Set(saved.fids.length > 0 ? saved.fids : allDirIds));
            setRestoreAsk(null);
          }}
          onDiscard={() => {
            // 不用了：丢弃上次状态，回到默认全展开
            setExpanded(new Set(allDirIds));
            setRestoreAsk(null);
          }}
        />
      )}
    </>
  );
}
