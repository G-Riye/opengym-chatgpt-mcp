/* Plan editing: validate a list of changes, show a diff, then write the whole
   document back through PUT /api/data with the revision it was based on.
   A proposal is short-lived and in-memory; a restart simply asks the model to
   preview again. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, stateFile } from './config.mjs';
import { uid, putState } from './opengym.mjs';
import { readState, invalidate, planView, routineName, routinesOf, todayIso } from './state.mjs';
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

function routineOf(S, id) {
  const routine = routinesOf(S).find(r => r.id === id);
  if (!routine) fail(`找不到训练模板 ${id}；请先调用 get_plan 获取有效 routine_id`, 'not_found');
  return routine;
}

function exerciseMeta(S, rawId) {
  const id = canonicalId(rawId);
  if (!lookup(id) && !(Array.isArray(S.customEx) && S.customEx.some(e => e.id === id))) {
    fail(`动作 ID ${rawId} 不在 openGym 动作库里；请先用 search_exercises 查有效 ID`);
  }
  if (isCardio(id)) fail(`「${describe(S, id).name}」是有氧动作，请在 openGym 里记录；计划只支持力量/计时动作`);
  return describe(S, id);
}

const STORE_KEYS = ['sets', 'mode', 'reps', 'repsMin', 'sec', 'weight', 'restSec', 'note', 'side', 'bodyweight', 'assisted', 'dbLoad'];
const INPUT_KEYS = ['sets', 'mode', 'reps', 'reps_min', 'seconds', 'weight', 'rest_sec', 'note', 'side', 'bodyweight', 'assisted', 'db_load'];

function buildEntry(S, input) {
  if (!isObj(input)) fail('exercise 必须是对象');
  for (const key of Object.keys(input)) {
    if (key !== 'exercise_id' && !INPUT_KEYS.includes(key)) fail(`exercise 里不认识字段 ${key}`);
  }
  if (!input.exercise_id) fail('exercise 缺少 exercise_id');
  const meta = exerciseMeta(S, input.exercise_id);
  const mode = input.mode === 'time' || input.seconds != null ? 'time' : 'reps';
  const sets = input.sets == null ? 3 : int(input.sets, 1, 20, 'sets');
  const entry = { id: meta.exercise_id, sets, mode };
  if (mode === 'time') {
    entry.sec = input.seconds == null ? 30 : int(input.seconds, 1, 3600, 'seconds');
  } else {
    entry.reps = input.reps == null ? 8 : int(input.reps, 1, 100, 'reps');
    const min = input.reps_min == null ? entry.reps : int(input.reps_min, 1, 100, 'reps_min');
    if (min > entry.reps) fail('reps_min 不能大于 reps');
    if (min !== entry.reps) entry.repsMin = min;
    entry.weight = input.weight == null ? 0 : num(input.weight, 0, 1000, 'weight');
  }
  if (input.rest_sec != null) entry.restSec = int(input.rest_sec, 0, 900, 'rest_sec');
  if (input.note != null) entry.note = text(String(input.note), 800, 'note');
  if (input.side != null) entry.side = bool(input.side, 'side');
  if (input.bodyweight != null) entry.bodyweight = bool(input.bodyweight, 'bodyweight');
  else if (meta.is_bodyweight) entry.bodyweight = true;
  if (input.assisted != null) entry.assisted = bool(input.assisted, 'assisted');
  else if (meta.is_assisted) entry.assisted = true;
  if (input.db_load != null) entry.dbLoad = oneOf(input.db_load, ['each', 'total'], 'db_load');
  return entry;
}

function patchEntry(S, old, patch) {
  if (!isObj(patch)) fail('patch 必须是对象');
  for (const key of Object.keys(patch)) if (!INPUT_KEYS.includes(key)) fail(`patch 里不认识字段 ${key}`);
  const next = { ...old };
  if (patch.sets != null) next.sets = int(patch.sets, 1, 20, 'sets');
  if (patch.mode != null) {
    oneOf(patch.mode, ['reps', 'time'], 'mode');
    next.mode = patch.mode;
    if (patch.mode === 'time') { delete next.reps; delete next.repsMin; delete next.weight; }
    else { delete next.sec; if (next.reps == null) next.reps = 8; }
  }
  if (patch.seconds != null) {
    next.mode = 'time'; next.sec = int(patch.seconds, 1, 3600, 'seconds');
    delete next.reps; delete next.repsMin; delete next.weight;
  }
  if (patch.reps != null) {
    if (next.mode === 'time') fail('计时动作不能设置 reps；请先把 mode 改为 reps');
    next.reps = int(patch.reps, 1, 100, 'reps');
  }
  if (patch.reps_min != null) {
    if (next.mode === 'time') fail('计时动作不能设置 reps_min');
    next.repsMin = int(patch.reps_min, 1, 100, 'reps_min');
  }
  if (next.mode !== 'time' && next.repsMin != null && next.reps != null && next.repsMin > next.reps) {
    fail('reps_min 不能大于 reps');
  }
  if (patch.weight != null) {
    if (next.mode === 'time') fail('计时动作不能设置 weight');
    next.weight = num(patch.weight, 0, 1000, 'weight');
  }
  if (patch.rest_sec != null) next.restSec = int(patch.rest_sec, 0, 900, 'rest_sec');
  if (patch.note != null) next.note = patch.note === '' ? undefined : text(String(patch.note), 800, 'note');
  if (patch.side != null) next.side = bool(patch.side, 'side');
  if (patch.bodyweight != null) next.bodyweight = bool(patch.bodyweight, 'bodyweight');
  if (patch.assisted != null) next.assisted = bool(patch.assisted, 'assisted');
  if (patch.db_load != null) next.dbLoad = oneOf(patch.db_load, ['each', 'total'], 'db_load');
  if (next.note === undefined) delete next.note;
  return next;
}

function entryLabel(S, entry) {
  const meta = describe(S, entry.id);
  if (entry.mode === 'time') return `${meta.name} ${entry.sets}×${entry.sec}s`;
  const reps = entry.repsMin && entry.repsMin !== entry.reps ? `${entry.repsMin}–${entry.reps}` : `${entry.reps}`;
  return `${meta.name} ${entry.sets}×${reps}${entry.weight ? ` @${entry.weight}${S.unit || 'kg'}` : ''}`;
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
