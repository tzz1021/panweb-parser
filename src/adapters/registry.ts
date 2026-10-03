/**
 * 适配器注册表 —— 网盘识别与分发唯一入口（docs/STRUCTURE.md：src/adapters/registry.ts）
 *
 * 约束（HANDOFF §4）：UI 永不 import 具体适配器（如 uc.ts），只走本注册表 + PanAdapter 接口。
 *
 * v1 只注册 UC（开发顺序第 2 步已完成），后续网盘按 src/adapters/README.md 接入：
 *   import { xxxAdapter } from './xxx';
 *   registerAdapter(xxxAdapter);
 * 现状：uc / quark（v1.1.9）/ alipan（v1.2.x 初稿）/ xunlei（迅雷云盘）
 */
import type { PanAdapter } from './types';
import { ucAdapter } from './uc/registry';
import { quarkAdapter } from './quark/registry';
import { alipanAdapter } from './alipan/registry';
import { xunleiAdapter } from './xunlei/registry';

/** 已注册适配器（先注册者优先，同 id 重复注册忽略） */
const adapters: PanAdapter[] = [];

// 模块初始化时注册适配器（必须在 adapters 声明之后，避免 TDZ）
registerAdapter(ucAdapter);
registerAdapter(quarkAdapter);
registerAdapter(alipanAdapter);
registerAdapter(xunleiAdapter);

/** 注册适配器 */
export function registerAdapter(adapter: PanAdapter): void {
  if (!adapters.some((a) => a.id === adapter.id)) {
    adapters.push(adapter);
  }
}

/** 当前已注册的全部适配器（只读） */
export function getAdapters(): readonly PanAdapter[] {
  return adapters;
}

/** 按 id 取适配器 */
export function getAdapterById(id: string): PanAdapter | undefined {
  return adapters.find((a) => a.id === id);
}

/**
 * 识别分享链接属于哪个网盘（按注册顺序返回第一个匹配者）。
 * 无匹配返回 undefined —— UI 据此提示「暂不支持的网盘」。
 */
export function detectShareUrl(url: string): PanAdapter | undefined {
  return adapters.find((a) => a.detect(url));
}
