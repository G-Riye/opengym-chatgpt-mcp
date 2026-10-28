#!/usr/bin/env node
/* Write-path test. Run it against a THROWAWAY openGym instance (a copy of
   data/), never the live one. Creates a routine, edits it, then prints the new
   revision. */
import fs from 'node:fs';
import path from 'node:path';

const SELF = path.resolve(import.meta.dirname, '..');
const port = process.env.MCP_PORT || '8788';
const token = fs.readFileSync(path.join(SELF, 'secrets', 'mcp-token'), 'utf8').trim();
const base = `http://127.0.0.1:${port}/mcp`;

async function rpc(method, params) {
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data = await res.json();
  return data;
}
async function call(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.result?.isError) {
    let p = null; try { p = JSON.parse(r.result.content[0].text); } catch {}
    throw new Error(`${name}: ${p?.error || 'tool error'}`);
  }
  return r.result.structuredContent;
}

const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) process.exitCode = 1;
};

const before = await call('get_plan');
check('initial plan', Array.isArray(before.plan.routines), `rev=${before.revision}`);

const ex = await call('search_exercises', { query: '深蹲', limit: 3 });
check('search 深蹲', ex.count > 0, ex.results[0]?.name);
const exId = ex.results[0].exercise_id;

const preview = await call('plan_preview', {
  actions: [{
    type: 'create_routine',
    name: 'WRITE TEST',
    weekdays: [6],
    exercises: [
      { exercise_id: exId, sets: 4, reps: 6, weight: 60, rest_sec: 180, note: '测试用，请勿保留' },
      { exercise_id: '0289', sets: 3, reps: 10, weight: 10, db_load: 'each' },
    ],
  }],
});
check('preview created', !!preview.proposal_id);
check('preview shows 2 exercises', preview.changes[0].includes('WRITE TEST'));

const applied = await call('plan_apply', { proposal_id: preview.proposal_id, confirmation: '确认写入' });
check('apply ok', applied.ok === true, `rev=${applied.rev} backup=${applied.backup}`);

const after = await call('get_plan');
const created = after.plan.routines.find(r => r.name === 'WRITE TEST');
check('routine persisted', !!created, created?.routine_id);
check('weekday 6 assigned', after.plan.weekdays['6']?.[0]?.name === 'WRITE TEST');
check('exercise fields preserved', created?.exercises?.[0]?.weight === 60 && created?.exercises?.[0]?.rest_sec === 180
  && created?.exercises?.[0]?.note === '测试用，请勿保留');
check('dumbbell load preserved', created?.exercises?.[1]?.db_load === 'each');

const p2 = await call('plan_preview', {
  actions: [{ type: 'update_routine', routine_id: created.routine_id, name: 'WRITE TEST 2' }],
});
const a2 = await call('plan_apply', { proposal_id: p2.proposal_id, confirmation: '确认写入' });
check('second apply', a2.ok === true);

const p3 = await call('plan_preview', {
  actions: [{ type: 'set_exercise', routine_id: created.routine_id, index: 0, patch: { weight: 62.5, reps_min: 4 } }],
});
const a3 = await call('plan_apply', { proposal_id: p3.proposal_id, confirmation: '确认写入' });
check('set_exercise apply', a3.ok === true);

const final = await call('get_plan');
const edited = final.plan.routines.find(r => r.routine_id === created.routine_id);
check('edited weight', edited?.exercises?.[0]?.weight === 62.5, String(edited?.exercises?.[0]?.weight));
check('edited reps_min', edited?.exercises?.[0]?.reps_min === 4, String(edited?.exercises?.[0]?.reps_min));

const p4 = await call('plan_preview', {
  actions: [{ type: 'delete_routine', routine_id: created.routine_id }],
});
const a4 = await call('plan_apply', { proposal_id: p4.proposal_id, confirmation: '确认写入' });
check('delete apply', a4.ok === true);
const cleaned = await call('get_plan');
check('routine deleted', !cleaned.plan.routines.some(r => r.routine_id === created.routine_id));
check('weekday cleared', !cleaned.plan.weekdays['6']?.length);

console.log(process.exitCode ? '\nwrite test failed' : '\nwrite test passed');
