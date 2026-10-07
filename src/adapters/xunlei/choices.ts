/**
 * 迅雷取链方案规则（v1.4；docs/xunlei-dl-choices.md 由主线程维护）
 *
 * 背景（yunx 实测）：`GET /drive/v1/files/{id}?space=&usage=CONSUME|PLAY` 影响返回的直链集合：
 *   ① web_content ② stream(PLAY) ③ media ④ 真实 md5；①②③ 可下也可浏览器播，④ 可秒传；
 *   下载速度 ②(PLAY) > ①(CONSUME)，压缩包有奇效。
 *
 * 设置项是**多行文本**，每行一条规则（按文件名自上而下匹配，命中即用；无命中 → CONSUME）：
 *   -regex ".*\.\(xls\|ppt\|docx\|pdf\)$" = CONSUME     # 区分大小写
 *   -iregex ".*\.\(ts\|mp4\|mov\)$" = PLAY             # 不区分大小写
 * 非法行**忽略**（进 `invalid` 供 UI 浅色提示），不抛错。
 */
export type XlUsage = 'CONSUME' | 'PLAY';

/** 解析出的一条规则 */
export interface DlChoiceRule {
  /** 正则源（原样，未转义处理） */
  pattern: string;
  /** 是否忽略大小写（-iregex = true） */
  caseInsensitive: boolean;
  usage: XlUsage;
  /** 原始行（UI 提示用） */
  raw: string;
}

export interface ParsedChoiceRules {
  rules: DlChoiceRule[];
  /** 非法行原文（UI 浅色提示，不弹错） */
  invalid: string[];
}

/** 行格式：`-regex "<pattern>" = CONSUME|PLAY`（`-iregex` 不区分大小写） */
const RULE_RE = /^\s*-(i?)regex\s+"(.*)"\s*=\s*(CONSUME|PLAY)\s*$/i;

/**
 * 模式归一：Tzz 样例用 POSIX 式转义 `\(` `\)` `\|`（表「分组/或」），
 * 而 JS 正则里它们是**字面量**——这里把这三个归一成 JS 语义，两种写法都可用。
 * （`\.` 在两边都是字面点，保持一致，不处理。）
 */
export function normalizeDlPattern(pattern: string): string {
  return String(pattern ?? '')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\|/g, '|');
}

/**
 * 解析多行规则文本：合法行 → rules（保序）；空行/注释(#)跳过；其余进 invalid。
 * 正则在解析期做一次编译校验，编译失败的行也进 invalid（避免运行期崩）。
 */
export function parseDlChoiceRules(text: string): ParsedChoiceRules {
  const rules: DlChoiceRule[] = [];
  const invalid: string[] = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = RULE_RE.exec(line);
    if (!m) {
      invalid.push(line);
      continue;
    }
    const caseInsensitive = m[1] === 'i' || m[1] === 'I';
    // POSIX 式转义（Tzz 样例）→ JS 语义
    const pattern = normalizeDlPattern(m[2]);
    const usage = m[3].toUpperCase() as XlUsage;
    try {
      // eslint-disable-next-line no-new
      new RegExp(pattern, caseInsensitive ? 'i' : '');
    } catch {
      invalid.push(line);
      continue;
    }
    rules.push({ pattern, caseInsensitive, usage, raw: line });
  }
  return { rules, invalid };
}

/** 按文件名自上而下匹配规则，返回首个命中的 usage；无命中 → null */
export function matchUsageByFileName(rules: DlChoiceRule[], fileName: string): XlUsage | null {
  const name = String(fileName ?? '');
  for (const r of rules) {
    try {
      if (new RegExp(r.pattern, r.caseInsensitive ? 'i' : '').test(name)) return r.usage;
    } catch {
      // 解析期已校验；这里再兜一层，跳过坏规则
    }
  }
  return null;
}

/**
 * 最终 usage：**调用方显式覆盖（弹窗选择）** > 设置规则命中 > CONSUME。
 * @param override DownloadParams.usage（用户弹窗选择；undefined = 自动）
 * @param rulesText 设置里的多行规则文本
 * @param fileName 文件名（规则按此匹配）
 */
export function resolveUsage(override: XlUsage | undefined, rulesText: string, fileName: string): XlUsage {
  if (override === 'CONSUME' || override === 'PLAY') return override;
  const { rules } = parseDlChoiceRules(rulesText);
  return matchUsageByFileName(rules, fileName) ?? 'CONSUME';
}
