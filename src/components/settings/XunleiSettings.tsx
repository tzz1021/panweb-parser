/**
 * 迅雷云盘专属设置（docs/STRUCTURE.md：src/components/settings/XunleiSettings.tsx，v1.4）
 *
 * 三项：
 * - scan 单页条数（默认 30 = 官方 web 默认；改动后下次获取资源列表生效）
 * - 单页不够时按「大宗文件判定阈值」重跑一次（少翻几页）
 * - 解析后是否允许在文件行看「隐秘参数」（脱敏；需先解析该文件）
 *
 * 说明：迅雷的 captcha 身份与盐表**不在前端**（restore/download 的 captcha_token 由代理/后端注入，
 * web 端 captcha_sign 前端算不出、后端也不下发），所以这里没有任何凭据类配置项。
 */
import type { JSX } from 'react';
import type { XunleiPrefs } from '../../core/types';
import { Switch } from './UacTable';

export interface XunleiSettingsProps {
  xunlei: XunleiPrefs;
  onChange: (patch: Partial<XunleiPrefs>) => void;
}

export function XunleiSettings({ xunlei, onChange }: XunleiSettingsProps): JSX.Element {
  return (
    <div className="settings-section">
      <div className="settings-section-title">迅雷云盘</div>
      <div className="switch-row">
        <div>
          <div className="switch-label">scan 单页条数</div>
          <div className="switch-sub">
            官方 web 默认 30；调大能减少翻页次数，但一次拉更多对象更容易触发风控（0/非法值回退 30）；改动后下次获取资源列表生效
          </div>
        </div>
        <input
          className="input"
          type="number"
          min={0}
          style={{ width: 90, padding: '6px 10px' }}
          value={xunlei.scanLimit}
          onChange={(e) => onChange({ scanLimit: Math.max(0, Number(e.target.value) || 0) })}
        />
      </div>
      <div className="switch-row">
        <div>
          <div className="switch-label">单页不够时按大宗阈值重跑</div>
          <div className="switch-sub">
            首屏只有 30 条且返回 next_page_token 时，改用「大宗文件判定」阈值（默认 100）再拉一次；仍带游标才按页续拉
          </div>
        </div>
        <Switch on={xunlei.bulkRetry} onChange={(v) => onChange({ bulkRetry: v })} label="单页不够时按大宗阈值重跑" />
      </div>
      <div className="switch-row">
        <div>
          <div className="switch-label">解析后显示文件隐秘参数</div>
          <div className="switch-sub">
            需先解析该文件才可见：展示详情接口的 device_id / share_id / task_id、links 的 expire / token_type 等脱敏字段（不含任何凭据本体），便于判断后端账号是不是会员号
          </div>
        </div>
        <Switch
          on={xunlei.fileHiddenVolumn}
          onChange={(v) => onChange({ fileHiddenVolumn: v })}
          label="解析后显示文件隐秘参数"
        />
      </div>
    </div>
  );
}
