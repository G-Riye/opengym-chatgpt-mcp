#!/usr/bin/env node
/* End-to-end smoke test against a running connector. Read-only plus one
   plan_preview (which never writes). Exits non-zero on any failed assertion. */
import fs from 'node:fs';
import path from 'node:path';

const SELF = path.resolve(import.meta.dirname, '..');
const port = process.env.MCP_PORT || '8787';
const base = `http://127.0.0.1:${port}`;
const token = fs.readFileSync(path.join(SELF, 'secrets', 'mcp-token'), 'utf8').trim();

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
};

async function rpc(method, params, { auth = true, viaPath = false } = {}) {
  const url = viaPath ? `${base}/mcp/${token}` : `${base}/mcp`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, text };
}

async function call(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  const out = r.data?.result;
  if (out?.isError) {
    let parsed = null;
    try { parsed = JSON.parse(out.content[0].text); } catch {}
    throw new Error(`${name} tool error: ${parsed?.error || out.content?.[0]?.text}`);
  }
  return out?.structuredContent;
}

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '1' },
});
check('initialize', init.status === 200 && init.data?.result?.protocolVersion === '2025-06-18',
  init.data?.result?.serverInfo?.name);

const list = await rpc('tools/list', {});
const tools = list.data?.result?.tools || [];
check('tools/list', tools.length === 11, `${tools.length} tools`);
check('no write tool without schema', tools.every(t => t.inputSchema?.type === 'object'));

const status = await call('get_status');
check('get_status', status?.connected === true, `rev=${status?.rev} writes=${status?.writes_enabled}`);

const context = await call('get_training_context');
check('get_training_context', Array.isArray(context?.plan?.routines), `${JSON.stringify(context).length} bytes`);
check('context has schedule', Array.isArray(context?.upcoming) && context.upcoming.length === 7);
check('context has recent', Array.isArray(context?.recent_workouts));

const search = await call('search_exercises', { query: '卧推', limit: 5 });
check('search_exercises 卧推', search?.count > 0, (search?.results || []).map(x => x.name).slice(0, 3).join(' | '));
check('search returns ids', (search?.results || []).every(x => /^[A-Za-z0-9]+$/.test(x.exercise_id)));

const updates = await call('get_updates', { ack: false });
check('get_updates', typeof updates?.count === 'number', `count=${updates?.count}`);

const before = await call('get_plan');
const preview = await call('plan_preview', {
  actions: [{
    type: 'create_routine',
    name: 'SMOKE TEST - 请勿写入',
    exercises: [{ exercise_id: search.results[0].exercise_id, sets: 3, reps: 8, weight: 20 }],
  }],
});
check('plan_preview', !!preview?.proposal_id && Array.isArray(preview.changes), preview?.changes?.[0] || '');
const after = await call('get_plan');
check('preview does not write', before.revision === after.revision, `rev ${before.revision} -> ${after.revision}`);

const unauth = await rpc('tools/list', {}, { auth: false });
check('rejects missing token', unauth.status === 401, `HTTP ${unauth.status}`);

const pathAuth = await rpc('tools/list', {}, { auth: false, viaPath: true });
check('accepts token in path', pathAuth.status === 200 && (pathAuth.data?.result?.tools || []).length === 11);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
