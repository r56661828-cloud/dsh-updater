import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, apiBase, apiUrl, reportError } from '../src/api.js';

afterEach(() => {
  delete document.baseURI; // 还原 jsdom 原型上的 baseURI
  vi.unstubAllGlobals();
});

function stubBaseURI(value) {
  Object.defineProperty(document, 'baseURI', { value, configurable: true });
}

describe('apiUrl 拼接规则', () => {
  it('根路径 baseURI 直接拼接', () => {
    stubBaseURI('http://x/');
    expect(apiBase()).toBe('http://x/');
    expect(apiUrl('/api/dsh-updater/status')).toBe('http://x/api/dsh-updater/status');
  });

  it('非根路径 baseURI 补齐末尾斜杠（页面路径按目录解析）', () => {
    stubBaseURI('http://x/y/page.html');
    expect(apiBase()).toBe('http://x/y/page.html/');
    expect(apiUrl('/api/dsh-updater/status')).toBe('http://x/y/page.html/api/dsh-updater/status');
  });

  it('baseURI 不可解析时原样返回', () => {
    stubBaseURI('');
    expect(apiBase()).toBe('');
    expect(apiUrl('/api/dsh-updater/status')).toBe('/api/dsh-updater/status');
  });

  it('非相对路径与非字符串原样返回', () => {
    stubBaseURI('http://x/y/');
    expect(apiUrl('rel')).toBe('rel');
    expect(apiUrl('//other/p')).toBe('//other/p');
    expect(apiUrl(null)).toBe(null);
    expect(apiUrl(123)).toBe(123);
  });
});

describe('api', () => {
  it('默认以 content-type json 请求拼接后的 URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok: 1 }) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(api('/status')).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/dsh-updater/status',
      expect.objectContaining({ headers: { 'content-type': 'application/json' } }),
    );
  });

  it('opts 与 headers 合并透传', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);
    await api('/check', { method: 'POST', body: 'B', headers: { 'x-a': '1' } });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/dsh-updater/check',
      expect.objectContaining({ method: 'POST', body: 'B', headers: { 'content-type': 'application/json', 'x-a': '1' } }),
    );
  });
});

describe('reportError', () => {
  it('把异常上报到 /client-error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);
    reportError('doCheck', new Error('boom'));
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/dsh-updater/client-error',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ where: 'doCheck', message: 'boom', stack: expect.any(String) });
  });

  it('fetch 同步抛错时静默吞掉', () => {
    vi.stubGlobal('fetch', () => { throw new Error('no fetch'); });
    expect(() => reportError('refresh', new Error('x'))).not.toThrow();
  });
});
