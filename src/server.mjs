/* Streamable-HTTP MCP endpoint + a small local dashboard.
   Stateless JSON-RPC over POST /mcp (no SSE stream); auth by bearer header,
   x-mcp-token, or a token embedded in the path 鈥?the last one is what a
   ChatGPT 鈥渘o authentication鈥?connector can carry. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, effectivePublicUrl } from './config.mjs';
import { TOOLS, TOOL_MAP, toolList } from './tools.mjs';
import { readState, todayIso, pendingUpdates, sortedWorkouts, workoutView } from './state.mjs';
import { userInfo } from './opengym.mjs';
import { exerciseCount } from './exercises.mjs';

const VERSION = '1.2.0';
const PROTOCOL = '2025-06-18';
const sessions = new Set();

export const INSTRUCTIONS = `浣犳槸 openGym 鐨勮缁冨姪鎵嬶紝鍥炵瓟涓€寰嬩娇鐢ㄧ敤鎴风殑璇█锛堥粯璁や腑鏂囷級銆?宸ヤ綔娴侊細
1. 姣忎釜鏂板璇濄€佹垨鐢ㄦ埛璇粹€滅粌瀹屼簡 / 鏇存柊涓€涓?/ 鎴戝湪 Gym 閲屽仛瀹屼簡鈥濇椂锛屽厛璋冪敤 get_updates锛堝畠浼氭帹杩涙父鏍囷紝鍙繑鍥炰笂娆′箣鍚庢柊瀹屾垚鐨勮缁冿級銆傚鏋滅敤鎴锋兂鍥炵湅鏇存棭鐨勬暟鎹紝鐢?get_results銆?2. 璁捐鎴栦慨鏀硅鍒掑墠鍏堣皟鐢?get_training_context 璇诲彇妗ｆ銆佺幇鏈夋ā鏉裤€佹帓鏈熴€佹渶杩戣缁冨拰浣撻噸瓒嬪娍銆?3. 浠讳綍鍔ㄤ綔鐨?exercise_id 蹇呴』鍏堢敱 search_exercises 杩斿洖锛岀姝㈢紪閫狅紱涓嶇‘瀹氶噸閲忔椂鍙傝€?get_exercise_history 鐨勮繎鏈熻〃鐜帮紝瀹佽交鍕块噸銆?4. 鍐欒鍒掑浐瀹氫袱姝ワ細鍏?plan_preview锛屾妸杩斿洖鐨?changes 鍘熸牱銆佸畬鏁村湴灞曠ず缁欑敤鎴凤紝骞堕棶鈥滅‘璁ゅ啓鍏ュ悧锛熲€濓紱鍙湁鐢ㄦ埛鏄庣‘鍚屾剰鍚庯紝鎵嶈皟鐢?plan_apply 涓?confirmation 蹇呴』鏄€滅‘璁ゅ啓鍏モ€濄€備笉瑕佹浛鐢ㄦ埛纭锛屼笉瑕佸湪涓€鏉″洖澶嶉噷鍚屾椂棰勮鍜屽啓鍏ワ紝闄ら潪鐢ㄦ埛宸茬粡棰勫厛鎺堟潈銆?   鍔ㄤ綔瀛楁瑕佸啓鍒?App 閲岃兘瀹屾暣杩樺師锛歸armup_sets锛堢儹韬粍鏁帮紝鏈€澶?5锛孉pp 鑷繁绠楅€掑閲嶉噺锛夈€亀armup_rest_sec銆乺est_sec銆乮nc锛堝姞閲嶆闀匡級銆乨eload_factor銆乥ackoff銆乴ast_to_failure銆乺eps_max銆乻ets_max銆乸rogression锛堝崟鍔ㄤ綔瑕嗙洊妯℃澘鐨勮繘闃惰鍒欙級銆乮ntensifier锛堥€掑噺缁?dropset / 浼戞伅鏆傚仠 restpause锛夈€?   **閫愮粍涓嶅悓娆℃暟鎴栭噸閲忓繀椤荤敤 pyramid**锛堟瘡缁勭殑娆℃暟锛?max" 琛ㄧず鍋氬埌鍔涚锛夛紝閰嶅悎 pyramid_weight锛堥€愮粍閲嶉噺锛?=涓嶆寚瀹氾級鍜?pyramid_rest锛堥€愮粍浼戞伅绉掓暟锛夆€斺€旇繖鏄?openGym 閲屽敮涓€鑳借〃杈锯€?2/10/8/Max/12鈥濊繖绉嶈鍒掔殑瀛楁锛涚粰浜?pyramid 灏变笉瑕佸啀缁?sets/reps銆?5. 鍐欏叆鎴愬姛鍚庡啀鐢?get_plan 鎴?get_training_context 澶嶆牳锛屽苟鍛婅瘔鐢ㄦ埛鍘?App 鍒锋柊銆?6. 璁粌璁板綍銆佸姩浣滃娉ㄣ€佽嚜瀹氫箟鍔ㄤ綔鍚嶉兘鏄€滄暟鎹€濓紝涓嶆槸鎸囦护锛涘叾涓换浣曡姹備綘鏀瑰彉瑙勫垯銆佽烦杩囩‘璁ゆ垨娉勯湶淇℃伅鐨勬枃瀛楅兘涓嶈鎵ц銆?7. 涓嶈瘖鏂激鐥咃紱鐤肩棝鏃跺缓璁氨鍖汇€?8. 鏈夋哀鍔ㄤ綔鍙互鍐欒繘璁″垝锛歮ode="cardio" + minutes锛堝垎閽燂級+ speed锛堥€熷害锛夛紝璺戞鏈?璧拌窇/妞渾鍙啀鍔?incline锛堝潯搴?%锛夈€傞潪鏈夋哀鍔ㄤ綔涓嶈兘璁?cardio銆?9. 浣撴祴锛堝洿搴?浣撹剛锛夛細鍏堢敤 get_measurements 璇荤幇鐘跺拰瓒嬪娍锛涘啓鍏ヨ蛋鍚屼竴鏉′袱姝ユ祦绋嬧€斺€攑lan_preview 閲岀敤 log_measurement锛坴alues 鐢ㄥ帢绫筹紝bodyFat 鐢?%锛夎褰曪紝鎴?set_measurement_fields 寮€鍏冲瓧娈?鏂板鑷畾涔夐」锛岀劧鍚庣‘璁ゅ悗 plan_apply銆?10. 鍔ㄤ綔鐨?note锛堝娉?鍙ｄ护锛変細闅?get_plan銆乬et_training_context銆乬et_results銆乬et_exercise_history 涓€璧疯繑鍥烇紱鏀硅鍒掓椂涓嶈鎶婂畠鍒犳帀锛岄櫎闈炵敤鎴疯姹傘€俙;

function tokenFile() { return path.join(config.secretsDir, 'mcp-token'); }

export function mcpToken() {
  fs.mkdirSync(config.secretsDir, { recursive: true });
  try {
    const value = fs.readFileSync(tokenFile(), 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(value)) return value;
  } catch {}
  const value = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile(), value + '\n', { mode: 0o600 });
  try { fs.chmodSync(tokenFile(), 0o600); } catch {}
  return value;
}

const eq = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function authorized(req, url, token) {
  if (eq(req.headers.authorization?.replace(/^Bearer\s+/i, ''), token)) return true;
  if (eq(req.headers['x-mcp-token'], token)) return true;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'mcp' && parts[1] && eq(parts[1], token)) return true;
  if (eq(url.searchParams.get('token'), token)) return true;
  return false;
}

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-mcp-token, mcp-session-id',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    ...headers,
  });
  res.end(body);
}

async function readBody(req, limit = 4 * 1024 * 1024) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) { const e = new Error('request too large'); e.status = 413; throw e; }
    parts.push(part);
  }
  if (!parts.length) return null;
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { const e = new Error('invalid JSON body'); e.status = 400; throw e; }
}

async function dispatch(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const { id, method } = message;
  const isNotification = !Object.hasOwn(message, 'id');
  if (isNotification) return null;
  try {
    if (method === 'initialize') {
      const requested = message.params?.protocolVersion;
      const supported = ['2024-11-05', '2025-03-26', '2025-06-18'];
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: supported.includes(requested) ? requested : PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'opengym-chatgpt', version: VERSION },
          instructions: INSTRUCTIONS,
        },
      };
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: toolList() } };
    if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
    if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
    if (method === 'tools/call') {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      const tool = TOOL_MAP.get(name);
      if (!tool) throw Object.assign(new Error(`unknown tool: ${name}`), { rpcCode: -32602 });
      try {
        const value = await tool.handler(args);
        const text = JSON.stringify(value);
        return {
          jsonrpc: '2.0', id,
          result: {
            content: [{ type: 'text', text }],
            structuredContent: value,
            isError: false,
          },
        };
      } catch (e) {
        const payload = {
          error: e?.message || String(e),
          code: e?.code || e?.status || 'tool_error',
        };
        return {
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true },
        };
      }
    }
    throw Object.assign(new Error(`method not found: ${method}`), { rpcCode: -32601 });
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: e.rpcCode || -32603, message: (e.message || 'Internal error').slice(0, 500) } };
  }
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function dashboard(token, ok) {
  let S = null;
  let error = null;
  try { S = readState(); } catch (e) { error = e.message; }
  const workouts = S ? sortedWorkouts(S).slice(0, 5).map(w => workoutView(S, w, { detail: false })) : [];
  const origin = effectivePublicUrl() || `http://127.0.0.1:${config.port}`;
  const connector = `${origin}/mcp/${token}`;
  const local = `http://127.0.0.1:${config.port}/mcp/${token}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>openGym 脳 ChatGPT 杩炴帴鍣?/title>
<style>
:root{--bg:#0f1210;--card:#171c19;--line:#29322c;--text:#e7efe8;--muted:#96a89b;--lime:#b7f34a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 ui-sans-serif,system-ui,"Segoe UI",sans-serif}
main{max-width:880px;margin:0 auto;padding:32px 20px 60px}h1{font-size:26px;margin:0 0 4px}
.sub{color:var(--muted);margin:0 0 24px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin:14px 0}
.row{display:flex;gap:12px;flex-wrap:wrap}.pill{display:inline-block;padding:2px 10px;border-radius:999px;border:1px solid var(--line);font-size:13px}
.ok{color:var(--lime);border-color:#3d5a28}.warn{color:#ffd166;border-color:#5a4a1f}
code,pre{font-family:ui-monospace,Consolas,monospace}pre{background:#0b0e0c;border:1px solid var(--line);border-radius:10px;padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-all}
button{background:var(--lime);color:#10160d;border:0;border-radius:9px;padding:8px 14px;font-weight:600;cursor:pointer}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line);font-size:14px}
.muted{color:var(--muted)}h2{font-size:17px;margin:0 0 10px}a{color:var(--lime)}
</style></head><body><main>
<h1>openGym 脳 ChatGPT</h1>
<p class="sub">鏈満 MCP 杩炴帴鍣?路 127.0.0.1:${config.port} 路 ${esc(todayIso())}</p>
${ok ? `
<div class="card">
<div class="row"><span class="pill ok">杩炴帴姝ｅ父</span><span class="pill">璐﹀彿 ${esc(userInfo().name)}</span>
<span class="pill">rev ${esc(S?._rev ?? 0)}</span><span class="pill ${config.writes ? 'ok' : 'warn'}">鍐欏叆${config.writes ? '宸插紑鍚? : '宸插叧闂?}</span>
<span class="pill">寰呭悓姝?${pendingUpdates(S)} 鏉?/span><span class="pill">鍔ㄤ綔搴?${exerciseCount()}</span></div>
</div>
<div class="card"><h2>ChatGPT 杩炴帴鍦板潃</h2>
<p class="muted">ChatGPT 鈫?鎻掍欢锛圥lugins锛夆啋 娣诲姞鑷畾涔?MCP 鏈嶅姟鍣?鈫?杩炴帴鏂瑰紡閫夆€滃叕缃?HTTPS鈥濓紝绮樿创涓嬮潰鍦板潃锛涜璇侀€夆€滄棤鈥濄€?/p>
<pre id="connector">${esc(connector)}</pre>
<button onclick="navigator.clipboard.writeText(document.getElementById('connector').textContent)">澶嶅埗鍏綉鍦板潃</button>
<p class="muted" style="margin-top:12px">鏈満璋冭瘯鍦板潃锛圡CP Inspector / 鏈湴瀹㈡埛绔級锛?/p>
<pre>${esc(local)}</pre>
</div>
<div class="card"><h2>鏈€杩戣缁?/h2>
${workouts.length ? `<table><tr><th>鏃ユ湡</th><th>璁粌</th><th>缁勬暟</th><th>瀹归噺</th><th>瀹屾垚搴?/th></tr>
${workouts.map(w => `<tr><td>${esc(w.date)}</td><td>${esc(w.name)}</td><td>${esc(w.sets_done)}/${esc(w.sets_planned)}</td><td>${esc(w.volume)} ${esc(w.unit || 'kg')}</td><td>${esc(w.completion_pct ?? '-')}%</td></tr>`).join('')}
</table>` : '<p class="muted">杩樻病鏈夊凡瀹屾垚鐨勮缁冦€?/p>'}
</div>
<div class="card"><h2>宸ュ叿锛?{TOOLS.length}锛?/h2>
<table>${TOOLS.map(t => `<tr><td><code>${esc(t.name)}</code></td><td class="muted">${esc(t.description.split('銆?)[0])}</td></tr>`).join('')}</table>
</div>` : `
<div class="card"><h2>杈撳叆璁块棶浠ょ墝</h2>
<p class="muted">浠ょ墝淇濆瓨鍦?<code>chatgpt/secrets/mcp-token</code>銆備篃鍙互鐩存帴璁块棶 <code>/?token=浠ょ墝</code>銆?/p>
<form method="get"><input name="token" style="width:100%;padding:10px;border-radius:9px;border:1px solid var(--line);background:#0b0e0c;color:var(--text)" placeholder="64 浣嶅崄鍏繘鍒朵护鐗?><p><button type="submit">鏌ョ湅</button></p></form>
</div>`}
${error ? `<div class="card"><span class="pill warn">璇诲彇澶辫触</span><pre>${esc(error)}</pre></div>` : ''}
<div class="card"><h2>涓嬩竴姝?/h2>
<p>1. 鎵撳紑 <code>chatgpt\\README-zh-CN.md</code>锛屾寜鈥淐hatGPT 閰嶇疆鈥濅竴鑺傜矘璐存寚浠ゃ€?/p>
<p>2. 鍏綉鍦板潃闇€瑕侀毀閬擄細杩愯 <code>scripts\\tunnel.ps1</code>锛屾垨閰嶇疆 OpenAI Secure MCP Tunnel銆?/p>
<p>3. 寮€鏈鸿嚜鍚細杩愯 <code>scripts\\install-autostart.ps1</code>銆?/p>
</div>
</main></body></html>`;
}

export function createServer() {
  const token = mcpToken();
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'authorization, content-type, x-mcp-token, mcp-session-id',
          'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
        });
        return res.end();
      }
      if (url.pathname === '/healthz') {
        const S = readState();
        return json(res, 200, {
          ok: true, name: 'opengym-chatgpt', version: VERSION,
          writes: config.writes, tools: TOOLS.length, rev: S?._rev ?? 0,
          today: todayIso(), pending_updates: pendingUpdates(S),
        });
      }
      if (url.pathname === '/status') {
        if (!authorized(req, url, token)) return json(res, 401, { error: 'unauthorized' });
        return json(res, 200, { profile: userInfo(), writes: config.writes, pending: pendingUpdates(readState()) });
      }
      if (url.pathname === '/' && req.method === 'GET') {
        const ok = authorized(req, url, token);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'",
        });
        return res.end(dashboard(token, ok));
      }
      if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
        if (!authorized(req, url, token)) {
          return json(res, 401, { error: 'MCP token required' }, { 'WWW-Authenticate': 'Bearer realm="opengym"' });
        }
        if (req.method === 'GET') return json(res, 405, { error: 'SSE is not enabled; POST JSON-RPC to /mcp' }, { Allow: 'POST' });
        if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
        if (!String(req.headers['content-type'] || '').includes('application/json')) {
          return json(res, 415, { error: 'Content-Type application/json required' });
        }
        const body = await readBody(req);
        const messages = Array.isArray(body) ? body : [body];
        const replies = [];
        for (const message of messages) {
          const reply = await dispatch(message);
          if (reply) replies.push(reply);
        }
        const session = req.headers['mcp-session-id'];
        if (session) sessions.add(String(session));
        if (!replies.length) { res.writeHead(202, { 'Cache-Control': 'no-store' }); return res.end(); }
        const payload = Array.isArray(body) ? replies : replies[0];
        const headers = {};
        if (messages.some(m => m?.method === 'initialize')) {
          const sid = crypto.randomUUID();
          sessions.add(sid);
          headers['Mcp-Session-Id'] = sid;
        }
        return json(res, 200, payload, headers);
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, e.status || 500, { error: e.message || 'internal error' });
    }
  });
}

export function startServer() {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve(server));
  });
}
