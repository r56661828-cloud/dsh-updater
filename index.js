// @you-renjun/dsh-updater — host 插件
// 职责：版本检查（registry dist-tags）/ 升级编排（spawn assets/upgrade.mjs）/ 重启 / 升级后自检
// 设计文档：~/dsh-explore/dsh-updater-plugin-design.md（方案 X：运行中安装，确认后重启；只盯 latest）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';

const REPO = '@deepseek-ai/dsh';
const CHANNEL = 'latest'; // 决策 2：只盯 latest
const STATE_DIR = path.join(os.homedir(), '.dsh', 'updater');
const STATUS_PATH = path.join(STATE_DIR, 'status.json');
const PROFILE = process.env.DSH_PROFILE || 'web';
const PROFILE_DIR = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', PROFILE);
const HOOK_PACKAGES = ['@deepseek-ai/dsh-hooks-claude-code', '@deepseek-ai/dsh-hook-protocol', '@deepseek-ai/dsh-llm'];
const BUSY_PHASES = ['running', 'awaiting-restart', 'restarting', 'selfcheck'];

const inject = ['webServer'];
// 升级后自检控制面：running 为防重入标志（runSelfcheck 内部检查 + POST /selfcheck 手动触发共用）；
// run 为执行入口，间接一层是为了可测试性——测试替换执行体，避免真跑自检（会写 status.json/读系统状态）
export const selfcheck = {
  running: false,
  run: () => runSelfcheck(),
};

// ── 基础设施 ─────────────────────────────────────────────────────────────
function launcherEntry() { return process.argv[1] || ''; }
function launcherPkgPath() {
  // argv[1] 可能是 nvm bin 下的符号链接（如 ~/.nvm/.../bin/dsh），必须先解析真实路径再向上找
  let entry = launcherEntry();
  try { entry = fs.realpathSync(entry); } catch {}
  let dir = path.dirname(entry);
  for (let i = 0; i < 8; i++) {
    const p = path.join(dir, 'package.json');
    try { if (JSON.parse(fs.readFileSync(p, 'utf8')).name === REPO) return p; } catch {}
    const up = path.dirname(dir); if (up === dir) break; dir = up;
  }
  return null;
}
function launcherVersion() {
  const p = launcherPkgPath();
  try { return String(JSON.parse(fs.readFileSync(p, 'utf8')).version).replace(/^v/, ''); } catch { return null; }
}
function semverParse(v) {
  const m = String(v || '').replace(/^v/, '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null } : null;
}
function semverCompare(a, b) {
  const A = semverParse(a), B = semverParse(b);
  if (!A || !B) return 0;
  for (const k of ['major', 'minor', 'patch']) if (A[k] !== B[k]) return A[k] - B[k];
  if (A.pre && B.pre) {
    const pa = A.pre.split('.'), pb = B.pre.split('.');
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i], y = pb[i];
      if (x === y) continue;
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
      if (nx && ny) return +x - +y;
      if (nx) return -1;
      if (ny) return 1;
      return x < y ? -1 : 1;
    }
    return 0;
  }
  if (A.pre) return -1;
  if (B.pre) return 1;
  return 0;
}
function readStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')); } catch { return null; }
}
function writeStatus(s) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATUS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATUS_PATH);
}
// 结构化运行日志（JSONL，2MB 轮转保留一代）：API 错误 / 自检结果 / 生命周期事件全部落盘，供事后定位
const LOG_PATH = path.join(STATE_DIR, 'logs', 'updater.log');
// 时间戳统一北京时间（Asia/Shanghai，UTC+8 无夏令时），格式：2026-10-27T13:27:03.123+08:00
function bjTs(d) {
  d = d || new Date();
  const p = n => String(n).padStart(2, '0');
  const t = new Date(d.getTime() + 8 * 3600000);
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}+08:00`;
}
function log(level, tag, msg, extra) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: bjTs(), level, tag, msg, ...(extra && typeof extra === 'object' && Object.keys(extra).length ? { extra } : {}) }) + '\n');
    try { if (fs.statSync(LOG_PATH).size > 2 * 1024 * 1024) fs.renameSync(LOG_PATH, LOG_PATH + '.1'); } catch {}
  } catch {}
}
function archiveStatus(cur) {
  // 每次新升级开始前，把上一次的 status.json 归档到 history/（保留最近 10 份）
  try {
    if (!cur || !cur.startedAt) return;
    const hDir = path.join(STATE_DIR, 'history');
    fs.mkdirSync(hDir, { recursive: true });
    fs.copyFileSync(STATUS_PATH, path.join(hDir, `${cur.startedAt}-${cur.target || cur.phase || 'unknown'}.json`));
    const old = fs.readdirSync(hDir).sort();
    while (old.length > 10) fs.unlinkSync(path.join(hDir, old.shift()));
  } catch {}
}
async function fetchDistTags() {
  const r = await fetch(`https://registry.npmjs.org/-/package/${REPO}/dist-tags`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('registry HTTP ' + r.status);
  return r.json();
}
function userEnv() {
  let uid = 1000;
  try { uid = os.userInfo().uid; } catch {}
  return Object.assign({}, process.env, {
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${uid}/bus`,
  });
}
function sh(cmd, args, opts) {
  return new Promise(resolve => {
    execFile(cmd, args, Object.assign({ encoding: 'utf8', timeout: 30000 }, opts || {}), (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// ── 服务方法 ─────────────────────────────────────────────────────────────
const CHECK_SOURCES = ['refresh', 'heartbeat', 'manual'];
async function check(source) {
  const src = CHECK_SOURCES.includes(source) ? source : 'host';
  const current = launcherVersion();
  const tags = await fetchDistTags();
  const latest = tags[CHANNEL];
  const updateAvailable = current ? semverCompare(latest, current) > 0 : false;
  // 每次检查都落一条 info 心跳（tag 标明触发来源），证明检查链路存活、可回答“上次检查是什么时候”
  log('info', 'check-' + src, updateAvailable ? 'update available' : 'check ok (no update)', { current, latest, updateAvailable });
  return {
    current,
    latest,
    channel: CHANNEL,
    updateAvailable,
    source: src,
    tags,
    checkedAt: new Date().toISOString(),
  };
}
async function start(targetRaw) {
  const target = String(targetRaw || '').replace(/^v/, '').trim();
  if (!/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(target)) { log('warn', 'pre-upgrade', 'start rejected: bad target', { target }); return { error: 'target 版本格式非法: ' + target }; }
  const cur = readStatus();
  if (cur && BUSY_PHASES.includes(cur.phase)) { log('warn', 'pre-upgrade', 'start rejected: busy', { target, phase: cur.phase }); return { error: '已有升级流程在进行（phase=' + cur.phase + '）' }; }
  const tags = await fetchDistTags();
  if (tags.latest !== target) { log('warn', 'pre-upgrade', 'start rejected: target != latest', { target, latest: tags.latest }); return { error: `目标 ${target} 不等于 latest(${tags.latest})——政策仅允许升级到 latest` }; }
  archiveStatus(cur); // 上一次运行归档到 history/，供事后定位
  log('info', 'pre-upgrade', 'start accepted', { target });
  const steps = [
    ['backup', '备份配置（两份 cordis.patch.yml）'],
    ['baseline', 'dump-config 留基准 + baseline 快照'],
    ['verify', '校验目标版本（仅允许 latest 通道）'],
    ['install', 'npm i -g ' + REPO + '@' + target],
    ['verify-version', 'dsh --version 核对'],
  ].map(([id, title]) => ({ id, title, state: 'pending', result: '', ts: Date.now() }));
  writeStatus({ v: 1, target, phase: 'running', selfcheckPending: false, steps, startedAt: Date.now(), error: null });
  const logFd = fs.openSync(path.join(STATE_DIR, 'last-upgrade.log'), 'a');
  const child = spawn(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), 'assets', 'upgrade.mjs'), target, STATUS_PATH, process.execPath, launcherEntry(), PROFILE], { detached: true, stdio: ['ignore', logFd, logFd], env: process.env });
  child.unref();
  fs.closeSync(logFd);
  log('info', 'pre-upgrade', 'upgrade script spawned', { target, pid: child.pid });
  return { accepted: true, target };
}
async function restart() {
  const s = readStatus();
  if (!s || s.phase !== 'awaiting-restart') { log('warn', 'restart', 'restart rejected', { phase: s ? s.phase : 'null' }); return { error: '当前 phase=' + (s ? s.phase : 'null') + '，不在可重启状态' }; }
  s.phase = 'restarting';
  s.selfcheckPending = true;
  s.restartedAt = Date.now();
  writeStatus(s);
  log('info', 'restart', 'restart issued', { target: s.target, restartedAt: s.restartedAt });
  // detached：重启会杀死本 host，重启命令必须独立存活
  const child = spawn('/bin/sh', ['-c', 'systemctl --user restart dsh-web'], { detached: true, stdio: 'ignore', env: userEnv() });
  child.unref();
  return { issued: true };
}
function statusView() {
  const s = readStatus();
  return s || { v: 1, phase: 'idle', steps: [], selfcheckPending: false };
}

// ── 升级后自检（新 host 实例接棒执行；与会话 Phase 3 对齐的最小集）────────
function addSelfcheckStep(id, title) {
  const s = readStatus(); if (!s) return null;
  const st = { id, title, state: 'running', result: '', ts: Date.now() };
  s.steps.push(st); writeStatus(s); return st;
}
function finishSelfcheckStep(id, ok, result, level) {
  const s = readStatus(); if (!s) return;
  const st = [...s.steps].reverse().find(x => x.id === id && x.state === 'running');
  if (st) {
    st.state = ok ? 'done' : (level === 'warn' ? 'warn' : 'failed');
    st.result = String(result || '').slice(0, 500); st.ts = Date.now();
    if (st.state === 'done') log('info', 'selfcheck', 'passed: ' + id);
    else log(st.state === 'warn' ? 'warn' : 'error', 'selfcheck', st.state + ': ' + id, { result: st.result });
  }
  writeStatus(s);
}
async function runSelfcheck() {
  if (selfcheck.running) return;
  selfcheck.running = true;
  log('info', 'selfcheck', 'selfcheck started');
  try {
    const s0 = readStatus(); if (!s0) return;
    s0.phase = 'selfcheck'; writeStatus(s0);
    const restartTs = s0.restartedAt || Date.now();
    const afterDumpPath = path.join(STATE_DIR, 'after-dump.yaml');

    let st = addSelfcheckStep('selfcheck-version', '自检 S1：版本 == 目标');
    const cur = launcherVersion();
    finishSelfcheckStep('selfcheck-version', cur === s0.target, `当前 ${cur || '?'} / 目标 ${s0.target}`, 'fail');

    st = addSelfcheckStep('selfcheck-resynth', '自检 S2：profile 重合成');
    try {
      const my = fs.statSync(path.join(PROFILE_DIR, 'cordis.yml')).mtimeMs;
      finishSelfcheckStep('selfcheck-resynth', my >= restartTs - 60000, 'cordis.yml mtime ' + new Date(my).toISOString(), 'warn');
    } catch (e) { finishSelfcheckStep('selfcheck-resynth', false, e.message, 'warn'); }

    st = addSelfcheckStep('selfcheck-dump', '自检 S3：dump diff 用户层零丢失');
    try {
      const r = await sh(process.execPath, [launcherEntry(), '--profile', PROFILE, '--dump-config'], { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      if (r.err || r.stdout.length < 100) throw new Error('dump 失败: ' + String(r.stderr || r.err || '').slice(0, 200));
      fs.writeFileSync(afterDumpPath, r.stdout);
      const after = r.stdout;
      const before = s0.baseline && s0.baseline.beforeDump ? fs.readFileSync(s0.baseline.beforeDump, 'utf8') : '';
      // 动态：baseline 快照的用户层顶层 insert id（新插件自动纳入，零维护）
      // 静态：手写关键行兜底（含 dsh-auth-refresh 等 bundle 行）
      const dynamic = (s0.baseline && s0.baseline.userLayerIds) || [];
      const staticKeys = ['mcp-codegraph', 'agentmemory', 'allowedModels', 'ui-theme', 'dsh-auth-refresh',
        'dsh-role-researcher', 'dsh-role-dev', 'dsh-role-tester',
        'preset-dsh-researcher', 'preset-dsh-dev', 'preset-dsh-tester'];
      const keys = [...new Set([...staticKeys, ...dynamic])];
      const missing = keys.filter(k => before.includes('- id: ' + k) && !after.includes('- id: ' + k));
      finishSelfcheckStep('selfcheck-dump', missing.length === 0, missing.length ? '用户层丢失: ' + missing.join(',') : '用户层条目零丢失', 'fail');
    } catch (e) { finishSelfcheckStep('selfcheck-dump', false, e.message, 'warn'); }

    st = addSelfcheckStep('selfcheck-roles', '自检 S4：角色模型钉核对');
    try {
      const after = fs.readFileSync(afterDumpPath, 'utf8');
      const roles = (s0.baseline && s0.baseline.roles) || {};
      const bad = [];
      for (const [tool, model] of Object.entries(roles)) {
        const idx = after.indexOf('toolName: ' + tool);
        const seg = idx >= 0 ? after.slice(idx, idx + 400) : '';
        const m = seg.match(/model:\s*(\S+)/);
        if (idx < 0 || !m || m[1] !== model) bad.push(`${tool}=${m ? m[1] : '缺失'}(期望 ${model})`);
      }
      finishSelfcheckStep('selfcheck-roles', bad.length === 0, bad.length ? '不一致: ' + bad.join('; ') : '三角色模型钉与升级前一致', 'fail');
    } catch (e) { finishSelfcheckStep('selfcheck-roles', false, e.message, 'warn'); }

    st = addSelfcheckStep('selfcheck-service', '自检 S5：服务健康');
    try {
      const a = await sh('systemctl', ['--user', 'is-active', 'dsh-web'], { env: userEnv(), timeout: 10000 });
      finishSelfcheckStep('selfcheck-service', a.stdout.trim() === 'active', 'is-active=' + a.stdout.trim(), 'fail');
    } catch (e) { finishSelfcheckStep('selfcheck-service', false, e.message, 'fail'); }

    st = addSelfcheckStep('selfcheck-journal', '自检 S6：journal 错误扫描');
    try {
      const since = new Date(restartTs - 5000).toISOString();
      const j = await sh('journalctl', ['--user', '-u', 'dsh-web', '--since', since, '--no-pager'], { env: userEnv(), timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
      const lines = String(j.stdout || '').split(/\r?\n/).filter(l => /error|failed|not found|ENOTEMPTY|ENOENT/i.test(l));
      finishSelfcheckStep('selfcheck-journal', lines.length === 0, lines.length ? lines.slice(0, 3).join(' ⏎ ') : '重启窗口零错误', 'warn');
    } catch (e) { finishSelfcheckStep('selfcheck-journal', false, e.message, 'warn'); }

    st = addSelfcheckStep('selfcheck-hooks', '自检 S7：hooks 三包在位');
    try {
      const missing = HOOK_PACKAGES.filter(p => { try { fs.accessSync(path.join(PROFILE_DIR, 'node_modules', p)); return false; } catch { return true; } });
      finishSelfcheckStep('selfcheck-hooks', missing.length === 0, missing.length ? '缺失: ' + missing.join(',') : '三包在位', 'fail');
    } catch (e) { finishSelfcheckStep('selfcheck-hooks', false, e.message, 'warn'); }

    // S8：profile 内 @deepseek-ai/* 精确钉依赖必须跟随宿主版本（2026-11-02 rc.5 升级暴露：版本不齐被宿主禁用）
    st = addSelfcheckStep('selfcheck-plugin-versions', '自检 S8：本地插件的宿主依赖版本对齐');
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, 'package.json'), 'utf8'));
      const hostV = launcherVersion();
      const bad = [];
      for (const [name] of Object.entries(pkg.dependencies || {}).filter(([n]) => n.startsWith('@deepseek-ai/'))) {
        try {
          const v = String(JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, 'node_modules', name, 'package.json'), 'utf8')).version).replace(/^v/, '');
          if (v !== hostV) bad.push(`${name}@${v}（宿主 ${hostV}）`);
        } catch {}
      }
      finishSelfcheckStep('selfcheck-plugin-versions', bad.length === 0,
        bad.length ? '版本未跟随宿主: ' + bad.join('; ') + ' —— 修复: pnpm add <pkg>@' + hostV : '全部随宿主版本对齐', 'warn');
    } catch (e) { finishSelfcheckStep('selfcheck-plugin-versions', false, e.message, 'warn'); }

    // 人工项占位（机器做不了的明示给用户）
    for (const [id, title] of [['manual-gui', '人工确认：GUI 冒烟'], ['manual-session', '人工确认：新会话工具下发']]) {
      const s = readStatus(); if (!s) break;
      s.steps.push({ id, title, state: 'manual', result: '', ts: Date.now() });
      writeStatus(s);
    }

    const s = readStatus();
    const auto = s.steps.filter(x => String(x.id).startsWith('selfcheck-'));
    const fails = auto.filter(x => x.state === 'failed').length;
    const warns = auto.filter(x => x.state === 'warn').length;
    s.selfcheckPending = false;
    s.phase = fails ? 'failed' : warns ? 'done-with-warnings' : 'done';
    s.finishedAt = Date.now();
    writeStatus(s);
    log('info', 'selfcheck', 'selfcheck finished', { phase: s.phase, fails, warns });
  } finally {
    selfcheck.running = false;
  }
}

// ── apply ────────────────────────────────────────────────────────────────
export function apply(ctx) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}

  // 跨重启接棒：上一实例发出的重启完成后，由新实例自动执行升级后自检
  try {
    const s = readStatus();
    if (s && s.selfcheckPending && s.phase === 'restarting') {
      log('info', 'handover', 'selfcheck handed over from previous instance', { target: s.target, restartedAt: s.restartedAt });
      setTimeout(() => { runSelfcheck().catch(() => {}); }, 5000); // 等服务/插件面稳定后再跑
    }
  } catch {}

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/dsh-updater',
    handler: async (req, res) => {
      const u = new URL(req.url, 'http://localhost');
      const p = u.pathname.replace(/^\/api\/dsh-updater/, '').replace(/\/+$/, '') || '/';
      try {
        if (req.method === 'GET' && p === '/health') return json(res, 200, { ok: true, version: launcherVersion(), channel: CHANNEL, entry: launcherEntry() });
        if (req.method === 'GET' && p === '/status') return json(res, 200, statusView());
        if (req.method === 'POST' && p === '/check') {
          const body = JSON.parse((await readBody(req)) || '{}');
          return json(res, 200, await check(body.source));
        }
        if (req.method === 'POST' && p === '/start') {
          const body = JSON.parse((await readBody(req)) || '{}');
          return json(res, 200, await start(body.target));
        }
        if (req.method === 'POST' && p === '/restart') return json(res, 200, await restart());
        if (req.method === 'POST' && p === '/selfcheck') {
          // 手动触发升级后自检（台账人工核销后重跑）：升级流程 busy（phase ∈ BUSY_PHASES）或
          // 自检已在跑（selfcheck.running）时拒绝，不重复执行；可跑则受理后 fire-and-forget
          // 执行（不 await，不阻塞响应），防重入兜底由 runSelfcheck 内 selfcheck.running 保证
          const cur = readStatus();
          const phase = cur ? cur.phase : 'null';
          if ((cur && BUSY_PHASES.includes(cur.phase)) || selfcheck.running) {
            log('warn', 'selfcheck', 'manual trigger rejected', { phase, selfcheckRunning: selfcheck.running });
            return json(res, 200, { ok: false, error: '已有升级/自检流程在进行（phase=' + phase + (selfcheck.running ? '，selfcheckRunning=true' : '') + '），不能手动触发自检' });
          }
          selfcheck.run().catch(() => {});
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && p === '/client-error') {
          // 浏览器侧插件异常上报：进同一份日志，level=error
          const body = JSON.parse((await readBody(req)) || '{}');
          log('error', 'client-error', String(body.where || 'client'), {
            message: String(body.message || '').slice(0, 500),
            stack: String(body.stack || '').split('\n').slice(0, 4).join(' ⏎ '),
          });
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { ok: false, error: 'not found: ' + p });
      } catch (e) {
        // error 报文全量落盘：message + 底层 cause（fetch failed 的真实网络原因在 e.cause）+ 堆栈前 4 行
        log('error', 'api-error', 'handler error', {
          path: p,
          method: req.method,
          error: String((e && e.message) || e),
          cause: String((e && e.cause && (e.cause.code || e.cause.message)) || ''),
          stack: String((e && e.stack) || '').split('\n').slice(0, 4).join(' ⏎ '),
        });
        return json(res, 500, { ok: false, error: String((e && e.message) || e) });
      }
    },
  }), 'dsh-updater: API route');

  return () => {};
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export { inject };
