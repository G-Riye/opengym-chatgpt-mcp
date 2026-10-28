# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/).

## [Unreleased]

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
