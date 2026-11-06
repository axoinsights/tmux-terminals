# Where tmux-terminals is published, and how to get it into more places

The tool and its agent skill are the same artifact: one repository, one `SKILL.md`, several
registries picking it up. Status column is the state of this repository, not of the tool.

## Live now (nothing to do)

| # | Marketplace / registry | What it gives you | Route |
| --- | --- | --- | --- |
| 1 | **GitHub** — <https://github.com/axoinsights/tmux-terminals> | the source, and the git URL every other registry installs from | topics set: `agent-skills`, `claude-plugin`, `claude-code`, `tmux`, `self-hosted`, … |
| 2 | **skills.sh** (Vercel, the Agent Skills directory) — <https://skills.sh/axoinsights/tmux-terminals> | the `npx skills add` path used by Claude Code, Codex, Cursor, OpenCode, OpenClaw, pi and ~70 more | auto-indexed from the repo's `skills/` directory; verified live |
| 3 | **Claude Code plugin marketplace** (this repo is its own marketplace) | `/plugin marketplace add axoinsights/tmux-terminals` → `/plugin install tmux-terminals@axoinsights` | `.claude-plugin/marketplace.json` + `.claude-plugin/plugin.json`; verified with `claude plugin marketplace add` / `install` / `details` (~170 tokens always-on, ~1.6k on invoke) |
| 4 | **npm** — <https://www.npmjs.com/package/tmux-terminals> | `npx tmux-terminals` for humans, and the skill inside the tarball for `npx skills experimental_sync` | `files` includes `skills/`; the CLI is also the subject of the skill |

## One command each, waiting on a login (run these yourself)

| # | Marketplace | Command |
| --- | --- | --- |
| 5 | **npm 0.2.0** (the version that carries the skill) | `cd ~/projects/tmux-terminals && npm login && npm publish` — the token in `~/.npmrc` returned 401, so the publish of 0.2.0 is pending |
| 6 | **ClawHub** (OpenClaw skills registry, <https://clawhub.ai>) | `npx clawhub login` (device flow) then `cd ~/projects/tmux-terminals && npx clawhub skill publish ./skills/tmux-terminals --slug tmux-terminals --version 0.2.0`; afterwards `clawhub install tmux-terminals` works for everyone |
| 7 | **claude-plugins.dev** (community registry + `skills-installer` CLI) | automatic: their crawler indexes public GitHub repos that have `skills/*/SKILL.md` or `.claude-plugin/*`. Check <https://claude-plugins.dev/api/skills?q=tmux-terminals>; once indexed the install line is `npx skills-installer install @axoinsights/tmux-terminals/tmux-terminals` |

## Needs a human submission (they gate entry)

| # | Marketplace | How |
| --- | --- | --- |
| 8 | **Anthropic official plugin directory** (shows up in `claude plugin marketplace`'s built-in `anthropic-plugin-directory`) | submission form: <https://clau.de/plugin-directory-submission>. Say: external plugin, source `https://github.com/axoinsights/tmux-terminals` (`.claude-plugin/plugin.json` at the root, one skill, no MCP server, no hooks), MIT, homepage `terminals.axoinsights.com`. Expect a security review: the plugin is instructions + one read-only script, but the *tool* it installs opens a shell behind a token, so say that plainly rather than letting them find it |
| 9 | **`anthropics/skills`** (Anthropic's own skills repo, also indexed by skills.sh) | issue/PR proposing the skill; weaker fit than the plugin directory because they keep first-party skills there |
| 10 | **`sickn33/agentic-awesome-skills`** (~49k stars, indexed by skills.sh) | PR adding `skills/tmux-terminals/SKILL.md` per their `CONTRIBUTING.md` (start from `docs/contributors/skill-template.md`, run `npm run validate`). Copy the skill directory; keep the reference files next to it |
| 11 | **`hesreallyhim/awesome-claude-code`** (~57k stars) | their rule: 14 days old **and** actively developed, or 100+ stars, and one recommendation per person at a time. First commit was 2026-11-03, so submit from ~2026-11-17 using their issue form template (a plain PR gets closed) |
| 12 | **`travisvn/awesome-claude-skills`**, **`VoltAgent/awesome-claude-code-subagents`** | plain PR adding a row/link; lists like these accept the GitHub URL + one-line description |

## Not a fit yet

- **Smithery / Glama / mcp.so** are MCP-server registries. tmux-terminals is an HTTP + WebSocket
  server, not an MCP server. If we ever wrap it (`tmux-terminals mcp` exposing
  `list_sessions`, `spawn`, `send`, `read_screen`), those registries open up and the same
  `SKILL.md` keeps working as the instructions layer. Worth ~150 lines in `src/mcp.ts` if the
  phone UI turns out not to be the only wanted interface.
- **VS Code / JetBrains / Cursor marketplaces** — nothing to install there; the client is a browser.
- **`skills.sh` "official" / packs** — they curate; a `npx skills add` listing plus good install
  counts is the practical path, then they pick up notable repos themselves.

## Keeping the listings honest

When the version moves, update in one commit: `package.json` version, `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`, `CHANGELOG.md`, then `npm publish`, `git tag -a v<ver>`,
`npx clawhub skill publish …`, and push (GitHub / skills.sh / claude-plugins.dev then follow
automatically).
