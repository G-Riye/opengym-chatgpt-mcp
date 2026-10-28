# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/).

## [Unreleased]

## [1.4.5] - 2026-10-29

### Added
- **Cloudflare Tunnel mode.** `scripts/tunnel.ps1 -Mode cloudflare` runs one named tunnel that
  publishes both hostnames: the openGym app proxy and the MCP connector. No DDNS, no IPv6
  dependency, TLS from Cloudflare, and nothing inbound on the router. `scripts/setup-cloudflare.ps1`
  creates the tunnel once and writes `store/cloudflare.json` + `store/cloudflared.yml`;
  `Start.cmd` follows `store/tunnel-mode.txt` like before.
- **The paired native app can now use the public app proxy without the browser token cookie.**
  `/api/health`, `/api/config`, `POST /api/pair/redeem`, `OPTIONS /api/*`, any `/api/*` carrying a
  Bearer token and `/exercise-media/*` are let through; each is authenticated by the openGym API
  itself. The browser UI still needs the 64-char token cookie or `?t=`.

### Changed
- `tunnel.ps1` accepts `cloudflare` in `-Mode`; the status/stop commands and the stored public
  URLs (`public-url.txt`, `app-url.txt`) now describe the two Cloudflare hostnames.

## [1.4.4] - 2026-10-29

### Changed
- **No artificial exercise cap.** `create_routine` and `add_exercise` no longer refuse more than
  12 exercises. openGym's own routine editor has no such limit (`views/RoutineEdit.jsx` pushes
  slots with no count check), and real plans now carry 15–20 movements. Per-exercise validation
  (mode, ranges, exercise ids) is unchanged.
- **Duplicate exercise ids now match the official app.** The connector used to reject the same
  exercise id twice in one routine. openGym allows it: `sheets.jsx` `AddToRoutine` tags an
  exercise "already in" and still adds it, and `lib/routines.js routineSlotIndex` maps a session
  row to its slot among the twins. The connector now allows it and addresses slots by index
  (`set_exercise`, `remove_exercise`, `move_exercise`, `replace_exercise`, supersets).
- `get_capabilities` states the real limits (`exercises_per_routine`: at least 1, no artificial
  cap; `duplicate_exercise_ids`: allowed and addressed by index), and the `plan_preview`
  description says the same.

### Added
- `scripts/fields-test.mjs`: 15- and 20-exercise templates, `add_exercise` past 20, a
  duplicate-id routine edited by slot index, and the official warm-up ramp in `preview_session`
  rows. Negative cases still cover unknown fields, a missing `exercise_id`, an empty routine and
  31 actions.

### Kept
- Write safety unchanged: 4 MB request-body cap, confirmation `确认写入`, a fresh revision check,
  a local backup before every write, and `buildEntry` validation of every exercise field.

## [1.4.3] - 2026-10-28

### Added
- The access log (and `/access`) now records the request **path** with the token masked
  (`/mcp/<token>/connector`), so it is visible which connector URL a client actually used —
  the decisive clue when a client keeps an old tool list while the server is current.

## [1.4.2] - 2026-10-28

### Added
- **MCP access log** (`logs/mcp-access.log`, one JSON line per request): records `initialize`
  with the client's `clientInfo`, protocol, IP, user-agent and the tool count it was offered,
  plus `tools/list` and every `tools/call`. `/version` now reports `last_client`, so
  "did ChatGPT really reconnect, and to which build?" is answered from the server side.
- `GET /access?token=<token>` returns the last 200 entries for quick inspection.
- `README-zh-CN.md` §2.4 explains how to use both when a client keeps an old tool list.

## [1.4.1] - 2026-10-28

### Added
- `GET /version` (no token): running version, protocol, tool names and a `paths.versioned_alias`
  like `/mcp/<token>/v141`. Handy for proving the server is current when a client still shows an
  old tool list, and the versioned path doubles as a cache-buster for such clients.
- Every response now carries `X-OpenGym-Mcp-Version` and `X-OpenGym-Mcp-Tools` headers.
- `README-zh-CN.md` §2.4 documents the "ChatGPT still shows 11 tools" case step by step
  (new conversation → remove/re-add connector → versioned path → verify with get_capabilities).

## [1.4.0] - 2026-10-28

### Added
- **`preview_session`** (14th tool): runs the *official* frontend session builder
  (`session-start.js buildSessionEntries → buildSets + applyPrescription`) and returns the rows
  the App will open with — warm-up ramp weights, progression/deload-adjusted loads, pyramid
  per-set targets, drop-set and rest-pause bursts, per-side splits — beside the template
  prescription, so "template 60 kg → App 62.5 kg" is visible before the session.
- **`get_muscle_balance`** (15th tool): effective sets per muscle over a rolling window with the
  official `muscles.loadOfWorkouts` + `levelsOf` weights (primary 1, secondary 0.5, warm-ups
  excluded, only ticked sets), ranked weekly volume, the 0–4 level and what was missed.
- Read model now returns the remaining per-set facts: `failure: true` (力竭组), the raw `phase`,
  the exercise `order` in the session and its `superset {group,name,rest_sec}`; exercise history
  counts `failure_sets`.
- `get_capabilities` documents the two new analysis tools and the extra read fields.
- `scripts/fields-test.mjs` is now **85 checks**, including preview rows vs template weight and
  the muscle-balance ranking/labels.

### Changed
- Server instructions #13/#14 tell the model to use `preview_session` for real target numbers
  and `get_muscle_balance` for volume questions instead of re-deriving them.

## [1.3.2] - 2026-10-28

### Added
- **`get_capabilities`** (13th tool): a self-describing manifest — connector version, protocol,
  every tool with its write flag, the full plan-edit vocabulary (actions, exercise fields,
  modes, numeric limits), the read model's fields (set types, drops, bursts, measurements) and
  the write-safety rules. Built from the live tool schemas so it cannot drift, and it touches
  neither openGym nor the data directory.
- `get_status` now returns `connector_version`, `tool_count` and `protocol`, so "am I on the
  latest version?" is answerable without a separate call.
- Server instruction #12 tells the model to use `get_capabilities` instead of guessing.
- `scripts/mcp-smoke.mjs` checks that `get_capabilities.version` equals `package.json`.

### Changed
- Version now lives in `src/version.mjs` only; `src/server.mjs` imports it, and
  `scripts/release.ps1` bumps that file (plus `package.json`) and syntax-checks it.

## [1.3.1] - 2026-10-28

### Fixed
- A backtick inside the new instruction text closed the `INSTRUCTIONS` template literal, so
  1.3.0 could not start. Removed and, more importantly, `scripts/release.ps1` now runs
  `node --check` on `src/server.mjs` and `src/tools.mjs` **before** committing, so a release
  can no longer be published with an unparseable server.
- v1.3.0 tag replaced by v1.3.1; the feature set is identical.

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
