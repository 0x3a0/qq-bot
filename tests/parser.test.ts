import { describe, expect, it } from 'vitest';
import { HELP_TEXT, normalizeContent, parseCommand } from '../src/commands/parser.js';

describe('normalizeContent', () => {
  it('去掉首尾空白与零宽字符', () => {
    expect(normalizeContent('  \u200b大盘 ')).toBe('大盘');
  });

  it('去掉残留的 @ 提及标记', () => {
    expect(normalizeContent('<@!1234> 大盘')).toBe('大盘');
  });

  it('空内容返回空串', () => {
    expect(normalizeContent(undefined)).toBe('');
    expect(normalizeContent('   ')).toBe('');
  });
});

describe('parseCommand', () => {
  it('识别「大盘」', () => {
    expect(parseCommand('大盘')?.kind).toBe('market');
  });

  it('识别带空格与斜杠的写法', () => {
    expect(parseCommand(' /大盘 ')?.kind).toBe('market');
    expect(parseCommand('／大盘')?.kind).toBe('market');
  });

  it('识别「行情」「板块」「热力图」等同义指令', () => {
    expect(parseCommand('行情')?.kind).toBe('market');
    expect(parseCommand('看看板块')?.kind).toBe('market');
    expect(parseCommand('来张热力图')?.kind).toBe('market');
  });

  it('识别 ping 测试指令', () => {
    expect(parseCommand('ping')?.kind).toBe('ping');
    expect(parseCommand('PING')?.kind).toBe('ping');
    expect(parseCommand('在吗')?.kind).toBe('ping');
  });

  it('识别帮助指令', () => {
    expect(parseCommand('帮助')?.kind).toBe('help');
    expect(parseCommand('help')?.kind).toBe('help');
  });

  it('无法识别时返回 null', () => {
    expect(parseCommand('今天天气不错')).toBeNull();
    expect(parseCommand('')).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
    expect(parseCommand('@@@')).toBeNull();
  });

  it('大盘优先于 ping 关键词', () => {
    expect(parseCommand('大盘行情')?.kind).toBe('market');
  });
});

describe('HELP_TEXT', () => {
  it('包含大盘与 ping 指令说明', () => {
    expect(HELP_TEXT).toContain('大盘');
    expect(HELP_TEXT).toContain('ping');
  });
});
