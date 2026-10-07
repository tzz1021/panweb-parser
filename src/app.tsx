/**
 * 应用根组件（docs/STRUCTURE.md：src/app.tsx）
 *
 * hash 路由：/#/（输入页）/ /#/result（结果页）/ /#/dev（开发页）
 * 解析会话（ParseSession）在 App 层持有：HomePage 产出，ResultPage 消费。
 * Header/Footer 全局共享；设置面板为全局弹窗。
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { HomePage } from './pages/HomePage';
import { ResultPage } from './pages/ResultPage';
import { HistoryPage } from './pages/HistoryPage';
import { DevPage } from './pages/DevPage';
import { SettingsModal } from './components/SettingsModal';
import { ThemeToggle } from './components/ThemeToggle';
import { ToastProvider } from './components/Toast';
import type { ParseSession } from './core/types';

/** 仓库地址（占位：仓库建好后指向真实地址） */
const REPO_URL = 'https://github.com/tzz1021/panweb-parser';

/** hash 路由 hook */
function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = (): void => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

type View = 'home' | 'result' | 'history' | 'dev';

/** 全局页脚（HANDOFF 附件：居中小组字三段） */
function SiteFooter(): ReactNode {
  return (
    <footer className="site-footer">
      <p className="f1" style={{ margin: 0 }}>
        本站完全开源免费，如果通过付费获取到请立即申请退款并差评
      </p>
      <p className="f2" style={{ margin: 0 }}>
        核心功能参考开源项目{' '}
        <a href="https://github.com/hmjz100/LinkSwift" target="_blank" rel="noreferrer">
          LinkSwift
        </a>{' '}
        · UI 部分参考{' '}
        <a href="https://pdpb.cn" target="_blank" rel="noreferrer">
          pdpb.cn
        </a>
      </p>
      <p className="f3" style={{ margin: 0 }}>
        功能更全、自托管文档更详细的请查看{' '}
        <a href="https://github.com/qaiu/netdisk-fast-download" target="_blank" rel="noreferrer">
          nfd 云解析
        </a>
      </p>
    </footer>
  );
}

/** 全局页头（logo 占位 + 查看历史 + 主题灯泡 + 设置 + 仓库地址带 GitHub 图标） */
function SiteHeader({ onOpenSettings }: { onOpenSettings: () => void }): ReactNode {
  return (
    <header className="site-header">
      <a
        className="brand"
        href="#/"
        onClick={() => {
          // 首页点击品牌回输入页
        }}
      >
        <span className="brand-logo">☁️</span>
        <span className="brand-name">panweb-parser</span>
      </a>
      <div className="header-actions">
        <button type="button" className="btn btn-ghost" onClick={() => (window.location.hash = '#/history')}>
          查看历史
        </button>
        {/* v1.3.1：夜间模式灯泡（三态轮换；header 全局共享，所有页面都有） */}
        <ThemeToggle />
        <button type="button" className="btn btn-ghost" onClick={onOpenSettings} title="偏好设置">
          ⚙️ 设置
        </button>
        <a className="btn btn-secondary btn-sm" href={REPO_URL} target="_blank" rel="noreferrer">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true" style={{ marginRight: 4 }}>
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
          </svg>
          仓库地址
        </a>
      </div>
    </header>
  );
}

export function App(): ReactNode {
  const hash = useHashRoute();
  const [session, setSession] = useState<ParseSession | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingParse, setPendingParse] = useState<{ url: string; autoParse?: boolean } | null>(null);

  let view: View = 'home';
  if (hash.startsWith('#/dev')) view = 'dev';
  else if (hash.startsWith('#/history')) view = 'history';
  else if (hash.startsWith('#/result')) view = 'result';

  // 直接 URL 进 #/result 但无会话 → 回输入页
  useEffect(() => {
    if (view === 'result' && !session) {
      window.location.hash = '#/';
    }
  }, [view, session]);

  return (
    <ToastProvider>
      <SiteHeader onOpenSettings={() => setSettingsOpen(true)} />
      <div className="page">
        {view === 'result' && session ? (
          <ResultPage
            session={session}
            onBack={() => {
              setSession(null);
              window.location.hash = '#/';
            }}
            onJump={(jumpUrl) => {
              // v1.1.6 jumper：回输入页自动触发新任务（0B 文件夹二次获取）
              setPendingParse({ url: jumpUrl, autoParse: true });
              window.location.hash = '#/';
            }}
          />
        ) : view === 'history' ? (
          <HistoryPage
            onReparse={(url, autoParse) => {
              setPendingParse({ url, autoParse });
              window.location.hash = '#/';
            }}
          />
        ) : view === 'dev' ? (
          <DevPage />
        ) : (
          <HomePage
            pending={pendingParse}
            onOpenSettings={() => setSettingsOpen(true)}
            onParsed={(s) => {
              setSession(s);
              setPendingParse(null);
              window.location.hash = '#/result';
            }}
          />
        )}
      </div>
      <SiteFooter />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </ToastProvider>
  );
}
