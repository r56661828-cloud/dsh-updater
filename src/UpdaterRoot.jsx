import getReact from './react.js';
import { CHECK_INTERVAL_MS, POLL_MS, RETRY_MS } from './constants.js';
import { CSS } from './styles.js';
import { fmt } from './i18n.js';
import { reportError } from './api.js';

// 升级入口现在是侧栏底部的原生动作按钮：定位完全交给槽位（footerActions 的 flex 布局），
// 因此不再有 position:fixed / top / right / z-index。样式走主题 token，跟随明暗主题与缩放。
// 规则刻意放在组件内（而不是 styles.js）：本次改动的文件白名单不含 styles.js，
// 若后续允许动样式表，把 CHIP_CSS 里的两条规则挪进 CSS 字符串即可，行为不变。
const CHIP_CSS = `
.dupd-chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.dupd-chip:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dupd-chip-compact { width: 28px; min-width: 28px; padding: 0; justify-content: center; }
.dupd-root-end { margin-left: auto; order: 2; }
`;

// 槽位渲染时宿主会传 { wide }（宽栏 true / 折成 56px 窄栏 false）。窄栏里「⬆ 更新」会溢出
// 边框并换行，因此折叠态只留图标；文案、点击与显隐条件不变，也不引入任何定位属性。
// 展开态额外追加 dupd-root-end（margin-left:auto），在宿主 footerActions 这个 flex 行里推到行尾；
// 窄栏的 footerActions 是 justify-content:center，加 auto margin 会破坏居中，故只在宽栏追加。
function UpdaterRoot({ api, t, wide }) {
  const React = getReact();
  const h = React.createElement;
  const [info, setInfo] = React.useState(null);
  const [open, setOpen] = React.useState(false);
  const [status, setStatus] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [net, setNet] = React.useState(false);
  const [lastErr, setLastErr] = React.useState('');
  const pollRef = React.useRef(null);

  async function doCheck(source) {
    try { const r = await api('/check', { method: 'POST', body: JSON.stringify({ source: source || 'manual' }) }); setInfo(r); setNet(false); }
    catch (e) { setNet(true); setLastErr(e && e.message || e); reportError('doCheck', e); if (source === 'refresh') setTimeout(() => doCheck('retry'), 15000); }
  }
  function schedulePoll(ms) {
    if (pollRef.current == null) pollRef.current = setTimeout(() => { pollRef.current = null; refresh(); }, ms || POLL_MS);
  }
  function stopPoll() { if (pollRef.current != null) { clearTimeout(pollRef.current); pollRef.current = null; } }
  async function refresh() {
    try {
      const s = await api('/status'); setStatus(s); setNet(false);
      const ph = s && s.phase;
      if (ph === 'running' || ph === 'restarting' || ph === 'selfcheck') schedulePoll(POLL_MS);
    } catch (e) { setNet(true); schedulePoll(RETRY_MS); reportError('refresh', e); }
  }
  async function start() {
    if (!info || !info.latest) return;
    setBusy(true); setLastErr('');
    try { const r = await api('/start', { method: 'POST', body: JSON.stringify({ target: info.latest }) }); if (r && r.error) setLastErr(r.error); await refresh(); }
    catch (e) { setLastErr(e && e.message || e); reportError('start', e); } finally { setBusy(false); }
  }
  async function restart() {
    setBusy(true); setLastErr('');
    try { await api('/restart', { method: 'POST' }); setStatus(s => Object.assign({}, s || {}, { phase: 'restarting' })); schedulePoll(2000); }
    catch { /* host 正在死亡：页面随后自动重连 */ schedulePoll(2000); }
    finally { setBusy(false); }
  }

  React.useEffect(() => {
    doCheck('refresh'); refresh();
    const iv = setInterval(() => doCheck('heartbeat'), CHECK_INTERVAL_MS);
    return () => { clearInterval(iv); stopPoll(); };
  }, []);

  const ph = (status && status.phase) || 'idle';
  const steps = (status && status.steps) || [];
  const inFlight = ph === 'running' || ph === 'restarting' || ph === 'selfcheck';
  const showChip = !!(info && info.updateAvailable) || ph === 'awaiting-restart'; // 有更新 或 待重启确认
  const terminalPh = ph === 'done' || ph === 'done-with-warnings' || ph === 'failed';
  const freshTarget = !!(info && info.updateAvailable);

  function doCheckManual() { setBusy(true); doCheck('manual').finally(() => setBusy(false)); }

  const compact = wide === false; // 仅折叠窄栏（显式 false）走紧凑态；缺省视为宽栏
  const tip = info ? fmt(t, 'chip.tooltip', { latest: info.latest, current: info.current }) : '';
  const chip = showChip ? h('button', {
    key: 'chip', type: 'button',
    className: compact ? 'dupd-chip dupd-chip-compact' : 'dupd-chip',
    onClick: () => setOpen(true),
    title: tip,
    'aria-label': compact ? (tip || undefined) : undefined,
  }, compact ? '⬆' : '⬆ ' + fmt(t, 'btn.upgrade')) : null;

  const banner = [];
  if (net) banner.push(h('div', { key: 'net', className: 'dupd-banner dupd-warn', role: 'status' }, fmt(t, 'banner.netdown')));
  if (ph === 'restarting') banner.push(h('div', { key: 'rst', className: 'dupd-banner dupd-info', role: 'status' }, fmt(t, 'phase.restarting')));
  if (freshTarget && ph !== 'awaiting-restart' && ph !== 'restarting') banner.push(h('div', { key: 'note2', className: 'dupd-banner dupd-muted' }, fmt(t, 'banner.restartNote')));
  if (ph === 'awaiting-restart' || ph === 'restarting') banner.push(h('div', { key: 'note', className: 'dupd-banner dupd-muted' }, fmt(t, 'banner.restartNote')));

  const stepIcon = st => st.state === 'done' ? '✓' : st.state === 'failed' ? '✗' : st.state === 'warn' ? '⚠' : st.state === 'manual' ? '☰' : st.state === 'running' ? '◌' : '○';
  const stepClass = st => 'dupd-step dupd-' + st.state;

  // 终态 + 有待执行的新升级：旧步骤是“上次运行记录”，不与本次目标混排——只显示一行摘要
  const stepView = (terminalPh && freshTarget)
    ? h('div', { key: 'lastrun', className: 'dupd-empty' },
        '上次升级记录：' + (status && status.finishedAt ? new Date(status.finishedAt).toLocaleString('zh-CN', { hour12: false }) : '—') +
        ' → ' + ((status && status.target) || '?') + '（' + fmt(t, 'phase.' + ph) + '）；点「开始升级」发起本次升级',
      )
    : (steps.length ? h('ul', { key: 'steps', className: 'dupd-steps' }, steps.map((st, i) => h('li', { key: st.id + '-' + i, className: stepClass(st) },
        h('span', { className: 'dupd-step-icon', 'aria-hidden': true }, stepIcon(st)),
        h('span', { className: 'dupd-step-title' }, st.title),
        st.result ? h('span', { className: 'dupd-step-result' }, ' — ' + st.result) : null,
        st.state === 'running' ? h('span', { className: 'dupd-step-live' }, fmt(t, 'step.running') || '…') : null,
      ))) : h('div', { key: 'nosteps', className: 'dupd-empty' }, fmt(t, 'phase.idle')));

  const manual = steps.some(s => s.state === 'manual') ? h('div', { key: 'manual', className: 'dupd-manual' },
    h('div', { className: 'dupd-manual-title' }, fmt(t, 'manual.title')),
    h('div', { className: 'dupd-manual-item' }, '☐ ' + fmt(t, 'manual.gui')),
    h('div', { className: 'dupd-manual-item' }, '☐ ' + fmt(t, 'manual.session')),
  ) : null;

  const errLine = lastErr ? h('div', { key: 'err', className: 'dupd-banner dupd-error', role: 'alert' }, lastErr) : null;

  let action = null;
  if (ph === 'awaiting-restart') {
    // 升级流程进行中：继续走完（重启确认）
    action = h('button', { key: 'restart', type: 'button', className: 'dupd-btn dupd-primary', disabled: busy, onClick: restart }, fmt(t, 'btn.restart'));
  } else if (inFlight) {
    action = h('button', { key: 'busy', type: 'button', className: 'dupd-btn', disabled: true }, fmt(t, 'phase.' + ph));
  } else if (info && info.updateAvailable) {
    // v1.2 修复：有新版就提供升级入口——status.json 残留的 done 相位（上一次升级的记录）不再挡住新升级
    action = h('button', { key: 'start', type: 'button', className: 'dupd-btn dupd-primary', disabled: busy, onClick: start }, fmt(t, 'btn.start'));
  } else if (ph === 'done' || ph === 'done-with-warnings') {
    action = h('span', { key: 'ok', className: 'dupd-banner dupd-info' }, fmt(t, 'phase.' + ph));
  } else {
    action = h('button', { key: 'start', type: 'button', className: 'dupd-btn dupd-primary', disabled: busy || !info || !info.updateAvailable, onClick: start }, fmt(t, 'btn.start'));
  }

  const panel = open ? h('div', { key: 'backdrop', className: 'dupd-backdrop', onClick: e => { if (e.target === e.currentTarget && !inFlight) setOpen(false); } },
    h('div', { className: 'dupd-modal', role: 'dialog', 'aria-modal': true, 'aria-label': fmt(t, 'title') },
      h('div', { className: 'dupd-modal-head' },
        h('h2', { className: 'dupd-modal-title' }, fmt(t, 'title')),
        h('button', { type: 'button', className: 'dupd-modal-close', 'aria-label': fmt(t, 'btn.close'), disabled: inFlight, onClick: () => setOpen(false) }, '✕'),
      ),
      info ? h('div', { className: 'dupd-subtitle' }, fmt(t, 'subtitle', { current: info.current, target: info.latest })) : null,
      banner, errLine,
      h('div', { className: 'dupd-steps-wrap' }, stepView, manual),
      h('div', { className: 'dupd-modal-actions' },
        action,
        h('button', { type: 'button', className: 'dupd-btn', disabled: busy || inFlight, onClick: doCheckManual }, fmt(t, 'btn.recheck')),
        h('button', { type: 'button', className: 'dupd-btn', disabled: inFlight, onClick: () => setOpen(false) }, fmt(t, 'btn.close')),
      ),
    )) : null;

  // 只有按钮真正显示时才追加 dupd-root-end：无更新（chip === null）时外层 div 仍在，
  // 若它也带 margin-left:auto + order:2，这个空 flex 子项会与同行的 remote-bridge
  // 「Pair an iPhone」（自带 auto 外边距 + order:1）平分剩余空间，把对方从行尾挤到中间。
  const rootClass = !compact && showChip ? 'dupd-root dupd-root-end' : 'dupd-root';

  return h('div', { className: rootClass }, h('style', { key: 'css' }, CSS + CHIP_CSS), chip, panel);
}

export { UpdaterRoot };
