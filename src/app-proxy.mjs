// app-proxy.mjs
//
// Serves the openGym PWA on a plain-HTTP localhost port so that `tailscale funnel`
// can publish it on a second public HTTPS port (:8443). Caddy cannot be used for this
// because its site is TLS with an internal CA and binds only the LAN IP.
//
//   GET  /                -> frontend/dist (SPA)
//   *    /api/*           -> reverse proxy to the openGym API (127.0.0.1:30347)
//   GET  /exercise-media/*-> catalogue/media
//
// Access control: a 64-char token (secrets/app-token) must be presented once as
// ?t=<token> (or ?token=). It then becomes an HttpOnly cookie so the PWA, its
// service worker and the manifest all keep working on the iPhone Home Screen.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatgptDir = path.resolve(__dirname, '..');
const root = path.resolve(chatgptDir, '..');
const distDir = path.join(root, 'frontend', 'dist');
const mediaDir = path.join(root, 'catalogue', 'media');
const secretsDir = path.join(chatgptDir, 'secrets');
const tokenFile = path.join(secretsDir, 'app-token');

const PORT = Number(process.env.APP_PORT || 8081);
const API_HOST = process.env.OPEN_GYM_HOST || '127.0.0.1';
const API_PORT = Number(process.env.OPEN_GYM_PORT || 30347);
const COOKIE = 'gym_app';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function ensureToken() {
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch { }
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.writeFileSync(tokenFile, token + '\n', { encoding: 'utf8', mode: 0o600 });
  return token;
}
const TOKEN = ensureToken();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};
const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

function cookieFrom(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}
function allowed(req, url) {
  const cookie = cookieFrom(req);
  if (cookie && safeEqual(cookie, TOKEN)) return 'cookie';
  const q = url.searchParams.get('t') || url.searchParams.get('token') || '';
  if (q && safeEqual(q, TOKEN)) return 'query';
  return '';
}

function unlockPage(message = '') {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>openGym · 需要访问令牌</title>
<style>
:root{--bg:#0c0e12;--card:#141a22;--line:#243040;--text:#e8eef7;--muted:#8fa2b8;--lime:#b7f34a}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);
font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;padding:24px}
.card{width:min(460px,100%);background:var(--card);border:1px solid var(--line);border-radius:18px;padding:26px}
h1{font-size:19px;margin:0 0 6px}p{color:var(--muted);margin:0 0 18px}
input{width:100%;padding:12px 14px;border-radius:11px;border:1px solid var(--line);background:#0a0d12;color:var(--text);font-size:15px}
button{margin-top:12px;width:100%;padding:12px;border:0;border-radius:11px;background:var(--lime);color:#0a1200;font-weight:650;font-size:15px}
.err{color:#ff8a8a;margin:0 0 12px;font-size:14px}code{background:#0a0d12;padding:1px 5px;border-radius:5px;font-size:13px}
</style></head><body><div class="card">
<h1>openGym · 需要访问令牌</h1>
<p>这个地址对公网开放，打开它需要令牌。令牌保存在电脑上的
<code>chatgpt/secrets/app-token</code>，或在电脑上运行 <code>Show-Connection.cmd</code> 查看完整链接。</p>
${message ? `<p class="err">${message}</p>` : ''}
<form method="GET" action="/">
  <input name="t" placeholder="粘贴 64 位令牌" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus>
  <button type="submit">进入 openGym</button>
</form>
</div></body></html>`;
}

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

function serveFile(req, res, absPath, { immutable = false, spaFallback = false } = {}) {
  return fsp.stat(absPath).then(
    (st) => {
      if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
      const ext = path.extname(absPath).toLowerCase();
      let cache = 'no-cache';
      if (immutable && /[.-][a-z0-9]{8,}\./i.test(path.basename(absPath))) {
        cache = 'public, max-age=31536000, immutable';
      }
      const headers = {
        'Content-Type': mimeOf(absPath),
        'Content-Length': st.size,
        'Cache-Control': cache,
        'X-Content-Type-Options': 'nosniff',
      };
      if (ext === '.html') headers['Cache-Control'] = 'no-cache, must-revalidate';
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(absPath).pipe(res);
    },
    () => {
      if (spaFallback) return serveFile(req, res, path.join(distDir, 'index.html'));
      send(res, 404, 'text/plain; charset=utf-8', 'not found');
    }
  );
}

function proxyApi(req, res, url) {
  const headers = { ...req.headers, host: `${API_HOST}:${API_PORT}` };
  delete headers['accept-encoding'];
  const upstream = http.request(
    { host: API_HOST, port: API_PORT, method: req.method, path: url.pathname + url.search, headers },
    (up) => {
      const out = { ...up.headers };
      delete out['transfer-encoding'];
      res.writeHead(up.statusCode || 502, out);
      up.pipe(res);
    }
  );
  upstream.on('error', (err) => {
    send(res, 502, 'application/json; charset=utf-8', JSON.stringify({ error: 'openGym API unreachable', detail: err.code || err.message }));
  });
  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, 'text/plain; charset=utf-8', 'bad request');
  }

  if (url.pathname === '/__healthz') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, name: 'opengym-app-proxy', port: PORT }));
  }

  let decoded;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'text/plain; charset=utf-8', 'bad request');
  }

  const how = allowed(req, url);
  if (!how) {
    if (url.pathname === '/' && (req.headers.accept || '').includes('text/html')) {
      return send(res, 401, 'text/html; charset=utf-8', unlockPage());
    }
    return send(res, 401, 'application/json; charset=utf-8', JSON.stringify({ error: 'app token required' }));
  }

  if (how === 'query') {
    const clean = new URL(url);
    clean.searchParams.delete('t');
    clean.searchParams.delete('token');
    const target = clean.pathname + (clean.search || '');
    return send(res, 302, 'text/plain; charset=utf-8', 'redirecting', {
      Location: target,
      'Set-Cookie': `${COOKIE}=${TOKEN}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
    });
  }

  if (decoded.startsWith('/api/') || decoded === '/api') {
    return proxyApi(req, res, url);
  }
  if (decoded.startsWith('/exercise-media/')) {
    const rel = decoded.slice('/exercise-media/'.length);
    const abs = path.join(mediaDir, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!abs.startsWith(mediaDir)) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    return serveFile(req, res, abs, { immutable: true });
  }

  const rel = decoded === '/' ? 'index.html' : path.normalize(decoded).replace(/^([/\\])+/, '');
  const abs = path.join(distDir, rel);
  if (!abs.startsWith(distDir)) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
  const hasExt = path.extname(abs) !== '';
  return serveFile(req, res, abs, { immutable: true, spaFallback: !hasExt });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`openGym app proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`token file: ${tokenFile}`);
});
server.on('error', (err) => {
  console.error('app proxy failed:', err.code || err.message);
  process.exit(1);
});
