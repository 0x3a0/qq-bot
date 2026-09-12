/**
 * 指令解析：QQ 在 GROUP_AT_MESSAGE_CREATE 事件里已经去掉 @机器人 前缀，
 * 因此这里只需要对剩余文本做归一化匹配。
 */

export type CommandKind = 'ping' | 'market' | 'help';

export interface ParsedCommand {
  kind: CommandKind;
  /** 归一化后的原始文本 */
  raw: string;
}

export const MARKET_KEYWORDS = ['大盘', '行情', '热力图', '热力图谱', '板块', '资金'];
export const PING_KEYWORDS = ['ping', '在吗', 'hello', 'hi', '测试'];
export const HELP_KEYWORDS = ['帮助', 'help', '菜单'];

/** 去掉零宽字符、首尾空白与结尾的 @ 提及标记。 */
export function normalizeContent(content: string | undefined): string {
  if (!content) return '';
  return content
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/<@!?[^>]+>/g, ' ')
    .trim();
}

/** 解析指令；无法识别返回 null，由调用方决定是否忽略。 */
export function parseCommand(content: string | undefined): ParsedCommand | null {
  const raw = normalizeContent(content);
  if (raw.length === 0) return null;

  // 允许前导斜杠或全角斜杠，例如 "/大盘"、"／大盘"
  const body = raw.replace(/^[/／]+/, '').trim().toLowerCase();
  if (body.length === 0) return null;

  if (MARKET_KEYWORDS.some((keyword) => body.includes(keyword))) {
    return { kind: 'market', raw };
  }
  if (PING_KEYWORDS.some((keyword) => body.includes(keyword))) {
    return { kind: 'ping', raw };
  }
  if (HELP_KEYWORDS.some((keyword) => body.includes(keyword))) {
    return { kind: 'help', raw };
  }
  return null;
}

export const HELP_TEXT = [
  '可用指令：',
  '· @机器人 大盘 —— 返回 A 股行业板块成交额 TOP25 文字榜单 + 热力图',
  '· @机器人 ping —— 连通性测试',
  '· @机器人 帮助 —— 显示本说明',
].join('\n');
