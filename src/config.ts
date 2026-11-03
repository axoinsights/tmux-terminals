/**
 * Configuration: CLI flags > AGENT_TERMINAL_* env vars > <configDir>/config.json > defaults.
 * The config file is created on first run (mode 600) and holds the generated access token.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

export interface AgentDef {
  id: string;
  label: string;
  command: string;
  args: string[];
  resumeArgs: string[];
}
export interface GroupDef {
  label: string;
  socket: string;
}
export type TlsSetting = "auto" | "off" | { cert: string; key: string };

export interface Config {
  host: string;
  port: number;
  token: string;
  tls: TlsSetting;
  agents: AgentDef[];
  tmuxSocket: string;
  groups: GroupDef[];
  transcribeUrl?: string;
  transcribeModel: string;
  transcribeApiKey?: string;
  cwdPresets: string[];
}

export interface LoadedConfig {
  config: Config;
  configDir: string;
  configFile: string;
  /** Where the order file and session registry live (default: configDir). */
  stateDir: string;
  /** True when this call generated the token and wrote a new config file. */
  firstRun: boolean;
  /** Where the token came from. */
  tokenSource: "flag" | "env" | "file" | "generated";
}

export class ConfigError extends Error {}

export const DEFAULTS = {
  host: "127.0.0.1",
  port: 8767,
  tls: "auto" as TlsSetting,
  tmuxSocket: "agent-terminal",
  transcribeModel: "whisper-1",
};

export type Flags = Partial<{
  host: string;
  port: string;
  tls: string;
  "tmux-socket": string;
  "config-dir": string;
}>;

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SOCKET_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function configDirFor(env: NodeJS.ProcessEnv, flags: Flags = {}): string {
  if (flags["config-dir"]) return path.resolve(flags["config-dir"]);
  if (env.AGENT_TERMINAL_CONFIG_DIR) return path.resolve(env.AGENT_TERMINAL_CONFIG_DIR);
  const base = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(os.homedir(), ".config");
  return path.join(base, "agent-terminal");
}

/** First executable named `cmd` on PATH (or `cmd` itself when it contains a slash). */
export function which(cmd: string, envPath: string | undefined = process.env.PATH): string | null {
  const isExec = (p: string) => {
    try {
      if (!fs.statSync(p).isFile()) return false;
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (cmd.includes("/")) return isExec(cmd) ? cmd : null;
  for (const dir of (envPath || "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    if (isExec(p)) return p;
  }
  return null;
}

export function defaultAgents(env: NodeJS.ProcessEnv = process.env, find: (c: string) => string | null = (c) => which(c, env.PATH)): AgentDef[] {
  const shell = env.SHELL && path.isAbsolute(env.SHELL) && find(env.SHELL) ? env.SHELL : find("bash") ? "bash" : "sh";
  const agents: AgentDef[] = [{ id: "shell", label: "Shell", command: shell, args: [], resumeArgs: [] }];
  const optional: AgentDef[] = [
    { id: "claude", label: "Claude Code", command: "claude", args: [], resumeArgs: ["--continue"] },
    { id: "codex", label: "Codex", command: "codex", args: [], resumeArgs: ["resume", "--last"] },
    { id: "aider", label: "aider", command: "aider", args: [], resumeArgs: ["--restore-chat-history"] },
  ];
  for (const a of optional) if (find(a.command)) agents.push(a);
  return agents;
}

function strArray(v: unknown, what: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new ConfigError(`${what} must be an array of strings`);
  return v as string[];
}

export function validateAgents(raw: unknown): AgentDef[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ConfigError("agents must be a non-empty array");
  const seen = new Set<string>();
  return raw.map((a, i) => {
    if (!a || typeof a !== "object") throw new ConfigError(`agents[${i}] must be an object`);
    const o = a as Record<string, unknown>;
    if (typeof o.id !== "string" || !ID_RE.test(o.id)) throw new ConfigError(`agents[${i}].id must match ${ID_RE}`);
    if (seen.has(o.id)) throw new ConfigError(`duplicate agent id "${o.id}"`);
    seen.add(o.id);
    if (typeof o.command !== "string" || !o.command.trim()) throw new ConfigError(`agents[${i}].command must be a non-empty string`);
    const label = o.label === undefined ? o.id : o.label;
    if (typeof label !== "string" || !label.trim() || label.length > 40) throw new ConfigError(`agents[${i}].label must be a string of 1-40 chars`);
    return { id: o.id, label, command: o.command, args: strArray(o.args, `agents[${i}].args`), resumeArgs: strArray(o.resumeArgs, `agents[${i}].resumeArgs`) };
  });
}

export function validateSocket(name: unknown, what: string): string {
  if (typeof name !== "string" || !SOCKET_RE.test(name)) throw new ConfigError(`${what} must match ${SOCKET_RE} (a tmux -L socket name, not a path)`);
  if (name === "default") throw new ConfigError(`${what} must not be "default": that is your own tmux server, which agent-terminal never touches`);
  return name;
}

function validateGroups(raw: unknown, mainSocket: string): GroupDef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ConfigError("groups must be an array of { label, socket }");
  const labels = new Set<string>();
  return raw.map((g, i) => {
    const o = (g ?? {}) as Record<string, unknown>;
    if (typeof o.label !== "string" || !o.label.trim() || o.label.length > 40) throw new ConfigError(`groups[${i}].label must be a string of 1-40 chars`);
    if (labels.has(o.label)) throw new ConfigError(`duplicate group label "${o.label}"`);
    labels.add(o.label);
    const socket = validateSocket(o.socket, `groups[${i}].socket`);
    if (socket === mainSocket) throw new ConfigError(`groups[${i}].socket equals tmuxSocket; use a different tmux server`);
    return { label: o.label, socket };
  });
}

function parsePort(v: unknown, what: string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ConfigError(`${what} must be an integer 1-65535 (got ${JSON.stringify(v)})`);
  return n;
}

function parseTls(v: unknown, what: string): TlsSetting {
  if (v === "auto" || v === "off") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.cert === "string" && typeof o.key === "string") return { cert: path.resolve(o.cert), key: path.resolve(o.key) };
  }
  if (typeof v === "string" && v.includes(",")) {
    const [cert, key] = v.split(",");
    if (cert && key) return { cert: path.resolve(cert), key: path.resolve(key) };
  }
  throw new ConfigError(`${what} must be "auto", "off", or { "cert": "/path.pem", "key": "/path.key" } (flag form: cert.pem,key.pem)`);
}

function parseJsonEnv(name: string, v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    throw new ConfigError(`${name} must be valid JSON`);
  }
}

export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);
}

export function newToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export interface LoadOptions {
  flags?: Flags;
  env?: NodeJS.ProcessEnv;
  /** Create the config dir/file (and token) when missing. Default true; `doctor` passes false. */
  create?: boolean;
  find?: (cmd: string) => string | null;
}

export function loadConfig(opts: LoadOptions = {}): LoadedConfig {
  const env = opts.env ?? process.env;
  const flags = opts.flags ?? {};
  const create = opts.create ?? true;
  const configDir = configDirFor(env, flags);
  const configFile = path.join(configDir, "config.json");

  let file: Record<string, unknown> = {};
  let fileExists = false;
  try {
    const text = fs.readFileSync(configFile, "utf8");
    fileExists = true;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    file = parsed as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new ConfigError(`cannot read ${configFile}: ${(e as Error).message}`);
  }

  const pick = <T>(flag: T | undefined, envName: string, key: string): { v: unknown; from: string } | undefined => {
    if (flag !== undefined) return { v: flag, from: "flag" };
    if (env[envName] !== undefined && env[envName] !== "") return { v: env[envName], from: "env" };
    if (file[key] !== undefined) return { v: file[key], from: "file" };
    return undefined;
  };

  const host = (pick(flags.host, "AGENT_TERMINAL_HOST", "host")?.v ?? DEFAULTS.host) as string;
  if (typeof host !== "string" || !host.trim()) throw new ConfigError("host must be a non-empty string");
  const port = parsePort(pick(flags.port, "AGENT_TERMINAL_PORT", "port")?.v ?? DEFAULTS.port, "port");
  const tlsPick = pick(flags.tls, "AGENT_TERMINAL_TLS", "tls");
  const tls = tlsPick ? parseTls(tlsPick.v, "tls") : DEFAULTS.tls;
  const tmuxSocket = validateSocket(pick(flags["tmux-socket"], "AGENT_TERMINAL_TMUX_SOCKET", "tmuxSocket")?.v ?? DEFAULTS.tmuxSocket, "tmuxSocket");

  let agentsRaw: unknown;
  if (env.AGENT_TERMINAL_AGENTS) agentsRaw = parseJsonEnv("AGENT_TERMINAL_AGENTS", env.AGENT_TERMINAL_AGENTS);
  else if (file.agents !== undefined) agentsRaw = file.agents;
  const agents = agentsRaw === undefined ? defaultAgents(env, opts.find) : validateAgents(agentsRaw);

  let groupsRaw: unknown = file.groups;
  if (env.AGENT_TERMINAL_GROUPS) groupsRaw = parseJsonEnv("AGENT_TERMINAL_GROUPS", env.AGENT_TERMINAL_GROUPS);
  const groups = validateGroups(groupsRaw, tmuxSocket);

  let cwdPresets: string[] = ["~"];
  if (env.AGENT_TERMINAL_CWD_PRESETS) cwdPresets = env.AGENT_TERMINAL_CWD_PRESETS.split(",").map((s) => s.trim()).filter(Boolean);
  else if (file.cwdPresets !== undefined) cwdPresets = strArray(file.cwdPresets, "cwdPresets");

  const transcribeUrl = (env.AGENT_TERMINAL_TRANSCRIBE_URL || (file.transcribeUrl as string | undefined)) || undefined;
  if (transcribeUrl !== undefined && !/^https?:\/\//.test(String(transcribeUrl))) throw new ConfigError("transcribeUrl must be an http(s) URL");
  const transcribeModel = String(env.AGENT_TERMINAL_TRANSCRIBE_MODEL || file.transcribeModel || DEFAULTS.transcribeModel);
  const transcribeApiKey = (env.AGENT_TERMINAL_TRANSCRIBE_API_KEY || (file.transcribeApiKey as string | undefined)) || undefined;

  // Token: env > file > generated. (Never a flag: argv is visible in `ps`.)
  let token = "";
  let tokenSource: LoadedConfig["tokenSource"] = "generated";
  if (env.AGENT_TERMINAL_TOKEN) {
    token = env.AGENT_TERMINAL_TOKEN;
    tokenSource = "env";
  } else if (typeof file.token === "string" && file.token) {
    token = file.token;
    tokenSource = "file";
  }
  if (token && token.length < 16) throw new ConfigError("token must be at least 16 characters (delete it from the config file to generate a strong one)");

  let firstRun = false;
  if (!token) {
    token = newToken();
    firstRun = true;
    if (create) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      const initial = { ...file, host: file.host ?? DEFAULTS.host, port: file.port ?? DEFAULTS.port, tls: file.tls ?? DEFAULTS.tls, tmuxSocket: file.tmuxSocket ?? DEFAULTS.tmuxSocket, token };
      const tmp = `${configFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(initial, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, configFile);
    }
  } else if (!fileExists && create && tokenSource === "env") {
    // Token supplied by env only: still create the dir so state files have a home, but do not persist the token.
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }

  const stateDir = path.resolve(env.AGENT_TERMINAL_STATE_DIR || configDir);
  return {
    config: { host, port, token, tls, agents, tmuxSocket, groups, transcribeUrl, transcribeModel, transcribeApiKey, cwdPresets },
    configDir,
    configFile,
    stateDir,
    firstRun,
    tokenSource,
  };
}
