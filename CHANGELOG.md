# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/).

## [Unreleased]

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
