import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { UpdaterRoot } from '../src/UpdaterRoot.jsx';
import { DICT } from '../src/i18n.js';

const h = React.createElement;
const t = (k) => DICT.zh[k] || k;
const UPDATE_INFO = { updateAvailable: true, current: '0.2.1-rc.5', latest: '0.2.2-rc.1' };

beforeEach(() => {
  // reportError 走 api.js 真实 fetch，stub 掉避免环境差异
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({}) }));
});
afterEach(() => vi.unstubAllGlobals());

function makeApi({ info = UPDATE_INFO, status = { phase: 'idle', steps: [] } } = {}) {
  return vi.fn((path) => {
    if (path === '/check') return Promise.resolve(info);
    if (path === '/status') return Promise.resolve(status);
    return Promise.resolve({});
  });
}

async function openPanel(api) {
  render(h(UpdaterRoot, { api, t }));
  await waitFor(() => expect(screen.getByText('⬆ 更新')).toBeTruthy());
  fireEvent.click(screen.getByText('⬆ 更新'));
  await screen.findByText('dsh版本更新');
}

describe('UpdaterRoot 交互', () => {
  it('点击 chip「⬆ 更新」弹出「dsh版本更新」面板', async () => {
    const api = makeApi();
    await openPanel(api);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('点「开始升级」→ POST /start，body 含 target', async () => {
    const api = makeApi();
    await openPanel(api);
    fireEvent.click(screen.getByText('开始升级'));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/start', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"target":"0.2.2-rc.1"'),
    })));
  });

  it('点「立即重启」→ POST /restart', async () => {
    const api = makeApi({ info: null, status: { phase: 'awaiting-restart', steps: [] } });
    await openPanel(api);
    fireEvent.click(screen.getByText('立即重启'));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/restart', { method: 'POST' }));
  });

  it('点「重新检查」→ POST /check（source=manual）', async () => {
    const api = makeApi();
    await openPanel(api);
    fireEvent.click(screen.getByText('重新检查'));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/check', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"source":"manual"'),
    })));
  });
});
