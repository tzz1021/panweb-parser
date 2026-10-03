/**
 * 偏好设置弹窗（HANDOFF 附件：UAC 表 / 默认方式 / 足迹 三块）
 * 修改即存（localStorage，core/preferences.ts）。
 */
import { useState } from 'react';
import type { JSX } from 'react';
import { getPreferences, resetPreferences, setPreferences } from '../core/preferences';
import type { Preferences } from '../core/types';
import { useToast } from './Toast';
import { UacTable } from './settings/UacTable';
import { DefaultMode } from './settings/DefaultMode';
import { FootprintOpts } from './settings/FootprintOpts';
import { AdvancedSettings } from './settings/AdvancedSettings';
import { QuarkSettings } from './settings/QuarkSettings';
import { XunleiSettings } from './settings/XunleiSettings';

/** 备份文件名（v1.1.7） */
export const SETTING_BAK_FILE = 'panhub_setting_bak.json';

/** 下载文件（Blob 直存） */
function downloadFile(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

export interface SettingsModalProps {
  onClose: () => void;
}

export function SettingsModal({ onClose }: SettingsModalProps): JSX.Element {
  const [prefs, setPrefs] = useState<Preferences>(() => getPreferences());
  const { toast } = useToast();

  const apply = (patch: Partial<Preferences>): void => {
    setPrefs((prev) => {
      const next = setPreferences(patch);
      return { ...prev, ...next };
    });
  };

  /** v1.1.7：导出偏好备份 panhub_setting_bak.json */
  const exportBackup = (): void => {
    downloadFile(SETTING_BAK_FILE, JSON.stringify(getPreferences(), null, 2));
    toast(`已导出 ${SETTING_BAK_FILE}`, 'success');
  };

  /** v1.1.7：导入偏好备份（与 DEFAULTS 深合并，缺字段自动补默认） */
  const importBackup = (file: File | undefined): void => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as Partial<Preferences>;
        if (typeof parsed !== 'object' || parsed === null) {
          throw new Error('备份文件不是 JSON 对象');
        }
        setPreferences(parsed);
        setPrefs(getPreferences());
        toast('偏好设置已导入', 'success');
      } catch (err) {
        toast(`导入失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    };
    reader.onerror = () => toast('读取备份文件失败', 'error');
    reader.readAsText(file);
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="modal-head">
          <h3 className="modal-title">偏好设置</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <UacTable
            modals={prefs.modals}
            onModalsChange={(patch) => apply({ modals: { ...prefs.modals, ...patch } })}
            transport={prefs.transport}
            onTransportChange={(patch) => apply({ transport: { ...prefs.transport, ...patch } })}
          />
          <DefaultMode prefs={prefs} onChange={apply} />
          <FootprintOpts footprint={prefs.footprint} onChange={(patch) => apply({ footprint: { ...prefs.footprint, ...patch } })} />
          <AdvancedSettings advanced={prefs.advanced} onChange={(patch) => apply({ advanced: { ...prefs.advanced, ...patch } })} />
          <QuarkSettings quark={prefs.quark} onChange={(patch) => apply({ quark: { ...prefs.quark, ...patch } })} />
          <XunleiSettings xunlei={prefs.xunlei} onChange={(patch) => apply({ xunlei: { ...prefs.xunlei, ...patch } })} />
        </div>
        <div className="modal-foot">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              resetPreferences();
              setPrefs(getPreferences());
              toast('已恢复默认设置', 'success');
            }}
          >
            恢复默认
          </button>
          {/* v1.1.7：偏好备份导出/导入（panhub_setting_bak.json） */}
          <button type="button" className="btn btn-secondary" onClick={exportBackup}>
            导出备份
          </button>
          <label className="btn btn-secondary" style={{ cursor: 'pointer', margin: 0 }}>
            导入备份
            <input
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={(e) => {
                importBackup(e.target.files?.[0]);
                e.target.value = ''; // 允许重复选择同一文件
              }}
            />
          </label>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
