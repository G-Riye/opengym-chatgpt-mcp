/* What the app would put on the bar when a session starts.
   Reuses the official frontend session builder (buildSessionEntries → buildPlannedEntry →
   buildSets + applyPrescription) so the numbers match openGym exactly: progression rules,
   deloads, pyramid targets, drop-sets / rest-pause bursts and the warm-up ramp are applied
   exactly as the App applies them. */
import { planFor, routinesOf, todayIso, addDays, upcoming } from './state.mjs';
import { buildSessionEntries } from '../../frontend/src/lib/session-start.js';
import { isWarmupRow } from '../../frontend/src/lib/workout-model.js';
import { describe } from './exercises.mjs';

const round = n => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

function rowView(row) {
  const kind = isWarmupRow(row) ? 'warmup' : 'work';
  return {
    kind,
    weight: row?.w ?? null,
    reps: row?.r ?? null,
    seconds: row?.sec ?? null,
    minutes: row?.min ?? null,
    speed: row?.speed ?? null,
    incline: row?.incline ?? null,
    ...(row?.max === true ? { max: true } : {}),
    ...(row?.phase ? { phase: row.phase } : {}),
    ...(row?.sides ? {
      sides: {
        L: { weight: row.sides.L?.w ?? null, reps: row.sides.L?.r ?? null },
        R: { weight: row.sides.R?.w ?? null, reps: row.sides.R?.r ?? null },
      },
    } : {}),
  };
}

function entryView(S, entry) {
  const meta = describe(S, entry.id);
  const target = entry.target || entry.planned || {};
  const rows = (Array.isArray(entry.sets) ? entry.sets : []).map(rowView);
  return {
    exercise_id: meta.exercise_id || entry.id,
    name: meta.name,
    superset: entry.sg ? { group: entry.sg } : null,
    prescribed: {
      sets: target.sets ?? null,
      mode: target.mode || 'reps',
      reps: target.reps ?? null,
      reps_min: target.repsMin ?? null,
      reps_max: target.repsMax ?? null,
      weight: target.weight ?? null,
      rest_sec: target.restSec ?? null,
      warmup_sets: target.warmupSets ?? null,
      pyramid: Array.isArray(target.pyramid) ? target.pyramid : null,
      pyramid_weight: Array.isArray(target.pyramidWeight) ? target.pyramidWeight : null,
      intensifier: target.intensifier || null,
      progression: target.prog || null,
    },
    rows,
    row_counts: {
      warmup: rows.filter(r => r.kind === 'warmup').length,
      work: rows.filter(r => r.kind === 'work').length,
    },
    ...(typeof target.note === 'string' && target.note ? { note: target.note.slice(0, 800) } : {}),
  };
}

/* Preview one date (default today). `routine_id` previews a routine even if it is not
   scheduled that day; otherwise the date's own plan is used. */
export function previewSession(S, { date, routine_id: routineId } = {}) {
  const iso = date || todayIso();
  const routines = routinesOf(S);
  let ids = [];
  let source = 'plan';
  if (routineId) {
    if (!routines.some(r => r.id === routineId)) throw new Error(`找不到训练模板 ${routineId}`);
    ids = [routineId];
    source = 'explicit';
  } else {
    const day = planFor(S, iso);
    ids = day.ids;
    source = day.source || 'plan';
  }
  if (!ids.length) {
    const next = upcoming(S, 7, addDays(iso, 1)).filter(d => d.routine_ids && d.routine_ids.length)[0] || null;
    return {
      date: iso,
      unit: S?.unit || 'kg',
      source,
      routines: [],
      message: '这一天没有排训练。',
      next_training_day: next ? { date: next.date, routines: next.routine_ids } : null,
    };
  }
  const out = ids.map(id => {
    const routine = routines.find(r => r.id === id);
    const entries = buildSessionEntries(S, routine || { id, name: id, ex: [] });
    return {
      routine_id: id,
      name: routine?.name || id,
      progression: routine?.prog || 'off',
      exercises: entries.map(entry => entryView(S, entry)),
    };
  });
  return {
    date: iso,
    unit: S?.unit || 'kg',
    source,
    note: 'row 里的重量/次数是 App 开训时真正会显示的目标：官方 buildSessionEntries 已套用进阶规则、减载、金字塔、递减/休息暂停与热身递增，和模板里的 weight 不一定相同。',
    routines: out,
  };
}
