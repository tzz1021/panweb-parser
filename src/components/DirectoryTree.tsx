/**
 * 目录树（docs/STRUCTURE.md：src/components/DirectoryTree.tsx）
 *
 * 展示性组件：树形缩进 + 勾选（文件）/ 展开收起（目录）+ 大小/时间/操作列。
 * 目录行显示 static 图标区分 file/folder（参考 pdpb.cn）。
 * 勾选状态由父级（ResultPage）持有，本组件只渲染与回调。
 */
import type { JSX } from 'react';
import type { ShareFile } from '../adapters/types';
import type { LinkEntry, TreeNode } from '../core/types';
import { formatSize, formatTime } from '../utils/format';
import { linkDetailOf, linkStatusLabel, type LinkDetail, type LinkStatusKind } from '../utils/linkStatus';

/** 树节点扁平行（ResultPage 预计算：按展开状态拍平 + 缩进） */
export interface TreeRow {
  node: TreeNode;
  depth: number;
}

export interface DirectoryTreeProps {
  rows: TreeRow[];
  /** 已展开的目录 fid 集合 */
  expanded: ReadonlySet<string>;
  /** 已勾选的文件 fid 集合 */
  checked: ReadonlySet<string>;
  /** fid → 直链结果（批量解析后；含获取时间/终止标记，v1.1.5） */
  links: ReadonlyMap<string, LinkEntry>;
  onToggleDir: (fid: string) => void;
  onToggleFile: (fid: string) => void;
  onToggleDirAll: (node: TreeNode) => void;
  /** 单文件解析（§12：原“复制直链”位置改解析按钮）；缺省不显示 */
  onParseFile?: (fid: string) => void;
  /** 解析进行中（禁用按钮，防连点） */
  busy?: boolean;
  /** 跳转文件夹回调（未加载成功 / 大宗跳过的目录二次获取，v1.1.6 / v1.3.2）；缺省不显示按钮 */
  onJumpToFolder?: (node: TreeNode) => void;
  /** 显示属性：文件夹内部文件和子文件夹个数（v1.1.6） */
  showDirProps?: boolean;
  /** 文件夹属性统计（fid → {文件数, 子文件夹数}，父级预计算，避免逐行递归） */
  dirProps?: ReadonlyMap<string, { files: number; dirs: number }>;
  /** v1.1.7 隐秘参数：文件夹行 <> 按钮（开发者直连官方 API）；缺省不显示 */
  onHiddenVolumn?: (node: TreeNode) => void;
  /** v1.1.7 高级功能：显示隐秘参数按钮 */
  showHiddenVolumn?: boolean;
  /**
   * v1.4：**文件行**的隐秘参数按钮（解析后可就地看脱敏详情，不发请求）；
   * 两个 props 都给才渲染（父级已按设置 + 适配器能力门开）
   */
  showFileHiddenVolumn?: boolean;
  onFileHiddenVolumn?: (fid: string) => void;
  /** v1.1.7 显示 etag（最右列“校验和”，离线从数据库读取） */
  showEtag?: boolean;
  /** v1.1.7 显示详细的解析时间和有效期（上次HH:MM剩xHxM） */
  showLinkDetail?: boolean;
}

export function DirectoryTree({
  rows,
  checked,
  links,
  onToggleDir,
  onToggleFile,
  onToggleDirAll,
  onParseFile,
  busy,
  onJumpToFolder,
  showDirProps,
  dirProps,
  onHiddenVolumn,
  showHiddenVolumn,
  showFileHiddenVolumn,
  onFileHiddenVolumn,
  showEtag,
  showLinkDetail,
}: DirectoryTreeProps): JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon">📂</span>
        <span>暂无解析数据</span>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="file-table">
        <thead>
          <tr>
            <th className="col-name">名称</th>
            <th className="col-num">大小</th>
            {/* v1.1.7：隐秘参数按钮列（大小与创建时间之间，纯文本 <>，不污染 padding） */}
            <th className="col-hidden" style={{ width: 44 }} />
            <th className="col-num">创建时间</th>
            <th className="col-action">操作</th>
            {showEtag && <th className="col-num">校验和</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ node, depth }) => {
            const f = node.file;
            const isDir = Boolean(f.dir);
            const link = links.get(f.fid);
            const detail: LinkDetail = linkDetailOf(link, f.size);
            const status: LinkStatusKind = detail.kind === 'green' ? 'green' : detail.kind === 'yellow' ? 'yellow' : detail.kind === 'failed' || detail.kind === 'terminated' ? 'red' : 'white';
            const rowClass =
              status === 'green' ? 'file-row--green' : status === 'yellow' ? 'file-row--yellow' : status === 'red' ? 'file-row--red' : '';
            // v1.3.1：打对钩的行加 .file-row--checked（自定义底色/主题默认高亮）；
            // 目录行的勾选态由子树推导（dirChecked），与勾选框显示保持一致。
            // 优先级：status 红/黄/绿 > 勾选底色，靠 index.css 里的复合选择器（tr.file-row--checked.file-row--green）保证。
            const isChecked = isDir ? dirChecked(node, checked) : checked.has(f.fid);
            const trClass = `${rowClass}${isChecked ? ' file-row--checked' : ''}`.trim();
            // v1.1.7：详细状态文本颜色（设置开启时显示）
            const statusColor =
              status === 'green'
                ? 'var(--ok, #28a745)'
                : status === 'yellow'
                  ? 'var(--warn, #d4a017)'
                  : status === 'red'
                    ? 'var(--danger)'
                    : 'var(--text-dim)';
            return (
              <tr key={f.fid} className={trClass}>
                <td className="col-name">
                  <div className="tree-row">
                    {depth > 0 && <span className="tree-spacer">{'\u00A0'.repeat((depth - 1) * 4)}├─ </span>}
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => (isDir ? onToggleDirAll(node) : onToggleFile(f.fid))}
                      title={isDir ? '勾选/取消该目录下全部文件' : undefined}
                    />
                    <span
                      className="tree-row file-name"
                      style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: isDir ? 'pointer' : 'default' }}
                      onClick={isDir ? () => onToggleDir(f.fid) : undefined}
                    >
                      <span className="file-icon">{isDir ? '📁' : '📄'}</span>
                      <span className={isDir ? 'file-name file-name--dir' : 'file-name'}>{f.fileName}</span>
                    </span>
                    <span className={`meta-tag ${isDir ? 'meta-tag--folder' : 'meta-tag--file'}`}>
                      {isDir ? 'folder' : 'file'}
                    </span>
                    {/* v1.1.6 显示属性：文件夹内部文件和子文件夹个数（未加载成功/大宗跳过的目录无子级，故无统计数据） */}
                    {isDir && showDirProps && dirProps?.get(f.fid) && (
                      <span className="field-hint" style={{ fontSize: 11.5, marginLeft: 2 }}>
                        {dirProps.get(f.fid)!.files} 文件 · {dirProps.get(f.fid)!.dirs} 文件夹
                      </span>
                    )}
                  </div>
                </td>
                <td className="col-num">{formatSize(node.size)}</td>
                {/* v1.1.7：隐秘参数按钮（仅文件夹行；开发者用缓存 stoken + fid 直连官方 detail API） */}
                <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                  {isDir && showHiddenVolumn && onHiddenVolumn && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ padding: '1px 6px', fontFamily: 'monospace', fontSize: 12 }}
                      onClick={() => onHiddenVolumn(node)}
                      title="隐秘参数（仅限开发者）：使用缓存信息直连官方 API 查看该文件夹原始字段"
                    >
                      {'<>'}
                    </button>
                  )}
                </td>
                <td className="col-num">{formatTime(f.modifiedAt)}</td>
                <td className="col-action">
                  {/* v1.1.5.3：移除每行 status:xxx 文本（保留四色行底色 + 状态按钮） */}
                  {/* v1.4：文件行隐秘参数（迅雷）——解析后可就地看脱敏详情，不发请求 */}
                  {!isDir && showFileHiddenVolumn && onFileHiddenVolumn && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ padding: '1px 6px', fontFamily: 'monospace', fontSize: 12, marginRight: 6 }}
                      onClick={() => onFileHiddenVolumn(f.fid)}
                      title="隐秘参数（仅限开发者）：查看该文件最近一次解析的脱敏详情字段（不发请求）"
                    >
                      {'<>'}
                    </button>
                  )}
                  {/* v1.1.7：设置开启时显示详细状态文本（上次HH:MM剩xHxM） */}
                  {!isDir && showLinkDetail && link && (
                    <span className="field-hint" style={{ color: statusColor, marginRight: 6 }}>
                      {linkStatusLabel(link, f.size)}
                    </span>
                  )}
                  {/* v1.1.7：yellow 行预留状态文本宽度占位（按钮与 white 行错开，对齐一致性） */}
                  {!isDir && !showLinkDetail && detail.kind === 'yellow' && link && onParseFile && (
                    <span className="field-hint" style={{ visibility: 'hidden', marginRight: 6 }}>
                      {linkStatusLabel(link, f.size)}
                    </span>
                  )}
                  {/* v1.3.2：0B 判据已废弃（children=undefined 且 size=0 混合了空目录/失败/大宗三种语义）——
                      改按契约字段 scanError / bulkSkipped 分别提示，二者互斥（失败优先）。 */}
                  {isDir && node.scanError && (
                    <>
                      <span className="field-hint" style={{ color: 'var(--danger)', marginRight: 6 }}>
                        请求业务码 {node.scanError.code}，内容不完整
                      </span>
                      {onJumpToFolder && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => onJumpToFolder(node)}
                          title="上游/转发失败导致该文件夹未能列出目录树，可单独重扫该目录（二次获取，新建相关联的链接任务）"
                        >
                          转到此文件夹
                        </button>
                      )}
                    </>
                  )}
                  {isDir && node.bulkSkipped && (
                    <>
                      <span className="field-hint" style={{ color: 'var(--warn)', marginRight: 6 }}>
                        大宗（{node.bulkSkipped.count}  &gt;  {node.bulkSkipped.threshold}）
                      </span>
                      {onJumpToFolder && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => onJumpToFolder(node)}
                          title="一级对象数超过阈值，按设置主动跳过（保持折叠），可单独扫描该目录查看"
                        >
                          转到此文件夹
                        </button>
                      )}
                    </>
                  )}
                  {!isDir && detail.kind === 'failed' && onParseFile && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => onParseFile(f.fid)}
                      disabled={busy}
                      title="网络等不可抗拒因素导致失败，点击重试"
                    >
                      重试
                    </button>
                  )}
                  {!isDir && detail.kind === 'expired' && onParseFile && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => onParseFile(f.fid)}
                      disabled={busy}
                      title="直链已过期，一键续杯（重新获取下载链接）"
                    >
                      一键续杯
                    </button>
                  )}
                  {!isDir && detail.kind === 'terminated' && onParseFile && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => onParseFile(f.fid)}
                      disabled={busy}
                      title="上次手动终止，重新解析该文件"
                    >
                      重新解析
                    </button>
                  )}
                  {/* v1.1.7：yellow（有效但剩余时间不够完整下载）也可单文件重新解析（续杯） */}
                  {!isDir && detail.kind === 'yellow' && onParseFile && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => onParseFile(f.fid)}
                      disabled={busy}
                      title="剩余有效期可能不足以支撑完整下载，重新解析（续杯）"
                    >
                      重新解析
                    </button>
                  )}
                  {!isDir && detail.kind === 'none' && onParseFile && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => onParseFile(f.fid)}
                      disabled={busy}
                      title="解析该文件（需 cookie 的网盘会先弹窗）"
                    >
                      解析
                    </button>
                  )}
                </td>
                {/* v1.1.7：校验和列（etag 种类/支持情况见 UAC 表；离线从数据库读取，UC 不支持显示 —） */}
                {showEtag && <td className="col-num">{isDir ? '—' : f.md5 || f.sha1 || '—'}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 目录勾选态：子树全部勾选才显示勾选 */
function dirChecked(node: TreeNode, checked: ReadonlySet<string>): boolean {
  if (!node.children) return false;
  return node.children.every((c) => (c.file.dir ? dirChecked(c, checked) : checked.has(c.file.fid)));
}

/** 工具：把树拍平成行（按 expanded 展开状态），供 ResultPage 使用 */
export function flattenTree(root: TreeNode, expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (node: TreeNode, depth: number): void => {
    rows.push({ node, depth });
    if (node.file.dir && node.children && expanded.has(node.file.fid)) {
      for (const child of node.children) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

/** 工具：收集某节点下全部叶子文件 */
export function collectLeaves(node: TreeNode, out: ShareFile[] = []): ShareFile[] {
  if (node.children) {
    for (const c of node.children) collectLeaves(c, out);
  } else if (!node.file.dir) {
    out.push(node.file);
  }
  return out;
}
