/** QQ 开放平台 v2 相关类型定义，字段以官方文档为准。 */

export interface QqUser {
  id?: string;
  username?: string;
  bot?: boolean;
  union_openid?: string;
  union_user_account?: string;
  user_openid?: string;
  member_openid?: string;
  member_role?: string;
}

export interface QqMessageScene {
  source?: string;
  ext?: string[];
}

export interface QqMessageAttachment {
  url?: string;
  filename?: string;
  width?: number;
  height?: number;
  size?: number;
  content_type?: string;
  voice_wav_url?: string;
  asr_refer_text?: string;
}

export interface QqArkData {
  prompt?: string;
  ark_type?: string;
  ark_name?: string;
  fields?: Record<string, unknown>;
}

export interface QqMsgElement {
  msg_idx?: string;
  author?: QqUser;
  message_type?: number;
  content?: string;
  attachments?: QqMessageAttachment[];
  ark_data?: QqArkData;
  msg_elements?: QqMsgElement[];
}

/** GROUP_AT_MESSAGE_CREATE 事件体（d 字段）。 */
export interface GroupAtMessageCreateData {
  id: string;
  author?: QqUser;
  content?: string;
  group_openid: string;
  timestamp?: string;
  message_type?: number;
  message_scene?: QqMessageScene;
  attachments?: QqMessageAttachment[];
  mentions?: QqUser[];
  ark_data?: QqArkData;
  msg_elements?: QqMsgElement[];
}

export interface ReadyData {
  version?: number;
  session_id?: string;
  user?: QqUser;
  shard?: [number, number];
}

/** Gateway 下行报文（文档：通用数据结构）。 */
export interface GatewayPayload<T = unknown> {
  op: number;
  d?: T;
  s?: number;
  t?: string;
  id?: string;
}

export const OpCode = {
  /** 服务端推送的事件 */
  Dispatch: 0,
  /** 客户端心跳 */
  Heartbeat: 1,
  /** 客户端鉴权 */
  Identify: 2,
  /** 客户端恢复连接 */
  Resume: 6,
  /** 服务端要求重连 */
  Reconnect: 7,
  /** 服务端要求停止重连并重新鉴权 */
  InvalidSession: 9,
  /** 服务端下发心跳周期 */
  Hello: 10,
  /** 服务端心跳应答 */
  HeartbeatAck: 11,
} as const;

export type OpCodeValue = (typeof OpCode)[keyof typeof OpCode];

/** WebSocket 关闭码含义（文档：WebSocket 错误码）。 */
export const CLOSE_CODE_MEANING: Record<number, string> = {
  4001: '无效的 opcode',
  4002: '无效的 payload',
  4006: '无效的 session id，无法继续 resume，需重新 identify',
  4007: 'seq 错误',
  4008: '发送 payload 过快',
  4009: '连接过期，需重连并 resume',
  4010: '无效的 shard',
  4011: '需要处理的 guild 过多，请分片',
  4012: '无效的 version',
  4013: '无效的 intent',
  4014: 'intent 无权限',
  4914: '机器人已下架，只允许连接沙箱环境',
  4915: '机器人已封禁',
};

/** 判断该关闭码是否允许 resume 重试。 */
export function canResumeOnClose(code: number): boolean {
  if (code === 4008 || code === 4009) return true;
  return code >= 4900 && code <= 4913;
}

/** 判断该关闭码是否允许 identify 重试。 */
export function canIdentifyOnClose(code: number): boolean {
  if (code === 4006 || code === 4007) return true;
  if (code === 4008 || code === 4009) return true;
  if (code >= 4900 && code <= 4913) return true;
  if (code >= 4001 && code <= 4014) return false;
  // 1000/1001 等正常关闭或未知关闭码都允许重连
  return true;
}

/** 判断该关闭码是否属于不可恢复错误（需要人工处理）。 */
export function isFatalCloseCode(code: number): boolean {
  return code === 4010 || code === 4011 || code === 4012 || code === 4013 || code === 4014 || code === 4914 || code === 4915;
}
