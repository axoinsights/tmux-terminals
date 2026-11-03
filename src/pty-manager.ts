/**
 * Session manager: every session is a tmux session on a dedicated tmux socket, and the node-pty process is only a
 * tmux *attach client*. Closing a browser tab, restarting this server or losing wifi never kills an agent: on the
 * next start the surviving tmux sessions are re-attached ("adopted"). Only an explicit kill ends one.
 *
 * Optional `groups`: other tmux sockets whose sessions are shown (attachable, typeable) as their own sidebar group.
 */
import * as pty from "@homebridge/node-pty-prebuilt-multiarch";
import * as os from "node:os";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { which, type AgentDef, type GroupDef } from "./config.js";
import type { PtySessionInfo } from "./protocol.js";

export type { PtySessionInfo };

interface ProcInfo { pid: number; ppid: number; sid: number; start: string }

interface PtySession extends PtySessionInfo {
  proc: pty.IPty;
  scrollback: string;
  lastInputAt: number;
  killTimer?: NodeJS.Timeout;
  tracked?: ProcInfo[];
  tmuxName: string;
  tmuxSocket: string;
  panePid?: number;
  killRequested?: boolean;
  detaching?: boolean;
  reattaches?: number;
}

export interface PtyManagerOptions {
  tmuxSocket: string;
  agents: AgentDef[];
  groups: GroupDef[];
  stateDir: string;
  /** Poll interval for watched groups (ms). */
  groupPollMs?: number;
  tmuxConf?: string;
}

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KILL_GRACE_MS = 3000;
const SCROLLBACK_MAX_CHARS = 300_000;
const ATTACH_TAIL_CHARS = 50_000;
const EXITED_SCROLLBACK_TAIL_CHARS = 5_000;
const REAP_AFTER_MS = 30 * 60 * 1000;
const REAP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_REATTACHES = 3;
const NAME_RE = /^at-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const GROUP_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
// DEC private modes worth carrying over a truncated scrollback head (cursor keys/visibility, mouse, focus, alt screen, paste).
const REPLAY_MODES = new Set(["1", "25", "1000", "1002", "1003", "1004", "1005", "1006", "1015", "47", "1047", "1049", "2004"]);

// ─── process-tree helpers (Linux /proc; harmless no-ops elsewhere) ───
function readProcs(): ProcInfo[] {
  const out: ProcInfo[] = [];
  let names: string[];
  try { names = fs.readdirSync("/proc"); } catch { return out; }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${n}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      out.push({ pid: Number(n), ppid: Number(rest[1]), sid: Number(rest[3]), start: rest[19] });
    } catch { /* process vanished */ }
  }
  return out;
}

function collectTree(leader: number): ProcInfo[] {
  const procs = readProcs();
  const keep = new Map<number, ProcInfo>();
  for (const p of procs) if (p.sid === leader && p.pid !== leader) keep.set(p.pid, p);
  const kids = new Map<number, ProcInfo[]>();
  for (const p of procs) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)!).push(p);
  const stack = [leader];
  while (stack.length) {
    for (const c of kids.get(stack.pop()!) ?? []) {
      if (!keep.has(c.pid)) { keep.set(c.pid, c); stack.push(c.pid); }
    }
  }
  return [...keep.values()];
}

/** Signal a process group plus a tracked tree (only pids whose start time still matches, so a recycled pid is never hit). */
function signalGroup(pid: number, sig: NodeJS.Signals, tracked: ProcInfo[] = []): void {
  if (!(pid > 1)) return; // kill(-0) would signal OUR OWN process group
  try { process.kill(-pid, sig); } catch { /* no such group */ }
  const live = new Map(readProcs().map((p) => [p.pid, p.start]));
  for (const t of tracked) {
    if (live.get(t.pid) !== t.start) continue;
    try { process.kill(t.pid, sig); } catch { /* already gone */ }
  }
}

function trimSafe(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  let cut = s.length - maxChars;
  const code = s.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) cut++; // do not start in the middle of a surrogate pair
  return s.slice(cut);
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

type DataListener = (id: string, chunk: string) => void;
type ExitListener = (id: string, code: number) => void;
interface RegistryEntry { id: string; agent: string; cwd: string; title: string; titleCustom?: boolean; startedAt: number }

export class PtyManager {
  private sessions = new Map<string, PtySession>();
  private dataListeners = new Set<DataListener>();
  private exitListeners = new Set<ExitListener>();
  private tmuxBin: string | null;
  private readonly socket: string;
  private readonly agents: Map<string, AgentDef>;
  private readonly groups: GroupDef[];
  private readonly registryFile: string;
  private readonly orderFile: string;
  private readonly tmuxConf: string;
  private readonly groupPollMs: number;
  private order: string[] = [];
  private timers: NodeJS.Timeout[] = [];

  constructor(opts: PtyManagerOptions) {
    this.socket = opts.tmuxSocket;
    if (!this.socket || this.socket === "default") throw new Error('refusing to use the default tmux socket; set tmuxSocket to a dedicated name');
    this.agents = new Map(opts.agents.map((a) => [a.id, a]));
    this.groups = opts.groups;
    this.registryFile = path.join(opts.stateDir, "sessions.json");
    this.orderFile = path.join(opts.stateDir, "order.json");
    this.tmuxConf = opts.tmuxConf ?? path.join(PKG_ROOT, "tmux.conf");
    this.groupPollMs = opts.groupPollMs ?? 3000;
    this.tmuxBin = which("tmux");
    fs.mkdirSync(opts.stateDir, { recursive: true, mode: 0o700 });
    this.order = this.loadOrder();
    const t = setInterval(() => this.reap(), REAP_INTERVAL_MS);
    t.unref();
    this.timers.push(t);
  }

  get hasTmux(): boolean { return this.tmuxBin !== null; }

  // ─── tmux plumbing ───
  private tmux(args: string[], socket = this.socket): { ok: boolean; out: string } {
    const r = spawnSync(this.tmuxBin!, ["-L", socket, ...args], { encoding: "utf8", timeout: 5000, env: this.cleanEnv() });
    return { ok: r.status === 0, out: (r.stdout || "").trim() };
  }

  /** Env for tmux and everything it starts: ours minus AGENT_TERMINAL_*, TMUX*. */
  cleanEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (k.startsWith("AGENT_TERMINAL_") || k === "TMUX" || k === "TMUX_PANE") continue;
      env[k] = v;
    }
    env.TERM = "xterm-256color";
    return env;
  }

  /** Start the tmux server if needed, outside this service's cgroup when running under systemd (a restart would kill it otherwise). */
  private ensureTmuxServer(): void {
    if (this.tmux(["show-options", "-gs", "escape-time"]).ok) return;
    const start = ["-L", this.socket, "-f", this.tmuxConf, "start-server"];
    const env = this.cleanEnv();
    let r = { status: 1 as number | null };
    if (process.env.INVOCATION_ID && which("systemd-run")) {
      r = spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", this.tmuxBin!, ...start], { timeout: 8000, env });
    }
    if (r.status !== 0) spawnSync(this.tmuxBin!, start, { timeout: 8000, env });
    for (let i = 0; i < 30 && !this.tmux(["show-options", "-gs", "escape-time"]).ok; i++) sleepMs(100);
  }

  private paneOf(name: string, socket: string): number | undefined {
    const pid = Number(this.tmux(["list-panes", "-t", "=" + name, "-F", "#{pane_pid}"], socket).out.split("\n")[0]);
    return pid > 0 ? pid : undefined;
  }

  // ─── persistence ───
  private saveRegistry(): void {
    const entries: RegistryEntry[] = [...this.sessions.values()]
      .filter((s) => s.status === "running" && !s.group)
      .map((s) => ({ id: s.id, agent: s.agent, cwd: s.cwd, title: s.title, titleCustom: s.titleCustom, startedAt: s.startedAt }));
    try {
      fs.writeFileSync(`${this.registryFile}.tmp`, JSON.stringify(entries, null, 1), { mode: 0o600 });
      fs.renameSync(`${this.registryFile}.tmp`, this.registryFile);
    } catch (e) { console.warn(`[pty] could not write ${this.registryFile}: ${(e as Error).message}`); }
  }

  private loadRegistry(): Map<string, RegistryEntry> {
    try {
      const arr = JSON.parse(fs.readFileSync(this.registryFile, "utf8")) as RegistryEntry[];
      return new Map(arr.filter((e) => e && typeof e.id === "string").map((e) => [e.id, e]));
    } catch { return new Map(); }
  }

  /** Startup: re-attach to every surviving `at-*` tmux session. Returns how many were adopted. */
  adoptExisting(): number {
    if (!this.tmuxBin) return 0;
    const listed = this.tmux(["list-sessions", "-F", "#{session_name} #{window_width} #{window_height}"]);
    if (!listed.ok) { this.saveRegistry(); return 0; }
    const reg = this.loadRegistry();
    let n = 0;
    for (const line of listed.out.split("\n")) {
      const [name, w, h] = line.split(" ");
      const m = NAME_RE.exec(name || "");
      if (!m || this.sessions.has(m[1])) continue;
      const id = m[1];
      const meta = reg.get(id);
      const cwd = meta?.cwd || this.tmux(["display-message", "-p", "-t", "=" + name, "#{pane_current_path}"]).out || os.homedir();
      const agent = meta?.agent || "shell";
      const cols = Number(w) || 100, rows = Number(h) || 30;
      try {
        const proc = pty.spawn(this.tmuxBin, ["-L", this.socket, "attach-session", "-t", "=" + name], { name: "xterm-256color", cols, rows, cwd: os.homedir(), env: this.cleanEnv() });
        const session: PtySession = {
          id, agent, cwd,
          title: meta?.title || this.defaultTitle(agent, cwd),
          titleCustom: meta?.titleCustom,
          status: "running",
          startedAt: meta?.startedAt || Date.now(),
          lastOutputAt: Date.now(),
          cols, rows, proc, scrollback: "", lastInputAt: Date.now(), tmuxName: name, tmuxSocket: this.socket,
        };
        this.sessions.set(id, session);
        this.wire(session);
        n++;
      } catch (e) { console.warn(`[pty] could not adopt ${name}: ${(e as Error).message}`); }
    }
    this.saveRegistry();
    this.pruneOrder();
    return n;
  }

  private defaultTitle(agent: string, cwd: string): string {
    const label = this.agents.get(agent)?.label ?? agent;
    return `${label}: ${cwd.replace(os.homedir(), "~")}`;
  }

  // ─── listeners / listing ───
  onData(fn: DataListener): void { this.dataListeners.add(fn); }
  onExit(fn: ExitListener): void { this.exitListeners.add(fn); }

  list(): PtySessionInfo[] {
    const idx = new Map(this.order.map((id, i) => [id, i]));
    return [...this.sessions.values()]
      .sort((a, b) => (idx.get(a.id) ?? Infinity) - (idx.get(b.id) ?? Infinity) || a.startedAt - b.startedAt)
      .map((s) => this.strip(s));
  }

  get(id: string): PtySessionInfo | undefined {
    const s = this.sessions.get(id);
    return s ? this.strip(s) : undefined;
  }

  // ─── shared sidebar order ───
  private loadOrder(): string[] {
    try {
      const a = JSON.parse(fs.readFileSync(this.orderFile, "utf8"));
      return Array.isArray(a?.order) ? a.order.filter((x: unknown) => typeof x === "string").slice(0, 500) : [];
    } catch { return []; }
  }
  private saveOrder(): void {
    try {
      fs.writeFileSync(`${this.orderFile}.tmp`, JSON.stringify({ version: 1, order: this.order }), { mode: 0o600 });
      fs.renameSync(`${this.orderFile}.tmp`, this.orderFile);
    } catch (e) { console.warn(`[pty] could not write ${this.orderFile}: ${(e as Error).message}`); }
  }
  private dropFromOrder(id: string): void {
    if (!this.order.includes(id)) return;
    this.order = this.order.filter((x) => x !== id);
    this.saveOrder();
  }
  /** Ids no live session has any more leave the order. */
  pruneOrder(): void {
    const live = new Set([...this.sessions.values()].filter((s) => s.status === "running").map((s) => s.id));
    const next = this.order.filter((id) => live.has(id));
    if (next.length !== this.order.length) { this.order = next; this.saveOrder(); }
  }
  /** A client reordered the sidebar. Unknown / ended ids are ignored; running sessions it left out keep their relative order after it. */
  setOrder(ids: unknown): boolean {
    if (!Array.isArray(ids) || ids.length > 500 || !ids.every((x) => typeof x === "string" && x.length <= 80)) return false;
    const running = (id: string) => this.sessions.get(id)?.status === "running";
    const want = [...new Set(ids as string[])].filter(running);
    const rest = this.list().map((s) => s.id).filter((id) => running(id) && !want.includes(id));
    this.order = [...want, ...rest];
    this.saveOrder();
    return true;
  }

  // ─── watched groups (other tmux sockets) ───
  /** Attach a client to every session on each group's socket that is not shown yet. Returns how many were added. */
  syncGroups(): number {
    if (!this.tmuxBin) return 0;
    let n = 0;
    const SEP = "|::|"; // tmux prints a tab (and, without a UTF-8 locale, non-ASCII) as "_"; -u keeps titles intact
    this.groups.forEach((g, gi) => {
      const listed = this.tmux(["-u", "list-sessions", "-F", ["#{session_name}", "#{window_width}", "#{window_height}", "#{session_created}", "#{pane_current_path}", "#{@agent_terminal_title}"].join(SEP)], g.socket);
      if (!listed.ok) return;
      for (const line of listed.out.split("\n")) {
        const [name, w, h, created, cwd, ...t] = line.split(SEP), title = t.join(SEP);
        if (!GROUP_NAME_RE.test(name || "")) continue;
        const id = `g${gi}-${name}`;
        const cur = this.sessions.get(id);
        if (cur && cur.status === "running") { if (title && !cur.titleCustom && cur.title !== title) cur.title = title.slice(0, 80); continue; }
        const cols = Number(w) || 120, rows = Number(h) || 40;
        try {
          const proc = pty.spawn(this.tmuxBin!, ["-L", g.socket, "attach-session", "-t", "=" + name], { name: "xterm-256color", cols, rows, cwd: os.homedir(), env: this.cleanEnv() });
          const session: PtySession = {
            id, agent: "", cwd: cwd || os.homedir(), title: (title || name).slice(0, 80), group: g.label,
            status: "running", startedAt: Number(created) > 0 ? Number(created) * 1000 : Date.now(), lastOutputAt: Date.now(),
            cols, rows, proc, scrollback: "", lastInputAt: Date.now(), tmuxName: name, tmuxSocket: g.socket,
          };
          this.sessions.set(id, session);
          this.wire(session);
          n++;
        } catch (e) { console.warn(`[pty] could not attach ${g.label}/${name}: ${(e as Error).message}`); }
      }
    });
    return n;
  }
  /** Poll the groups' sockets so a new session shows up in every open sidebar. `onNew` fires when the list changed. */
  watchGroups(onNew: () => void): void {
    if (!this.tmuxBin || this.groups.length === 0) return;
    const tick = () => { try { if (this.syncGroups() > 0) onNew(); } catch { /* tmux hiccup */ } };
    tick();
    const t = setInterval(tick, this.groupPollMs);
    t.unref();
    this.timers.push(t);
  }

  // ─── scrollback ───
  /** Tail of the scrollback for a (re)attaching client, with the terminal modes the dropped head switched on replayed as a prefix. */
  getScrollbackTail(id: string, maxChars = ATTACH_TAIL_CHARS): { data: string; truncated: boolean } {
    const full = this.sessions.get(id)?.scrollback ?? "";
    if (full.length <= maxChars) return { data: full, truncated: false };
    const tail = trimSafe(full, maxChars);
    const head = full.slice(0, full.length - tail.length);
    const modes = new Map<string, string>();
    for (const m of head.matchAll(/\x1b\[\?(\d+)([hl])/g)) {
      if (REPLAY_MODES.has(m[1])) modes.set(m[1], m[2]);
    }
    let prefix = "";
    for (const [mode, state] of modes) prefix += `\x1b[?${mode}${state}`;
    return { data: prefix + tail, truncated: true };
  }

  // ─── spawn / control ───
  /** Absolute path of an agent's command, or null if it is not installed. */
  resolveAgentCommand(agent: AgentDef): string | null {
    return which(expandHome(agent.command));
  }

  spawn(agentId: string, cwd: string, cols = 80, rows = 24, resume = false): PtySessionInfo {
    if (!this.tmuxBin) throw new Error("tmux is not installed");
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Unknown agent "${String(agentId).slice(0, 40)}"`);
    const wanted = typeof cwd === "string" && cwd.trim() ? expandHome(cwd.trim()) : os.homedir();
    if (!path.isAbsolute(wanted)) throw new Error("Working directory must be an absolute path (or start with ~)");
    let resolvedCwd: string;
    try {
      resolvedCwd = fs.realpathSync(wanted);
      if (!fs.statSync(resolvedCwd).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Error(`Working directory does not exist: ${wanted}`);
    }
    const bin = this.resolveAgentCommand(agent);
    if (!bin) throw new Error(`Command '${agent.command}' for agent '${agent.id}' was not found on PATH`);
    const args = resume && agent.resumeArgs.length ? [...agent.args, ...agent.resumeArgs] : agent.args;
    const c = Math.min(Math.max(Math.floor(cols) || 80, 2), 1000), r = Math.min(Math.max(Math.floor(rows) || 24, 2), 1000);
    const id = crypto.randomUUID();
    const tmuxName = `at-${id}`;
    const env = this.cleanEnv();
    this.ensureTmuxServer();
    let proc: pty.IPty;
    try {
      // -e PATH: the tmux server may be older than this process, so hand it the current PATH explicitly.
      proc = pty.spawn(this.tmuxBin, [
        "-L", this.socket, "-f", this.tmuxConf, "new-session", "-A", "-s", tmuxName, "-c", resolvedCwd,
        "-e", `PATH=${env.PATH ?? ""}`, bin, ...args,
      ], { name: "xterm-256color", cols: c, rows: r, cwd: resolvedCwd, env });
    } catch (e) {
      throw new Error(`Failed to start '${agent.command}': ${(e as Error).message}`);
    }
    const session: PtySession = {
      id, agent: agent.id, cwd: resolvedCwd, title: this.defaultTitle(agent.id, resolvedCwd),
      status: "running", startedAt: Date.now(), lastOutputAt: Date.now(), cols: c, rows: r,
      proc, scrollback: "", lastInputAt: Date.now(), tmuxName, tmuxSocket: this.socket,
    };
    this.sessions.set(id, session);
    this.wire(session);
    this.saveRegistry();
    return this.strip(session);
  }

  /** Sets a user-chosen title (control chars stripped; empty resets to the default). False on unknown id or an over-long title. */
  rename(id: string, title: string): boolean {
    const s = this.sessions.get(id);
    if (!s || typeof title !== "string") return false;
    const clean = title.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
    if (clean.length > 80) return false;
    if (clean) { s.title = clean; s.titleCustom = true; }
    else { s.title = s.group ? s.tmuxName : this.defaultTitle(s.agent, s.cwd); delete s.titleCustom; }
    this.saveRegistry();
    return true;
  }

  private spawnAttach(session: PtySession): pty.IPty {
    return pty.spawn(this.tmuxBin!, ["-L", session.tmuxSocket, "attach-session", "-t", "=" + session.tmuxName], {
      name: "xterm-256color", cols: session.cols, rows: session.rows, cwd: os.homedir(), env: this.cleanEnv(),
    });
  }

  private wire(session: PtySession): void {
    const id = session.id;
    const proc = session.proc;
    proc.onData((chunk) => {
      session.lastOutputAt = Date.now();
      session.scrollback += chunk;
      if (session.scrollback.length > SCROLLBACK_MAX_CHARS) session.scrollback = trimSafe(session.scrollback, SCROLLBACK_MAX_CHARS);
      for (const fn of this.dataListeners) fn(id, chunk);
    });
    proc.onExit(({ exitCode }) => {
      if (session.proc !== proc) return; // superseded by a re-attach
      if (session.killTimer) clearTimeout(session.killTimer);
      if (session.detaching) return; // server shutdown: the agent lives on in tmux
      // The attach client died but the tmux session didn't (killed client, tmux hiccup): re-attach.
      if (!session.killRequested && (session.reattaches ?? 0) < MAX_REATTACHES && this.tmux(["has-session", "-t", "=" + session.tmuxName], session.tmuxSocket).ok) {
        session.reattaches = (session.reattaches ?? 0) + 1;
        try {
          session.proc = this.spawnAttach(session);
          this.wire(session);
          return;
        } catch { /* fall through to tombstone */ }
      }
      if (session.killRequested && session.panePid && session.tracked?.length) signalGroup(session.panePid, "SIGKILL", session.tracked);
      session.status = "exited";
      session.exitCode = exitCode;
      session.exitedAt = Date.now();
      session.scrollback = trimSafe(session.scrollback, EXITED_SCROLLBACK_TAIL_CHARS);
      this.saveRegistry();
      this.dropFromOrder(id);
      for (const fn of this.exitListeners) fn(id, exitCode);
    });
  }

  write(id: string, data: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.status !== "running" || typeof data !== "string") return false;
    s.lastInputAt = Date.now();
    s.proc.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const s = this.sessions.get(id);
    if (!s || s.status !== "running") return false;
    if (!(cols >= 2 && rows >= 2 && cols <= 1000 && rows <= 1000)) return false;
    try {
      s.proc.resize(Math.floor(cols), Math.floor(rows));
      s.cols = Math.floor(cols);
      s.rows = Math.floor(rows);
      return true;
    } catch { return false; }
  }

  /** The one operation that ends an agent: destroys its tmux session, then SIGHUP, then SIGKILL after a grace period. */
  kill(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.status === "running" && !s.killTimer) {
      s.killRequested = true;
      s.panePid = this.paneOf(s.tmuxName, s.tmuxSocket);
      const pid = s.panePid ?? s.proc.pid;
      s.tracked = s.panePid ? collectTree(s.panePid) : [];
      this.tmux(["kill-session", "-t", "=" + s.tmuxName], s.tmuxSocket);
      signalGroup(pid, "SIGHUP", s.tracked);
      s.killTimer = setTimeout(() => {
        s.tracked = [...(s.tracked ?? []), ...collectTree(pid)];
        signalGroup(pid, "SIGKILL", s.tracked);
        try { s.proc.kill("SIGKILL"); } catch { /* already gone */ }
      }, KILL_GRACE_MS);
      s.killTimer.unref();
      // Not deleted here: proc.onExit tombstones it, so every client sees status "exited".
    }
    return true;
  }

  /** Server shutdown: only DETACH (end the tmux attach clients). The agents keep running for the next start to adopt. */
  detachAll(): void {
    for (const t of this.timers) clearInterval(t);
    for (const s of this.sessions.values()) {
      if (s.status !== "running") continue;
      s.detaching = true;
      try { s.proc.kill(); } catch { /* already gone */ }
    }
  }

  private reap(): void {
    const cutoff = Date.now() - REAP_AFTER_MS;
    for (const [id, s] of this.sessions) {
      if (s.status === "exited" && (s.exitedAt ?? 0) < cutoff) this.sessions.delete(id);
    }
  }

  private strip(s: PtySession): PtySessionInfo {
    const { proc, scrollback, lastInputAt, killTimer, tracked, tmuxName, tmuxSocket, killRequested, detaching, reattaches, panePid, ...info } = s;
    void proc; void scrollback; void lastInputAt; void killTimer; void tracked; void tmuxName; void tmuxSocket; void killRequested; void detaching; void reattaches; void panePid;
    return info;
  }
}
