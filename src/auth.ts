/**
 * Token authentication. The token is accepted from (in order) an `Authorization: Bearer` header,
 * the `tmux_terminals_auth` cookie, or a `?token=` query parameter. There is NO localhost exemption:
 * reverse proxies (tailscale serve, nginx, ...) connect from localhost.
 */
import * as crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

export const COOKIE_NAME = "tmux_terminals_auth";

/** Constant-time string compare (hash first so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export interface Credentials {
  token: string | null;
  via: "bearer" | "cookie" | "query" | null;
}

export function extractToken(req: Pick<IncomingMessage, "headers" | "url">): Credentials {
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return { token: auth.replace(/^Bearer\s+/i, "").trim(), via: "bearer" };
  const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (cookie) return { token: cookie, via: "cookie" };
  try {
    const q = new URL(req.url || "/", "http://x").searchParams.get("token");
    if (q) return { token: q, via: "query" };
  } catch {
    /* bad url */
  }
  return { token: null, via: null };
}

/** Every token the request presents, so a stale cookie never hides a fresh `?token=` (e.g. after rotating the token). */
export function allCredentials(req: Pick<IncomingMessage, "headers" | "url">): Array<{ token: string; via: NonNullable<Credentials["via"]> }> {
  const out: Array<{ token: string; via: NonNullable<Credentials["via"]> }> = [];
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) out.push({ token: auth.replace(/^Bearer\s+/i, "").trim(), via: "bearer" });
  const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (cookie) out.push({ token: cookie, via: "cookie" });
  try {
    const q = new URL(req.url || "/", "http://x").searchParams.get("token");
    if (q) out.push({ token: q, via: "query" });
  } catch {
    /* bad url */
  }
  return out;
}

export type AuthResult = { ok: true; via: NonNullable<Credentials["via"]> } | { ok: false; status: 401 | 429; retryAfter?: number };

interface Fail {
  count: number;
  lockedUntil: number;
  last: number;
}

/**
 * Verifies tokens and slows brute force: after `freeFailures` bad tokens from one address, further BAD tokens are
 * refused with 429 for an exponentially growing time. A correct token always passes, so an attacker behind the same
 * proxy address cannot lock the owner out.
 */
export class Authenticator {
  private fails = new Map<string, Fail>();
  constructor(
    private readonly token: string,
    private readonly opts: { freeFailures?: number; baseLockMs?: number; maxLockMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  check(req: Pick<IncomingMessage, "headers" | "url">, ip: string): AuthResult {
    const creds = allCredentials(req);
    const good = creds.find((c) => safeEqual(c.token, this.token));
    if (good) {
      this.fails.delete(ip);
      return { ok: true, via: good.via };
    }
    const cred = { token: creds.length ? creds[creds.length - 1].token : null };
    const now = this.now();
    const f = this.fails.get(ip);
    if (f && f.lockedUntil > now) return { ok: false, status: 429, retryAfter: Math.ceil((f.lockedUntil - now) / 1000) };
    // A request with no credentials at all is not a guess; only count attempts that presented a wrong token.
    if (!cred.token) return { ok: false, status: 401 };
    const free = this.opts.freeFailures ?? 5;
    const entry = f ?? { count: 0, lockedUntil: 0, last: now };
    entry.count++;
    entry.last = now;
    if (entry.count > free) {
      const lock = Math.min((this.opts.baseLockMs ?? 1000) * 2 ** (entry.count - free - 1), this.opts.maxLockMs ?? 300_000);
      entry.lockedUntil = now + lock;
    }
    this.fails.set(ip, entry);
    if (this.fails.size > 1000) this.prune(now);
    return { ok: false, status: 401 };
  }

  private prune(now: number): void {
    for (const [k, v] of this.fails) if (now - v.last > 3_600_000) this.fails.delete(k);
  }
}
