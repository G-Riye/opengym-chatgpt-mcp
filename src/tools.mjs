/* MCP tool catalogue. Names are stable English; descriptions tell the model the
   exact workflow (read → preview → confirm → apply) and the Chinese
   confirmation string. */
import { config } from './config.mjs';
import { userInfo, me } from './opengym.mjs';
import {
  requireState, readState, planView, upcoming, recent, workoutsBetween,
  exerciseHistory, bodyweightView, getUpdates, pendingUpdates, contextView,
  resetUpdates, todayIso, measurementsView,
} from './state.mjs';
import { search, exerciseCount } from './exercises.mjs';
import { createProposal, commitProposal, proposalCount } from './plan.mjs';
import { VERSION } from './version.mjs';
import { MEASUREMENT_FIELDS } from './state.mjs';

const obj = (properties = {}, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});

const CARDIO_PROPS = {
  minutes: {
    type: 'integer', minimum: 1, maximum: 600,
    description: 'Cardio only: minutes per set. Giving it switches the exercise to mode="cardio".',
  },
  speed: {
    type: 'number', minimum: 0, maximum: 100,
    description: 'Cardio only: speed in the profile speed unit (km/h or mph).',
  },
  incline: {
    type: 'number', minimum: 0, maximum: 40,
    description: 'Cardio only: treadmill grade in percent (half-percent steps); only on walking/running/elliptical style cardio.',
  },
};

/* Fields that only exist because openGym's editor stores them on the routine exercise:
   warm-up ramp, per-set (pyramid) targets, drop-sets / rest-pause, back-off, deload. */
const ADVANCED_PROPS = {
  warmup_sets: {
    type: 'integer', minimum: 0, maximum: 5,
    description: 'Warm-up sets the app inserts before the work sets (openGym max 5). 0 removes them. The app picks the ramp weights itself.',
  },
  warmup_rest_sec: {
    type: 'integer', minimum: 0, maximum: 900,
    description: 'Rest between warm-up sets; 0 falls back to rest_sec.',
  },
  inc: {
    type: 'number', minimum: 0, maximum: 100,
    description: 'Load increment the progression rule adds (kg/lb), e.g. 2.5.',
  },
  deload_factor: {
    type: 'number', enum: [0.8, 0.85, 0.9],
    description: 'Epley deload percentage used when the rule backs off (0.9 is openGym default).',
  },
  backoff: {
    type: 'boolean',
    description: 'Add back-off work after the last work set (steps down by inc).',
  },
  last_to_failure: {
    type: 'boolean',
    description: 'Prescribe the last work set to failure.',
  },
  sets_max: {
    type: 'integer', minimum: 1, maximum: 10,
    description: 'Set ceiling for triple progression (how many sets the rule may climb to).',
  },
  reps_max: {
    type: 'integer', minimum: 1, maximum: 100,
    description: 'Top of the rep range used by double/triple progression; must be >= reps / reps_min.',
  },
  progression: {
    type: 'string', enum: ['off', 'linear', 'greyskull', 'double', 'triple', 'time'],
    description: 'Per-exercise override of the routine progression.',
  },
  intensifier: {
    anyOf: [
      {
        type: 'object', additionalProperties: false, required: ['type'],
        properties: {
          type: { type: 'string', enum: ['dropset'] },
          count: { type: 'integer', minimum: 1, maximum: 10, description: 'How many drops after the work set.' },
          pct: { type: 'number', minimum: 5, maximum: 50, description: 'Percent of the work weight shed per drop.' },
        },
      },
      {
        type: 'object', additionalProperties: false, required: ['type'],
        properties: {
          type: { type: 'string', enum: ['restpause'] },
          total_reps: { type: 'integer', minimum: 1, maximum: 100 },
          rest_sec: { type: 'integer', minimum: 5, maximum: 120 },
        },
      },
      { type: 'null' },
    ],
    description: 'Drop-sets or rest-pause prescribed with the exercise. null clears it.',
  },
  pyramid: {
    type: 'array', minItems: 1, maxItems: 10,
    items: { anyOf: [{ type: 'integer', minimum: 1, maximum: 100 }, { type: 'string', enum: ['max'] }] },
    description: 'Per-set rep targets, e.g. [12,10,8,"max",12] ("max" = as many reps as possible). Supplying it makes the set count = list length and replaces sets/reps; use it whenever the user wants a different rep count per set.',
  },
  pyramid_weight: {
    type: 'array', maxItems: 10,
    items: { type: 'number', minimum: 0, maximum: 1000 },
    description: 'Per-set planned weight, index-aligned with pyramid (0 = no planned weight for that set). Needs pyramid.',
  },
  pyramid_rest: {
    type: 'array', maxItems: 10,
    items: { type: 'integer', minimum: 0, maximum: 900 },
    description: 'Per-set rest seconds, index-aligned with pyramid (0 = use rest_sec). Needs pyramid.',
  },
};

const EXERCISE_INPUT = {
  type: 'object',
  properties: {
    exercise_id: { type: 'string', description: 'Exact exercise ID from search_exercises.' },
    sets: { type: 'integer', minimum: 1, maximum: 20 },
    mode: { type: 'string', enum: ['reps', 'time', 'cardio'] },
    reps: { type: 'integer', minimum: 1, maximum: 100 },
    reps_min: { type: 'integer', minimum: 1, maximum: 100, description: 'Optional low end of a rep range.' },
    seconds: { type: 'integer', minimum: 1, maximum: 3600, description: 'Per-set seconds for mode=time.' },
    weight: { type: 'number', minimum: 0, maximum: 1000, description: 'Working weight in the profile unit (0 for bodyweight).' },
    rest_sec: { type: 'integer', minimum: 0, maximum: 900 },
    note: { type: 'string', description: 'Short coaching cue in the user language; stored as untrusted text.' },
    side: { type: 'boolean', description: 'Per-side exercise (reps count both sides in openGym).' },
    bodyweight: { type: 'boolean' },
    assisted: { type: 'boolean' },
    db_load: { type: 'string', enum: ['each', 'total'] },
    ...CARDIO_PROPS,
    ...ADVANCED_PROPS,
  },
  required: ['exercise_id'],
  additionalProperties: false,
};

const PATCH = {
  type: 'object',
  properties: {
    sets: { type: 'integer', minimum: 1, maximum: 20 },
    mode: { type: 'string', enum: ['reps', 'time', 'cardio'] },
    reps: { type: 'integer', minimum: 1, maximum: 100 },
    reps_min: { type: 'integer', minimum: 1, maximum: 100 },
    seconds: { type: 'integer', minimum: 1, maximum: 3600 },
    weight: { type: 'number', minimum: 0, maximum: 1000 },
    rest_sec: { type: 'integer', minimum: 0, maximum: 900 },
    note: { type: 'string' },
    side: { type: 'boolean' },
    bodyweight: { type: 'boolean' },
    assisted: { type: 'boolean' },
    db_load: { type: 'string', enum: ['each', 'total'] },
    ...CARDIO_PROPS,
    ...ADVANCED_PROPS,
  },
  additionalProperties: false,
};

const ACTION = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['create_routine', 'update_routine', 'delete_routine', 'set_exercise', 'add_exercise',
        'remove_exercise', 'move_exercise', 'replace_exercise', 'set_superset', 'clear_superset',
        'assign_weekday', 'override_date', 'set_progression', 'add_bodyweight',
        'log_measurement', 'set_measurement_fields'],
    },
    routine_id: { type: 'string', description: 'Existing routine id; omit for create_routine (server generates one).' },
    name: { type: 'string', description: 'Routine name, or superset name.' },
    emoji: { type: 'string' },
    progression: { type: 'string', enum: ['off', 'linear', 'greyskull', 'double', 'triple', 'time'] },
    weekdays: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, description: '0=Sunday … 6=Saturday.' },
    exercises: { type: 'array', items: EXERCISE_INPUT, description: 'For create_routine: 1–12 exercises in order.' },
    exercise: { ...EXERCISE_INPUT, description: 'For add_exercise / replace_exercise.' },
    index: { type: 'integer', minimum: 0 },
    to_index: { type: 'integer', minimum: 0 },
    indexes: { type: 'array', items: { type: 'integer', minimum: 0 } },
    patch: PATCH,
    weekday: { type: 'integer', minimum: 0, maximum: 6 },
    date: { type: 'string', description: 'YYYY-MM-DD. For log_measurement: the day being measured (defaults to today).' },
    weight: { type: 'number', minimum: 1, maximum: 1000 },
    values: {
      type: 'object', additionalProperties: true,
      description: 'For log_measurement: centimetres per field (bodyFat in %), e.g. {"waist":82,"chest":101.5,"bodyFat":18.4}. Use {"custom":{"左小腿":36}} or {"other":[{"name":"左小腿","value":36}]} for custom fields.',
    },
    enable: {
      type: 'array', items: { type: 'string' },
      description: 'For set_measurement_fields: built-in keys to switch on (neck, shoulders, chest, waist, hips, abdomen, upperArmLeft, upperArmRight, forearmLeft, forearmRight, wristLeft, wristRight, thighLeft, thighRight, calfLeft, calfRight, ankleLeft, ankleRight, bodyFat).',
    },
    disable: {
      type: 'array', items: { type: 'string' },
      description: 'For set_measurement_fields: built-in keys to switch off.',
    },
    custom: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name'],
        properties: { name: { type: 'string' }, id: { type: 'string' }, enabled: { type: 'boolean' } },
      },
      description: 'For set_measurement_fields: add or rename custom measurement fields (values are entered later through log_measurement).',
    },
    disable_custom: {
      type: 'array', items: { type: 'string' },
      description: 'For set_measurement_fields: ids or names of custom fields to switch off.',
    },
  },
  required: ['type'],
  additionalProperties: false,
};

/* A self-describing manifest: what this connector can do right now. Built from the live
   tool schemas so it cannot drift from what the model is actually offered, and it never
   touches openGym or the data directory (works even when openGym is down). */
function capabilities() {
  const planTool = TOOLS.find(t => t.name === 'plan_preview');
  const actionSchema = planTool?.inputSchema?.properties?.actions?.items;
  const exerciseProps = actionSchema?.properties?.exercises?.items?.properties || {};
  const patchProps = actionSchema?.properties?.patch?.properties || {};
  const actions = actionSchema?.properties?.type?.enum || [];
  return {
    connector: {
      name: 'opengym-chatgpt',
      version: VERSION,
      protocol: '2025-06-18',
      transport: 'MCP Streamable HTTP at /mcp (token in path or Authorization: Bearer)',
      generated_at: new Date().toISOString(),
    },
    tools: TOOLS.map(t => ({
      name: t.name,
      title: t.title,
      write: t.annotations?.readOnlyHint === false,
      destructive: t.annotations?.destructiveHint === true,
    })),
    plan_editing: {
      actions,
      modes: ['reps', 'time', 'cardio'],
      exercise_fields: Object.keys(exerciseProps),
      patch_fields: Object.keys(patchProps),
      limits: {
        exercises_per_routine: '1–12',
        actions_per_preview: '1–30',
        sets: '1–20',
        reps: '1–100',
        reps_min: '1–100, must be <= reps',
        reps_max: '1–100, must be >= reps / reps_min',
        seconds: '1–3600 (mode=time)',
        minutes: '1–600 (mode=cardio)',
        speed: '0–100 in the profile speed unit',
        incline: '0–40 %, half-percent steps, cardio with a hill only',
        weight: '0–1000 in the profile unit',
        rest_sec: '0–900, warmup_rest_sec: 0–900',
        warmup_sets: '0–5 (the app builds the ramp weights itself)',
        inc: '0–100',
        deload_factor: [0.8, 0.85, 0.9],
        sets_max: '1–10 (triple progression)',
        pyramid: '1–10 targets, each 1–100 or "max"; pyramid_weight 0–1000 per set, pyramid_rest 0–900 per set',
        intensifier: ['dropset {count 1–10, pct 5–50}', 'restpause {total_reps 1–100, rest_sec 5–120}'],
        progression: ['off', 'linear', 'greyskull', 'double', 'triple', 'time'],
      },
    },
    reading: {
      set_types: ['straight', 'dropset', 'restpause', 'warmup'],
      set_type_labels: {
        straight: '普通组',
        dropset: '递减组',
        restpause: '爆发组（休息暂停 / rest-pause）',
        warmup: '热身组',
      },
      set_fields: ['weight', 'reps', 'seconds', 'minutes', 'speed', 'incline', 'done', 'rir', 'rpe',
        'type', 'drops', 'bursts', 'burst_reps', 'max', 'note', 'sides.L/R'],
      workout_exercise_fields: ['exercise_id', 'name', 'body_part', 'target', 'sets', 'top_weight',
        'set_summary', 'prescribed', 'note'],
      history_session_fields: ['date', 'workout_id', 'routine', 'sets_done', 'top_weight', 'top_reps',
        'total_reps', 'est_1rm', 'drop_sets', 'rest_pause_sets', 'burst_reps', 'note'],
      measurements: {
        fields: MEASUREMENT_FIELDS.map(f => f.key),
        units: 'centimetres (bodyFat is %); lb profiles only convert for display',
        write_actions: ['log_measurement', 'set_measurement_fields'],
      },
      rest_pause_note: 'a rest-pause row\'s reps already include its bursts (10+4+2 is ONE set of 16)',
    },
    workflow: {
      write: 'plan_preview → show changes → user confirms → plan_apply(confirmation:"确认写入")',
      safety: [
        'preview never writes',
        'apply checks the document revision and refuses stale proposals',
        'every write creates a backup (last 30 kept in store/backups)',
        'writes can be disabled with OPENGYM_ALLOW_WRITES=0',
      ],
      docs: ['README.md', 'README-zh-CN.md', 'GPT-INSTRUCTIONS.md', 'CHANGELOG.md'],
    },
  };
}

export const TOOLS = [
  {
    name: 'get_status',
    title: 'Connection status',
    description: 'Read-only. Check that the local bridge can reach openGym, which profile it answers for, the current revision and whether writes are enabled. Call this first when anything looks disconnected.',
    inputSchema: obj(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: async () => {
      const auth = await me();
      const S = readState();
      return {
        connected: true,
        profile: userInfo().name,
        uid: userInfo().id,
        rev: S?._rev ?? 0,
        has_state: !!S,
        writes_enabled: config.writes,
        api_base: config.baseUrl,
        data_dir: config.dataDir,
        today: todayIso(),
        timezone: config.timezone,
        exercise_library: exerciseCount(),
        pending_updates: pendingUpdates(S),
        open_proposals: proposalCount(),
        account: { name: auth?.user?.name || userInfo().name },
        connector_version: VERSION,
        tool_count: TOOLS.length,
        protocol: '2025-06-18',
        capabilities_tool: 'get_capabilities',
      };
    },
  },
  {
    name: 'get_capabilities',
    title: 'What this connector can do',
    description: 'Read-only and offline-safe (does not touch openGym data). Returns the connector version, protocol, every tool with its write permission, the full plan-edit vocabulary (actions, exercise fields, modes, limits), the fields the read model returns (set types, drops, bursts, measurements) and the write-safety rules. Call this when the user asks “现在能做什么 / 是不是最新版”, or before promising a feature the schema may not have.',
    inputSchema: obj(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: () => capabilities(),
  },
  {
    name: 'get_training_context',
    title: 'Full training context',
    description: 'Read-only. The main context call: profile, bodyweight trend, every routine with sets/reps/weight/rest/notes, the weekly schedule and next 7 days, the last 5 completed workouts with per-set actuals, how many new completions are waiting, and a body-measurement summary. Per-set rows expose what was actually done: `type` (straight / dropset / restpause / warmup), `drops` (递减组: weight + reps per drop), `bursts` (爆发组, rest-pause bursts: reps + rest_sec, with `burst_reps`), `max` for an AMRAP set and per-side equivalents; the exercise carries `set_summary` counts and the `prescribed` intensifier. Use this before designing any plan. It does not acknowledge updates.',
    inputSchema: obj(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: () => {
      const S = requireState();
      const view = contextView(S);
      view.profile.name = userInfo().name;
      return view;
    },
  },
  {
    name: 'get_plan',
    title: 'Plan only',
    description: 'Read-only. Routines (with exercise indices), the weekday map, one-off date overrides and the next seven days. Use this when you only need the plan, or to get exact routine_id / exercise index before previewing a change.',
    inputSchema: obj(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: () => {
      const S = requireState();
      return { today: todayIso(), plan: planView(S), upcoming: upcoming(S, 7), revision: S._rev ?? 0 };
    },
  },
  {
    name: 'search_exercises',
    title: 'Search exercise IDs',
    description: 'Read-only. Search the full built-in exercise library (5,600+ entries) plus the profile’s custom exercises. Chinese and English names both work (卧推, 深蹲, bench press…). Always call this before naming an exercise_id in a plan; never invent IDs. Results include body part, equipment and bodyweight/assisted flags.',
    inputSchema: obj({
      query: { type: 'string', description: 'Exercise name or ID, e.g. 卧推 / bench press / 0289.' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    }, ['query']),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: ({ query, limit }) => search(readState(), query, limit ?? 20),
  },
  {
    name: 'get_exercise_history',
    title: 'Exercise history and 1RM',
    description: 'Read-only. Per-exercise history: last sessions, top weight/reps, total reps and estimated 1RM (Epley, completed sets of 1–12 reps). Each session also reports `drop_sets`, `rest_pause_sets` and `burst_reps` (爆发组) when the exercise was trained with those intensifiers. Use it before prescribing a weight or judging progress.',
    inputSchema: obj({
      exercise_id: { type: 'string', description: 'Exact exercise ID, preferably from search_exercises.' },
      limit: { type: 'integer', minimum: 1, maximum: 30 },
    }, ['exercise_id']),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: ({ exercise_id, limit }) => exerciseHistory(requireState(), exercise_id, limit ?? 8),
  },
  {
    name: 'get_results',
    title: 'Completed workouts in a date range',
    description: 'Read-only. Completed sessions between two dates (default: last 14 days), newest first, with per-set actual weight/reps/RIR/sides, set types (`type`, `drops` for 递减组, `bursts` for 爆发组/rest-pause with reps + rest_sec, `max` for AMRAP), completion vs target, volume and PRs. Use this to review a block or answer “上周练得怎么样”.',
    inputSchema: obj({
      since: { type: 'string', description: 'YYYY-MM-DD inclusive. Defaults to 14 days ago.' },
      until: { type: 'string', description: 'YYYY-MM-DD inclusive. Defaults to today.' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: ({ since, until, limit }) => {
      const S = requireState();
      const end = until || todayIso();
      const start = since || new Date(Date.parse(end + 'T12:00:00') - 13 * 86400000)
        .toLocaleDateString('en-CA', { timeZone: config.timezone });
      const workouts = workoutsBetween(S, start, end, limit ?? 20);
      return {
        since: start, until: end, count: workouts.length,
        unit: S.unit || 'kg',
        total_volume: Math.round(workouts.reduce((n, w) => n + (w.volume || 0), 0) * 10) / 10,
        workouts,
        bodyweight: bodyweightView(S),
      };
    },
  },
  {
    name: 'get_measurements',
    title: 'Body measurements',
    description: 'Read-only. Body measurements (neck, shoulders, chest, waist, hips, arms, thighs, calves, body fat and any custom fields) in centimetres / percent, with the latest entry, per-field series and recent entries. Use it before advising on body composition or when the user asks “最近围度怎么样”.',
    inputSchema: obj({
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many recent entries to return (default 24).' },
      series_days: { type: 'integer', minimum: 7, maximum: 3650, description: 'Series window in days (default 365).' },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: ({ limit, series_days }) => {
      const S = requireState();
      return measurementsView(S, { limit: limit ?? 24, seriesDays: series_days ?? 365 });
    },
  },
  {
    name: 'get_updates',
    title: 'New completions since last sync',
    description: 'Read-only, but advances a local cursor when ack=true (default). At the START of every conversation, and whenever the user asks “我练完了/Gym 里完成了/有什么更新”, call this. It returns only workouts completed since the previous call, with full sets (including 递减组 `drops` and 爆发组 `bursts`: reps + rest_sec), so you can update the conversation. The first call establishes a baseline and returns the latest session instead of dumping all history.',
    inputSchema: obj({
      ack: { type: 'boolean', description: 'Default true. Set false to peek without advancing the cursor.' },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: ({ ack, limit }) => getUpdates({ ack: ack !== false, limit: limit ?? 5 }),
  },
  {
    name: 'plan_preview',
    title: 'Preview a plan change',
    description: 'Dry-run only. Validates a list of edits and returns an exact human-readable change list plus a short-lived proposal_id. Nothing is written. Supported actions: create_routine (1–12 exercises), update_routine, delete_routine, set_exercise, add/remove/move/replace_exercise, set_superset, clear_superset, assign_weekday, override_date, set_progression, add_bodyweight, log_measurement, set_measurement_fields. Full openGym exercise model, not just a set count: mode=reps/time/cardio (cardio needs minutes + speed, optional incline), reps_min/reps_max, seconds, weight, rest_sec, side, bodyweight, assisted, db_load, supersets, plus warmup_sets (warm-up ramp, max 5), warmup_rest_sec, inc, deload_factor, backoff, last_to_failure, sets_max, per-exercise progression, intensifier (dropset/restpause) and pyramid/pyramid_weight/pyramid_rest for a different rep or weight on every set. Body measurements go through the same preview → confirm → apply flow with log_measurement / set_measurement_fields. Exercise IDs must come from search_exercises. After this, show the changes and ask the user; only then call plan_apply.',
    inputSchema: obj({ actions: { type: 'array', minItems: 1, maxItems: 30, items: ACTION } }, ['actions']),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: ({ actions }) => {
      if (!config.writes) throw new Error('写入已关闭（OPENGYM_ALLOW_WRITES=0）；只能预览/读取');
      const S = requireState();
      return createProposal(S, actions);
    },
  },
  {
    name: 'plan_apply',
    title: 'Write a previewed plan change',
    description: 'WRITE, HIGH IMPACT. Commits a proposal previously returned by plan_preview. Requires the exact proposal_id and the literal confirmation 「确认写入」, which you may only send after the user has seen the change list and explicitly agreed. The server checks the document revision, writes a backup, and refuses stale or conflicting proposals rather than overwriting. Never retry after a conflict — re-read the plan and preview again.',
    inputSchema: obj({
      proposal_id: { type: 'string' },
      confirmation: { type: 'string', enum: ['确认写入'] },
    }, ['proposal_id', 'confirmation']),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    handler: ({ proposal_id, confirmation }) => {
      if (!config.writes) throw new Error('写入已关闭（OPENGYM_ALLOW_WRITES=0）');
      return commitProposal(proposal_id, confirmation);
    },
  },
  {
    name: 'log_bodyweight',
    title: 'Record bodyweight',
    description: 'WRITE, LOW IMPACT. Add or replace one weigh-in for a date (default today). Only call after the user gives the number; require their explicit agreement, then send confirmation 「确认写入」.',
    inputSchema: obj({
      weight: { type: 'number', minimum: 1, maximum: 1000 },
      date: { type: 'string', description: 'YYYY-MM-DD; defaults to today.' },
      confirmation: { type: 'string', enum: ['确认写入'] },
    }, ['weight', 'confirmation']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: async ({ weight, date, confirmation }) => {
      if (!config.writes) throw new Error('写入已关闭（OPENGYM_ALLOW_WRITES=0）');
      if (confirmation !== '确认写入') throw new Error('confirmation 必须是「确认写入」');
      const S = requireState();
      const proposal = createProposal(S, [{ type: 'add_bodyweight', weight, ...(date ? { date } : {}) }]);
      return commitProposal(proposal.proposal_id, confirmation);
    },
  },
  {
    name: 'reset_updates_cursor',
    title: 'Reset the update cursor',
    description: 'Maintenance. Forget the “last seen completion” position; the next get_updates establishes a fresh baseline. Use only when the user asks to resync or the cursor is clearly wrong.',
    inputSchema: obj(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: () => resetUpdates(),
  },
];

export const TOOL_MAP = new Map(TOOLS.map(t => [t.name, t]));

export function toolList() {
  return TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
    name, title, description, inputSchema, annotations,
  }));
}

export function describeTool(name) {
  const tool = TOOL_MAP.get(name);
  return tool ? { name: tool.name, description: tool.description } : null;
}
