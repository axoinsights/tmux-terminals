# Contributing

Thanks for helping. The project aims to stay small and boring: Node + TypeScript, one HTML file for the UI, tmux for persistence.

## Setup

```bash
git clone <repo-url> && cd agent-terminal
npm install          # installs deps and compiles src/ to dist/
npm run build        # after editing src/*.ts
npm test             # build + unit tests + browser end-to-end
```

Requirements: Node 20+, tmux, and (for the browser suites) Playwright with Chromium:

```bash
npm install --no-save playwright && npx playwright install chromium
# or reuse an existing install:
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs npm test
```

## Layout

| Path | What |
| --- | --- |
| `src/config.ts` | config loading and validation (flags > env > file) |
| `src/auth.ts` | token extraction, constant-time compare, rate limiting |
| `src/pty-manager.ts` | tmux-backed sessions, adoption, order file, watched groups |
| `src/server.ts` | HTTP(S) routes, `/ws` protocol, dictation proxy |
| `src/cli.ts`, `doctor.ts`, `service.ts`, `tls.ts`, `pairing.ts` | CLI and helpers |
| `web/index.html` | the whole UI (xterm.js is served from `node_modules/@xterm/*`, nothing is vendored) |
| `test/unit/*.test.mjs` | `node:test` unit tests against `dist/` |
| `test/e2e/*.test.mjs` | end-to-end suites; each starts the real server on a random port with its own config dir and tmux socket |

## Rules

- Tests must use their own random port and tmux socket (see `test/e2e/helpers.mjs`) and clean up only what they started: kill by PID, `tmux -L <their socket> kill-server`. Never use `pkill`/`killall`, never touch the default tmux server.
- No personal data, hostnames, IPs or tokens in code, tests, docs or fixtures.
- Security-relevant changes need a test (see `test/unit/auth.test.mjs`, `server.test.mjs`) and a note in `SECURITY.md` if they change the model.
- Keep new runtime dependencies to a minimum.
- Commit style: `feat: ...`, `fix: ...`, `test: ...`, `docs: ...`.

## Releasing (maintainers)

Bump `version` in `package.json`, update `CHANGELOG.md`, run `npm test`, `npm pack` and check the tarball with `tar tzf`.
