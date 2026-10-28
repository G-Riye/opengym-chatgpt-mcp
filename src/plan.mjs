/* Plan editing: validate a list of changes, show a diff, then write the whole
   document back through PUT /api/data with the revision it was based on.
   A proposal is short-lived and in-memory; a restart simply asks the model to
   preview again. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, stateFile } from './config.mjs';
import { uid, putState } from './opengym.mjs';
import { readState, invalidate, planView, routineName, routinesOf, todayIso, MEASUREMENT_KEYS, DEFAULT_MEASUREMENT_KEYS } from './state.mjs';
import { canonicalId, lookup, isCardio, describe } from './exercises.mjs';

const POLICIES = new Set(['off', 'linear', 'greyskull', 'double', 'triple', 'time']);
const proposals = new Map();

export class PlanError extends Error {
  constructor(message, code = 'invalid') { super(message); this.name = 'PlanError'; this.code = code; }
}
const fail = (message, code = 'invalid') => { throw new PlanError(message, code); };

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const int = (v, lo, hi, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) fail(`${label} 必须是 ${lo}–${hi} 的整数`);
  return n;
};
const num = (v, lo, hi, label) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) fail(`${label} 必须是 ${lo}–${hi} 的数字`);
  return n;
};
const bool = (v, label) => {
  if (typeof v !== 'boolean') fail(`${label} 必须是 true/false`);
  return v;
};
const text = (v, max, label) => {
  if (typeof v !== 'string') fail(`${label} 必须是文字`);
  const s = v.trim();
  if (!s) fail(`${label} 不能为空`);
  if ([...s].length > max) fail(`${label} 最多 ${max} 个字符`);
  return s;
};
const isoDate = v => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) fail('date 必须是 YYYY-MM-DD');
  const d = new Date(v + 'T12:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) fail('date 不是真实日期');
  return v;
};
const oneOf = (v, list, label) => {
  if (!list.includes(v)) fail(`${label} 只能是 ${list.join(' / ')}`);
  return v;
};

/* openGym's own limits, mirrored from the frontend so a preview can never produce a
   document the app would refuse to open. */
const WARMUP_MAX = 5;          // history.js MAX_PLANNED_WARMUPS
const PYRAMID_MAX_SETS = 10;   // pyramid.js MAX_PYRAMID_SETS
const PYRAMID_MAX = 'max';     // pyramid.js PYRAMID_MAX
const DELOAD_FACTORS = [0.8, 0.85, 0.9];
const INTENSIFIER_KEYS = ['type', 'count', 'pct', 'total_reps', 'rest_sec'];

function cleanIntensifier(input) {
  if (input == null) return null;
  if (!isObj(input)) fail('intensifier 必须是对象，或 null 表示清除');
  for (const key of Object.keys(input)) {
    if (!INTENSIFIER_KEYS.includes(key)) fail(`intensifier 里不认识字段 ${key}`);
  }
  const type = oneOf(input.type, ['dropset', 'restpause'], 'intensifier.type');
  if (type === 'dropset') {
    return {
      type,
      count: input.count == null ? 1 : int(input.count, 1, 10, 'intensifier.count'),
      pct: input.pct == null ? 20 : num(input.pct, 5, 50, 'intensifier.pct'),
    };
  }
  return {
    type,
    totalReps: input.total_reps == null ? 10 : int(input.total_reps, 1, 100, 'intensifier.total_reps'),
    restSec: input.rest_sec == null ? 15 : int(input.rest_sec, 5, 120, 'intensifier.rest_sec'),
  };
}

function cleanPyramid(list) {
  if (!Array.isArray(list) || list.length < 1) fail('pyramid 必须是 1–10 个组目标');
  if (list.length > PYRAMID_MAX_SETS) fail(`pyramid 最多 ${PYRAMID_MAX_SETS} 组`);
  return list.map((value, i) => {
    if (value === PYRAMID_MAX) return PYRAMID_MAX;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 100) fail(`pyramid[${i}] 必须是 1–100 的整数或 "max"`);
    return n;
  });
}

/* pyramid_weight / pyramid_rest are index-aligned with pyramid and short lists are
   padded with 0 = "not set", which is exactly how the app stores them. */
function alignList(input, length, label, { lo, hi, integer }) {
  if (input == null) return [];
  if (!Array.isArray(input)) fail(`${label} 必须是数组`);
  if (input.length > length) fail(`${label} 最多 ${length} 项（和 pyramid 一样长）`);
  const out = Array.from({ length }, (_, i) => {
    if (i >= input.length || input[i] == null) return 0;
    return integer ? int(input[i], lo, hi, `${label}[${i}]`) : num(input[i], lo, hi, `${label}[${i}]`);
  });
  return out;
}

function ensureRepRange(entry) {
  if (entry.mode === 'time') return entry;
  if (entry.repsMin != null && entry.reps != null && entry.repsMin > entry.reps) {
    fail('reps_min 不能大于 reps');
  }
  if (entry.repsMax != null) {
    const lo = entry.repsMin ?? entry.reps;
    if (lo != null && entry.repsMax < lo) fail('reps_max 不能小于 reps / reps_min');
  }
  return entry;
}

/* Every advanced field the openGym editor can store on a routine exercise.
   `null` means "clear it", while omitted means "leave it alone" (patch only). */
function applyAdvanced(entry, input) {
  if ('warmup_sets' in input) {
    const n = input.warmup_sets == null ? 0 : int(input.warmup_sets, 0, WARMUP_MAX, 'warmup_sets');
    if (n > 0) entry.warmupSets = n; else delete entry.warmupSets;
  }
  if ('warmup_rest_sec' in input) {
    const n = input.warmup_rest_sec == null ? 0 : int(input.warmup_rest_sec, 0, 900, 'warmup_rest_sec');
    if (n > 0) entry.warmupRestSec = n; else delete entry.warmupRestSec;
  }
  if ('inc' in input) {
    const n = input.inc == null ? 0 : num(input.inc, 0, 100, 'inc');
    if (n > 0) entry.inc = n; else delete entry.inc;
  }
  if ('deload_factor' in input) {
    if (input.deload_factor == null) delete entry.deloadFactor;
    else entry.deloadFactor = oneOf(Number(input.deload_factor), DELOAD_FACTORS, 'deload_factor');
  }
  if ('backoff' in input) {
    if (input.backoff === true) entry.backoff = true; else delete entry.backoff;
  }
  if ('last_to_failure' in input) {
    if (input.last_to_failure === true) entry.lastToFailure = true; else delete entry.lastToFailure;
  }
  if ('progression' in input) {
    if (input.progression == null) delete entry.prog;
    else entry.prog = oneOf(input.progression, [...POLICIES], 'progression');
  }
  if ('sets_max' in input) {
    const n = input.sets_max == null ? 0 : int(input.sets_max, 1, 10, 'sets_max');
    if (n > 0) entry.setsMax = n; else delete entry.setsMax;
  }
  if ('reps_max' in input) {
    if (input.reps_max == null) delete entry.repsMax;
    else entry.repsMax = int(input.reps_max, 1, 100, 'reps_max');
  }
  if ('intensifier' in input) {
    const value = cleanIntensifier(input.intensifier);
    if (value) entry.intensifier = value; else delete entry.intensifier;
  }
  if ('pyramid' in input) {
    if (input.pyramid == null) {
      delete entry.pyramid;
      delete entry.pyramidWeight;
      delete entry.pyramidRest;
    } else {
      if ((entry.mode || 'reps') !== 'reps') fail('pyramid 只能用于 reps 动作，计时动作请用 sets/seconds');
      const targets = cleanPyramid(input.pyramid);
      entry.pyramid = targets;
      entry.sets = targets.length;
      const firstReps = targets.find(v => v !== PYRAMID_MAX);
      if (firstReps != null) entry.reps = firstReps;
      delete entry.repsMin;
      const weights = alignList(input.pyramid_weight, targets.length, 'pyramid_weight', { lo: 0, hi: 1000, integer: false });
      if (weights.some(w => w > 0)) entry.pyramidWeight = weights; else delete entry.pyramidWeight;
      const rests = alignList(input.pyramid_rest, targets.length, 'pyramid_rest', { lo: 0, hi: 900, integer: true });
      if (rests.some(r => r > 0)) entry.pyramidRest = rests; else delete entry.pyramidRest;
    }
  } else if (('pyramid_weight' in input) || ('pyramid_rest' in input)) {
    fail('pyramid_weight / pyramid_rest 必须和 pyramid 一起给');
  }
  return entry;
}

function routineOf(S, id) {
  const routine = routinesOf(S).find(r => r.id === id);
  if (!routine) fail(`找不到训练模板 ${id}；请先调用 get_plan 获取有效 routine_id`, 'not_found');
  return routine;
}

function exerciseMeta(S, rawId, mode = 'reps') {
  const id = canonicalId(rawId);
  if (!lookup(id) && !(Array.isArray(S.customEx) && S.customEx.some(e => e.id === id))) {
    fail(`动作 ID ${rawId} 不在 openGym 动作库里；请先用 search_exercises 查有效 ID`);
  }
  const meta = describe(S, id);
  const cardio = meta.body_part === 'cardio' || isCardio(id);
  if (cardio && mode !== 'cardio') {
    fail(`「${meta.name}」是有氧动作：请用 mode="cardio" + minutes（分钟）+ speed（速度）来写`);
  }
  if (!cardio && mode === 'cardio') {
    fail(`「${meta.name}」不是有氧动作，不能设 mode="cardio"`);
  }
  return meta;
}

/* Treadmill-style grade: half a percent, 0–40, and only on cardio that has a hill
   (lib/incline.js inclineFits). */
const HILLY = /treadmill|\bwalk|\brun\b|running|\bjog|sprint|stepmill|stair|stepper|elliptical|cross ?trainer|\bhik(e|ing)|incline|trot|march/i;
const FLAT = /bike|bicycl|cycl|row(ing|er)?\b|rope|skat|swim|\bski\b|erg\b|jack|burpee|punch|shuffle|hop|jump|climber|crawl/i;
const inclineFitsName = name => !FLAT.test(String(name || '')) && HILLY.test(String(name || ''));
function cleanIncline(value, meta) {
  if (!inclineFitsName(meta.name)) fail(`「${meta.name}」没有坡度这一项（只有跑步机/走跑/椭圆等有）`);
  const n = Math.round(num(value, 0, 40, 'incline') * 2) / 2;
  return n > 0 ? n : null;
}

const STORE_KEYS = ['sets', 'mode', 'reps', 'repsMin', 'repsMax', 'setsMax', 'sec', 'weight', 'restSec',
  'note', 'side', 'bodyweight', 'assisted', 'dbLoad', 'prog', 'inc', 'deloadFactor', 'backoff',
  'lastToFailure', 'warmupSets', 'warmupRestSec', 'intensifier', 'pyramid', 'pyramidWeight', 'pyramidRest'];
const INPUT_KEYS = ['sets', 'mode', 'reps', 'reps_min', 'reps_max', 'sets_max', 'seconds', 'weight',
  'minutes', 'speed', 'incline',
  'rest_sec', 'note', 'side', 'bodyweight', 'assisted', 'db_load', 'progression', 'inc',
  'deload_factor', 'backoff', 'last_to_failure', 'warmup_sets', 'warmup_rest_sec',
  'intensifier', 'pyramid', 'pyramid_weight', 'pyramid_rest'];

function buildEntry(S, input) {
  if (!isObj(input)) fail('exercise 必须是对象');
  for (const key of Object.keys(input)) {
    if (key !== 'exercise_id' && !INPUT_KEYS.includes(key)) fail(`exercise 里不认识字段 ${key}`);
  }
  if (!input.exercise_id) fail('exercise 缺少 exercise_id');
  const mode = input.mode === 'time' || input.seconds != null ? 'time'
    : input.mode === 'cardio' || input.minutes != null ? 'cardio' : 'reps';
  const meta = exerciseMeta(S, input.exercise_id, mode);
  const sets = input.sets == null ? (mode === 'cardio' ? 1 : 3) : int(input.sets, 1, 20, 'sets');
  const entry = { id: meta.exercise_id, sets, mode };
  if (mode === 'time') {
    entry.sec = input.seconds == null ? 30 : int(input.seconds, 1, 3600, 'seconds');
  } else if (mode === 'cardio') {
    entry.min = input.minutes == null ? 20 : int(input.minutes, 1, 600, 'minutes');
    entry.speed = input.speed == null ? 8 : num(input.speed, 0, 100, 'speed');
    if (input.incline != null) {
      const incline = cleanIncline(input.incline, meta);
      if (incline) entry.incline = incline;
    }
  } else {
    entry.reps = input.reps == null ? 8 : int(input.reps, 1, 100, 'reps');
    const min = input.reps_min == null ? entry.reps : int(input.reps_min, 1, 100, 'reps_min');
    if (min > entry.reps) fail('reps_min 不能大于 reps');
    if (min !== entry.reps) entry.repsMin = min;
    entry.weight = input.weight == null ? 0 : num(input.weight, 0, 1000, 'weight');
  }
  if (input.rest_sec != null) entry.restSec = int(input.rest_sec, 0, 900, 'rest_sec');
  if (input.note != null) entry.note = text(String(input.note), 800, 'note');
  if (mode !== 'cardio') {
    if (input.side != null) entry.side = bool(input.side, 'side');
    if (input.bodyweight != null) entry.bodyweight = bool(input.bodyweight, 'bodyweight');
    else if (meta.is_bodyweight) entry.bodyweight = true;
    if (input.assisted != null) entry.assisted = bool(input.assisted, 'assisted');
    else if (meta.is_assisted) entry.assisted = true;
    if (input.db_load != null) entry.dbLoad = oneOf(input.db_load, ['each', 'total'], 'db_load');
  }
  applyAdvanced(entry, input);
  ensureRepRange(entry);
  return entry;
}

function patchEntry(S, old, patch) {
  if (!isObj(patch)) fail('patch 必须是对象');
  for (const key of Object.keys(patch)) if (!INPUT_KEYS.includes(key)) fail(`patch 里不认识字段 ${key}`);
  const next = { ...old };
  const meta = describe(S, old.id);
  const clearCardio = () => { delete next.min; delete next.speed; delete next.incline; };
  if (patch.sets != null) next.sets = int(patch.sets, 1, 20, 'sets');
  if (patch.mode != null) {
    oneOf(patch.mode, ['reps', 'time', 'cardio'], 'mode');
    next.mode = patch.mode;
    if (patch.mode === 'time') {
      delete next.reps; delete next.repsMin; delete next.weight; clearCardio();
      delete next.pyramid; delete next.pyramidWeight; delete next.pyramidRest;
    } else if (patch.mode === 'cardio') {
      delete next.reps; delete next.repsMin; delete next.weight; delete next.sec;
      delete next.pyramid; delete next.pyramidWeight; delete next.pyramidRest;
      if (next.min == null) next.min = 20;
      if (next.speed == null) next.speed = 8;
    } else {
      delete next.sec; clearCardio();
      if (next.reps == null) next.reps = 8;
    }
  }
  if (patch.seconds != null) {
    next.mode = 'time'; next.sec = int(patch.seconds, 1, 3600, 'seconds');
    delete next.reps; delete next.repsMin; delete next.weight; clearCardio();
    delete next.pyramid; delete next.pyramidWeight; delete next.pyramidRest;
  }
  if (patch.minutes != null) {
    next.mode = 'cardio';
    next.min = int(patch.minutes, 1, 600, 'minutes');
    delete next.reps; delete next.repsMin; delete next.weight; delete next.sec;
    delete next.pyramid; delete next.pyramidWeight; delete next.pyramidRest;
    if (next.speed == null) next.speed = 8;
  }
  if (patch.speed != null) {
    next.mode = 'cardio';
    next.speed = num(patch.speed, 0, 100, 'speed');
    delete next.reps; delete next.repsMin; delete next.weight; delete next.sec;
    if (next.min == null) next.min = 20;
  }
  if (patch.incline != null) {
    if (next.mode !== 'cardio') fail('incline 只能用在有氧动作上（mode="cardio"）');
    const incline = cleanIncline(patch.incline, meta);
    if (incline) next.incline = incline; else delete next.incline;
  }
  if (patch.reps != null) {
    if (next.mode !== 'reps') fail('只有 reps 动作能设置 reps；请先把 mode 改为 reps');
    next.reps = int(patch.reps, 1, 100, 'reps');
  }
  if (patch.reps_min != null) {
    if (next.mode !== 'reps') fail('只有 reps 动作能设置 reps_min');
    next.repsMin = int(patch.reps_min, 1, 100, 'reps_min');
  }
  if (next.mode === 'reps' && next.repsMin != null && next.reps != null && next.repsMin > next.reps) {
    fail('reps_min 不能大于 reps');
  }
  if (patch.weight != null) {
    if (next.mode !== 'reps') fail('只有 reps 动作能设置 weight');
    next.weight = num(patch.weight, 0, 1000, 'weight');
  }
  if (patch.rest_sec != null) next.restSec = int(patch.rest_sec, 0, 900, 'rest_sec');
  if (patch.note != null) next.note = patch.note === '' ? undefined : text(String(patch.note), 800, 'note');
  if (patch.side != null) next.side = bool(patch.side, 'side');
  if (patch.bodyweight != null) next.bodyweight = bool(patch.bodyweight, 'bodyweight');
  if (patch.assisted != null) next.assisted = bool(patch.assisted, 'assisted');
  if (patch.db_load != null) next.dbLoad = oneOf(patch.db_load, ['each', 'total'], 'db_load');
  applyAdvanced(next, patch);
  ensureRepRange(next);
  if (next.note === undefined) delete next.note;
  return next;
}

function entryLabel(S, entry) {
  const meta = describe(S, entry.id);
  const bits = [];
  if (Array.isArray(entry.pyramid) && entry.pyramid.length) {
    const plan = entry.pyramid
      .map((value, i) => {
        const weight = Array.isArray(entry.pyramidWeight) ? Number(entry.pyramidWeight[i]) || 0 : 0;
        const reps = value === PYRAMID_MAX ? 'Max' : value;
        return weight > 0 ? `${reps}@${weight}` : String(reps);
      })
      .join('·');
    bits.push(`金字塔 ${plan}`);
  } else if (entry.mode === 'cardio') {
    bits.push(`${entry.sets ?? 1}×${entry.min ?? 20}分钟 @ ${entry.speed ?? 8}${entry.incline ? ` · 坡度${entry.incline}%` : ''}`);
  } else if (entry.mode === 'time') {
    bits.push(`${entry.sets}×${entry.sec}s`);
  } else {
    const reps = entry.repsMin && entry.repsMin !== entry.reps ? `${entry.repsMin}–${entry.reps}` : `${entry.reps}`;
    bits.push(`${entry.sets}×${reps}${entry.weight ? ` @${entry.weight}${S.unit || 'kg'}` : ''}`);
  }
  if (entry.warmupSets) bits.push(`热身${entry.warmupSets}组`);
  if (entry.intensifier?.type === 'dropset') bits.push(`递减${entry.intensifier.count}次/${entry.intensifier.pct}%`);
  if (entry.intensifier?.type === 'restpause') bits.push(`休息暂停共${entry.intensifier.totalReps}次`);
  if (entry.lastToFailure) bits.push('末组力竭');
  if (entry.backoff) bits.push('退让组');
  return `${meta.name} ${bits.join('，')}`;
}

function newId(prefix = 'gpt') {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

/* Apply every action to a deep copy. Returns {state, changes, touched}. */
export function applyActions(S, actions) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 30) {
    fail('actions 必须是 1–30 条修改');
  }
  const next = structuredClone(S);
  if (!Array.isArray(next.routines)) next.routines = [];
  if (!isObj(next.week)) next.week = {};
  if (!isObj(next.dayPlan)) next.dayPlan = {};
  if (!Array.isArray(next.bodyweight)) next.bodyweight = [];
  const changes = [];
  const touched = new Set();
  const note = message => changes.push(message);

  for (const [i, action] of actions.entries()) {
    if (!isObj(action) || typeof action.type !== 'string') fail(`第 ${i + 1} 条 action 缺少 type`);
    const type = action.type;

    if (type === 'create_routine') {
      const name = text(action.name, 60, 'name');
      if (next.routines.some(r => r.id === action.routine_id)) fail('routine_id 已存在');
      if (!Array.isArray(action.exercises) || action.exercises.length < 1 || action.exercises.length > 12) {
        fail('create_routine 需要 1–12 个 exercises');
      }
      const id = typeof action.routine_id === 'string' && action.routine_id
        ? text(action.routine_id, 64, 'routine_id') : newId('gpt');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) fail('routine_id 只能包含字母数字、下划线和连字符');
      const seen = new Set();
      const ex = action.exercises.map(item => {
        const entry = buildEntry(next, item);
        if (seen.has(entry.id)) fail(`同一个模板不能重复放入动作 ${entry.id}`);
        seen.add(entry.id);
        return entry;
      });
      const routine = { id, name, emoji: action.emoji ? text(action.emoji, 32, 'emoji') : 'figureStrength',
        prog: action.progression ? oneOf(action.progression, [...POLICIES], 'progression') : 'off', ex };
      next.routines.push(routine);
      note(`新建模板「${name}」：${ex.map(e => entryLabel(next, e)).join('；')}`);
      const days = Array.isArray(action.weekdays) ? action.weekdays : [];
      if (days.length) {
        for (const day of days) {
          const wd = int(day, 0, 6, 'weekdays');
          next.week[wd] = id;
          note(`把「${name}」放到${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][wd]}`);
        }
      }
      touched.add(id);
      continue;
    }

    if (type === 'update_routine') {
      const routine = routineOf(next, action.routine_id);
      const before = routine.name;
      if (action.name != null) routine.name = text(action.name, 60, 'name');
      if (action.emoji != null) routine.emoji = text(action.emoji, 32, 'emoji');
      if (action.progression != null) routine.prog = oneOf(action.progression, [...POLICIES], 'progression');
      note(`更新模板：${before}${routine.name !== before ? ` → ${routine.name}` : ''}`);
      touched.add(routine.id);
      continue;
    }

    if (type === 'delete_routine') {
      const routine = routineOf(next, action.routine_id);
      next.routines = next.routines.filter(r => r.id !== routine.id);
      for (const [day, value] of Object.entries(next.week)) {
        const ids = [].concat(value ?? []).filter(id => id !== routine.id);
        if (ids.length) next.week[day] = ids.length === 1 ? ids[0] : ids;
        else delete next.week[day];
      }
      for (const [date, value] of Object.entries(next.dayPlan)) {
        if ([].concat(value ?? []).includes(routine.id)) delete next.dayPlan[date];
      }
      note(`删除模板「${routine.name}」及其排期`);
      touched.add(routine.id);
      continue;
    }

    if (type === 'set_exercise') {
      const routine = routineOf(next, action.routine_id);
      const index = int(action.index, 0, Math.max(0, routine.ex.length - 1), 'index');
      const old = routine.ex[index];
      if (!old) fail('index 超出该模板的动作范围');
      const before = entryLabel(next, old);
      routine.ex[index] = patchEntry(next, old, action.patch || {});
      note(`改「${routine.name}」第 ${index + 1} 个动作：${before} → ${entryLabel(next, routine.ex[index])}`);
      touched.add(routine.id);
      continue;
    }

    if (type === 'add_exercise') {
      const routine = routineOf(next, action.routine_id);
      if (routine.ex.length >= 12) fail('一个模板最多 12 个动作');
      const entry = buildEntry(next, action.exercise);
      if (routine.ex.some(e => e.id === entry.id)) fail(`模板里已有动作 ${entry.id}`);
      const index = action.index == null ? routine.ex.length : int(action.index, 0, routine.ex.length, 'index');
      routine.ex.splice(index, 0, entry);
      note(`给「${routine.name}」加动作：${entryLabel(next, entry)}（第 ${index + 1} 位）`);
      touched.add(routine.id);
      continue;
    }

    if (type === 'remove_exercise') {
      const routine = routineOf(next, action.routine_id);
      if (routine.ex.length <= 1) fail('模板至少要保留 1 个动作；不需要它请用 delete_routine');
      const index = int(action.index, 0, routine.ex.length - 1, 'index');
      const [removed] = routine.ex.splice(index, 1);
      note(`从「${routine.name}」移除动作：${entryLabel(next, removed)}`);
      touched.add(routine.id);
      continue;
    }

    if (type === 'move_exercise') {
      const routine = routineOf(next, action.routine_id);
      const from = int(action.index, 0, routine.ex.length - 1, 'index');
      const to = int(action.to_index, 0, routine.ex.length - 1, 'to_index');
      const [entry] = routine.ex.splice(from, 1);
      routine.ex.splice(to, 0, entry);
      note(`调整「${routine.name}」动作顺序：${entryLabel(next, entry)} 移到第 ${to + 1} 位`);
      touched.add(routine.id);
      continue;
    }

    if (type === 'replace_exercise') {
      const routine = routineOf(next, action.routine_id);
      const index = int(action.index, 0, routine.ex.length - 1, 'index');
      const entry = buildEntry(next, action.exercise);
      if (routine.ex.some((e, j) => j !== index && e.id === entry.id)) fail('替换后会出现重复动作');
      const before = entryLabel(next, routine.ex[index]);
      routine.ex[index] = entry;
      note(`替换「${routine.name}」第 ${index + 1} 个动作：${before} → ${entryLabel(next, entry)}`);
      touched.add(routine.id);
      continue;
    }

    if (type === 'set_superset') {
      const routine = routineOf(next, action.routine_id);
      const indexes = Array.isArray(action.indexes) ? action.indexes.map(n => int(n, 0, routine.ex.length - 1, 'indexes')) : [];
      if (indexes.length < 2 || indexes.length > 4) fail('superset 需要 2–4 个动作下标');
      const id = `sg-${crypto.randomBytes(4).toString('hex')}`;
      const name = action.name ? text(action.name, 60, 'name') : `${indexes.map(i => describe(next, routine.ex[i].id).name).join(' + ')}`;
      const rest = action.rest_sec == null ? 90 : int(action.rest_sec, 0, 900, 'rest_sec');
      for (const idx of indexes) Object.assign(routine.ex[idx], { sg: id, sgName: name, sgRest: rest });
      note(`在「${routine.name}」设置超级组「${name}」：${indexes.map(i => i + 1).join('、')} 号动作`);
      touched.add(routine.id);
      continue;
    }

    if (type === 'clear_superset') {
      const routine = routineOf(next, action.routine_id);
      const indexes = Array.isArray(action.indexes) ? action.indexes.map(n => int(n, 0, routine.ex.length - 1, 'indexes')) : [];
      for (const idx of indexes) {
        delete routine.ex[idx].sg; delete routine.ex[idx].sgName; delete routine.ex[idx].sgRest;
      }
      note(`取消「${routine.name}」的超级组`);
      touched.add(routine.id);
      continue;
    }

    if (type === 'assign_weekday') {
      const wd = int(action.weekday, 0, 6, 'weekday');
      const dayName = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][wd];
      if (action.routine_id == null) {
        delete next.week[wd];
        note(`清空${dayName}的固定安排`);
      } else {
        const routine = routineOf(next, action.routine_id);
        next.week[wd] = routine.id;
        note(`${dayName}固定为「${routine.name}」`);
      }
      continue;
    }

    if (type === 'override_date') {
      const date = isoDate(action.date);
      if (action.routine_id == null) {
        delete next.dayPlan[date];
        note(`清除 ${date} 的单日覆盖`);
      } else if (action.routine_id === 'rest') {
        next.dayPlan[date] = 'rest';
        note(`${date} 设为休息日`);
      } else {
        const routine = routineOf(next, action.routine_id);
        next.dayPlan[date] = routine.id;
        note(`${date} 改为「${routine.name}」`);
      }
      continue;
    }

    if (type === 'set_progression') {
      const routine = routineOf(next, action.routine_id);
      routine.prog = oneOf(action.progression, [...POLICIES], 'progression');
      note(`「${routine.name}」的渐进策略改为 ${routine.prog}`);
      touched.add(routine.id);
      continue;
    }

    if (type === 'add_bodyweight') {
      const date = action.date ? isoDate(action.date) : todayIso();
      const weight = num(action.weight, 1, 1000, 'weight');
      next.bodyweight = next.bodyweight.filter(x => x && x.d !== date);
      next.bodyweight.push({ d: date, w: weight });
      next.bodyweight.sort((a, b) => String(a.d).localeCompare(String(b.d)));
      note(`记录体重：${date} ${weight}${next.unit || 'kg'}`);
      continue;
    }

    if (type === 'log_measurement') {
      const date = action.date ? isoDate(action.date) : todayIso();
      const values = action.values;
      if (!isObj(values) || !Object.keys(values).length) fail('log_measurement 需要 values 对象，例如 {"waist": 82}');
      if (!Array.isArray(next.customMeasurements)) next.customMeasurements = [];
      if (!Array.isArray(next.measurements)) next.measurements = [];
      if (!Array.isArray(next.measurementEnabled) || !next.measurementEnabled.length) {
        next.measurementEnabled = [...DEFAULT_MEASUREMENT_KEYS];
      }
      for (const key of Object.keys(values)) {
        if (!MEASUREMENT_KEYS.includes(key) && key !== 'other' && key !== 'custom') {
          fail(`不认识的测量字段 ${key}；可用：${MEASUREMENT_KEYS.join(' / ')} / custom`);
        }
      }
      const customPairs = [];
      if (values.custom != null) {
        if (!isObj(values.custom)) fail('values.custom 必须是 {名称: 数值}');
        for (const [name, value] of Object.entries(values.custom)) {
          const clean = String(name).trim();
          if (!clean) fail('custom 名称不能为空');
          let def = next.customMeasurements.find(c => String(c.name) === clean || String(c.id) === clean);
          if (!def) {
            def = { id: `c-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`, name: clean.slice(0, 60), enabled: true };
            next.customMeasurements.push(def);
            note(`新增自定义测量项「${def.name}」`);
          }
          customPairs.push({ id: String(def.id), name: def.name, value: num(value, 0, 1000, `custom.${clean}`) });
        }
      }
      if (values.other != null) {
        if (!Array.isArray(values.other)) fail('values.other 必须是数组');
        for (const item of values.other) {
          if (!isObj(item)) fail('values.other 的每一项必须是对象');
          const key = String(item.id ?? item.name ?? '').trim();
          if (!key) fail('values.other 需要 id 或 name');
          let def = next.customMeasurements.find(c => String(c.id) === key || String(c.name) === key);
          if (!def) {
            def = { id: `c-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`, name: key.slice(0, 60), enabled: true };
            next.customMeasurements.push(def);
            note(`新增自定义测量项「${def.name}」`);
          }
          customPairs.push({ id: String(def.id), name: def.name, value: num(item.value, 0, 1000, `other.${def.name}`) });
        }
      }

      let entry = next.measurements.find(e => e && e.d === date);
      if (!entry) {
        entry = { d: date, t: Date.now(), other: [] };
        for (const key of MEASUREMENT_KEYS) entry[key] = null;
        next.measurements.push(entry);
      }
      const parts = [];
      for (const key of MEASUREMENT_KEYS) {
        if (values[key] == null) continue;
        const v = num(values[key], 0, key === 'bodyFat' ? 100 : 1000, key);
        entry[key] = Math.round(v * 10) / 10;
        parts.push(`${key}=${entry[key]}`);
      }
      for (const pair of customPairs) {
        if (!Array.isArray(entry.other)) entry.other = [];
        const existing = entry.other.find(o => String(o?.id) === pair.id);
        const rounded = Math.round(pair.value * 10) / 10;
        if (existing) existing.value = rounded;
        else entry.other.push({ id: pair.id, name: pair.name, value: rounded });
        parts.push(`${pair.name}=${rounded}`);
      }
      if (!parts.length) fail('log_measurement 没有给出任何数值');
      entry.t = Date.now();
      next.measurements.sort((a, b) => String(a.d).localeCompare(String(b.d)));
      note(`记录体测：${date} ${parts.join('，')}（围度单位 cm，体脂 %）`);
      continue;
    }

    if (type === 'set_measurement_fields') {
      if (!Array.isArray(next.customMeasurements)) next.customMeasurements = [];
      if (!Array.isArray(next.measurementEnabled) || !next.measurementEnabled.length) {
        next.measurementEnabled = [...DEFAULT_MEASUREMENT_KEYS];
      }
      if (action.enable != null) {
        if (!Array.isArray(action.enable)) fail('enable 必须是字段名数组');
        for (const key of action.enable) {
          oneOf(String(key), MEASUREMENT_KEYS, 'enable');
          if (!next.measurementEnabled.includes(String(key))) next.measurementEnabled.push(String(key));
          note(`开启测量项 ${key}`);
        }
      }
      if (action.disable != null) {
        if (!Array.isArray(action.disable)) fail('disable 必须是字段名数组');
        for (const key of action.disable) {
          oneOf(String(key), MEASUREMENT_KEYS, 'disable');
          next.measurementEnabled = next.measurementEnabled.filter(k => k !== String(key));
          note(`关闭测量项 ${key}`);
        }
      }
      if (action.custom != null) {
        if (!Array.isArray(action.custom)) fail('custom 必须是数组');
        for (const item of action.custom) {
          if (!isObj(item)) fail('custom 每一项必须是对象');
          const name = text(String(item.name ?? ''), 60, 'custom.name');
          const found = next.customMeasurements.find(c => String(c.name) === name || (item.id && String(c.id) === String(item.id)));
          if (found) {
            found.name = name;
            if (item.enabled != null) found.enabled = bool(item.enabled, 'custom.enabled');
            note(`更新自定义测量项「${name}」`);
          } else {
            next.customMeasurements.push({ id: `c-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`, name, enabled: item.enabled == null ? true : bool(item.enabled, 'custom.enabled') });
            note(`新增自定义测量项「${name}」`);
          }
        }
      }
      if (action.disable_custom != null) {
        if (!Array.isArray(action.disable_custom)) fail('disable_custom 必须是数组');
        for (const key of action.disable_custom) {
          const found = next.customMeasurements.find(c => String(c.id) === String(key) || String(c.name) === String(key));
          if (!found) fail(`找不到自定义测量项 ${key}`);
          found.enabled = false;
          note(`停用自定义测量项「${found.name}」`);
        }
      }
      continue;
    }

    fail(`不支持的修改类型 ${type}`);
  }

  if (!changes.length) fail('所有内容与当前计划相同，没有需要写入的修改');
  return { state: next, changes, touched: [...touched] };
}

/* ---------- proposals ---------- */

function backup(state) {
  fs.mkdirSync(config.backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(config.backupsDir, `state-${uid()}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(state));
  const files = fs.readdirSync(config.backupsDir)
    .filter(f => f.startsWith(`state-${uid()}-`) && f.endsWith('.json'))
    .sort();
  for (const old of files.slice(0, Math.max(0, files.length - config.backupKeep))) {
    try { fs.rmSync(path.join(config.backupsDir, old), { force: true }); } catch {}
  }
  return file;
}

export function createProposal(S, actions) {
  const { state, changes, touched } = applyActions(S, actions);
  const id = crypto.randomUUID();
  const expires = Date.now() + config.proposalTtlMs;
  proposals.set(id, { id, state, changes, touched, baseRev: S._rev || 0, baseWid: S._wid || null, expires });
  for (const [key, value] of proposals) if (value.expires < Date.now()) proposals.delete(key);
  return {
    proposal_id: id,
    expires_in_seconds: Math.round(config.proposalTtlMs / 1000),
    base_rev: S._rev || 0,
    changes,
    touched_routines: touched.map(rid => ({ routine_id: rid, name: routineName(S, rid) })),
    plan_after: (() => {
      const view = planView(state);
      const keep = new Set(touched);
      return { ...view, routines: view.routines.filter(r => keep.has(r.routine_id)) };
    })(),
    next_step: '把 changes 原样给用户看，并问是否写入。用户明确同意后，调用 plan_apply，confirmation 固定为「确认写入」。',
  };
}

export async function commitProposal(id, confirmation) {
  if (confirmation !== '确认写入') fail('confirmation 必须是「确认写入」；请先让用户看过预览并明确同意', 'confirmation');
  const proposal = proposals.get(id);
  if (!proposal) fail('proposal_id 不存在或已过期；请重新调用 plan_preview', 'expired');
  if (proposal.expires < Date.now()) { proposals.delete(id); fail('预览已过期（15 分钟）；请重新预览', 'expired'); }

  const current = readState({ fresh: true });
  if (!current) fail('当前没有可写的训练状态');
  const rev = current._rev || 0;
  const wid = current._wid || null;
  if (rev !== proposal.baseRev || (proposal.baseWid && wid && wid !== proposal.baseWid)) {
    fail(`计划在你预览后已被修改（rev ${proposal.baseRev} → ${rev}）；请重新 get_plan 后再次预览`, 'conflict');
  }

  const backupFile = backup(current);
  let result;
  try {
    result = await putState(proposal.state, { baseRev: rev, baseWid: wid });
  } catch (e) {
    if (e.status === 409) fail('openGym 返回冲突：另一个设备刚写入过；请重新预览', 'conflict');
    throw e;
  }
  proposals.delete(id);
  invalidate();
  const after = readState({ fresh: true });
  return {
    ok: true,
    rev: result.rev ?? after?._rev ?? null,
    backup: path.basename(backupFile),
    changes: proposal.changes,
    message: '已写入 openGym。打开或刷新 App 就能看到新计划；训练数据未改动。',
  };
}

export function proposalCount() { return proposals.size; }
