#!/usr/bin/env node
// dsh-updater 升级编排脚本——由 host 插件 spawn（detached；注意 detached 只换 session 不换 cgroup）
// 用法: node upgrade.mjs <target> <statusPath> <nodeBin> <entryJs> [profile]           （前台形态）
//       node upgrade.mjs --bounce <target> <statusPath> <nodeBin> <entryJs> [profile]  （scope 内形态）
//       node upgrade.mjs --finish <statusPath>    （restart 完成后在 scope 内收尾，见 bounce 形态注释）
// 两阶段时序（1.2.0 重构：install 挪进 bounce 链，消除「运行中安装」）：
//   前台形态（宿主还活着，本进程在 dsh-web.service cgroup 内）：
//     backup → log-snapshot（版本化日志快照，失败降级不阻塞）
//     → baseline → verify（latest 通道校验）
//     → 发起 systemd-run --user --scope --unit=dsh-upgrader-bounce 独立 scope，
//       scope 内以 --bounce 参数重新调起本脚本自身 → 前台立即退出（不亲手 install/restart）
//   bounce 形态（独立 scope cgroup，宿主 restart 杀不到）：
//     install（npm i -g，此时宿主仍在运行、持旧 inode 不受替换影响）→ verify-version
//     → 写接棒台账（phase=restarting + selfcheckPending=true + restartedAt）
//     → systemctl --user restart dsh-web && --finish 收尾 → 结束
// 为什么要挪：install 若在前台运行中替换 launcher 树，曾致宿主前端崩溃/页面空白
//   （2026-11-02 实战，runbook §6）；挪进 scope 后安装期间宿主进程完整运行，
//   断连窗口收窄为 restart 前后数秒（npm 下载/安装时间不再计入断连）。
// 每步原子更新 status.json（steps 由两阶段共同续写：bounce 形态启动时重新 readStatus，
// 不沿用任何内存状态）；失败 → phase=failed + error（宿主未重启，弹框可见）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url); // bounce 链重新调起 / --finish 回调均需要脚本自身绝对路径
const rawArgs = process.argv.slice(2);
const mode = (rawArgs[0] === '--bounce' || rawArgs[0] === '--finish') ? rawArgs.shift() : null;
const bounceMode = mode === '--bounce'; // scope 内形态：install → verify-version → 台账 → restart
const finishMode = mode === '--finish'; // 收尾模式：restart 命令链回调，见 bounce 形态注释
// --finish 用法 `--finish <statusPath>`（1.1.1 兼容）：statusPath 落在第 1 位；其余形态 5 个位置参数
const [targetArg, statusPathArg, nodeBin, entryJs, profileArg] = rawArgs;
const statusPath = finishMode ? targetArg : statusPathArg;
const profile = profileArg || process.env.DSH_PROFILE || 'web';
const profileDir = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', profile);
const userPatch = path.join(os.homedir(), '.dsh', 'cordis.patch.yml');
const profilePatch = path.join(profileDir, 'cordis.patch.yml');
const REPO = '@deepseek-ai/dsh';

const target = String(targetArg || '').replace(/^v/, '');
if ((finishMode && !statusPath) || (!finishMode && (!target || !statusPath || !nodeBin || !entryJs))) {
  console.error('usage: upgrade.mjs <target> <statusPath> <nodeBin> <entryJs> [profile]');
  console.error('       upgrade.mjs --bounce <target> <statusPath> <nodeBin> <entryJs> [profile]');
  console.error('       upgrade.mjs --finish <statusPath>');
  process.exit(2);
}

function readStatus() {
  try { return JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch { return null; }
}
function writeStatus(s) {
  s.v = 1;
  const tmp = statusPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, statusPath);
}
// 结构化运行日志（与 host 插件共用同一个 JSONL 文件）
const LOG_PATH = path.join(path.dirname(statusPath), 'logs', 'updater.log');
function bjTs(d) {
  d = d || new Date();
  const p = n => String(n).padStart(2, '0');
  const t = new Date(d.getTime() + 8 * 3600000);
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}+08:00`;
}
const tagOf = id => ['install', 'verify-version', 'restart'].includes(id) ? 'upgrade' : 'pre-upgrade';
function log(level, tag, msg, extra) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: bjTs(), level, tag, msg, ...(extra && typeof extra === 'object' && Object.keys(extra).length ? { extra } : {}) }) + '\n');
  } catch {}
}
function step(id, title) {
  const s = readStatus(); if (!s) return null;
  const pend = s.steps.find(x => x.id === id && x.state === 'pending');
  if (pend) { pend.state = 'running'; pend.ts = Date.now(); writeStatus(s); log('info', tagOf(id), 'step started: ' + id); return pend; }
  const st = { id, title, state: 'running', result: '', ts: Date.now() };
  s.steps.push(st); writeStatus(s); log('info', tagOf(id), 'step started: ' + id); return st;
}
function finishStep(st, ok, result, state) {
  // state 可选覆盖：'warn' 用于「失败但可降级」的步骤（log-snapshot）——落 warn 态而非 failed，
  // 升级主链继续；不传时维持原语义（ok → done / !ok → failed）
  const s = readStatus(); if (!s) return;
  const cur = [...s.steps].reverse().find(x => x.id === st.id && x.state === 'running');
  if (cur) { cur.state = state || (ok ? 'done' : 'failed'); cur.result = String(result || '').slice(0, 800); cur.ts = Date.now(); }
  writeStatus(s);
  log(state === 'warn' ? 'warn' : (ok ? 'info' : 'error'), tagOf(st.id), 'step finished: ' + st.id, { ok, result: String(result || '').slice(0, 300) });
}
function fail(st, reason) {
  finishStep(st, false, reason);
  const s = readStatus();
  if (s) { s.phase = 'failed'; s.error = String(reason).slice(0, 800); writeStatus(s); }
  log('error', tagOf(st.id), 'upgrade flow failed: ' + st.id, { reason: String(reason).slice(0, 500) });
  process.exit(1);
}
function sh(cmd, args, opts) {
  return spawnSync(cmd, args, Object.assign({ encoding: 'utf8', timeout: 900000 }, opts || {}));
}
function semverNorm(v) { return String(v || '').replace(/^v/, '').trim(); }
function launcherVersion() {
  // entryJs 可能是符号链接（~/.nvm/.../bin/dsh），必须先 realpath 再向上找 package.json
  let entry = entryJs;
  try { entry = fs.realpathSync(entry); } catch {}
  let dir = path.dirname(entry);
  for (let i = 0; i < 8; i++) {
    const p = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (pkg.name === REPO) return semverNorm(pkg.version);
    } catch {}
    const up = path.dirname(dir); if (up === dir) break; dir = up;
  }
  return null;
}
function parseRoleModels(patchPath) {
  // 从用户层 patch 提取三个角色的模型钉：toolName: dsh_xxx 后不远处紧跟 model:
  const map = {};
  try {
    const lines = fs.readFileSync(patchPath, 'utf8').split(/\r?\n/);
    let cur = null, looked = 0;
    for (const line of lines) {
      const m = line.match(/toolName:\s*(dsh_\w+)/);
      if (m) { cur = m[1]; looked = 0; continue; }
      if (cur) {
        looked++;
        const mm = line.match(/^\s*model:\s*(\S+)/);
        if (mm) { map[cur] = mm[1]; cur = null; } else if (looked > 8) cur = null;
      }
    }
  } catch {}
  return map;
}
async function distTags() {
  const r = await fetch(`https://registry.npmjs.org/-/package/${REPO}/dist-tags`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('registry HTTP ' + r.status);
  return r.json();
}
function findRunningStep(id) {
  const s = readStatus();
  return s ? [...s.steps].reverse().find(x => x.id === id && x.state === 'running') : null;
}
function listVersionBaks(dir) {
  // version-logs 目录下 dsh-version*.bak 清单（含 mtime），按新→旧排序；
  // 目录不存在/读取失败按空清单处理（调用方据此走全量导出/不清理）
  try {
    return fs.readdirSync(dir)
      .filter(f => /^dsh-version.*\.bak$/.test(f))
      .map(f => { try { return { f, m: fs.statSync(path.join(dir, f)).mtimeMs }; } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => b.m - a.m);
  } catch { return []; }
}

// ── --finish 收尾模式：bounce 形态的 restart 命令链在 restart 完成后回调到此 ──
// 落 restart 步为 done 并补交棒日志；本进程运行在 dsh-upgrader-bounce.scope 内（同 bounce 形态），
// restart 杀 dsh-web.service cgroup 伤不到这里——即使极端时序下 scope 先被清理、收尾丢失，
// 接棒台账也已在 restart 前写好，自检照跑。
if (finishMode) {
  const rst = findRunningStep('restart');
  if (rst) finishStep(rst, true, 'restarted via dsh-upgrader-bounce.scope');
  const s = readStatus();
  if (s) log('info', 'pre-upgrade', 'upgrade flow handed over to selfcheck', { target: s.target });
  console.log('handed-over');
  process.exit(0);
}

// ── bounce 形态：前台发起的 dsh-upgrader-bounce.scope cgroup 内运行 ──
// 守卫：本形态由前台在 phase=running 时发起；防重入/异常调起（如 phase=failed 后再次触发）
if (bounceMode) {
  const bs = readStatus(); // 全新进程，必须重新读盘，不沿用任何内存状态
  if (!bs || bs.phase !== 'running') {
    console.error('bounce: status not in running phase (' + (bs ? bs.phase : 'null') + '); abort');
    process.exit(1);
  }
  // 步骤 4：安装（scope 内执行——宿主仍运行中、进程持旧 inode，launcher 树替换不影响宿主；
  // 这是相对 1.1.1 的关键重排：1.1.1 在前台装，曾致宿主前端崩溃/页面空白，见文件头）
  let bst = step('install', 'npm i -g ' + REPO + '@' + target);
  try {
    const npm = path.join(path.dirname(nodeBin), 'npm');
    const r = sh(npm, ['i', '-g', REPO + '@' + target, '--cache', '/tmp/npmcache-dsh'], { timeout: 900000 });
    const tail = String((r.stdout || '') + '\n' + (r.stderr || '')).split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
    if (r.status !== 0) throw new Error('npm 退出 ' + r.status + ': ' + (tail || 'see last-upgrade.log'));
    finishStep(bst, true, tail || 'ok');
  } catch (e) { fail(bst, '安装失败: ' + e.message); }

  // 步骤 5：版本核对（磁盘）
  bst = step('verify-version', 'dsh --version 核对（磁盘）');
  try {
    const v = launcherVersion();
    if (v !== target) throw new Error('磁盘版本为 ' + (v || '?') + '，期望 ' + target);
    finishStep(bst, true, 'v' + v);
  } catch (e) { fail(bst, '核对失败: ' + e.message); }

  // 写接棒台账（必须先于 restart，坑 11 契约）：本脚本即使此后异常死亡，
  // 新 host 实例挂载时（index.js selfcheckPending && phase==='restarting'）也会自动跑自检
  const hs = readStatus();
  if (hs) {
    hs.phase = 'restarting';
    hs.selfcheckPending = true;
    hs.restartedAt = Date.now();
    writeStatus(hs);
    log('info', 'pre-upgrade', 'handover written before bounce', { target });
  }

  // 步骤 6：restart。本进程已在独立 scope cgroup 内，宿主 restart 杀不到；无需再套 systemd-run。
  // restart 完成后链尾回调 --finish 落 restart 步 done + 交棒日志（1.1.1 保守设计保留：
  // 收尾挂进命令链而不是指望本进程在 restart 后必然存活）。
  const restartChain = 'systemctl --user restart dsh-web'
    + ' && ' + JSON.stringify(nodeBin) + ' ' + JSON.stringify(SELF) + ' --finish ' + JSON.stringify(statusPath);
  const r = sh('/bin/sh', ['-c', restartChain], { timeout: 120000 });
  if (r.status !== 0) {
    // restart 失败：宿主未重启（仍在运行），如实上报失败让弹框可见
    fail(findRunningStep('restart') || { id: 'restart' },
      'restart 退出 ' + r.status + ': ' + String(r.stderr || '').slice(0, 200));
  }
  console.log('bounced');
  process.exit(0);
}

const st0 = readStatus();
if (!st0 || st0.phase !== 'running') { console.error('status not in running phase; abort'); process.exit(1); }

// ── 步骤 1：备份（与会话流程 §1 一致：两份 cordis.patch.yml 带时间戳）──
let st = step('backup', '备份配置（两份 cordis.patch.yml）');
try {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  fs.copyFileSync(userPatch, userPatch + '.bak-' + ts);
  fs.copyFileSync(profilePatch, profilePatch + '.bak-' + ts);
  finishStep(st, true, '.bak-' + ts + '（用户层 + profile 层）');
} catch (e) { fail(st, '备份失败: ' + e.message); }

// ── 步骤 1b：版本化日志快照（升级前导出当前版本运行期的宿主 journal 日志，滚动保留 7 份）──
// 失败可降级（只 warn 不 fail）：日志快照是升级可观测性的补强，任何失败都不应阻塞升级主链。
// 起点基准：version-logs/ 最新一份 dsh-version*.bak 的首行注释
//   `# dsh-version-backup version=<ver> until=<ISO8601>`，取 until 作 --since 增量导出；
// 目录不存在/无合法基准 → 不加 --since（全量导出，一次性补齐）。
// 原子落盘：头部注释 + journalctl 输出先写 .tmp 再 rename 到正式名；同版本重复升级覆盖同名文件。
st = step('log-snapshot', '备份当前版本日志快照');
try {
  const ver = launcherVersion(); // 当前版本（升级前磁盘上的），文件名原样拼接（如 dsh-version0.2.2-rc.1.bak）
  if (!ver) throw new Error('无法确定当前 launcher 版本');
  const logsDir = path.join(path.dirname(statusPath), 'version-logs');
  const snapFile = path.join(logsDir, 'dsh-version' + ver + '.bak');
  fs.mkdirSync(logsDir, { recursive: true }); // 目录不存在则创建；不可写等异常落入下方降级路径
  let since = null, sinceDesc = '全量';
  const baks = listVersionBaks(logsDir);
  if (baks.length) {
    const m = (fs.readFileSync(path.join(logsDir, baks[0].f), 'utf8').split(/\r?\n/)[0] || '')
      .match(/^# dsh-version-backup version=\S+ until=(\S+)\s*$/);
    if (m) { since = m[1]; sinceDesc = since; }
  }
  const jArgs = ['--user', '-u', 'dsh-web', '--output=short-iso'];
  if (since) jArgs.push('--since=' + since);
  const until = bjTs(); // 导出执行时刻（北京时间 ISO8601），与 baseline 头部注释格式自洽、journalctl --since 可解析
  const r = sh('journalctl', jArgs, { timeout: 120000, maxBuffer: 64 * 1024 * 1024 }); // 全量导出可超 spawnSync 默认 1MB 缓冲
  if (r.status !== 0) throw new Error('journalctl 退出 ' + r.status + ': ' + String(r.stderr || '').slice(0, 200));
  const tmp = snapFile + '.tmp'; // .tmp 不匹配 dsh-version*.bak，滚动清理不会误删半成品
  fs.writeFileSync(tmp, '# dsh-version-backup version=' + ver + ' until=' + until + '\n' + String(r.stdout || ''));
  fs.renameSync(tmp, snapFile);
  // 滚动清理：按 mtime 保留最新 7 份（含刚写入的这份），其余 unlink（忽略错误）
  for (const old of listVersionBaks(logsDir).slice(7)) { try { fs.unlinkSync(path.join(logsDir, old.f)); } catch {} }
  const lines = String(r.stdout || '').split(/\r?\n/).filter(Boolean).length;
  finishStep(st, true, 'dsh-version' + ver + '.bak（' + lines + ' 行，自 ' + sinceDesc + '）');
} catch (e) {
  finishStep(st, false, '日志快照失败（不阻塞升级）: ' + e.message, 'warn');
}

// ── 步骤 2：dump 基准 + baseline 快照（旧版本 + 角色模型钉，供升级后自检 S3/S4 对比）──
st = step('baseline', 'dump-config 留基准 + baseline 快照');
try {
  const oldVersion = launcherVersion();
  const dumpPath = path.join(path.dirname(statusPath), 'before-' + Date.now() + '.yaml');
  const d = sh(nodeBin, [entryJs, '--profile', profile, '--dump-config'], { timeout: 120000 });
  if (d.status !== 0) throw new Error('dump-config 退出 ' + d.status + ': ' + String(d.stderr || '').slice(0, 300));
  fs.writeFileSync(dumpPath, d.stdout);
  const s = readStatus();
  // 用户层顶层 insert id 快照：升级后自检 S3 据此保护“所有用户层行”（新插件零调整自动纳入）
  const userLayerIds = (fs.readFileSync(userPatch, 'utf8').match(/^ {4}- id: (\S+)/gm) || [])
    .map(l => l.trim().replace(/^- id: /, ''));
  s.baseline = { oldVersion, roles: parseRoleModels(userPatch), beforeDump: dumpPath, userLayerIds };
  writeStatus(s);
  finishStep(st, true, '基准: ' + dumpPath + '（旧版本 ' + (oldVersion || '?') + '）');
} catch (e) { fail(st, '基准失败: ' + e.message); }

// ── 步骤 3：校验目标版本（政策：仅允许 latest 通道）──
st = step('verify', '校验目标版本（仅允许 latest 通道）');
try {
  const tags = await distTags();
  if (tags.latest !== target) {
    throw new Error(`目标 ${target} 不等于 latest(${tags.latest})——政策仅允许升级到 latest；若确需升级 ${target}，请由会话流程人工确认`);
  }
  finishStep(st, true, 'target == latest == ' + target);
} catch (e) { fail(st, '校验不通过: ' + e.message); }

// ── 步骤 4/5（install/verify-version）已挪进 bounce 形态，见 --bounce 分支 ──
// 前台不亲手安装：npm i -g 替换 launcher 树时宿主进程持旧 inode 本可不受影响，但 2026-11-02
// 实战证明运行中替换仍有页面空白风险（前端按需加载文件时命中被替换的半新半旧树）。

// ── 步骤 6：发起 bounce scope（前台的最后一步，发起后立即退出）──
// cgroup 语义（runbook 坑 11）：本前台进程由 dsh-web.service spawn，仍在宿主 cgroup 内，
// 亲手 stop/restart 会连宿主一起杀；--scope 把【被包命令】移入独立 scope——因此把
// 「install → verify-version → 台账 → restart」整链搬进 scope，由 --bounce 形态在那里完成。
// 发起用 detached spawn 而非 1.1.1 的 spawnSync：--scope 语义是 systemd-run 等被包命令跑完
// 才返回，同步等会把前台挂住整个安装期（可达 900s）；detached+unref 让前台发起后立即退出。
// 接棒台账（phase=restarting + selfcheckPending）不在这里写——install 还没跑，写了会让宿主
// 提前触发自检；台账由 bounce 形态在自己 restart 前写（见 --bounce 分支）。
st = step('restart', '重启 dsh-web（经独立 scope bounce：先停机安装新版本再重启，页面将短暂断开，稍后自动恢复）');
try {
  const bounceArgs = ['--user', '--scope', '--unit=dsh-upgrader-bounce',
    nodeBin, SELF, '--bounce', target, statusPath, nodeBin, entryJs, profile];
  const child = spawn('systemd-run', bounceArgs, { detached: true, stdio: 'ignore' });
  // 短窗口观察发起结果：ENOENT（error 事件）或秒退非零（scope 重名/bus 失败）当场上报；
  // 正常路径 bounce 在 scope 内长跑（install 可达 900s），窗口超时即视为发起成功。
  // 非零退出且 status 已是 failed → bounce 已自行上报失败（其 error 更精确），前台不覆盖。
  const outcome = await new Promise(resolve => {
    let done = false;
    const settle = v => { if (!done) { done = true; resolve(v); } };
    child.on('error', e => settle({ err: e }));
    child.on('exit', code => settle({ code }));
    setTimeout(() => settle({}), 500);
  });
  child.unref();
  if (outcome.err) throw outcome.err;
  if (outcome.code) {
    const s = readStatus();
    if (s && s.phase === 'failed') {
      log('info', 'upgrade', 'bounce self-reported failure; keep its error', { exitCode: outcome.code });
    } else {
      throw new Error('systemd-run 退出 ' + outcome.code + '（bounce 未启动，phase=' + (s ? s.phase : 'null') + '）');
    }
  } else {
    log('info', 'upgrade', 'bounce delegated to dsh-upgrader-bounce.scope; frontend exiting', { target });
  }
} catch (e) { fail(st, '发起 bounce 失败: ' + e.message); }
console.log('bounced');
