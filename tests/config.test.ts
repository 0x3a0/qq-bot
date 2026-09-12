import { describe, expect, it } from 'vitest';
import { DEFAULT_INTENTS, QQ_PRODUCTION_API_BASE, QQ_SANDBOX_API_BASE, loadConfig } from '../src/config.js';

const base = { APP_ID: '123456', CLIENT_SECRET: 'secret' };

describe('loadConfig', () => {
  it('使用默认值：正式环境、群聊 intents、60 秒行情缓存', () => {
    const config = loadConfig(base);
    expect(config.qqEnv).toBe('production');
    expect(config.apiBase).toBe(QQ_PRODUCTION_API_BASE);
    expect(config.intents).toBe(DEFAULT_INTENTS);
    expect(config.intents).toBe(1 << 25);
    expect(config.marketCacheTtlMs).toBe(60_000);
    expect(config.logLevel).toBe('info');
    expect(config.logEvents).toBe(false);
    expect(config.gatewayUrl).toBeNull();
  });

  it('缺少 APP_ID 或 CLIENT_SECRET 时抛出可读错误', () => {
    expect(() => loadConfig({ CLIENT_SECRET: 'secret' })).toThrow(/APP_ID/);
    expect(() => loadConfig({ APP_ID: '123' })).toThrow(/CLIENT_SECRET/);
  });

  it('sandbox 环境使用沙箱地址', () => {
    const config = loadConfig({ ...base, QQ_ENV: 'sandbox' });
    expect(config.apiBase).toBe(QQ_SANDBOX_API_BASE);
  });

  it('显式 QQ_API_BASE 优先于环境默认值', () => {
    const config = loadConfig({ ...base, QQ_ENV: 'sandbox', QQ_API_BASE: 'https://custom.example' });
    expect(config.apiBase).toBe('https://custom.example');
  });

  it('解析 intents、缓存 TTL 与布尔开关', () => {
    const config = loadConfig({
      ...base,
      QQ_INTENTS: '33554432',
      MARKET_CACHE_TTL_MS: '1500',
      LOG_EVENTS: 'true',
      LOG_LEVEL: 'debug',
    });
    expect(config.intents).toBe(33_554_432);
    expect(config.marketCacheTtlMs).toBe(1500);
    expect(config.logEvents).toBe(true);
    expect(config.logLevel).toBe('debug');
  });

  it('非数字的 QQ_INTENTS 被拒绝', () => {
    expect(() => loadConfig({ ...base, QQ_INTENTS: 'abc' })).toThrow(/QQ_INTENTS/);
  });

  it('负数的缓存 TTL 被拒绝', () => {
    expect(() => loadConfig({ ...base, MARKET_CACHE_TTL_MS: '-1' })).toThrow(/MARKET_CACHE_TTL_MS/);
  });

  it('字体文件按逗号拆分并去除空白', () => {
    const config = loadConfig({ ...base, FONT_FILES: ' C:\\a.ttf , C:\\b.ttf , ' });
    expect(config.fontFiles).toEqual(['C:\\a.ttf', 'C:\\b.ttf']);
  });

  it('图片输出目录默认指向 .tmp-probe/images', () => {
    expect(loadConfig(base).imageOutputDir).toBe('.tmp-probe/images');
    expect(loadConfig({ ...base, IMAGE_OUTPUT_DIR: 'out' }).imageOutputDir).toBe('out');
  });
});
