# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/), versioning: [SemVer](https://semver.org/).

## [0.1.0] - Unreleased

First version, extracted from a private terminal hub.

### Added
- tmux-backed persistent sessions on a dedicated socket (survive server restarts), rename / kill / attach, shared drag-and-drop order, split view, scrollback search, OSC 52 clipboard.
- Phone UI: key toolbar, compose bar, Android IME input mirror, Paste / Copy / Screen buttons, select mode, swipe gestures, PWA manifest, optional dictation (`transcribeUrl`), optional `window.nativeClipboard` bridge.
- Configurable agents (`shell` plus `claude` / `codex` / `aider` when on PATH) and optional watched tmux sockets shown as sidebar groups.
- Token auth on every route (no localhost bypass), cookie exchange, Origin check, brute-force backoff, `GET /healthz`.
- CLI: `start` (`--daemon`), `stop`, `status`, `doctor [--json]`, `token [--url|--qr]`, `install-service` (systemd user unit / launchd agent).
- Dockerfile and `compose.yaml` (sandbox option), CI workflow, unit and browser end-to-end tests.
