/**
 * 网盘种类横向表格（参考 pdpb.cn chips 行，HANDOFF 附件 UAC 表 10 盘）
 *
 * 两种形态：
 * - 首页展示：UC 可用可高亮，其余灰置灰，最右侧"更多网盘适配中..."（lastChip='coming'）
 * - 历史页筛选：全部可点（选中高亮），最右侧"全部"（lastChip='all'）
 *
 * logo 支持（1.0.1）：public/logos/<id>.png 存在则显示图片，缺失/加载失败回退短字。
 */
import { useState } from 'react';
import type { JSX } from 'react';

export interface PanMeta {
  id: string;
  short: string;
  name: string;
  available: boolean;
  /** 图标路径（public/logos/<id>.png，缺省回退短字） */
  logo?: string;
}

/** 10 盘（顺序同 HANDOFF 附件 UAC 表）+ 115（更多网盘，1.0.3 图标就位） */
export const PAN_LIST: PanMeta[] = [
  { id: 'baidu', short: '毒盘', name: '百度网盘', available: false, logo: '/logos/baidupan.png' },
  { id: 'quark', short: '夸', name: '夸克网盘', available: true, logo: '/logos/quark2.png' },
  { id: 'uc', short: 'UC', name: 'UC 网盘', available: true, logo: '/logos/UC2.png' },
  { id: 'alipan', short: '阿里', name: '阿里云盘', available: true, logo: '/logos/alipan-open.png' },
  { id: 'mobile', short: '移动', name: '移动云盘', available: false, logo: '/logos/139-2.png' },
  { id: 'ecloud', short: '翼', name: '天翼云盘', available: false, logo: '/logos/cloud189.png' },
  { id: 'ctt', short: '城', name: '城通网盘', available: false, logo: '/logos/ctfile.png' },
  { id: '123', short: '123', name: '123 网盘', available: false, logo: '/logos/123pan.png' },
  { id: 'xunlei', short: '迅', name: '迅雷网盘', available: true, logo: '/logos/xunleiyunpan.png' },
  { id: 'guangya', short: '光', name: '光鸭', available: false, logo: '/logos/guangyapan.png' },
  { id: '115', short: '115', name: '115 网盘', available: false, logo: '/logos/115open.png' },
];

export interface PanTableProps {
  /** 首页：detect 命中时高亮的盘 id */
  highlightId?: string | null;
  /** 筛选模式：当前选中的盘 id 或 'all'（提供 onSelect 即进入筛选模式） */
  selectedId?: string | null;
  /** 筛选模式：点击某盘/全部 */
  onSelect?: (id: string | 'all') => void;
  /** 最右侧尾巴：'coming' = 更多网盘适配中...（首页）；'all' = 全部（历史页） */
  lastChip?: 'coming' | 'all';
}

/** 单个盘 chip（logo 失败自动回退短字） */
function Chip({ pan, active, onClick }: { pan: PanMeta; active: boolean; onClick?: () => void }): JSX.Element {
  const [imgFailed, setImgFailed] = useState(false);
  const cls = [
    'pan-chip',
    pan.available ? 'pan-chip--available' : 'pan-chip--disabled',
    active ? 'pan-chip--highlight' : '',
    onClick ? 'pan-chip--clickable' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const inner = (
    <>
      {pan.logo && !imgFailed ? (
        <img
          src={pan.logo}
          alt={pan.name}
          style={{ width: 16, height: 16, objectFit: 'contain' }}
          onError={() => setImgFailed(true)}
        />
      ) : (
        <span className="chip-short">{pan.short}</span>
      )}
      <span>{pan.available ? pan.name : pan.name.replace(/网盘$/, '')}</span>
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick} title={pan.name}>
        {inner}
      </button>
    );
  }
  return (
    <span className={cls} title={pan.available ? pan.name : `${pan.name}（适配中）`}>
      {inner}
    </span>
  );
}

export function PanTable({ highlightId, selectedId, onSelect, lastChip = 'coming' }: PanTableProps): JSX.Element {
  return (
    <div className="pan-chips">
      {PAN_LIST.map((pan) => (
        <Chip
          key={pan.id}
          pan={pan}
          active={onSelect ? selectedId === pan.id : highlightId === pan.id}
          onClick={onSelect ? () => onSelect(pan.id) : undefined}
        />
      ))}
      {lastChip === 'all' && onSelect ? (
        <button
          type="button"
          className={`pan-chip pan-chip--coming ${selectedId === 'all' ? 'pan-chip--highlight' : ''}`}
          onClick={() => onSelect('all')}
        >
          全部
        </button>
      ) : (
        <span className="pan-chip pan-chip--coming">更多网盘适配中...</span>
      )}
    </div>
  );
}
