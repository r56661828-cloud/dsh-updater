export function apiBase() {
  if (typeof document === 'undefined') return '';
  const b = document.baseURI || '';
  try { const u = new URL(b); if (!u.pathname.endsWith('/')) u.pathname += '/'; return u.href; } catch { return ''; }
}
export function apiUrl(p) {
  if (typeof p !== 'string' || p.charAt(0) !== '/' || p.charAt(1) === '/') return p;
  const b = apiBase(); if (!b) return p;
  try { return new URL(p.slice(1), b).href; } catch { return p; }
}
export function api(path, opts) {
  return fetch(apiUrl('/api/dsh-updater' + path), Object.assign({}, opts || {}, {
    headers: Object.assign({ 'content-type': 'application/json' }, (opts && opts.headers) || {}),
  })).then(r => r.json());
}
export function reportError(where, e) {
  // 浏览器侧异常上报进宿主日志（client-error），便于事后定位
  try { api('/client-error', { method: 'POST', body: JSON.stringify({ where, message: (e && e.message) || String(e), stack: (e && e.stack) || '' }) }); } catch {}
}
