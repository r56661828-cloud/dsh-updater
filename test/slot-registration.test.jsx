// 升级入口迁移：全局浮层（shell.overlay + position:fixed）→ 原生侧栏底部动作槽位（sidebar.footer.action）
// 三条防回退断言：槽位常量、entry 源码不再引用 shell.overlay、chip 无固定定位且样式走主题 token。
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { UpdaterRoot } from '../src/UpdaterRoot.jsx';
import * as CONSTANTS from '../src/constants.js';
import { DICT } from '../src/i18n.js';

const h = React.createElement;
const t = (k) => DICT.zh[k] || k;
const UPDATE_INFO = { updateAvailable: true, current: '0.2.1-rc.5', latest: '0.2.2-rc.1' };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({}) }));
});
afterEach(() => vi.unstubAllGlobals());

function makeApi(info = UPDATE_INFO) {
  return vi.fn((path) => {
    if (path === '/check') return Promise.resolve(info);
    if (path === '/status') return Promise.resolve({ phase: 'idle', steps: [] });
    return Promise.resolve({});
  });
}

// jsdom 环境把全局 URL 换成了 jsdom 自己的实现，node:fs 不认这个实例；
// 因此先转成真实路径再读，避免 "The URL must be of scheme file"。
const HERE = dirname(fileURLToPath(import.meta.url));
const entrySource = readFileSync(join(HERE, '..', 'src', 'entry.js'), 'utf8');

describe('槽位注册：sidebar.footer.action', () => {
  it('constants 导出 SLOT_NAME = sidebar.footer.action', () => {
    expect(CONSTANTS.SLOT_NAME).toBe('sidebar.footer.action');
    // 既有常量不得被顺手改掉
    expect(CONSTANTS.NS).toBe('dsh-updater');
    expect(CONSTANTS.CHECK_INTERVAL_MS).toBe(3 * 60 * 60 * 1000);
    expect(CONSTANTS.POLL_MS).toBe(1000);
    expect(CONSTANTS.RETRY_MS).toBe(2500);
  });

  it('entry.js 使用 SLOT_NAME 注册，不再引用 shell.overlay', () => {
    expect(entrySource).not.toContain('shell.overlay');
    expect(entrySource).toContain('SLOT_NAME');
    expect(entrySource).toMatch(/import\s*\{[^}]*SLOT_NAME[^}]*\}\s*from\s*'\.\/constants\.js'/);
    expect(entrySource).toMatch(/name:\s*SLOT_NAME/);
    expect(entrySource).toMatch(/id:\s*'dsh-updater'/);
    expect(entrySource).toMatch(/order:\s*100/);
    expect(entrySource).toMatch(/label:\s*'dsh updater'/);
    // locale 注册与 ModuleLoader 外壳保持原样
    expect(entrySource).toContain('ctx.locale.register(NS, DICT)');
    expect(entrySource).toContain('window.__ModuleLoader__.load');
  });

  // 防回退：槽位渲染器把 ownerProps（含 wide）作为 props 传给注册组件。
  // 若注册回调写成零参箭头并直接 UpdaterRoot({ api, t })，wide 会被丢掉，
  // 折叠侧栏的紧凑态在真实运行时永远不触发（单测直调组件看不出来）。
  it('注册回调接收并透传槽位 props（wide 必须能到达 UpdaterRoot）', () => {
    expect(entrySource).toMatch(/\(\s*\w*props\s*\)\s*=>\s*UpdaterRoot\s*\(/i);
    expect(entrySource).toMatch(/UpdaterRoot\(\s*(Object\.assign\(\{\},\s*props|\{[^}]*\.\.\.props)/);
    // 旧写法（零参、丢 props）不得回流
    expect(entrySource).not.toMatch(/UpdaterRoot\(\s*\{\s*api,\s*t:\s*makeT\(ctx\)\s*\}\s*\)/);
  });
});

describe('chip 按钮：原生样式，无固定定位', () => {
  it('chip 是 .dupd-chip 原生按钮，style.position 非 fixed 且无定位偏移', async () => {
    const { container } = render(h(UpdaterRoot, { api: makeApi(), t }));
    await waitFor(() => expect(screen.getByText('⬆ 更新')).toBeTruthy());

    const chip = container.querySelector('.dupd-chip');
    expect(chip).toBeTruthy();
    expect(chip.tagName).toBe('BUTTON');
    expect(chip.type).toBe('button');
    // 文案与可访问名不变
    expect(chip.textContent).toBe('⬆ 更新');

    const st = chip.style;
    expect(st.position === '' || st.position === 'static').toBe(true);
    expect(st.top).toBe('');
    expect(st.right).toBe('');
    expect(st.zIndex).toBe('');
    // 不再硬编码品牌蓝
    expect(chip.getAttribute('style') || '').not.toContain('0073ed');
  });

  it('chip 的 title 提示仍带版本信息', async () => {
    const { container } = render(h(UpdaterRoot, { api: makeApi(), t }));
    await waitFor(() => expect(screen.getByText('⬆ 更新')).toBeTruthy());
    expect(container.querySelector('.dupd-chip').getAttribute('title')).toBe('发现新版本 0.2.2-rc.1（当前 0.2.1-rc.5），点击升级');
  });

  it('无更新时不渲染 chip', async () => {
    const api = makeApi({ updateAvailable: false, current: '0.2.1-rc.5', latest: '0.2.1-rc.5' });
    const { container } = render(h(UpdaterRoot, { api, t }));
    await waitFor(() => expect(api.mock.calls.filter(c => c[0] === '/status').length).toBeGreaterThan(0));
    expect(container.querySelector('.dupd-chip')).toBeNull();
    expect(screen.queryByText('⬆ 更新')).toBeNull();
  });

  it('样式表含 .dupd-chip 规则、走主题 token，且不再出现硬编码 #0073ed', async () => {
    const { container } = render(h(UpdaterRoot, { api: makeApi(), t }));
    await waitFor(() => expect(screen.getByText('⬆ 更新')).toBeTruthy());
    const css = Array.from(container.querySelectorAll('style')).map(s => s.textContent).join('\n');
    expect(css).toContain('.dupd-chip {');
    expect(css).toContain('.dupd-chip:hover');
    expect(css).toContain('var(--dsw-alias-border-l1)');
    expect(css).toContain('var(--dsw-alias-label-secondary)');
    expect(css).not.toContain('#0073ed');
    // 弹框遮罩本就该覆盖视口，必须保持 fixed
    expect(css).toMatch(/\.dupd-backdrop\s*\{[^}]*position:\s*fixed/);
  });

  it('点击 chip 仍打开「dsh版本更新」弹框', async () => {
    render(h(UpdaterRoot, { api: makeApi(), t }));
    await waitFor(() => expect(screen.getByText('⬆ 更新')).toBeTruthy());
    fireEvent.click(screen.getByText('⬆ 更新'));
    expect(await screen.findByText('dsh版本更新')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

// 宿主侧栏折叠成 56px 窄栏时向槽位传 wide=false（renderSlot('sidebar.footer.action', { wide })）。
// 紧凑态只留图标，避免「⬆ 更新」在窄栏里溢出换行。
const TOOLTIP_ZH = '发现新版本 0.2.2-rc.1（当前 0.2.1-rc.5），点击升级';

describe('chip 紧凑态：侧栏折叠 wide=false', () => {
  it('wide 缺省（宽栏）→ 文本含「⬆ 更新」', async () => {
    render(h(UpdaterRoot, { api: makeApi(), t }));
    await waitFor(() => expect(screen.getByText('⬆ 更新')).toBeTruthy());
    expect(screen.getByText('⬆ 更新').textContent).toBe('⬆ 更新');
  });

  it('wide={true} → 文本含「⬆ 更新」', async () => {
    render(h(UpdaterRoot, { api: makeApi(), t, wide: true }));
    await waitFor(() => expect(screen.getByText('⬆ 更新')).toBeTruthy());
    expect(screen.getByText('⬆ 更新').textContent).toBe('⬆ 更新');
  });

  it('wide={false} → 只含「⬆」（无文字标签）+ dupd-chip-compact 类 + 保留版本 title', async () => {
    const { container } = render(h(UpdaterRoot, { api: makeApi(), t, wide: false }));
    await waitFor(() => expect(container.querySelector('.dupd-chip')).toBeTruthy());

    const chip = container.querySelector('.dupd-chip');
    expect(chip.textContent).toBe('⬆');
    expect(chip.textContent).not.toContain('更新');
    expect(screen.queryByText('⬆ 更新')).toBeNull();
    // 紧凑类追加在既有类之后，基础样式叠加而非替换
    expect(chip.className.split(/\s+/)).toContain('dupd-chip');
    expect(chip.className.split(/\s+/)).toContain('dupd-chip-compact');
    // 可访问名与 title 仍是版本提示
    expect(chip.getAttribute('title')).toBe(TOOLTIP_ZH);
    expect(chip.getAttribute('aria-label')).toBe(TOOLTIP_ZH);
    // 紧凑态同样不得引入任何定位属性
    expect(chip.style.position === '' || chip.style.position === 'static').toBe(true);
    expect(chip.style.top).toBe('');
    expect(chip.style.right).toBe('');
    expect(chip.style.zIndex).toBe('');

    // 紧凑规则在样式表里，且不改定位
    const css = Array.from(container.querySelectorAll('style')).map(s => s.textContent).join('\n');
    expect(css).toMatch(/\.dupd-chip-compact\s*\{[^}]*width:\s*28px/);
    expect(css).toMatch(/\.dupd-chip-compact\s*\{[^}]*min-width:\s*28px/);
    expect(css).toMatch(/\.dupd-chip-compact\s*\{[^}]*justify-content:\s*center/);
    expect(css).not.toMatch(/\.dupd-chip-compact\s*\{[^}]*(position|top|right|z-index)\s*:/);
  });

  it('紧凑态点击仍打开「dsh版本更新」面板', async () => {
    const { container } = render(h(UpdaterRoot, { api: makeApi(), t, wide: false }));
    await waitFor(() => expect(container.querySelector('.dupd-chip')).toBeTruthy());
    fireEvent.click(container.querySelector('.dupd-chip'));
    expect(await screen.findByText('dsh版本更新')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

// 展开态对齐：.dupd-root 是宿主 footerActions（display:flex，实测 x=8/w=264，内容边缘 272）里的
// flex 子项。用 margin-left:auto 把它推到行尾（右边缘落在 272），视觉上位于「⋯ 更多」行正上方右端。
// 折叠 rail 的 footerActions 是 justify-content:center，auto margin 会破坏居中，因此窄栏不加该类；
// 两种状态都不引入 position/top/right/z-index。
describe('chip 对齐：宽栏右对齐（dupd-root-end），窄栏保持居中', () => {
  const cssOf = container => Array.from(container.querySelectorAll('style')).map(s => s.textContent).join('\n');

  it('wide 缺省（宽栏）→ .dupd-root 追加 dupd-root-end', async () => {
    const { container } = render(h(UpdaterRoot, { api: makeApi(), t }));
    await waitFor(() => expect(screen.getByText('⬆ 更新')).toBeTruthy());

    const root = container.querySelector('.dupd-root');
    expect(root).toBeTruthy();
    expect(root.className.split(/\s+/)).toContain('dupd-root');
    expect(root.className.split(/\s+/)).toContain('dupd-root-end');
    // 文案回归：宽栏仍是「⬆ 更新」
    expect(root.querySelector('.dupd-chip').textContent).toBe('⬆ 更新');
    // 对齐只靠 flex 外边距，不得引入定位属性
    expect(root.style.position).toBe('');
    expect(root.style.top).toBe('');
    expect(root.style.right).toBe('');
    expect(root.style.zIndex).toBe('');
  });

  it('wide={true}（宽栏）→ .dupd-root 同样追加 dupd-root-end', async () => {
    const { container } = render(h(UpdaterRoot, { api: makeApi(), t, wide: true }));
    await waitFor(() => expect(screen.getByText('⬆ 更新')).toBeTruthy());
    expect(container.querySelector('.dupd-root').className.split(/\s+/)).toContain('dupd-root-end');
  });

  // 2026-11-19 修复：无更新且非 awaiting-restart 时 chip 为 null，外层 div 仍在。
  // 若它照样带 dupd-root-end，这个空 flex 子项（0 宽但 margin-left:auto + order:2）会与
  // remote-bridge「Pair an iPhone」（margin-inline-start:auto + order:1）平分剩余空间，
  // 把同行按钮从行尾（right≈272）挤到行中间（实测 x=122/right=158）。
  it('无更新（无 chip）→ 宽栏 .dupd-root 不带 dupd-root-end', async () => {
    const noUpdate = { updateAvailable: false, current: '0.2.1-rc.5', latest: '0.2.1-rc.5' };
    for (const props of [{}, { wide: true }]) {
      const api = makeApi(noUpdate);
      const { container, unmount } = render(h(UpdaterRoot, Object.assign({ api, t }, props)));
      await waitFor(() => {
        const root = container.querySelector('.dupd-root');
        expect(root).toBeTruthy();
        expect(root.className.split(/\s+/)).not.toContain('dupd-root-end');
      });
      // 前提复核：这一态确实没有按钮可对齐
      expect(container.querySelector('.dupd-chip')).toBeNull();
      unmount();
    }
  });

  it('wide={false}（窄栏）→ 不加 dupd-root-end，仍是居中紧凑态', async () => {
    const { container } = render(h(UpdaterRoot, { api: makeApi(), t, wide: false }));
    await waitFor(() => expect(container.querySelector('.dupd-chip')).toBeTruthy());

    const root = container.querySelector('.dupd-root');
    expect(root).toBeTruthy();
    expect(root.className.split(/\s+/)).not.toContain('dupd-root-end');
    // 文案与紧凑类回归：窄栏仍是「⬆」+ dupd-chip-compact
    const chip = root.querySelector('.dupd-chip');
    expect(chip.textContent).toBe('⬆');
    expect(chip.className.split(/\s+/)).toContain('dupd-chip-compact');
  });

  it('样式表含 .dupd-root-end { margin-left: auto }，且不带定位属性', async () => {
    const { container } = render(h(UpdaterRoot, { api: makeApi(), t }));
    await waitFor(() => expect(screen.getByText('⬆ 更新')).toBeTruthy());

    const css = cssOf(container);
    expect(css).toContain('.dupd-root-end');
    expect(css).toMatch(/\.dupd-root-end\s*\{[^}]*margin-left\s*:\s*auto/);
    expect(css).not.toMatch(/\.dupd-root-end\s*\{[^}]*(position|top|right|z-index)\s*:/);
    // 既有 chip 规则不被对齐调整带走
    expect(css).toContain('.dupd-chip {');
    expect(css).toMatch(/\.dupd-chip-compact\s*\{[^}]*justify-content:\s*center/);
  });

  it('样式表给 .dupd-root-end 追加 order: 2，胜出行尾（与外挂 pair 按钮抢 auto 边距）', async () => {
    const { container } = render(h(UpdaterRoot, { api: makeApi(), t }));
    await waitFor(() => expect(screen.getByText('⬆ 更新')).toBeTruthy());

    const css = cssOf(container);
    // 宿主 footerActions 是 flex 行，remote-bridge 的「Pair an iPhone」按钮自带
    // margin-inline-start:auto + order:1；只靠 margin-left:auto 时两个 auto 边距平分剩余空间，
    // 本 chip 停在行中间。order:2 让它排到 order 最大处，真正占据行尾。
    expect(css).toMatch(/\.dupd-root-end\s*\{[^}]*order\s*:\s*2/);
    // 与既有 margin-left:auto 并存，不是替换
    expect(css).toMatch(/\.dupd-root-end\s*\{[^}]*margin-left\s*:\s*auto/);
    expect(css).not.toMatch(/\.dupd-root-end\s*\{[^}]*(position|top|right|z-index)\s*:/);
  });
});