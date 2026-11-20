// upgrade.mjs 行为契约回归（坑 11 修复 + 1.1.2 两阶段重构：install 挪进 bounce 链）
// 手段：PATH 桩 + HOME 沙盒 + fetch 桩全链路干跑脚本——不真跑 systemctl/systemd-run/npm，
//       不联网（registry 走桩），不碰 ~/.dsh（HOME 重定向到临时目录）。
//       systemd-run 桩模拟真实 --scope 语义：记录参数 → 快照发起时刻 status → shift 3 后
//       exec 被包命令（即 node upgrade.mjs --bounce ...），bounce 在"scope"内同步跑完。
// 契约（两阶段编排）：
//   P1 前台形态：verify 后【不亲手 install】，构造 systemd-run --user --scope
//      --unit=dsh-upgrader-bounce <nodeBin> <SELF> --bounce <target> <statusPath> <nodeBin>
//      <entryJs> <profile> 发起独立 scope 后立即退出；发起时刻台账未写（phase 仍 running）、
//      install 仍 pending。
//   P2 bounce 形态（scope 内）：按序 install → verify-version → 写接棒台账（phase=restarting
//      + selfcheckPending=true + restartedAt）→ systemctl restart；台账先于 restart 落盘
//      （坑 11 C1 迁移），install/verify-version/restart 三步最终 done。
//   P3 --finish 模式独立可用：restart 步落 done + 交棒日志（1.1.1 语义保留，步骤合并为 restart）。
//   P4 失败路径：bounce 内 install 失败 → phase=failed + error（bounce 的精确文案不被前台
//      覆盖）+ 不调用 restart；前台 systemd-run 启动失败（scope 没起来）→ 前台 fail。
//   P5 --bounce 防重入：phase 非 running 直接拒绝，不跑 install。
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// vitest 模块运行器下 import.meta.url 不是真实文件路径，用项目根（vitest 的 cwd）解析
const SCRIPT = path.resolve(process.cwd(), 'assets', 'upgrade.mjs');
const REAL_NODE = process.execPath;
const TARGET = '9.9.9'; // fetch 桩固定 latest === target，绕开真实 registry
if (!fs.existsSync(SCRIPT)) throw new Error(`upgrade.mjs not found at ${SCRIPT} (cwd=${process.cwd()})`);

const sandboxes = [];
afterEach(() => {
  while (sandboxes.length) fs.rmSync(sandboxes.pop(), { recursive: true, force: true });
});

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-test-'));
  sandboxes.push(root);
  const sb = {
    root,
    home: path.join(root, 'home'),
    pkg: path.join(root, 'fakepkg'),
    stub: path.join(root, 'bin'),
    rec: path.join(root, 'rec'),
    updater: path.join(root, 'updater'),
  };
  for (const d of [sb.home, path.join(sb.home, '.dsh', 'profiles', 'web'), sb.pkg, sb.stub, sb.rec, sb.updater]) {
    fs.mkdirSync(d, { recursive: true });
  }
  // 用户层/profile 层 patch 桩（parseRoleModels/备份步骤只要求文件存在）
  fs.writeFileSync(path.join(sb.home, '.dsh', 'cordis.patch.yml'), '# stub user patch\n');
  fs.writeFileSync(path.join(sb.home, '.dsh', 'profiles', 'web', 'cordis.patch.yml'), '# stub profile patch\n');
  // 假 dsh 包树：launcherVersion 沿 entryJs 向上找 package.json
  fs.writeFileSync(path.join(sb.pkg, 'dsh.js'), 'console.log("fake dsh entry");\n');
  fs.writeFileSync(path.join(sb.pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.1' }, null, 2));
  // status.json 种子：镜像 index.js start() 写出的 5 个 pending 步（restart 步由脚本运行时动态创建）
  fs.writeFileSync(path.join(sb.updater, 'status.json'), JSON.stringify({
    v: 1, target: TARGET, phase: 'running', selfcheckPending: false,
    steps: [['backup', '备份配置'], ['baseline', 'dump-config 留基准'], ['verify', '校验目标版本'], ['install', 'npm i -g'], ['verify-version', '版本核对']]
      .map(([id, title]) => ({ id, title, state: 'pending', result: '', ts: Date.now() })),
    startedAt: Date.now(), error: null,
  }, null, 2));
  sb.statusPath = path.join(sb.updater, 'status.json');
  sb.logPath = path.join(sb.updater, 'logs', 'updater.log');

  // ── PATH 桩 ──
  const sh = (name, body) => {
    const p = path.join(sb.stub, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(p, 0o755);
  };
  sh('node', `exec "${REAL_NODE}" "$@"`);
  sh('npm', [
    'printf \'%s\\n\' "$@" >> "$UPDT_TEST_REC/npm.args"',
    `sed -i "s/\\"version\\": \\"[^\\"]*\\"/\\"version\\": \\"$UPDT_TEST_TARGET\\"/" "$UPDT_TEST_PKG/package.json"`,
    'if [ -n "$UPDT_TEST_NPM_FAIL" ]; then echo "stub npm: forced failure" >&2; exit 1; fi',
    'exit 0',
  ].join('\n'));
  // systemd-run 桩：记录参数（每参数一行）→ 快照 bounce 发起时刻 status（断言 P1：此刻
  // 台账未写、install 未跑）→ 可强制失败（前台 fail 路径）→ 否则模拟真实 --scope 语义：
  // shift 掉 3 个 flag 后 exec 被包命令（node SELF --bounce ...），即 scope 内同步跑 bounce
  sh('systemd-run', [
    'printf \'%s\\n\' "$@" > "$UPDT_TEST_REC/systemd-run.args"',
    'cp "$UPDT_TEST_STATUS" "$UPDT_TEST_REC/status.at-bounce.json" 2>/dev/null || true',
    'if [ -n "$UPDT_TEST_SDRun_FAIL" ]; then echo "stub systemd-run: forced failure" >&2; exit 1; fi',
    'shift 3',
    'exec "$@"',
  ].join('\n'));
  sh('systemctl', [
    'printf \'%s\\n\' "$@" >> "$UPDT_TEST_REC/systemctl.args"',
    'cp "$UPDT_TEST_STATUS" "$UPDT_TEST_REC/status.at-systemctl.json" 2>/dev/null || true',
    'exit 0',
  ].join('\n'));
  // journalctl 桩：记录参数（每参数一行）→ 可强制失败 → 否则输出 3 行假日志（供快照断言行数）
  sh('journalctl', [
    'printf \'%s\\n\' "$@" > "$UPDT_TEST_REC/journalctl.args"',
    'if [ -n "$UPDT_TEST_JCTL_FAIL" ]; then echo "stub journalctl: forced failure" >&2; exit 1; fi',
    'printf \'%s\\n\' "2026-11-09T10:00:00+0800 stubhost dsh-web[1]: stub line A" "2026-11-09T10:00:01+0800 stubhost dsh-web[1]: stub line B" "2026-11-09T10:00:02+0800 stubhost dsh-web[1]: stub line C"',
    'exit 0',
  ].join('\n'));
  // fetch 桩：registry 请求返回固定 dist-tags，其余透传
  fs.writeFileSync(path.join(sb.stub, 'fetch-stub.cjs'), [
    'const orig = globalThis.fetch;',
    'globalThis.fetch = async (url) => {',
    '  if (String(url).includes("registry.npmjs.org")) {',
    '    return new Response(JSON.stringify({ latest: process.env.UPDT_TEST_TARGET }), { status: 200, headers: { "content-type": "application/json" } });',
    '  }',
    '  return orig(url);',
    '};',
  ].join('\n'));
  return sb;
}

function runScript(sb, args, extraEnv = {}) {
  const env = {
    ...process.env,
    HOME: sb.home,
    PATH: sb.stub + ':' + process.env.PATH,
    NODE_OPTIONS: '--require ' + path.join(sb.stub, 'fetch-stub.cjs'),
    UPDT_TEST_REC: sb.rec,
    UPDT_TEST_STATUS: sb.statusPath,
    UPDT_TEST_TARGET: TARGET,
    UPDT_TEST_PKG: sb.pkg,
    ...extraEnv,
  };
  return spawnSync(REAL_NODE, [SCRIPT, ...args], { env, encoding: 'utf8', timeout: 30000 });
}

// 前台形态对 bounce 是 detached spawn（unref）：前台退出时 bounce 可能仍在后台跑，
// 断言前轮询 status.json 直到满足谓词（桩全链毫秒级，正常瞬间通过；超时即失败证据）
async function waitFor(sb, pred, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const s = JSON.parse(fs.readFileSync(sb.statusPath, 'utf8'));
    if (pred(s)) return s;
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout; status=' + JSON.stringify(s).slice(0, 500));
    await new Promise(r => setTimeout(r, 50));
  }
}

const readArgs = (sb, name) => fs.readFileSync(path.join(sb.rec, name), 'utf8').trim().split('\n');
const readJson = (sb, p) => JSON.parse(fs.readFileSync(path.join(sb.rec, p), 'utf8'));
const hasFile = (sb, name) => fs.existsSync(path.join(sb.rec, name));

describe('upgrade.mjs 两阶段编排（install 挪进 bounce 链）', () => {
  it('P1+P2：前台 verify 后不亲手 install、构造正确的 systemd-run bounce 链；scope 内 install→verify-version→台账→restart，台账先于 restart', async () => {
    const sb = makeSandbox();
    const nodeStub = path.join(sb.stub, 'node');
    const entryJs = path.join(sb.pkg, 'dsh.js');
    const r = runScript(sb, [TARGET, sb.statusPath, nodeStub, entryJs, 'web']);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);

    // P1：前台构造的 systemd-run 命令行——flag、unit 名、--bounce 参数齐全且有序
    const sd = readArgs(sb, 'systemd-run.args');
    expect(sd[0]).toBe('--user');
    expect(sd[1]).toBe('--scope');
    expect(sd[2]).toBe('--unit=dsh-upgrader-bounce');
    expect(sd[3]).toBe(nodeStub);
    expect(sd[4]).toBe(SCRIPT); // scope 内以 --bounce 重新调起脚本自身
    expect(sd[5]).toBe('--bounce');
    expect(sd[6]).toBe(TARGET);
    expect(sd[7]).toBe(sb.statusPath);
    expect(sd[8]).toBe(nodeStub);
    expect(sd[9]).toBe(entryJs);
    expect(sd[10]).toBe('web');
    expect(r.stdout).toContain('bounced'); // 前台发起后立即退出

    // P1（核心）：发起时刻（bounce 尚未执行任何步骤）——台账未写、install 未跑
    const atBounce = readJson(sb, 'status.at-bounce.json');
    expect(atBounce.phase).toBe('running');
    expect(atBounce.selfcheckPending).toBe(false);
    expect(atBounce.steps.find(x => x.id === 'install').state).toBe('pending');
    expect(atBounce.steps.find(x => x.id === 'restart').state).toBe('running'); // 前台发起步

    // P2：等 bounce 全链完成（前台 detached 退出，bounce 可能稍后落盘）
    const fin = await waitFor(sb, s => s.phase !== 'running' && s.steps.every(x => x.state !== 'running'));

    // bounce 按序跑了 install（且只跑一次），--cache 隔离参数保留
    const npm = readArgs(sb, 'npm.args');
    expect(npm[0]).toBe('i');
    expect(npm[2]).toBe('@deepseek-ai/dsh@' + TARGET);
    expect(npm).toContain('--cache');
    expect(npm).toContain('/tmp/npmcache-dsh');

    // restart 动作走 systemctl --user restart（bounce 在 scope 内直连，无需再套 systemd-run）
    expect(readArgs(sb, 'systemctl.args')).toEqual(['--user', 'restart', 'dsh-web']);

    // P2（核心，坑 11 C1 迁移）：restart 执行时刻的 status 已带接棒台账，
    // 且 install/verify-version 已 done（先装好再重启）
    const atCtl = readJson(sb, 'status.at-systemctl.json');
    expect(atCtl.phase).toBe('restarting');
    expect(atCtl.selfcheckPending).toBe(true);
    expect(typeof atCtl.restartedAt).toBe('number');
    expect(atCtl.steps.find(x => x.id === 'install').state).toBe('done');
    expect(atCtl.steps.find(x => x.id === 'verify-version').state).toBe('done');

    // 终态：三步 done、phase=selfcheckPending 接棒态
    expect(fin.phase).toBe('restarting');
    expect(fin.selfcheckPending).toBe(true);
    expect(fin.steps.find(x => x.id === 'install').state).toBe('done');
    expect(fin.steps.find(x => x.id === 'verify-version').state).toBe('done');
    expect(fin.steps.find(x => x.id === 'restart').state).toBe('done');
    expect(fin.steps.filter(x => x.id === 'restart')).toHaveLength(1); // 不重复创建

    // 前台从未写过接棒台账，台账由 bounce 在 restart 前写（日志可证）
    const log = fs.readFileSync(sb.logPath, 'utf8');
    expect(log).toContain('handover written before bounce');
    expect(log).toContain('step finished: restart');
    expect(log).toContain('upgrade flow handed over to selfcheck');
  }, 30000);

  it('P4a：bounce 内 install 失败 → phase=failed + bounce 的 error 不被前台覆盖 + 不调用 restart', async () => {
    const sb = makeSandbox();
    const r = runScript(sb, [TARGET, sb.statusPath, path.join(sb.stub, 'node'), path.join(sb.pkg, 'dsh.js'), 'web'], { UPDT_TEST_NPM_FAIL: '1' });
    // 前台自身正常退出（失败发生在 scope 内、由 bounce 上报）
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);

    const fin = await waitFor(sb, s => s.phase === 'failed');
    expect(fin.error).toContain('安装失败'); // bounce 的精确文案（防前台双写覆盖）
    expect(fin.steps.find(x => x.id === 'install').state).toBe('failed');
    expect(fin.steps.find(x => x.id === 'verify-version').state).toBe('pending');
    expect(readArgs(sb, 'npm.args').length).toBeGreaterThan(0); // 确实进了 bounce 的 install
    expect(hasFile(sb, 'systemctl.args')).toBe(false); // 失败路径绝不 restart，宿主保持运行
    expect(fs.readFileSync(sb.logPath, 'utf8')).toContain('upgrade flow failed: install');
  }, 30000);

  it('P4b：前台 systemd-run 启动失败（scope 没起来）→ 前台 fail，phase=failed', () => {
    const sb = makeSandbox();
    const r = runScript(sb, [TARGET, sb.statusPath, path.join(sb.stub, 'node'), path.join(sb.pkg, 'dsh.js'), 'web'], { UPDT_TEST_SDRun_FAIL: '1' });
    expect(r.status, `stderr: ${r.stderr}`).toBe(1);

    const fin = JSON.parse(fs.readFileSync(sb.statusPath, 'utf8'));
    expect(fin.phase).toBe('failed');
    expect(fin.error).toContain('发起 bounce 失败');
    expect(hasFile(sb, 'npm.args')).toBe(false); // install 未跑（scope 没起来）
  }, 30000);

  it('P3：--finish 模式独立可用（restart 步落 done + 交棒日志）', () => {
    const sb = makeSandbox();
    // 种子改到 restart 后状态：5 步 done + restart running + 接棒台账已写
    const st = JSON.parse(fs.readFileSync(sb.statusPath, 'utf8'));
    st.phase = 'restarting';
    st.selfcheckPending = true;
    st.restartedAt = Date.now();
    for (const s of st.steps) s.state = 'done';
    st.steps.push({ id: 'restart', title: '重启 dsh-web', state: 'running', result: '', ts: Date.now() });
    fs.writeFileSync(sb.statusPath, JSON.stringify(st, null, 2));

    const r = runScript(sb, ['--finish', sb.statusPath]);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);

    const after = JSON.parse(fs.readFileSync(sb.statusPath, 'utf8'));
    const restarts = after.steps.filter(x => x.id === 'restart');
    expect(restarts).toHaveLength(1);
    expect(restarts[0].state).toBe('done');
    expect(after.phase).toBe('restarting'); // phase 保持接棒态，自检由新 host 接手
    expect(after.selfcheckPending).toBe(true);
    expect(fs.readFileSync(sb.logPath, 'utf8')).toContain('upgrade flow handed over to selfcheck');
  }, 30000);

  it('P5：--bounce 防重入——phase 非 running 直接拒绝，不跑 install', () => {
    const sb = makeSandbox();
    const st = JSON.parse(fs.readFileSync(sb.statusPath, 'utf8'));
    st.phase = 'failed';
    fs.writeFileSync(sb.statusPath, JSON.stringify(st, null, 2));

    const r = runScript(sb, ['--bounce', TARGET, sb.statusPath, path.join(sb.stub, 'node'), path.join(sb.pkg, 'dsh.js'), 'web']);
    expect(r.status).not.toBe(0);
    expect(hasFile(sb, 'npm.args')).toBe(false);
    const after = JSON.parse(fs.readFileSync(sb.statusPath, 'utf8'));
    expect(after.phase).toBe('failed'); // 状态不被改写
  }, 30000);
});

describe('upgrade.mjs log-snapshot（升级前版本化日志快照）', () => {
  // 契约（backup 之后新增子步，仅前台形态执行）：
  //   L1 有基准：journalctl --user -u dsh-web --output=short-iso --since=<最新基准头部 until>；
  //      快照写 version-logs/dsh-version<当前版本>.bak（同版本覆盖），头部插入
  //      `# dsh-version-backup version=<ver> until=<导出时刻北京时间 ISO8601>`，.tmp→rename 原子落盘；
  //      step state=done，result 含文件名/行数/起点。
  //   L2 无基准：命令不含 --since（全量导出）。
  //   L3 滚动：按 mtime 保留最新 7 份（含刚写入的），其余删除。
  //   L4 失败降级：journalctl 非零 → log-snapshot state=warn，不 fail、bounce 链照常完成。
  it('L1：有基准带 --since + 文件名/头部注释正确 + 同版本覆盖 + .tmp 无残留 + bounce 不重复执行', async () => {
    const sb = makeSandbox();
    const logsDir = path.join(sb.updater, 'version-logs');
    fs.mkdirSync(logsDir, { recursive: true });
    // 同版本旧快照（上次同版本升级产物，含旧垃圾内容）+ mtime 更新的另一版本基准：
    // 起点必须取 mtime 最新的合法头部（9.8.7 的 until），写入目标仍是 0.0.1 同名覆盖
    const sameOld = path.join(logsDir, 'dsh-version0.0.1.bak');
    fs.writeFileSync(sameOld, '# dsh-version-backup version=0.0.1 until=2026-11-07T08:00:00+08:00\nOLD JUNK\n');
    const newer = path.join(logsDir, 'dsh-version9.8.7.bak');
    fs.writeFileSync(newer, '# dsh-version-backup version=9.8.7 until=2026-11-08T09:30:00+08:00\nx\n');
    const t = Date.now();
    fs.utimesSync(sameOld, new Date(t - 600000), new Date(t - 600000));
    fs.utimesSync(newer, new Date(t), new Date(t));

    const r = runScript(sb, [TARGET, sb.statusPath, path.join(sb.stub, 'node'), path.join(sb.pkg, 'dsh.js'), 'web']);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);

    // 命令形态：flag 顺序固定，--since 取自最新基准头部的 until
    expect(readArgs(sb, 'journalctl.args'))
      .toEqual(['--user', '-u', 'dsh-web', '--output=short-iso', '--since=2026-11-08T09:30:00+08:00']);

    // 同名覆盖：旧垃圾内容被 journalctl 桩输出替换，头部是新注释（版本=当前 launcher 版本 0.0.1）
    const snap = fs.readFileSync(sameOld, 'utf8');
    expect(snap).not.toContain('OLD JUNK');
    expect(snap).toContain('stub line A');
    expect(snap.split('\n')[0]).toMatch(/^# dsh-version-backup version=0\.0\.1 until=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00$/);
    expect(fs.readdirSync(logsDir).some(f => f.endsWith('.tmp'))).toBe(false); // 原子落盘无残留

    const fin = await waitFor(sb, s => s.phase !== 'running' && s.steps.every(x => x.state !== 'running'));
    const ls = fin.steps.filter(x => x.id === 'log-snapshot');
    expect(ls).toHaveLength(1); // 仅前台形态创建一次，bounce 内不重复执行
    expect(ls[0].state).toBe('done');
    expect(ls[0].result).toContain('dsh-version0.0.1.bak（3 行，自 2026-11-08T09:30:00+08:00）');
  }, 30000);

  it('L2：无基准 → 全量导出（命令不含 --since），起点描述为「全量」', async () => {
    const sb = makeSandbox(); // version-logs 目录不存在
    const r = runScript(sb, [TARGET, sb.statusPath, path.join(sb.stub, 'node'), path.join(sb.pkg, 'dsh.js'), 'web']);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);

    const jargs = readArgs(sb, 'journalctl.args');
    expect(jargs.slice(0, 4)).toEqual(['--user', '-u', 'dsh-web', '--output=short-iso']);
    expect(jargs.some(a => a.startsWith('--since='))).toBe(false);

    const snapPath = path.join(sb.updater, 'version-logs', 'dsh-version0.0.1.bak');
    expect(fs.existsSync(snapPath)).toBe(true);
    const fin = await waitFor(sb, s => s.phase !== 'running' && s.steps.every(x => x.state !== 'running'));
    const ls = fin.steps.find(x => x.id === 'log-snapshot');
    expect(ls.state).toBe('done');
    expect(ls.result).toContain('dsh-version0.0.1.bak（3 行，自 全量）');
  }, 30000);

  it('L3：滚动保留 7 份——预置 9 个假 .bak，执行后剩 7 且删的是最旧 3 份', async () => {
    const sb = makeSandbox();
    const logsDir = path.join(sb.updater, 'version-logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const names = [];
    for (let i = 0; i < 9; i++) {
      const f = `dsh-version1.0.${i}.bak`;
      fs.writeFileSync(path.join(logsDir, f), `# dsh-version-backup version=1.0.${i} until=2026-11-01T00:0${i}:00+08:00\nx\n`);
      const t = Date.now() - (20 - i) * 60000; // i 越大 mtime 越新
      fs.utimesSync(path.join(logsDir, f), new Date(t), new Date(t));
      names.push(f);
    }
    const r = runScript(sb, [TARGET, sb.statusPath, path.join(sb.stub, 'node'), path.join(sb.pkg, 'dsh.js'), 'web']);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);

    const left = fs.readdirSync(logsDir).filter(f => /^dsh-version.*\.bak$/.test(f)).sort();
    expect(left).toHaveLength(7); // 9 预置 + 1 新写入 = 10 → 保留最新 7
    expect(left).toContain('dsh-version0.0.1.bak'); // 刚写入的这份（mtime 最新）必须保留
    for (const gone of names.slice(0, 3)) expect(left).not.toContain(gone); // 最旧 3 份被删
    for (const kept of names.slice(3)) expect(left).toContain(kept);
  }, 30000);

  it('L4：journalctl 失败 → log-snapshot 落 warn（不 fail），bounce 链照常完成升级', async () => {
    const sb = makeSandbox();
    const r = runScript(sb, [TARGET, sb.statusPath, path.join(sb.stub, 'node'), path.join(sb.pkg, 'dsh.js'), 'web'], { UPDT_TEST_JCTL_FAIL: '1' });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0); // 前台照常发起 bounce

    const fin = await waitFor(sb, s => s.phase !== 'running' && s.steps.every(x => x.state !== 'running'));
    const ls = fin.steps.find(x => x.id === 'log-snapshot');
    expect(ls.state).toBe('warn'); // 失败降级，不是 failed
    expect(ls.result).toContain('journalctl');
    expect(fin.phase).toBe('restarting'); // 升级主链不受阻
    expect(fin.steps.find(x => x.id === 'install').state).toBe('done');
    expect(fin.steps.find(x => x.id === 'verify-version').state).toBe('done');
    expect(fin.steps.find(x => x.id === 'restart').state).toBe('done');
    expect(readArgs(sb, 'systemctl.args')).toEqual(['--user', 'restart', 'dsh-web']); // bounce 照常重启
    expect(fs.readFileSync(sb.logPath, 'utf8')).toMatch(/"level":"warn"[^\n]*step finished: log-snapshot/);
  }, 30000);
});
