/* Exercise catalogue: the same 1,324 built-ins the app ships, plus the
   profile's custom exercises. Read-only and Node-safe. */
import { EXDB, EXALIAS } from '../../frontend/src/lib/exercises-data.js';

const INDEX = new Map(EXDB.map(e => [e.id, e]));
const ALIAS = EXALIAS && typeof EXALIAS === 'object' ? EXALIAS : {};
const BODYWEIGHT_EQ = new Set(['body weight', 'band', 'resistance band']);

/* Chinese → English terms, so 卧推 / 深蹲 / 引体向上 find the built-in names
   (the upstream catalogue is English-only). Custom exercises are matched by
   their own Chinese names directly. */
const ZH = {
  '卧推': 'bench press', '平板卧推': 'bench press', '上斜卧推': 'incline bench press',
  '哑铃卧推': 'dumbbell bench press', '深蹲': 'squat', '颈前深蹲': 'front squat',
  '高脚杯深蹲': 'goblet squat', '保加利亚': 'bulgarian split squat', '箭步蹲': 'lunge',
  '硬拉': 'deadlift', '罗马尼亚硬拉': 'romanian deadlift', '相扑硬拉': 'sumo deadlift',
  '引体向上': 'pull up', '引体': 'pull up', '反手引体': 'chin up', '高位下拉': 'lat pulldown',
  '划船': 'row', '杠铃划船': 'barbell row', '哑铃划船': 'dumbbell row', '坐姿划船': 'seated row',
  '肩推': 'shoulder press', '推举': 'overhead press', '坐姿推举': 'seated shoulder press',
  '侧平举': 'lateral raise', '前平举': 'front raise', '俯身飞鸟': 'reverse fly',
  '飞鸟': 'fly', '夹胸': 'cable crossover', '绳索夹胸': 'cable crossover',
  '弯举': 'curl', '杠铃弯举': 'barbell curl', '哑铃弯举': 'dumbbell curl', '锤式弯举': 'hammer curl',
  '臂屈伸': 'extension', '三头下压': 'triceps pushdown', '窄距卧推': 'close grip bench press',
  '双杠臂屈伸': 'dip', '俯卧撑': 'push up', '钻石俯卧撑': 'diamond push up',
  '腿举': 'leg press', '腿屈伸': 'leg extension', '腿弯举': 'leg curl',
  '臀推': 'hip thrust', '臀桥': 'glute bridge', '罗马椅': 'hyperextension', '山羊挺身': 'hyperextension',
  '提踵': 'calf raise', '站姿提踵': 'standing calf raise', '坐姿提踵': 'seated calf raise',
  '平板支撑': 'plank', '侧平板': 'side plank', '卷腹': 'crunch', '仰卧起坐': 'sit up',
  '悬垂举腿': 'hanging leg raise', '举腿': 'leg raise', '俄罗斯转体': 'russian twist',
  '绳索下压': 'pushdown', '面拉': 'face pull', '耸肩': 'shrug', '农夫行走': 'farmer',
  '壶铃摆荡': 'kettlebell swing', '波比跳': 'burpee', '开合跳': 'jumping jack',
  '划船机': 'rowing machine', '跑步机': 'treadmill', '椭圆机': 'elliptical', '单车': 'bike',
  '跳绳': 'jump rope', '爬楼': 'stair', '高抬腿': 'high knees', '臀外展': 'hip abduction',
  '内收': 'adduction', '胸': 'chest', '背': 'back', '腿': 'legs', '肩': 'shoulders', '手臂': 'arms',
};

const norm = s => String(s || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

export function canonicalId(id) {
  return typeof id === 'string' && ALIAS[id] && INDEX.has(ALIAS[id]) ? ALIAS[id] : id;
}

export function lookup(id) {
  return INDEX.get(canonicalId(id)) || null;
}

export function isCardio(id) {
  const ex = lookup(id);
  return !!ex && ex.bp === 'cardio';
}

export function isBodyweight(id) {
  const ex = lookup(id);
  return !!ex && BODYWEIGHT_EQ.has(ex.eq);
}

export function isAssisted(id) {
  const ex = lookup(id);
  return !!ex && ex.eq === 'leverage machine' && /\bassist(ed)?\b/i.test(String(ex.n || ''));
}

export function customList(S) {
  return Array.isArray(S?.customEx) ? S.customEx.filter(e => e && typeof e.id === 'string') : [];
}

export function nameOf(S, id) {
  const cid = canonicalId(id);
  const custom = customList(S).find(e => e.id === id || e.id === cid);
  return custom?.n || INDEX.get(cid)?.n || String(id || '未知动作');
}

export function describe(S, id) {
  const cid = canonicalId(id);
  const custom = customList(S).find(e => e.id === id || e.id === cid);
  if (custom) {
    return {
      exercise_id: custom.id, name: custom.n, body_part: custom.bp || null,
      equipment: custom.eq || null, category: custom.cat || 'custom',
      target: custom.tg || null, secondary: Array.isArray(custom.sm) ? custom.sm : [],
      is_bodyweight: !!custom.bodyweight || custom.eq === 'body weight',
      is_assisted: !!custom.assisted, custom: true,
    };
  }
  const ex = INDEX.get(cid);
  if (!ex) return { exercise_id: id, name: String(id), unknown: true };
  return {
    exercise_id: ex.id, name: ex.n, body_part: ex.bp || null, equipment: ex.eq || null,
    category: ex.cat || null, target: ex.tg || null,
    secondary: Array.isArray(ex.sm) ? ex.sm : [],
    is_bodyweight: BODYWEIGHT_EQ.has(ex.eq), is_assisted: isAssisted(ex.id), custom: false,
  };
}

function score(ex, q, terms) {
  const name = norm(ex.name);
  const id = String(ex.exercise_id || '');
  let best = 0;
  for (const term of terms) {
    const t = norm(term);
    if (!t) continue;
    if (id === t) best = Math.max(best, 100);
    if (name === t) best = Math.max(best, 95);
    if (name.startsWith(t + ' ')) best = Math.max(best, 85);
    if (name.includes(t)) best = Math.max(best, 70);
    const words = t.split(' ').filter(Boolean);
    if (words.length > 1 && words.every(w => name.includes(w))) best = Math.max(best, 65);
    if (ex.body_part && norm(ex.body_part) === t) best = Math.max(best, 45);
  }
  if (q && norm(name) === norm(q)) best = Math.max(best, 96);
  if (best) {
    // Prefer the plain barbell/dumbbell entry over band, board, "form check"
    // and side-view variants when a Chinese alias expands to a generic term.
    if (/^(barbell|dumbbell|kettlebell|cable) /.test(name)) best += 4;
    if (/band|side pov|form check|against chains|board/.test(name)) best -= 10;
    if (name.split(' ').length <= 4) best += 3;
    if (name.split(' ').length >= 7) best -= 4;
    for (const term of terms) {
      const t = norm(term);
      if (t && name.endsWith(' ' + t)) best += 6;
    }
  }
  return best;
}

export function search(S, query, limit = 20) {
  const q = String(query || '').trim();
  if (!q) throw new Error('query 不能为空；请输入动作名（中英文均可）或动作 ID');
  const n = Math.max(1, Math.min(50, Number(limit) || 20));
  const terms = [q];
  for (const [zh, en] of Object.entries(ZH)) if (q.includes(zh)) terms.push(en);
  const all = [
    ...EXDB.map(e => ({ ...e, name: e.n, body_part: e.bp, equipment: e.eq, category: e.cat,
      target: e.tg, secondary: Array.isArray(e.sm) ? e.sm : [],
      is_bodyweight: BODYWEIGHT_EQ.has(e.eq), is_assisted: e.eq === 'leverage machine' && /\bassist(ed)?\b/i.test(String(e.n || '')),
      exercise_id: e.id })),
    ...customList(S).map(e => ({ ...e, name: e.n, body_part: e.bp, equipment: e.eq, category: 'custom',
      target: e.tg, secondary: Array.isArray(e.sm) ? e.sm : [],
      is_bodyweight: !!e.bodyweight || e.eq === 'body weight', is_assisted: !!e.assisted,
      exercise_id: e.id })),
  ];
  const ranked = all.map(ex => ({ ex, s: score(ex, q, terms) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || String(a.ex.name).localeCompare(String(b.ex.name)))
    .slice(0, n)
    .map(({ ex }) => ({
      exercise_id: ex.exercise_id, name: ex.name, body_part: ex.body_part,
      equipment: ex.equipment, target: ex.target, secondary: ex.secondary,
      category: ex.category, is_bodyweight: !!ex.is_bodyweight,
      is_assisted: !!ex.is_assisted, custom: ex.category === 'custom',
    }));
  return { query: q, count: ranked.length, results: ranked };
}

export function exerciseCount() { return INDEX.size; }
