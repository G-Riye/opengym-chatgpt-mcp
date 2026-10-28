#!/usr/bin/env node
/* Deep test for the advanced exercise fields added in 1.1.0.
   Pure: clones the live state, runs applyActions in memory, prints what would be
   written. It NEVER calls the API and never touches data/. */
import fs from 'node:fs';
import path from 'node:path';
import { applyActions } from '../src/plan.mjs';
import { planView } from '../src/state.mjs';

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

console.log(`\nrevision in memory: ${S._rev} (unchanged - nothing was written)`);
