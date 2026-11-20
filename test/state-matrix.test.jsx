import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { UpdaterRoot } from '../src/UpdaterRoot.jsx';
import { DICT } from '../src/i18n.js';

const h = React.createElement;
const t = (k) => DICT.zh[k] || k;

beforeEach(() => {
  // reportError 走 api.js 真实 fetch，stub 掉避免环境差异
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({}) }));
});
afterEach(() => vi.unstubAllGlobals());

const PHASES = ['idle', 'running', 'restarting', 'awaiting-restart', 'selfcheck', 'done', 'done-with-warnings', 'failed'];
const INFOS = [
  ['null', null],
  ['no-update', { updateAvailable: false, current: '0.2.1-rc.5', latest: '0.2.1-rc.5' }],
  ['update', { updateAvailable: true, current: '0.2.1-rc.5', latest: '0.2.2-rc.1' }],
];
const STEPS = [{ id: 'install', title: 'x', state: 'done' }];

function makeApi(phase, info) {
  const calls = { check: 0, status: 0 };
  const api = vi.fn((path) => {
    if (path === '/check') { calls.check++; return Promise.resolve(info); }
    if (path === '/status') { calls.status++; return Promise.resolve({ phase, steps: STEPS }); }
    return Promise.resolve({});
  });
  return { api, calls };
}

// 原实现的行为矩阵（inFlight 分支优先于 updateAvailable：running/selfcheck/restarting 显示 busy 按钮）
function expectedAction(ph, info) {
  if (ph === 'awaiting-restart') return { text: '立即重启', tag: 'BUTTON', disabled: false };
  if (ph === 'running') return { text: '升级执行中…', tag: 'BUTTON', disabled: true };
  if (ph === 'restarting') return { text: '重启指令已发出，服务恢复中…', tag: 'BUTTON', disabled: true };
  if (ph === 'selfcheck') return { text: '升级后自检执行中…', tag: 'BUTTON', disabled: true };
  if (info && info.updateAvailable) return { text: '开始升级', tag: 'BUTTON', disabled: false };
  if (ph === 'done') return { text: '升级完成 ✓', tag: 'SPAN' };
  if (ph === 'done-with-warnings') return { text: '升级完成，但有警告 ⚠', tag: 'SPAN' };
  return { text: '开始升级', tag: 'BUTTON', disabled: true };
}

// 崩溃回归：POST /check 永不 resolve（info 停留 null），GET /status 返回 awaiting-restart →
// 旧实现在 chip 的 title 里直接读 info.latest/info.current，对 null 取字段即抛 TypeError。
describe('崩溃回归（红→绿基线）', () => {
  it('check 挂起 + awaiting-restart 时渲染不抛异常', async () => {
    const api = vi.fn((path) => {
      if (path === '/check') return new Promise(() => {});
      if (path === '/status') return Promise.resolve({ phase: 'awaiting-restart', steps: STEPS });
      return Promise.resolve({});
    });
    const { container } = render(h(UpdaterRoot, { api, t }));
    await waitFor(() => expect(api.mock.calls.filter(c => c[0] === '/status').length).toBeGreaterThan(0));
    await act(async () => {});
    expect(container.querySelector('.dupd-root')).toBeTruthy();
    expect(screen.getByText('⬆ 更新')).toBeTruthy();
    expect(container.textContent).not.toContain('undefined');
    expect(container.textContent).not.toContain('null');
  });
});

describe('状态矩阵 phase × info', () => {
  const combos = PHASES.flatMap((ph) => INFOS.map(([name, info]) => [`${ph}/${name}`, ph, info]));
  it.each(combos)('%s：渲染不抛异常，chip/动作/文本符合预期', async (_, ph, info) => {
    const { api, calls } = makeApi(ph, info);
    const { container } = render(h(UpdaterRoot, { api, t }));
    await waitFor(() => { expect(calls.check).toBeGreaterThan(0); expect(calls.status).toBeGreaterThan(0); });
    await act(async () => {});

    const expectChip = !!(info && info.updateAvailable) || ph === 'awaiting-restart';
    if (expectChip) {
      fireEvent.click(screen.getByText('⬆ 更新'));
      await screen.findByText('dsh版本更新');
      const a = expectedAction(ph, info);
      const el = screen.getAllByText(a.text).find(e => e.tagName === a.tag);
      expect(el).toBeTruthy();
      if (a.tag === 'BUTTON') expect(el.disabled).toBe(a.disabled);
      // 蓝图子集：有更新且非 awaiting-restart/restarting/执行中 → 可用的「开始升级」
      if (info && info.updateAvailable && !['awaiting-restart', 'restarting', 'running', 'selfcheck'].includes(ph)) {
        expect(el.disabled).toBe(false);
      }
    } else {
      expect(screen.queryByText('⬆ 更新')).toBeNull();
      expect(screen.queryByText('dsh版本更新')).toBeNull();
      expect(screen.queryByText('开始升级')).toBeNull();
    }
    expect(container.textContent).not.toContain('undefined');
    expect(container.textContent).not.toContain('null');
  });
});

describe('断线', () => {
  it('面板打开时 /check reject → 出现「与服务断开」', async () => {
    const api = vi.fn((path) => {
      if (path === '/check') return Promise.reject(new Error('net down'));
      if (path === '/status') return Promise.resolve({ phase: 'awaiting-restart', steps: STEPS });
      return Promise.resolve({});
    });
    render(h(UpdaterRoot, { api, t }));
    await waitFor(() => expect(screen.getByText('⬆ 更新')).toBeTruthy());
    fireEvent.click(screen.getByText('⬆ 更新'));
    await screen.findByText('dsh版本更新');
    // 挂载期 /check 的失败标志会被随后成功的 /status 清掉（原实现行为：setNet(false)）；
    // 用户视角的断线呈现：面板已开时重新检查失败 → 横幅出现
    fireEvent.click(screen.getByText('重新检查'));
    expect(await screen.findByText('与服务断开，自动重连中…')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('net down');
  });
});
