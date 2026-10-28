/* Weekly training volume per muscle, computed with the official frontend maths:
   muscles.loadOfWorkouts weights every completed set by its primary/secondary share
   (warm-ups excluded), exactly like the App's Muscle balance screen. */
import { addDays, todayIso, sortedWorkouts, workoutStart, isoOf } from './state.mjs';
import { loadOfWorkouts, levelsOf, rankOf, MUSCLES, MUSCLE_NAME } from '../../frontend/src/lib/muscles.js';
import zh from '../../frontend/src/locales/zh.js';

const ZH = zh?.default || zh || {};
const round = n => Math.round((Number(n) || 0) * 10) / 10;

function workoutDate(w) {
  return w?.d || (workoutStart(w) ? isoOf(new Date(workoutStart(w))) : '');
}

export function muscleBalance(S, { days = 7, since, until } = {}) {
  const span = Math.max(1, Math.min(365, Number(days) || 7));
  const end = until || todayIso();
  const start = since || addDays(end, -(span - 1));
  const workouts = sortedWorkouts(S).filter(w => {
    const d = workoutDate(w);
    return d && d >= start && d <= end;
  });
  const load = loadOfWorkouts(workouts);
  const levels = levelsOf(load);
  const rank = rankOf(load);
  const weekFactor = 7 / span;
  const muscles = MUSCLES
    .map(slug => {
      const label = MUSCLE_NAME[slug] || slug;
      const sets = Number(load[slug]) || 0;
      return {
        muscle: slug,
        name: label,
        name_zh: ZH[label] || label,
        sets: round(sets),
        weekly_sets: round(sets * weekFactor),
        level: levels[slug] ?? 0,
        worked: (rank.worked || []).includes(slug),
      };
    })
    .filter(m => m.sets > 0)
    .sort((a, b) => b.weekly_sets - a.weekly_sets);
  const total = round(muscles.reduce((n, m) => n + m.sets, 0));
  return {
    window: { since: start, until: end, days: span },
    workouts: workouts.length,
    workouts_detail: workouts.map(w => ({ date: w.d || null, name: w.name || null })),
    unit: 'effective sets (primary 1, secondary 0.5, warm-ups excluded)',
    total_effective_sets: total,
    muscles,
    missed: (rank.missed || []).map(slug => ({ muscle: slug, name: MUSCLE_NAME[slug] || slug, name_zh: ZH[MUSCLE_NAME[slug]] || MUSCLE_NAME[slug] || slug })),
    levels_scale: '0 = not trained, 1–4 = increasing weekly volume (official muscles.levelsOf thresholds)',
    note: '和 App「肌群训练量」一致：只统计已打勾的正式组，热身组不计；单侧动作按一次计。',
  };
}
