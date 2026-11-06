# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/), versioning: [SemVer](https://semver.org/).

## [0.2.0] - Unreleased

### Added
- **Agent skill**: `skills/tmux-terminals/` — `SKILL.md` plus `reference/setup.md`, `reference/cli.md`, `reference/api.md`, `reference/troubleshooting.md` and `scripts/sessions.mjs` (lists the sessions of a running server over HTTP without putting the token on the command line). It teaches a coding agent to install, run, expose, diagnose and script the tool.
- **Claude Code plugin manifests**: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, so `claude plugin marketplace add axoinsights/tmux-terminals` + `/plugin install tmux-terminals@axoinsights` works straight from this repository.
- The skill ships inside the npm package (`files` now includes `skills/`), which makes `npx skills experimental_sync` pick it up for anyone who installs `tmux-terminals` as a dependency.
- README: badges and an "Installing it as an agent skill" table with the marketplace routes.

## [0.1.0] - 2026-11-03

First version, extracted from a private terminal hub.

### Added
- tmux-backed persistent sessions on a dedicated socket (survive server restarts), rename / kill / attach, shared drag-and-drop order, split view, scrollback search, OSC 52 clipboard.
- Phone UI: key toolbar, compose bar, Android IME input mirror, Paste / Copy / Screen buttons, select mode, swipe gestures, PWA manifest, optional dictation (`transcribeUrl`), optional `window.nativeClipboard` bridge.
- Configurable agents (`shell` plus `claude` / `codex` / `aider` when on PATH) and optional watched tmux sockets shown as sidebar groups.
- Token auth on every route (no localhost bypass), cookie exchange, Origin check, brute-force backoff, `GET /healthz`.
- CLI: `start` (`--daemon`), `stop`, `status`, `doctor [--json]`, `token [--url|--qr]`, `install-service` (systemd user unit / launchd agent).
- Dockerfile and `compose.yaml` (sandbox option), CI workflow, unit and browser end-to-end tests.
