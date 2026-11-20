// POST /api/dsh-updater/selfcheck 手动触发升级后自检端点回归
// 手段：HOME 沙盒重定向 STATE_DIR（index.js 在模块顶层读 os.homedir()，须在动态 import 前改）+
//       selfcheck.run 执行体替换（真实 runSelfcheck 会写 status.json/读系统状态，测试禁止真跑）。
// 契约：
//   E1 端点已注册：webServer.register 走 kind:prefix 单路由（/api/dsh-updater），POST /selfcheck 可达（非 404）。
//   E2 busy 拒绝：phase ∈ BUSY_PHASES（running/awaiting-restart/restarting/selfcheck）返回 {ok:false, error}
//      且不调用 runSelfcheck；selfcheck.running 置位（自检已在跑）同样拒绝。
//   E3 可跑受理：phase 可跑时返回 {ok:true}，fire-and-forget 调用 runSelfcheck（不 await 阻塞响应）。
//   E4 并发防重入：首次受理后（自检启动即置 phase=selfcheck + selfcheck.running）二次触发被挡，不重复执行。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── HOME 沙盒：必须在动态 import index.js 之前重定向（STATE_DIR 在模块顶层求值）──
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-updater-selfcheck-'));
process.env.HOME = sandbox;
const STATE_DIR = path.join(sandbox, '.dsh', 'updater');
const STATUS_PATH = path.join(STATE_DIR, 'status.json');
const { apply, selfcheck } = await import('../index.js');

// 注册路由（cordis effect 直接执行），捕获 kind:prefix 路由定义与 handler
let routeDef = null;
apply({
  effect: (fn) => fn(),
  webServer: { register: (def) => { routeDef = def; } },
});
if (!routeDef) throw new Error('webServer.register 未被调用：apply() 注册失败');

// 按需重写沙盒内 status.json（readStatus 每次现读，phase 用例间互不污染）
function writeStatus(phase) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATUS_PATH, JSON.stringify({
    v: 1, target: '9.9.9', phase, selfcheckPending: false, steps: [], startedAt: Date.now(), error: null,
  }));
}

async function call(method, p) {
  const res = { writeHead: vi.fn(), end: vi.fn() };
  await routeDef.handler({ method, url: '/api/dsh-updater' + p }, res);
  return { code: res.writeHead.mock.calls[0][0], body: JSON.parse(res.end.mock.calls[0][0]) };
}

describe('POST /api/dsh-updater/selfcheck 手动触发自检', () => {
  // 永不 resolve 的执行体桩：若 handler await 自检，响应永远不返回——反向证明「不 await 阻塞响应」
  const runSelfcheckMock = vi.fn(() => new Promise(() => {}));

  beforeEach(() => {
    runSelfcheckMock.mockClear();
    selfcheck.run = runSelfcheckMock;
    selfcheck.running = false;
  });

  afterEach(() => {
    selfcheck.running = false;
  });

  it('E1 路由注册：kind prefix + /api/dsh-updater，POST /selfcheck 可达（非 404 not found）', async () => {
    expect(routeDef.kind).toBe('prefix');
    expect(routeDef.path).toBe('/api/dsh-updater');
    writeStatus('idle');
    const r = await call('POST', '/selfcheck');
    expect(r.code).toBe(200);
    expect(r.body).toEqual({ ok: true }); // 未实现时会命中兜底 404 { ok:false, error:'not found: /selfcheck' }
  });

  it('E2 busy phase（running/awaiting-restart/restarting/selfcheck）一律拒绝且不调用 runSelfcheck', async () => {
    for (const phase of ['running', 'awaiting-restart', 'restarting', 'selfcheck']) {
      writeStatus(phase);
      const r = await call('POST', '/selfcheck');
      expect(r.code, `phase=${phase}`).toBe(200);
      expect(r.body.ok, `phase=${phase}`).toBe(false);
      expect(String(r.body.error), `phase=${phase}`).toContain(phase);
      expect(runSelfcheckMock, `phase=${phase}`).not.toHaveBeenCalled();
    }
  });

  it('E2b selfcheck.running 置位（自检已在跑）同样拒绝且不重复触发', async () => {
    writeStatus('done');
    selfcheck.running = true; // 模拟真实 runSelfcheck 已置位的防重入标志
    const r = await call('POST', '/selfcheck');
    expect(r.body.ok).toBe(false);
    expect(String(r.body.error), `error=${r.body.error}`).toContain('selfcheckRunning');
    expect(runSelfcheckMock).not.toHaveBeenCalled();
  });

  it('E3 可跑受理：返回 {ok:true} 且调用 runSelfcheck，响应不被自检阻塞', async () => {
    writeStatus('done'); // 终态（idle/done/done-with-warnings/failed）均可重跑
    const r = await call('POST', '/selfcheck');
    expect(r.body).toEqual({ ok: true }); // 若 handler await 了自检，此行永远不会到达（桩永不 resolve）
    expect(runSelfcheckMock).toHaveBeenCalledTimes(1);
  });

  it('E4 并发二次触发被挡：首跑启动即置 phase=selfcheck，第二次触发 ok:false 且不重复执行', async () => {
    writeStatus('idle');
    // 模拟真实 runSelfcheck 的启动第一拍：同步置 phase=selfcheck（与 index.js runSelfcheck 同语义）
    selfcheck.run = vi.fn(async () => { writeStatus('selfcheck'); });
    const first = await call('POST', '/selfcheck');
    expect(first.body).toEqual({ ok: true });
    const second = await call('POST', '/selfcheck');
    expect(second.body.ok).toBe(false);
    expect(selfcheck.run).toHaveBeenCalledTimes(1);
  });
});
