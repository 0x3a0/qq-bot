export interface OneBotMessageSegment {
  type: string;
  data: Record<string, string>;
}

export interface GroupMessageEvent {
  post_type: "message";
  message_type: "group";
  self_id?: number;
  group_id: number;
  user_id: number;
  message: OneBotMessageSegment[] | string;
  raw_message?: string;
}

export interface OneBotApiResponse<T = unknown> {
  status: "ok" | "async" | "failed";
  retcode: number;
  data: T;
  echo?: string;
}

export interface OneBotApiRequest {
  action: string;
  params?: Record<string, unknown>;
  echo?: string;
}
