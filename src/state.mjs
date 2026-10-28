/* Read model over ./data/state-<uid>.json.
   The file is the same document the app syncs; reading it directly keeps every
   rich field (mode, per-side, bodyweight, supersets, notes) that the API's
   client projection would otherwise trim. */
import fs from 'node:fs';
import path from 'node:path';
import { config, stateFile } from './config.mjs';
import { uid } from './opengym.mjs';
import { describe, nameOf, isCardio } from './exercises.mjs';

const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
let cache = { mtimeMs: 0, size: -1, state: null, at: 0 };

export function todayIso() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

export function isoOf(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

export function addDays(iso, days) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(iso) {
  return new Date(iso + 'T12:00:00Z').getUTCDay();
}

export function readState({ fresh = false } = {}) {
  const file = stateFile(uid());
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  if (!fresh && cache.state && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.state;
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { throw new Error(`state 文件无法解析（${path.basename(file)}）：${e.message}`); }
  cache = { mtimeMs: stat.mtimeMs, size: stat.size, state, at: Date.now() };
  return state;
}

export function invalidate() { cache = { mtimeMs: 0, size: -1, state: null, at: 0 }; }

export function requireState() {
  const S = readState();
  if (!S) throw new Error('这个账号还没有同步过训练数据；请先在 openGym 里打开一次并同步');
  return S;
}

/* ---------- plan ---------- */

function idsOf(value) {
  return [].concat(value ?? []).filter(x => typeof x === 'string' && x);
}

export function routinesOf(S) {
  return Array.isArray(S?.routines) ? S.routines.filter(r => r && typeof r.id === 'string') : [];
}

export function routineName(S, id) {
  return routinesOf(S).find(r => r.id === id)?.name || id;
}

export function planFor(S, iso) {
  const override = S?.dayPlan?.[iso];
  if (override === 'rest') return { ids: [], source: 'rest_override' };
  const ids = idsOf(override).filter(id => routinesOf(S).some(r => r.id === id));
  if (ids.length) return { ids, source: 'override' };
  const wd = weekdayOf(iso);
  const weekly = idsOf(S?.week?.[wd]).filter(id => routinesOf(S).some(r => r.id === id));
  if (weekly.length) return { ids: weekly, source: 'weekday' };
  return { ids: [], source: 'rest' };
}

function exerciseLine(S, ex, index) {
  const meta = describe(S, ex.id);
  const mode = ex.mode || (meta.body_part === 'cardio' ? 'cardio' : 'reps');
  return {
    index,
    exercise_id: meta.exercise_id || ex.id,
    name: meta.name,
    sets: ex.sets ?? null,
    mode,
    reps: ex.reps ?? null,
    reps_min: ex.repsMin ?? null,
    reps_max: ex.repsMax ?? null,
    sets_max: ex.setsMax ?? null,
    seconds: ex.sec ?? null,
    minutes: ex.min ?? null,
    speed: ex.speed ?? null,
    incline: ex.incline ?? null,
    weight: ex.weight ?? null,
    rest_sec: ex.restSec ?? null,
    warmup_sets: ex.warmupSets ?? null,
    warmup_rest_sec: ex.warmupRestSec ?? null,
    inc: ex.inc ?? null,
    deload_factor: ex.deloadFactor ?? null,
    backoff: ex.backoff === true,
    last_to_failure: ex.lastToFailure === true,
    progression: ex.prog || null,
    intensifier: ex.intensifier && typeof ex.intensifier === 'object'
      ? (ex.intensifier.type === 'dropset'
        ? { type: 'dropset', count: ex.intensifier.count ?? null, pct: ex.intensifier.pct ?? null }
        : ex.intensifier.type === 'restpause'
          ? { type: 'restpause', total_reps: ex.intensifier.totalReps ?? null, rest_sec: ex.intensifier.restSec ?? null }
          : null)
      : null,
    pyramid: Array.isArray(ex.pyramid) && ex.pyramid.length ? [...ex.pyramid] : null,
    pyramid_weight: Array.isArray(ex.pyramidWeight) && ex.pyramidWeight.length ? [...ex.pyramidWeight] : null,
    pyramid_rest: Array.isArray(ex.pyramidRest) && ex.pyramidRest.length ? [...ex.pyramidRest] : null,
    note: typeof ex.note === 'string' && ex.note ? ex.note.slice(0, 800) : null,
    side: !!ex.side,
    bodyweight: ex.bodyweight ?? meta.is_bodyweight,
    assisted: ex.assisted ?? meta.is_assisted,
    db_load: ex.dbLoad || null,
    superset: ex.sg ? { group: ex.sg, name: ex.sgName || null, rest_sec: ex.sgRest ?? null } : null,
    body_part: meta.body_part,
    equipment: meta.equipment,
  };
}

export function planView(S) {
  const routines = routinesOf(S).map(r => ({
    routine_id: r.id, name: r.name || r.id, emoji: r.emoji || null,
    progression: r.prog || 'off',
    exercises: (Array.isArray(r.ex) ? r.ex : []).filter(e => e && e.id).map((e, i) => exerciseLine(S, e, i)),
  }));
  const weekdays = {};
  for (let d = 0; d < 7; d++) {
    const ids = idsOf(S?.week?.[d]).filter(id => routinesOf(S).some(r => r.id === id));
    weekdays[String(d)] = ids.map(id => ({ routine_id: id, name: routineName(S, id) }));
  }
  const overrides = {};
  for (const [date, value] of Object.entries(S?.dayPlan || {})) {
    if (value === 'rest') overrides[date] = 'rest';
    else {
      const ids = idsOf(value).filter(id => routinesOf(S).some(r => r.id === id));
      if (ids.length) overrides[date] = ids.map(id => ({ routine_id: id, name: routineName(S, id) }));
    }
  }
  return {
    unit: S?.unit || 'kg',
    routines,
    weekdays,
    weekday_names: DAY_NAMES,
    overrides,
    progression_policies: ['off', 'linear', 'greyskull', 'double', 'triple', 'time'],
  };
}

export function upcoming(S, days = 7, from = todayIso()) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    const { ids, source } = planFor(S, date);
    out.push({
      date,
      weekday: weekdayOf(date),
      weekday_name: DAY_NAMES[weekdayOf(date)],
      routines: ids.map(id => ({ routine_id: id, name: routineName(S, id) })),
      source,
      rest: ids.length === 0,
    });
  }
  return out;
}

/* ---------- workouts ---------- */

export function workoutStart(w) {
  if (Number.isFinite(w?.start)) return w.start;
  if (typeof w?.d === 'string') return Date.parse(w.d + 'T12:00:00');
  return 0;
}

export function workoutVolume(w) {
  let volume = 0;
  for (const entry of Array.isArray(w?.entries) ? w.entries : []) {
    for (const set of Array.isArray(entry?.sets) ? entry.sets : []) {
      const sides = set?.sides;
      if (sides && typeof sides === 'object') {
        for (const side of ['L', 'R']) {
          const s = sides[side];
          if (s && s.done) volume += (Number(s.w) || 0) * (Number(s.r) || 0);
        }
      } else if (set?.done) {
        volume += (Number(set.w) || 0) * (Number(set.r) || 0);
      }
    }
  }
  return Math.round(volume * 10) / 10;
}

/* ---------- per-set detail (drops = 递减组, bursts = 爆发组 / rest-pause) ---------- */

const isWarmupFlag = s => s?.warmup === true || /^warm-?up$/i.test(String(s?.phase || ''));

/* The app stores an intensifier two ways: the row's `type` and, for rest-pause, the
   `clusters` that break the set's own total into short-rest bursts (lib/workout-model.js). */
function setKind(s) {
  if (isWarmupFlag(s)) return 'warmup';
  const type = String(s?.type || '').toLowerCase();
  if (type === 'dropset' || (Array.isArray(s?.drops) && s.drops.length)) return 'dropset';
  if (type === 'restpause' || (Array.isArray(s?.clusters) && s.clusters.length)) return 'restpause';
  return 'straight';
}
const dropsView = s => (Array.isArray(s?.drops) ? s.drops : [])
  .map(d => ({ weight: d?.w ?? null, reps: d?.r ?? null }))
  .filter(d => d.weight != null || d.reps != null);
const burstsView = s => (Array.isArray(s?.clusters) ? s.clusters : [])
  .map(c => ({ reps: c?.r ?? null, rest_sec: c?.restSec ?? null }))
  .filter(c => c.reps != null);

/* All the per-set extras, shared by the flat row and its per-side halves. */
function setExtras(s) {
  const kind = setKind(s);
  const drops = dropsView(s);
  const bursts = burstsView(s);
  const out = {
    ...(kind !== 'straight' ? { type: kind } : {}),
    ...(s?.max === true ? { max: true } : {}),
    ...(drops.length ? { drops } : {}),
    ...(bursts.length ? { bursts, burst_reps: bursts.reduce((n, b) => n + (Number(b.reps) || 0), 0) } : {}),
  };
  return out;
}
function sideView(side) {
  return {
    weight: side?.w ?? null,
    reps: side?.r ?? null,
    done: !!side?.done,
    ...setExtras(side),
  };
}

export function workoutView(S, w, { detail = true } = {}) {
  const entries = Array.isArray(w?.entries) ? w.entries : [];
  let setsDone = 0;
  let setsPlanned = 0;
  const exercises = entries.filter(e => e && e.id).map(e => {
    const target = e.target || {};
    const meta = describe(S, e.id);
    const sets = (Array.isArray(e.sets) ? e.sets : []).map(s => ({
      weight: s?.w ?? null,
      reps: s?.r ?? null,
      seconds: s?.sec ?? null,
      minutes: s?.min ?? null,
      speed: s?.speed ?? null,
      incline: s?.incline ?? null,
      done: !!s?.done,
      rir: Number.isFinite(s?.rir) ? s.rir : null,
      rpe: Number.isFinite(s?.rpe) ? s.rpe : null,
      ...setExtras(s),
      ...(typeof s?.note === 'string' && s.note ? { note: s.note.slice(0, 300) } : {}),
      ...(s?.sides ? { sides: { L: sideView(s.sides.L), R: sideView(s.sides.R) } } : {}),
    }));
    setsDone += sets.reduce((n, s) => n + (s.done ? (s.sides ? 2 : 1) : 0), 0);
    const planned = target.sets ?? e.planned?.sets ?? sets.length;
    setsPlanned += Number(planned) || 0;
    return {
      exercise_id: meta.exercise_id || e.id,
      name: meta.name,
      body_part: meta.body_part,
      target: {
        sets: planned ?? null, mode: target.mode || e.planned?.mode || null,
        reps: target.reps ?? e.planned?.reps ?? null,
        reps_min: target.repsMin ?? e.planned?.repsMin ?? null,
        weight: target.weight ?? e.planned?.weight ?? null,
        rest_sec: target.restSec ?? null,
        minutes: target.min ?? null,
        speed: target.speed ?? null,
        incline: target.incline ?? null,
      },
      sets: detail ? sets : sets.filter(s => s.done),
      top_weight: e.topW ?? null,
      set_summary: (() => {
        const counts = { straight: 0, dropset: 0, restpause: 0, warmup: 0 };
        let burstReps = 0;
        for (const set of sets) {
          counts[set.type || 'straight'] = (counts[set.type || 'straight'] || 0) + 1;
          burstReps += set.burst_reps || 0;
        }
        return counts.restpause || counts.dropset || counts.warmup
          ? { ...counts, ...(burstReps ? { burst_reps: burstReps } : {}) }
          : null;
      })(),
      prescribed: target.intensifier || target.warmupSets
        ? { ...(target.intensifier ? { intensifier: target.intensifier } : {}), ...(target.warmupSets ? { warmup_sets: target.warmupSets } : {}) }
        : null,
      ...(() => {
        const note = typeof e.note === 'string' && e.note ? e.note
          : (typeof target.note === 'string' && target.note ? target.note : '');
        return note ? { note: note.slice(0, 400) } : {};
      })(),
    };
  });
  const start = Number.isFinite(w?.start) ? w.start : null;
  const end = Number.isFinite(w?.end) ? w.end : null;
  return {
    workout_id: w?.id || null,
    date: w?.d || (start ? isoOf(new Date(start)) : null),
    name: w?.name || null,
    started_at: start ? new Date(start).toISOString() : null,
    duration_min: start && end && end >= start ? Math.round((end - start) / 60000) : null,
    routine_ids: Array.isArray(w?.routineIds) ? w.routineIds : (w?.routineId ? [w.routineId] : []),
    bodyweight: w?.bw ?? null,
    volume: workoutVolume(w),
    unit: S?.unit || 'kg',
    sets_done: setsDone,
    sets_planned: setsPlanned,
    completion_pct: setsPlanned ? Math.round(setsDone / setsPlanned * 100) : null,
    prs: (Array.isArray(w?.prs) ? w.prs : []).map(id => ({ exercise_id: id, name: nameOf(S, id) })),
    exercises,
  };
}

export function sortedWorkouts(S) {
  const list = Array.isArray(S?.workouts) ? S.workouts.filter(w => w && typeof w === 'object') : [];
  return [...list].sort((a, b) => workoutStart(b) - workoutStart(a) || String(b.d || '').localeCompare(String(a.d || '')));
}

export function recent(S, limit = 6, { detail = true } = {}) {
  const n = Math.max(1, Math.min(20, Number(limit) || 6));
  return sortedWorkouts(S).slice(0, n).map(w => workoutView(S, w, { detail }));
}

export function workoutsBetween(S, since, until, limit = 20) {
  const n = Math.max(1, Math.min(50, Number(limit) || 20));
  return sortedWorkouts(S).filter(w => {
    const d = w.d || (workoutStart(w) ? isoOf(new Date(workoutStart(w))) : '');
    return (!since || d >= since) && (!until || d <= until);
  }).slice(0, n).map(w => workoutView(S, w, { detail: true }));
}

/* ---------- history / bodyweight ---------- */

function epley(w, r) {
  if (!(w > 0) || !(r >= 1) || r > 12) return null;
  return Math.round(w * (1 + r / 30) * 10) / 10;
}

export function exerciseHistory(S, exerciseId, limit = 8) {
  const meta = describe(S, exerciseId);
  const id = meta.exercise_id;
  const sessions = [];
  for (const w of [...sortedWorkouts(S)].reverse()) {
    const entries = (Array.isArray(w.entries) ? w.entries : []).filter(e => e && (e.id === id || e.id === exerciseId));
    if (!entries.length) continue;
    let top = null;
    let bestEst = null;
    let totalReps = 0;
    let doneSets = 0;
    let dropSets = 0;
    let restPauseSets = 0;
    let burstReps = 0;
    for (const e of entries) {
      for (const s of Array.isArray(e.sets) ? e.sets : []) {
        if (!s?.done) continue;
        doneSets += 1;
        const kind = setKind(s);
        if (kind === 'dropset') dropSets += 1;
        if (kind === 'restpause') {
          restPauseSets += 1;
          burstReps += burstsView(s).reduce((n, b) => n + (Number(b.reps) || 0), 0);
        }
        const reps = Number(s.r) || 0;
        totalReps += reps;
        const weight = Number(s.w) || 0;
        if (!top || weight > top.weight) top = { weight, reps };
        const est = epley(weight, reps);
        if (est && (!bestEst || est > bestEst)) bestEst = est;
      }
    }
    if (!doneSets) continue;
    const note = entries
      .map(e => (typeof e.note === 'string' ? e.note : '') || (typeof e.target?.note === 'string' ? e.target.note : ''))
      .find(Boolean) || '';
    sessions.push({
      date: w.d, workout_id: w.id, routine: w.name || null,
      sets_done: doneSets, top_weight: top?.weight ?? null, top_reps: top?.reps ?? null,
      total_reps: totalReps, est_1rm: bestEst,
      ...(dropSets || restPauseSets ? { drop_sets: dropSets, rest_pause_sets: restPauseSets } : {}),
      ...(burstReps ? { burst_reps: burstReps } : {}),
      ...(note ? { note: String(note).slice(0, 400) } : {}),
    });
  }
  const bestWeight = sessions.reduce((best, s) => s.top_weight != null && (!best || s.top_weight > best.top_weight) ? s : best, null);
  const bestEst = sessions.reduce((best, s) => s.est_1rm != null && (!best || s.est_1rm > best.est_1rm) ? s : best, null);
  return {
    exercise: { exercise_id: id, name: meta.name, body_part: meta.body_part, equipment: meta.equipment,
      is_bodyweight: !!meta.is_bodyweight, is_assisted: !!meta.is_assisted },
    sessions: sessions.slice(-Math.max(1, Math.min(30, Number(limit) || 8))),
    best_weight: bestWeight ? { weight: bestWeight.top_weight, reps: bestWeight.top_reps, date: bestWeight.date } : null,
    best_est_1rm: bestEst ? { value: bestEst.est_1rm, unit: S?.unit || 'kg', date: bestEst.date } : null,
    note: '估算 1RM 用 Epley，仅统计 1–12 次且已完成的组；助力器械数值越小越难。',
  };
}

export function bodyweightView(S) {
  const list = Array.isArray(S?.bodyweight) ? S.bodyweight.filter(x => x && Number.isFinite(x.w)) : [];
  const sorted = [...list].sort((a, b) => String(a.d || '').localeCompare(String(b.d || '')));
  const last = sorted[sorted.length - 1] || null;
  const weekAgo = addDays(todayIso(), -7);
  const prior = [...sorted].reverse().find(x => String(x.d || '') <= weekAgo) || null;
  return {
    unit: S?.unit || 'kg',
    latest: last ? { date: last.d, weight: last.w } : null,
    change_7d: last && prior ? Math.round((last.w - prior.w) * 10) / 10 : null,
    goal: Number.isFinite(S?.targetW) ? { weight: S.targetW, unit: S?.unit || 'kg' } : null,
    recent: sorted.slice(-10),
  };
}

/* ---------- body measurements ---------- */

/* Mirrors frontend/src/lib/measurements.js. Values are stored in centimetres (bodyFat in %)
   no matter what the profile's weight unit is; the app converts only at the UI edge. */
export const MEASUREMENT_FIELDS = [
  { key: 'neck', label: '颈围', group: '躯干' },
  { key: 'shoulders', label: '肩围', group: '躯干' },
  { key: 'chest', label: '胸围', group: '躯干' },
  { key: 'waist', label: '腰围', group: '躯干' },
  { key: 'hips', label: '臀围', group: '躯干' },
  { key: 'abdomen', label: '腹围', group: '躯干', optional: true },
  { key: 'upperArmLeft', label: '左上臂', group: '手臂' },
  { key: 'upperArmRight', label: '右上臂', group: '手臂' },
  { key: 'forearmLeft', label: '左前臂', group: '手臂' },
  { key: 'forearmRight', label: '右前臂', group: '手臂' },
  { key: 'wristLeft', label: '左腕', group: '手臂', optional: true },
  { key: 'wristRight', label: '右腕', group: '手臂', optional: true },
  { key: 'thighLeft', label: '左大腿', group: '腿' },
  { key: 'thighRight', label: '右大腿', group: '腿' },
  { key: 'calfLeft', label: '左小腿', group: '腿' },
  { key: 'calfRight', label: '右小腿', group: '腿' },
  { key: 'ankleLeft', label: '左踝', group: '腿', optional: true },
  { key: 'ankleRight', label: '右踝', group: '腿', optional: true },
  { key: 'bodyFat', label: '体脂率', group: '其他', kind: 'percent', optional: true },
];
export const MEASUREMENT_KEYS = MEASUREMENT_FIELDS.map(f => f.key);
export const DEFAULT_MEASUREMENT_KEYS = MEASUREMENT_FIELDS.filter(f => !f.optional).map(f => f.key);

const mRound = n => Math.round(n * 10) / 10;
const mValid = v => (Number.isFinite(+v) && +v > 0 ? mRound(+v) : null);

function measurementEntryView(entry) {
  const values = {};
  for (const key of MEASUREMENT_KEYS) {
    const v = mValid(entry?.[key]);
    if (v != null) values[key] = v;
  }
  const other = (Array.isArray(entry?.other) ? entry.other : [])
    .map(o => ({ id: o?.id ?? null, name: o?.name ?? null, value: mValid(o?.value) }))
    .filter(o => o.value != null);
  return { date: entry?.d ?? null, values, ...(other.length ? { other } : {}) };
}

export function measurementsView(S, { limit = 24, seriesDays = 365 } = {}) {
  const all = (Array.isArray(S?.measurements) ? S.measurements : [])
    .filter(e => e && /^\d{4}-\d{2}-\d{2}$/.test(String(e.d || '')))
    .sort((a, b) => String(a.d).localeCompare(String(b.d)) || (Number(a.t) || 0) - (Number(b.t) || 0));
  const custom = (Array.isArray(S?.customMeasurements) ? S.customMeasurements : [])
    .filter(c => c && c.id && String(c.name || '').trim())
    .map(c => ({ id: String(c.id), name: String(c.name).trim(), enabled: c.enabled !== false }));
  const enabled = Array.isArray(S?.measurementEnabled) && S.measurementEnabled.length
    ? S.measurementEnabled.filter(k => MEASUREMENT_KEYS.includes(k))
    : DEFAULT_MEASUREMENT_KEYS;

  const cutoff = addDays(todayIso(), -Math.max(1, Math.min(3650, Number(seriesDays) || 365)));
  const recent = all.filter(e => String(e.d) >= cutoff);
  const series = {};
  for (const key of enabled) {
    const points = recent
      .map(e => ({ date: e.d, value: mValid(e[key]) }))
      .filter(p => p.value != null);
    if (points.length) series[key] = points;
  }
  for (const c of custom) {
    if (!c.enabled) continue;
    const points = recent
      .map(e => ({ date: e.d, value: mValid((e.other || []).find(o => String(o.id) === c.id)?.value) }))
      .filter(p => p.value != null);
    if (points.length) series[c.id] = points;
  }

  const shown = all.slice(-Math.max(1, Math.min(100, Number(limit) || 24))).map(measurementEntryView);
  const latest = shown.length ? shown[shown.length - 1] : null;
  const unit = S?.unit === 'lb' ? 'in' : 'cm';
  return {
    unit: 'cm',
    display_unit: unit,
    note: '所有围度以厘米存储（体脂率是百分比）；lb 档案里 App 只做显示换算。字段见 fields。',
    fields: MEASUREMENT_FIELDS.map(f => ({ key: f.key, label: f.label, group: f.group, unit: f.kind === 'percent' ? '%' : 'cm', enabled: enabled.includes(f.key) })),
    custom_fields: custom,
    latest,
    series,
    entries: shown,
    total_entries: all.length,
  };
}

export function measurementsSummary(S) {
  const view = measurementsView(S, { limit: 1, seriesDays: 30 });
  return {
    latest: view.latest,
    enabled_fields: view.fields.filter(f => f.enabled).map(f => f.key),
    custom_fields: view.custom_fields.filter(c => c.enabled).map(c => c.name),
    total_entries: view.total_entries,
  };
}



function cursorFile() { return path.join(config.storeDir, 'updates.json'); }

function readCursor() {
  try {
    const raw = fs.readFileSync(cursorFile(), 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch { return null; }
}

function writeCursor(value) {
  fs.mkdirSync(config.storeDir, { recursive: true });
  const temp = cursorFile() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, cursorFile());
}

export function pendingUpdates(S = readState()) {
  if (!S) return 0;
  const cursor = readCursor();
  if (!cursor) return 0;
  return sortedWorkouts(S).filter(w => workoutStart(w) > Number(cursor.lastStart || 0)).length;
}

export function getUpdates({ ack = true, limit = 5 } = {}) {
  const S = requireState();
  const cursor = readCursor();
  const all = sortedWorkouts(S);
  if (!cursor) {
    const latest = all[0] || null;
    const value = { lastStart: latest ? workoutStart(latest) : Date.now(), lastDate: latest?.d || todayIso(),
      initializedAt: new Date().toISOString() };
    writeCursor(value);
    return {
      first_run: true, count: 0,
      message: latest
        ? `首次同步已建立基准；最近一次训练是 ${latest.d}「${latest.name || '训练'}」。以后只返回这之后新完成的训练。`
        : '首次同步已建立基准；目前还没有已完成的训练。',
      latest: latest ? workoutView(S, latest, { detail: false }) : null,
    };
  }
  const fresh = all.filter(w => workoutStart(w) > Number(cursor.lastStart || 0))
    .sort((a, b) => workoutStart(a) - workoutStart(b))
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 5)));
  if (!fresh.length) return { count: 0, message: '没有新的已完成训练。' };
  const out = fresh.map(w => workoutView(S, w, { detail: true }));
  if (ack) {
    const last = fresh[fresh.length - 1];
    writeCursor({ lastStart: workoutStart(last), lastDate: last.d || todayIso(), updatedAt: new Date().toISOString() });
  }
  return { count: out.length, workouts: out };
}

export function resetUpdates() {
  try { fs.rmSync(cursorFile(), { force: true }); } catch {}
  return { ok: true };
}

/* ---------- aggregate ---------- */

export function contextView(S) {
  const workouts = sortedWorkouts(S);
  const last = workouts[0] ? workoutView(S, workouts[0], { detail: true }) : null;
  return {
    now: new Date().toISOString(),
    today: todayIso(),
    timezone: config.timezone,
    profile: {
      name: undefined, // filled by the tool layer (user record)
      unit: S?.unit || 'kg',
      language: S?.lang || 'zh',
      bodyweight: bodyweightView(S),
      default_rest_sec: S?.restSec ?? null,
    },
    plan: planView(S),
    upcoming: upcoming(S, 7),
    recent_workouts: recent(S, 5, { detail: true }),
    last_workout: last,
    measurements: measurementsSummary(S),
    pending_updates: pendingUpdates(S),
    totals: {
      routines: routinesOf(S).length,
      workouts: workouts.length,
      first_workout: workouts.length ? workouts[workouts.length - 1].d : null,
    },
    notes: {
      reads: '训练历史来自 openGym 已同步的数据；每次 get_updates 之后只返回新完成的训练。',
      writes: '写入前会先预览；只有用户明确确认后才调用 plan_apply。组数/次数/重量会原样进入 openGym。',
      exercise_ids: '动作 ID 必须先通过 search_exercises 取得；不要编造 ID。',
    },
  };
}

/* Exported for tools that need the raw effective plan of one date. */
export { DAY_NAMES, isCardio };
