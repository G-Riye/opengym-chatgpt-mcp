#!/usr/bin/env node
/* Deep test for the advanced exercise fields added in 1.1.0.
   Pure: clones the live state, runs applyActions in memory, prints what would be
   written. It NEVER calls the API and never touches data/. */
import fs from 'node:fs';
import path from 'node:path';
import { applyActions } from '../src/plan.mjs';
import { planView, measurementsView, workoutView, exerciseHistory } from '../src/state.mjs';
import { previewSession } from '../src/session.mjs';
import { muscleBalance } from '../src/balance.mjs';
import { isCardio } from '../src/exercises.mjs';

const SELF = path.resolve(import.meta.dirname, '..');
const ROOT = path.resolve(SELF, '..');
const dataDir = path.join(ROOT, 'data');
const stateFile = fs.readdirSync(dataDir).find(f => f.startsWith('state-') && f.endsWith('.json'));
const S = JSON.parse(fs.readFileSync(path.join(dataDir, stateFile), 'utf8').replace(/^\uFEFF/, ''));

const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) process.exitCode = 1;
};

const { state, changes } = applyActions(S, [{
  type: 'create_routine',
  name: 'ADV TEST 请勿写入',
  exercises: [
    {
      exercise_id: '0025',
      pyramid: [12, 10, 8, 'max', 12],
      pyramid_weight: [40, 50, 60, 0, 40],
      pyramid_rest: [90, 0, 120, 0, 0],
      warmup_sets: 2,
      warmup_rest_sec: 60,
      inc: 2.5,
      deload_factor: 0.85,
      backoff: true,
      last_to_failure: true,
      progression: 'double',
      reps_max: 12,
      sets_max: 5,
      intensifier: { type: 'dropset', count: 2, pct: 25 },
      rest_sec: 150,
      note: '高级字段测试',
    },
    {
      exercise_id: '0289',
      sets: 3,
      reps: 10,
      weight: 10,
      db_load: 'each',
      intensifier: { type: 'restpause', total_reps: 15, rest_sec: 20 },
      warmup_sets: 1,
    },
  ],
}]);

const created = state.routines.find(r => r.name === 'ADV TEST 请勿写入');
check('routine created in memory', !!created);
const a = created?.ex?.[0] || {};
const b = created?.ex?.[1] || {};

check('pyramid stored', JSON.stringify(a.pyramid) === JSON.stringify([12, 10, 8, 'max', 12]), JSON.stringify(a.pyramid));
check('pyramid set count = list length', a.sets === 5, `sets=${a.sets}`);
check('pyramid weight aligned', JSON.stringify(a.pyramidWeight) === JSON.stringify([40, 50, 60, 0, 40]), JSON.stringify(a.pyramidWeight));
check('pyramid rest aligned', JSON.stringify(a.pyramidRest) === JSON.stringify([90, 0, 120, 0, 0]), JSON.stringify(a.pyramidRest));
check('warmup sets', a.warmupSets === 2, `warmupSets=${a.warmupSets}`);
check('warmup rest', a.warmupRestSec === 60, `warmupRestSec=${a.warmupRestSec}`);
check('increment', a.inc === 2.5, `inc=${a.inc}`);
check('deload factor', a.deloadFactor === 0.85, `deloadFactor=${a.deloadFactor}`);
check('backoff', a.backoff === true);
check('last to failure', a.lastToFailure === true);
check('per-exercise progression', a.prog === 'double', `prog=${a.prog}`);
check('reps max', a.repsMax === 12, `repsMax=${a.repsMax}`);
check('sets max', a.setsMax === 5, `setsMax=${a.setsMax}`);
check('dropset', a.intensifier?.type === 'dropset' && a.intensifier?.count === 2 && a.intensifier?.pct === 25, JSON.stringify(a.intensifier));
check('restpause', b.intensifier?.type === 'restpause' && b.intensifier?.totalReps === 15 && b.intensifier?.restSec === 20, JSON.stringify(b.intensifier));
check('second exercise warmup', b.warmupSets === 1);
check('changes mention warm-up', changes.join(' ').includes('热身2组'), changes.join(' | '));
check('changes mention pyramid', changes.join(' ').includes('金字塔'), changes.join(' | '));
check('changes mention dropset', changes.join(' ').includes('递减'), changes.join(' | '));

/* Round-trip through the read model the model actually sees. */
const shown = planView(state).routines.find(r => r.name === 'ADV TEST 请勿写入').exercises;
check('planView exposes warmup_sets', shown[0].warmup_sets === 2);
check('planView exposes pyramid', JSON.stringify(shown[0].pyramid) === JSON.stringify([12, 10, 8, 'max', 12]));
check('planView exposes pyramid_weight', JSON.stringify(shown[0].pyramid_weight) === JSON.stringify([40, 50, 60, 0, 40]));
check('planView exposes intensifier', shown[0].intensifier?.type === 'dropset', JSON.stringify(shown[0].intensifier));
check('planView exposes per-exercise progression', shown[0].progression === 'double');

/* Validation must reject nonsense instead of writing it. */
const rejects = (label, actions) => {
  try {
    applyActions(S, actions);
    check(label, false, '未报错');
  } catch (err) {
    check(label, true, err.message);
  }
};
rejects('rejects 6 warm-up sets', [{ type: 'create_routine', name: 'X', exercises: [{ exercise_id: '0025', warmup_sets: 6 }] }]);
rejects('rejects pyramid of 11 sets', [{ type: 'create_routine', name: 'X', exercises: [{ exercise_id: '0025', pyramid: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }] }]);
rejects('rejects pyramid_weight without pyramid', [{ type: 'create_routine', name: 'X', exercises: [{ exercise_id: '0025', pyramid_weight: [40] }] }]);
rejects('rejects bad deload factor', [{ type: 'create_routine', name: 'X', exercises: [{ exercise_id: '0025', deload_factor: 0.7 }] }]);
rejects('rejects unknown intensifier field', [{ type: 'create_routine', name: 'X', exercises: [{ exercise_id: '0025', intensifier: { type: 'dropset', reps: 5 } }] }]);
rejects('rejects pyramid on a time exercise', [{ type: 'create_routine', name: 'X', exercises: [{ exercise_id: 'plank', mode: 'time', seconds: 30, pyramid: [10, 10] }] }]);

/* ---------- 1.2.0: cardio in plans ---------- */

const CARDIO_ID = '3666'; // walking on incline treadmill
const { state: s2, changes: c2 } = applyActions(S, [{
  type: 'create_routine',
  name: 'CARDIO TEST 请勿写入',
  exercises: [
    { exercise_id: CARDIO_ID, minutes: 30, speed: 5.5, incline: 12, note: '先走 5 分钟再上坡度' },
    { exercise_id: '0025', sets: 3, reps: 5, weight: 60, rest_sec: 180 },
  ],
}]);
const cardio = s2.routines.find(r => r.name === 'CARDIO TEST 请勿写入')?.ex?.[0] || {};
check('cardio mode stored', cardio.mode === 'cardio', `mode=${cardio.mode}`);
check('cardio minutes', cardio.min === 30, `min=${cardio.min}`);
check('cardio speed', cardio.speed === 5.5, `speed=${cardio.speed}`);
check('cardio incline', cardio.incline === 12, `incline=${cardio.incline}`);
check('cardio defaults to 1 set', cardio.sets === 1, `sets=${cardio.sets}`);
check('cardio note kept', String(cardio.note || '').includes('坡度'), cardio.note);
check('cardio label', c2.join(' ').includes('分钟'), c2.join(' | '));
check('cardio read model', planView(s2).routines.find(r => r.name === 'CARDIO TEST 请勿写入').exercises[0].minutes === 30);

rejects('rejects cardio without mode', [{ type: 'create_routine', name: 'X', exercises: [{ exercise_id: CARDIO_ID, sets: 2 }] }]);
rejects('rejects cardio mode on a lift', [{ type: 'create_routine', name: 'X', exercises: [{ exercise_id: '0025', mode: 'cardio', minutes: 20 }] }]);
rejects('rejects incline on a bike', [{ type: 'create_routine', name: 'X', exercises: [{ exercise_id: '2138', mode: 'cardio', minutes: 20, incline: 8 }] }]);

/* ---------- 1.2.0: body measurements ---------- */

const { state: s3, changes: c3 } = applyActions(S, [
  { type: 'log_measurement', date: '2026-10-28', values: { waist: 82.4, chest: 101, bodyFat: 18.6, custom: { 左小腿: 36.2 } } },
  { type: 'set_measurement_fields', enable: ['abdomen'], custom: [{ name: '颈围-放松' }] },
]);
const m = (s3.measurements || []).find(e => e.d === '2026-10-28') || {};
check('measurement entry created', m.d === '2026-10-28');
check('measurement waist stored', m.waist === 82.4, `waist=${m.waist}`);
check('measurement bodyFat stored', m.bodyFat === 18.6, `bodyFat=${m.bodyFat}`);
check('measurement custom value', (m.other || []).some(o => o.name === '左小腿' && o.value === 36.2), JSON.stringify(m.other));
check('custom field registered', (s3.customMeasurements || []).some(c => c.name === '左小腿'));
check('measurement enable field', (s3.measurementEnabled || []).includes('abdomen'));
check('measurement custom via action', (s3.customMeasurements || []).some(c => c.name === '颈围-放松'));
check('measurement changes readable', c3.join(' ').includes('记录体测'), c3.join(' | '));

const mv = measurementsView(s3, { limit: 5 });
check('measurementsView latest', mv.latest?.date === '2026-10-28', JSON.stringify(mv.latest?.values));
check('measurementsView series', Array.isArray(mv.series?.waist) && mv.series.waist.length > 0);
check('measurementsView cm unit', mv.unit === 'cm' && mv.display_unit === (S.unit === 'lb' ? 'in' : 'cm'));

rejects('rejects unknown measurement field', [{ type: 'log_measurement', values: { weight: 70 } }]);
rejects('rejects bad measurement value', [{ type: 'log_measurement', values: { waist: -3 } }]);

/* ---------- notes must survive the read model ---------- */
const withNotes = planView(S).routines.flatMap(r => r.exercises).filter(x => x.note);
check('planView returns exercise notes', withNotes.length > 0, `${withNotes.length} notes`);
const workoutWithNote = (S.workouts || []).flatMap(w => w.entries || []).filter(e => (e.note || e.target?.note));
check('workout entries carry notes', workoutWithNote.length > 0, `${workoutWithNote.length} entries`);

/* ---------- 1.3.0: per-set detail (drops / bursts / max / warm-up) ---------- */

const synthetic = structuredClone(S);
synthetic.workouts = [{
  id: 'synthetic-1', d: '2026-10-28', name: 'SET TYPES', start: Date.parse('2026-10-28T10:00:00Z'), end: Date.parse('2026-10-28T11:00:00Z'),
  entries: [{
    id: '0025',
    sg: 'sg-A',
    target: { sets: 3, reps: 8, weight: 60, intensifier: { type: 'restpause', totalReps: 16, restSec: 15 } },
    sets: [
      { w: 40, r: 8, done: true, phase: 'warmup', warmup: true },
      { w: 60, r: 10, done: true, failure: true },
      { w: 60, r: 12, done: true, type: 'dropset', drops: [{ w: 50, r: 8 }, { w: 40, r: 6 }] },
      { w: 60, r: 16, done: true, type: 'restpause', clusters: [{ r: 10, restSec: 15 }, { r: 4, restSec: 15 }, { r: 2, restSec: 15 }] },
      { w: 60, r: 5, done: true, max: true },
    ],
  }, {
    id: '0289',
    target: { sets: 2, reps: 12, weight: 20 },
    sets: [{
      w: 20, r: 16, done: true, type: 'restpause',
      sides: {
        L: { w: 20, r: 16, done: true, type: 'restpause', clusters: [{ r: 10, restSec: 15 }, { r: 6, restSec: 15 }] },
        R: { w: 20, r: 14, done: true, type: 'restpause', clusters: [{ r: 8, restSec: 15 }, { r: 6, restSec: 15 }] },
      },
    }],
  }],
}];
const wv = workoutView(synthetic, synthetic.workouts[0], { detail: true });
const bench = wv.exercises.find(x => x.exercise_id === '0025');
const db = wv.exercises.find(x => x.exercise_id === '0289');
check('set type warmup', bench.sets[0].type === 'warmup', bench.sets[0].type);
check('set type straight', bench.sets[1].type === undefined, String(bench.sets[1].type));
check('dropset exposed', bench.sets[2].type === 'dropset' && bench.sets[2].drops?.length === 2, JSON.stringify(bench.sets[2].drops));
check('drop weights', bench.sets[2].drops[0].weight === 50 && bench.sets[2].drops[1].reps === 6);
check('burst set exposed', bench.sets[3].type === 'restpause', String(bench.sets[3].type));
check('bursts exposed', JSON.stringify(bench.sets[3].bursts) === JSON.stringify([{ reps: 10, rest_sec: 15 }, { reps: 4, rest_sec: 15 }, { reps: 2, rest_sec: 15 }]), JSON.stringify(bench.sets[3].bursts));
check('burst_reps total', bench.sets[3].burst_reps === 16, String(bench.sets[3].burst_reps));
check('max set flagged', bench.sets[4].max === true);
check('set_summary counts', bench.set_summary?.restpause === 1 && bench.set_summary?.dropset === 1 && bench.set_summary?.warmup === 1, JSON.stringify(bench.set_summary));
check('prescribed intensifier exposed', bench.prescribed?.intensifier?.type === 'restpause', JSON.stringify(bench.prescribed));
check('per-side bursts', db.sets[0].sides.L.type === 'restpause' && db.sets[0].sides.L.burst_reps === 16 && db.sets[0].sides.R.burst_reps === 14, JSON.stringify(db.sets[0].sides.L));
check('workout view totals', wv.sets_done === 7, `sets_done=${wv.sets_done}`);
check('failure flag exposed', bench.sets[1].failure === true);
check('phase exposed', bench.sets[0].phase === 'warmup', String(bench.sets[0].phase));
check('exercise order exposed', bench.order === 1 && db.order === 2, `${bench.order}/${db.order}`);
check('superset group exposed', bench.superset?.group === 'sg-A', JSON.stringify(bench.superset));

const histRow = exerciseHistory(synthetic, '0025', 1);
check('history counts rest-pause sets', histRow.sessions[0]?.rest_pause_sets === 1, JSON.stringify(histRow.sessions[0]));
check('history counts drop sets', histRow.sessions[0]?.drop_sets === 1);
check('history burst reps', histRow.sessions[0]?.burst_reps === 16, String(histRow.sessions[0]?.burst_reps));
check('history counts failure sets', histRow.sessions[0]?.failure_sets === 1, String(histRow.sessions[0]?.failure_sets));

/* ---------- 1.4.0: official-logic preview + muscle balance ---------- */

const preview = previewSession(S, { date: '2026-10-28' });
check('preview_session returns routines', Array.isArray(preview.routines), `${preview.routines?.length ?? 0} routines on 2026-10-28`);
const previewRoutine = preview.routines?.[0];
check('preview_session keeps prescription beside rows', !!previewRoutine?.exercises?.[0]?.prescribed,
  JSON.stringify(previewRoutine?.exercises?.[0]?.prescribed).slice(0, 90));
const previewRows = (previewRoutine?.exercises || []).flatMap(e => e.rows || []);
check('preview_session rows are typed', previewRows.length > 0 && previewRows.every(r => r.kind === 'work' || r.kind === 'warmup'),
  `${previewRows.length} rows`);
check('preview_session applies progression (rows may differ from template weight)',
  (previewRoutine?.exercises || []).some(e => (e.rows || []).some(r => r.weight !== e.prescribed?.weight)),
  'compared row weights against template weight');

const balance = muscleBalance(S, { days: 7 });
check('muscle balance window', balance.window?.days === 7, JSON.stringify(balance.window));
check('muscle balance counts workouts', balance.workouts >= 1, `${balance.workouts} workouts, ${balance.total_effective_sets} effective sets`);
check('muscle balance ranked', Array.isArray(balance.muscles) && balance.muscles.every((m, i, a) => i === 0 || a[i - 1].weekly_sets >= m.weekly_sets),
  balance.muscles.slice(0, 3).map(m => `${m.name_zh || m.name}=${m.weekly_sets}`).join(', '));
check('muscle balance has labels', !!balance.muscles[0]?.name_zh, balance.muscles[0]?.name_zh);


/* ---------- 1.4.4: no artificial exercise cap, duplicate ids, warm-up rows ---------- */

/* openGym's own routine editor has no exercise-count cap and accepts the same exercise more
   than once (lib/routines.js routineSlotIndex maps a session row to its slot among the twins).
   The connector must mirror that instead of an invented 12 limit, while every entry is still
   validated field by field and preview_session keeps inserting the app's warm-up ramp. */
const seedIds = (S.routines || []).flatMap(r => (r.ex || []).map(e => e.id)).filter(Boolean);
const uniqIds = [...new Set(seedIds)].filter(id => !isCardio(id));
if (uniqIds.length < 2) throw new Error('fields-test needs at least 2 known exercise ids in the live state');
const mkExercises = n => Array.from({ length: n }, (_, i) => {
  const out = { exercise_id: uniqIds[i % uniqIds.length], sets: 3, reps: 8, weight: 40, rest_sec: 120 };
  if (i === 0) out.warmup_sets = 3;
  return out;
});

const { state: s15 } = applyActions(S, [{ type: 'create_routine', name: 'CAP15 TEST 请勿写入', exercises: mkExercises(15) }]);
const r15 = (s15.routines || []).find(r => r.name === 'CAP15 TEST 请勿写入');
check('15-exercise routine accepted (no 12 cap)', r15?.ex?.length === 15, `len=${r15?.ex?.length}`);

const { state: s20 } = applyActions(S, [{ type: 'create_routine', name: 'CAP20 TEST 请勿写入', exercises: mkExercises(20) }]);
const r20 = (s20.routines || []).find(r => r.name === 'CAP20 TEST 请勿写入');
check('20-exercise routine accepted', r20?.ex?.length === 20, `len=${r20?.ex?.length}`);

const { state: s21 } = applyActions(s20, [{ type: 'add_exercise', routine_id: r20.id, exercise: { exercise_id: uniqIds[0], sets: 3, reps: 5, weight: 50 } }]);
const r21 = (s21.routines || []).find(r => r.id === r20.id);
check('add_exercise past 20 accepted', r21?.ex?.length === 21, `len=${r21?.ex?.length}`);

const { state: sDup } = applyActions(S, [{
  type: 'create_routine',
  name: 'DUP TEST 请勿写入',
  exercises: [
    { exercise_id: uniqIds[0], sets: 3, reps: 8, weight: 40 },
    { exercise_id: uniqIds[0], sets: 3, reps: 5, weight: 45 },
  ],
}]);
const rDup = (sDup.routines || []).find(r => r.name === 'DUP TEST 请勿写入');
check('duplicate exercise ids allowed in one routine', rDup?.ex?.length === 2 && rDup.ex[0].id === rDup.ex[1].id,
  JSON.stringify(rDup?.ex?.map(e => e.id)));

const { state: sDup2 } = applyActions(sDup, [{ type: 'set_exercise', routine_id: rDup.id, index: 1, patch: { reps: 6 } }]);
const rDup2 = (sDup2.routines || []).find(r => r.id === rDup.id);
check('slot index addresses the right twin', rDup2?.ex?.[0]?.reps === 8 && rDup2?.ex?.[1]?.reps === 6,
  `${rDup2?.ex?.[0]?.reps}/${rDup2?.ex?.[1]?.reps}`);

const shownDup = planView(sDup2).routines.find(r => r.routine_id === rDup.id)?.exercises || [];
check('read model shows both twins', shownDup.length === 2 && shownDup[0].exercise_id === shownDup[1].exercise_id,
  shownDup.map(e => e.exercise_id).join(','));

const capPreview = previewSession(s15, { routine_id: r15.id });
const capRoutine = capPreview.routines?.[0];
check('preview_session builds all 15 exercises', capRoutine?.exercises?.length === 15, `${capRoutine?.exercises?.length}`);
const warmRows = (capRoutine?.exercises?.[0]?.rows || []).filter(r => r.kind === 'warmup');
check('preview_session inserts the warm-up ramp',
  warmRows.length === 3 && capRoutine?.exercises?.[0]?.row_counts?.warmup === 3, `warmup=${warmRows.length}`);

const preview20 = previewSession(s20, { routine_id: r20.id });
check('preview_session builds all 20 exercises', preview20.routines?.[0]?.exercises?.length === 20,
  `${preview20.routines?.[0]?.exercises?.length}`);

/* Write safety kept: field, shape and action-list validation still refuse junk. */
rejects('rejects an unknown exercise field', [{ type: 'create_routine', name: 'X', exercises: [{ exercise_id: uniqIds[0], bogus: 1 }] }]);
rejects('rejects an exercise without id', [{ type: 'create_routine', name: 'X', exercises: [{ sets: 3, reps: 8 }] }]);
rejects('rejects an empty routine', [{ type: 'create_routine', name: 'X', exercises: [] }]);
rejects('rejects 31 preview actions', Array.from({ length: 31 }, () => ({ type: 'update_routine', routine_id: (S.routines || [])[0]?.id })));

console.log(`\nrevision in memory: ${S._rev} (unchanged - nothing was written)`);
