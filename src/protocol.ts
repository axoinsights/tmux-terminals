/** WebSocket protocol between web/index.html and the server (JSON text frames, `/ws`). */

export interface PtySessionInfo {
  id: string;
  /** Agent id from config (`shell`, `claude`, ...). */
  agent: string;
  cwd: string;
  title: string;
  /** True once a user renamed it; lets the client tell a real name from the auto title. */
  titleCustom?: boolean;
  status: "running" | "exited";
  startedAt: number;
  /** Epoch ms of the last byte the process printed. */
  lastOutputAt: number;
  exitedAt?: number;
  exitCode?: number;
  cols: number;
  rows: number;
  /** Label of the configured `groups` entry this session belongs to (watched tmux socket). Absent for the main group. */
  group?: string;
}

export type ClientMessage =
  | { type: "pty_spawn"; agent: string; cwd: string; cols?: number; rows?: number; resume?: boolean }
  | { type: "pty_input"; sessionId: string; data: string }
  | { type: "pty_resize"; sessionId: string; cols: number; rows: number }
  | { type: "pty_kill"; sessionId: string }
  | { type: "pty_attach"; sessionId: string }
  | { type: "pty_detach"; sessionId: string }
  | { type: "pty_rename"; sessionId: string; title: string }
  | { type: "pty_order"; order: string[] }
  | { type: "pty_list" };

export type ServerMessage =
  | { type: "pty_list"; sessions: PtySessionInfo[] }
  | { type: "pty_spawned"; session: PtySessionInfo }
  | { type: "pty_output"; sessionId: string; data: string }
  | { type: "pty_exit"; sessionId: string; code: number }
  | { type: "pty_scrollback"; sessionId: string; data: string; truncated?: boolean }
  | { type: "pty_error"; message: string; sessionId?: string };
