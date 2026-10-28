#!/usr/bin/env node
/* Entry point: start the connector, or run a one-off check.
   node src/main.mjs            start
   node src/main.mjs doctor     check data, auth, catalogue
   node src/main.mjs token      print the connector URLs
   node src/main.mjs test       in-process MCP smoke test (read-only) */
import { config, ensureDirs, effectivePublicUrl } from './config.mjs';
import { ensureToken, verifyAuth, userInfo, dataPaths } from './opengym.mjs';
import { startServer, mcpToken } from './server.mjs';
import { closeDb } from './db.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const command = process.argv[2] || 'start';

async function doctor() {
  ensureDirs();
  console.log('== openGym ChatGPT connector ==');
  console.log('data dir   :', dataPaths().dataDir);
  console.log('profile    :', userInfo().name, `(${userInfo().id})`);
  console.log('api        :', config.baseUrl);
  console.log('writes     :', config.writes ? 'on' : 'off');
  console.log('timezone   :', config.timezone);
  ensureToken();
  await verifyAuth();
  console.log('auth       : ok (bearer token verified via /api/me)');
  const { search, exerciseCount } = await import('./exercises.mjs');
  console.log('exercises  :', exerciseCount());
  const found = search(null, '卧推', 3);
  console.log('zh search  :', found.results.map(x => `${x.exercise_id} ${x.name}`).join(' | '));
  const { readState, planView } = await import('./state.mjs');
  const S = readState();
  console.log('state rev  :', S?._rev ?? 0);
  const plan = planView(S);
  console.log('routines   :', plan.routines.length, plan.routines.map(r => r.name).join(' / '));
  return true;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  } catch {
    return '';
  }
}

function tokenInfo() {
  const token = mcpToken();
  const local = `http://127.0.0.1:${config.port}/mcp/${token}`;
  const pub = effectivePublicUrl() ? `${effectivePublicUrl()}/mcp/${token}` : '(未配置 PUBLIC_URL；先运行 scripts/tunnel.ps1)';
  console.log('== ChatGPT 连接器 ==');
  console.log('local  :', local);
  console.log('public :', pub);
  console.log('token  :', token);

  const chatgptDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const appUrl = readText(path.join(chatgptDir, 'store', 'app-url.txt'));
  const appToken = readText(path.join(chatgptDir, 'secrets', 'app-token'));
  console.log('');
  console.log('== openGym App（手机 5G 用） ==');
  if (appUrl) {
    console.log('app    :', `${appUrl}/?t=${appToken}`);
  } else {
    console.log('app    :', '(公网地址未开启；运行 Tunnel-Tailscale.cmd)');
  }
  console.log('token  :', appToken || '(尚未生成；启动 app-proxy 后自动生成)');
  console.log('lan    :', 'https://192.168.50.47:8443  (在家用，不需要令牌)');
}

async function smoke() {
  const { readState, planView, recent } = await import('./state.mjs');
  const { search } = await import('./exercises.mjs');
  const { TOOLS } = await import('./tools.mjs');
  const S = readState();
  if (!S) throw new Error('no state');
  const plan = planView(S);
  console.error('tools', TOOLS.length, 'routines', plan.routines.length);
  console.error('search 卧推 →', search(S, '卧推', 2).results.map(x => x.name).join(' | '));
  console.error('recent →', recent(S, 2, { detail: false }).map(w => `${w.date} ${w.name}`).join(' | '));
  console.error('ok');
}

if (command === 'doctor') {
  doctor().then(() => process.exit(0)).catch(e => { console.error('doctor failed:', e.message); process.exit(1); });
} else if (command === 'token') {
  tokenInfo();
} else if (command === 'test') {
  smoke().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
} else {
  ensureDirs();
  ensureToken();
  verifyAuth().then(async () => {
    await startServer();
    const token = mcpToken();
    console.log('');
    console.log('openGym × ChatGPT connector is running.');
    console.log(`  local MCP : http://127.0.0.1:${config.port}/mcp/  (token in chatgpt/secrets/mcp-token)`);
    console.log(`  dashboard : http://127.0.0.1:${config.port}/  (run Show-Connection.cmd for the tokenized URL)`);
    console.log(`  profile   : ${userInfo().name} (${userInfo().id})`);
    console.log(`  writes    : ${config.writes ? 'on (preview + 确认写入 required)' : 'off'}`);
    console.log('  stop      : Ctrl+C');
    console.log('');
  }).catch(e => {
    console.error('启动失败：' + e.message);
    process.exitCode = 1;
  });
}

function shutdown() {
  closeDb();
  console.log('\nbye');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
