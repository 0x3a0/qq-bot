import type { GroupMessageEvent, OneBotMessageSegment } from "../onebot/types.js";

function segments(event: GroupMessageEvent): OneBotMessageSegment[] {
  return typeof event.message === "string" ? [{ type: "text", data: { text: event.message } }] : event.message;
}

export function isMentioned(event: GroupMessageEvent, botQq?: string): boolean {
  const target = botQq ?? (event.self_id === undefined ? undefined : String(event.self_id));
  return segments(event).some((segment) => segment.type === "at" && (!target || segment.data.qq === target || segment.data.qq === "all"));
}

export function commandText(event: GroupMessageEvent): string {
  return segments(event)
    .filter((segment) => segment.type === "text")
    .map((segment) => segment.data.text ?? "")
    .join("")
    .replace(/\s+/gu, "");
}

export function isAShareCommand(event: GroupMessageEvent, botQq?: string): boolean {
  return isMentionedCommand(event, "a股", botQq);
}

export function isUSShareCommand(event: GroupMessageEvent, botQq?: string): boolean {
  return isMentionedCommand(event, "美股", botQq);
}

function isMentionedCommand(event: GroupMessageEvent, command: string, botQq?: string): boolean {
  return event.post_type === "message" && event.message_type === "group" && isMentioned(event, botQq) && commandText(event).toLocaleLowerCase() === command;
}
