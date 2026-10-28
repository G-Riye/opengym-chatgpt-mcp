# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/).

## [Unreleased]

## [1.3.0] - 2026-10-28

### Added
- **What was actually done, set by set.** Every completed set now carries `type`
  (`straight` / `dropset` / `restpause` / `warmup`), `drops` (递减组: weight + reps per drop),
  `bursts` + `burst_reps` (爆发组 = rest-pause bursts: reps + rest_sec per burst) and `max`
  (AMRAP). Per-side rows expose the same fields under `sides.L` / `sides.R`.
- Exercises in a workout now carry `set_summary` (counts of straight/dropset/restpause/warmup
  plus total `burst_reps`) and `prescribed` (the routine's intensifier / warm-up count), so a
  model can tell "planned rest-pause" from "actually did rest-pause".
- `get_exercise_history` sessions report `drop_sets`, `rest_pause_sets` and `burst_reps`.
- Tool descriptions in `get_training_context`, `get_results`, `get_updates` and
  `get_exercise_history` document these fields, and the server instructions explain that a
  rest-pause row's `reps` already includes its bursts (do not count them as extra sets).
- `scripts/fields-test.mjs` grew to **72 checks**, including a synthetic workout with a
  warm-up row, a drop-set, a rest-pause row with three bursts, an AMRAP set and a per-side
  rest-pause set.

## [1.2.1] - 2026-10-28

### Fixed
- `scripts/release.ps1` read `src/server.mjs` with `Get-Content -Raw`, which decodes as ANSI on
  Windows PowerShell 5.1 and turned the Chinese MCP instructions into mojibake — the template
  literal no longer closed, so the connector could not start after a release. Both files are now
  read and written as explicit UTF-8, and the bump is verified before committing.
- Restored `src/server.mjs` from the pre-release commit; the v1.2.0 tag was replaced by v1.2.1.
  The feature set is identical to 1.2.0.

## [1.2.0] - 2026-10-28

### Added
- **Cardio in plans.** `mode:"cardio"` with `minutes`, `speed` and `incline` (percent, half-step,
  only on treadmill/walking/running/elliptical style cardio — the same name rules as
  `lib/incline.js`). Cardio exercises now round-trip through `get_plan` and the change list
  reads `1×30分钟 @ 5.5 · 坡度12%`. Non-cardio exercises still refuse `mode:"cardio"`.
- **Body measurements.** New read tool `get_measurements` (19 built-in fields + custom fields,
  series, latest, recent entries, cm/percent canonical units) and two write actions inside the
  normal preview → confirm → apply flow: `log_measurement` (values in cm, bodyFat in %,
  `custom`/`other` for custom fields) and `set_measurement_fields` (enable/disable built-ins,
  add or rename custom fields). `get_training_context` now carries a measurements summary.
- **Notes everywhere.** Workout entries now expose their own note (previously only the planned
  target note), cardio sets expose `minutes/speed/incline`, and `get_exercise_history` returns
  the session note. `get_plan` / `get_training_context` already returned per-exercise notes.
- `scripts/fields-test.mjs` grew to **57 checks** (cardio, measurements, notes, plus the
  existing warm-up / pyramid / intensifier cases and their rejection paths).

### Changed
- `plan_preview` description, server instructions and `GPT-INSTRUCTIONS.md` document cardio,
  measurements, and the warm-up / pyramid semantics.
- `scripts/mcp-smoke.mjs` expects 12 tools.

## [1.1.0] - 2026-10-28

### Added
- **Full openGym exercise prescription through MCP.** `plan_preview` / `plan_apply` now
  accept, validate and store every field the openGym editor keeps on a routine exercise:
  - `warmup_sets` (0–5 warm-up ramp) and `warmup_rest_sec` — the warm-up block that used to
    be impossible to write, since it is a per-exercise setting, not a set row.
  - `pyramid` + `pyramid_weight` + `pyramid_rest` — a different rep target (or `"max"`) and
    weight for **every** set, e.g. `[12,10,8,"max",12]`; this is openGym's only way to
    express per-set weights, and it overrides `sets`/`reps`.
  - `inc`, `deload_factor`, `backoff`, `last_to_failure`, `reps_max`, `sets_max` and a
    per-exercise `progression` override.
  - `intensifier`: drop-sets (`{type:"dropset",count,pct}`) and rest-pause
    (`{type:"restpause",total_reps,rest_sec}`).
- `get_plan` / `get_training_context` now return those fields (`warmup_sets`,
  `pyramid`, `pyramid_weight`, `pyramid_rest`, `intensifier`, `inc`, `deload_factor`,
  `backoff`, `last_to_failure`, `reps_max`, `sets_max`, `progression`), so the model can
  read a plan back and round-trip it.
- Change lists now spell the prescription out, e.g.
  `barbell bench press 金字塔 12@40·10@50·8@60·Max·12@40，热身2组，递减2次/25%，末组力竭`.
- `scripts/fields-test.mjs`: 31 in-memory checks for the new fields, including the
  rejection cases (6 warm-ups, 11-set pyramid, unknown intensifier keys, pyramid on a
  timed exercise). It never writes.

### Changed
- `plan_preview` documentation and the server instructions now tell the model to prefer
  `pyramid` whenever the rep count or weight differs per set.

## [1.0.0] - 2026-10-27

### Added
- MCP Streamable HTTP server on `127.0.0.1:8787` with token-in-path (or bearer) auth.
- 11 tools: `get_status`, `get_training_context`, `get_plan`, `search_exercises`,
  `get_exercise_history`, `get_results`, `get_updates`, `plan_preview`, `plan_apply`,
  `log_bodyweight`, `reset_updates_cursor`.
- Two-step plan writes: dry-run preview with a 15-minute `proposal_id`, explicit
  `确认写入` confirmation, revision check, and a 30-deep backup rotation.
- Update cursor so a chat can pull only workouts completed since the last sync.
- `app-proxy` that publishes the openGym PWA on `127.0.0.1:8081` behind an
  `app-token` cookie, for `tailscale funnel` on `:8443` (phone use without a VPN).
- PowerShell lifecycle scripts: autostart, cold-start health checks, Tailscale Funnel
  (login + funnel enable handled automatically), Cloudflare quick/named tunnels.
- `mcp-smoke.mjs` (14 checks) and `write-test.mjs` (write flow on a data copy).
