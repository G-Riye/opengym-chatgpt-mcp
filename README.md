# openGym × ChatGPT MCP connector

A small, self-hosted **MCP server (Streamable HTTP)** that lets ChatGPT chat read your
[openGym](https://github.com/) 1.4.1 data and write training plans back into the app,
without giving the model any local agent/shell capability.

> Unofficial community project. Not affiliated with openGym. You run it on your own
> machine, against your own openGym data directory.

## What it does

- **Reads** the openGym state file directly (plans, routines, schedules, workout history,
  per-set actuals, bodyweight trend, 5,600+ exercise library).
- **Writes** through the official openGym API (`PUT /api/data`) with a revision check,
  an automatic backup, and a mandatory two-step `plan_preview` → `plan_apply` flow.
- **Serves** MCP over HTTP so ChatGPT can reach it; pair it with a public HTTPS tunnel
  (Tailscale Funnel / Cloudflare Tunnel) and register it as a custom MCP connector.

## Architecture

```
ChatGPT  --https-->  tunnel  -->  connector (127.0.0.1:8787)  -->  openGym API (127.0.0.1:30347)
                                        |                                  |
                                        +-- reads data/state-*.json -------+

iPhone (5G) --https--> tunnel :8443 --> app-proxy (127.0.0.1:8081) --> openGym PWA + /api
```

| Service | Port | Purpose |
|---|---|---|
| connector | 8787 | MCP endpoint `/mcp/<token>`, status dashboard, `/healthz` |
| app-proxy | 8081 | publishes the openGym PWA to a plain-HTTP local port for `tailscale funnel` |
| openGym API | 30347 | provided by openGym itself |

## Requirements

- Windows 10/11, [openGym 1.4.1](https://github.com/) installed next to this folder
- Node.js ≥ 22 (the bundled `windows\runtime\node.exe` is used by the scripts)
- Optional: Tailscale (Funnel) or Cloudflare Tunnel for a public HTTPS URL

## Quick start

```bat
Start.cmd              :: start openGym + connector + app proxy, open the dashboard
Show-Connection.cmd    :: print the MCP URL (with token) and the phone URL
Tunnel-Tailscale.cmd   :: publish both endpoints with Tailscale Funnel
App-QR.cmd             :: QR code for the phone (openGym PWA over 5G)
Stop.cmd               :: stop connector + tunnels
```

Then in ChatGPT: **Plugins → Add custom MCP server → URL `https://<host>/mcp/<token>`
→ Authentication: No authentication**, and paste [`GPT-INSTRUCTIONS.md`](GPT-INSTRUCTIONS.md)
into the project/custom GPT.

Full Chinese guide: [`README-zh-CN.md`](README-zh-CN.md).

## MCP tools

| Tool | Kind | Purpose |
|---|---|---|
| `get_status` | read | connection/health, profile, revision |
| `get_training_context` | read | profile, bodyweight trend, routines, schedule, recent workouts |
| `get_plan` | read | routines, weekday map, date overrides, next 7 days |
| `search_exercises` | read | 5,600+ exercise library, Chinese + English |
| `get_exercise_history` | read | per-exercise session history, best set, est. 1RM |
| `get_results` | read | completed sessions in a date range |
| `get_measurements` | read | body measurements: 19 built-in fields + custom, series and latest |
| `get_updates` | read | only workouts completed since the last sync (cursor) |
| `plan_preview` | dry-run | validate edits, return a change list + `proposal_id` |
| `plan_apply` | **write** | commit a previewed change (needs `确认写入`) |
| `log_bodyweight` | **write** | record one weigh-in |
| `reset_updates_cursor` | maintenance | resync the update cursor |

Write safety: preview never writes, apply refuses stale proposals (revision check),
every write creates a backup in `store/backups/` (last 30 kept).

### What a plan edit can prescribe

Every field openGym's own editor stores on a routine exercise is reachable through
`plan_preview` / `plan_apply`:

| Field | Meaning |
|---|---|
| `sets`, `reps`, `reps_min`, `reps_max` | flat prescription / rep range |
| `weight`, `mode`, `seconds`, `rest_sec` | load, reps vs timed hold, rest |
| `warmup_sets`, `warmup_rest_sec` | warm-up ramp (0–5 sets) and its own rest |
| `pyramid`, `pyramid_weight`, `pyramid_rest` | **per-set** targets, e.g. `[12,10,8,"max",12]` with a weight and rest for each set |
| `inc`, `deload_factor`, `backoff` | progression step, deload %, back-off sets |
| `last_to_failure`, `intensifier` | last set to failure, drop-sets, rest-pause |
| `progression` | per-exercise override of the routine rule |
| `side`, `bodyweight`, `assisted`, `db_load` | unilateral, bodyweight, assisted, dumbbell load semantics |
| `note`, supersets (`sg`, `sgName`, `sgRest`) | coaching cue and superset grouping |
| `mode:"cardio"` + `minutes` + `speed` + `incline` | cardio entries in a routine (treadmill grade only where it exists) |
| `log_measurement` / `set_measurement_fields` (actions) | body measurements in the same preview → apply flow |

`pyramid` is the only representation of per-set work: giving it sets `sets` to the list
length and replaces `reps`, so a shared "12 · 10 · 8 · Max · 12" round-trips exactly.

**Notes vs warm-ups.** Every exercise's `note` (the coaching text you write in openGym) is
returned by `get_plan`, `get_training_context`, `get_results` and `get_exercise_history`.
Warm-ups are a *count* (`warmup_sets`), not a list of weights: the app builds the ramp when
the session starts (50 % / 75 % / 87.5 % of the working weight, never below the bar), so
"warm-up set 1 = 5 kg" is a session row, not a plan field.

## Security model

- The MCP token lives in `secrets/mcp-token`; the Caddy/openGym token is derived from
  `data/secret`. Both are ignored by git.
- The public URL embeds the token: treat it as a password. Rotate by deleting
  `secrets/mcp-token` and restarting the connector.
- The PWA published on `:8443` is protected by an `app-token` cookie **plus** openGym's
  own login.
- Nothing in this repo is required to run with a public tunnel; everything works on
  `127.0.0.1` only.

## Repository layout

```
src/        connector (MCP server, state reader, plan writer, API client, app proxy)
scripts/    PowerShell lifecycle: start/stop/autostart, tunnels, smoke tests, QR
*.cmd       double-click entry points for the above
```

## Development

```bat
node src/main.mjs doctor    :: data + auth + catalogue check
node src/main.mjs test      :: in-process MCP smoke test (read-only)
node scripts/mcp-smoke.mjs  :: protocol-level checks against a running connector
node scripts/fields-test.mjs:: 31 in-memory checks for the advanced plan fields
node scripts/write-test.mjs :: write flow against a throwaway copy of the data
```

## Releases

Version lives in `package.json` and in `src/server.mjs` (`VERSION`), history in
`CHANGELOG.md`, and every release is tagged `vX.Y.Z` on GitHub.

```bat
Release.cmd 1.2.0 "what changed"
```

`scripts/release.ps1` bumps both version strings, runs `fields-test` and `mcp-smoke`,
commits, tags, pushes to `origin`, then restarts the connector so the machine is already
running the new version. Add `-NoPush` to rehearse, `-SkipTests` to skip the suites.

Version history: see [`CHANGELOG.md`](CHANGELOG.md).

License: AGPL-3.0-or-later (see `package.json`).
