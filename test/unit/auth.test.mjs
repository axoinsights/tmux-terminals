import test from "node:test";
import assert from "node:assert/strict";
import { Authenticator, extractToken, safeEqual, parseCookies } from "../../dist/auth.js";

const req = (o = {}) => ({ headers: o.headers ?? {}, url: o.url ?? "/" });

test("safeEqual compares correctly regardless of length", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", "x"), false);
});

test("token is read from Bearer header, cookie or query", () => {
  assert.deepEqual(extractToken(req({ headers: { authorization: "Bearer tok1" } })), { token: "tok1", via: "bearer" });
  assert.deepEqual(extractToken(req({ headers: { cookie: "a=1; at_auth=tok2; b=3" } })), { token: "tok2", via: "cookie" });
  assert.deepEqual(extractToken(req({ url: "/?x=1&token=tok3" })), { token: "tok3", via: "query" });
  assert.deepEqual(extractToken(req()), { token: null, via: null });
  assert.deepEqual(parseCookies("a=%20b; c=d"), { a: " b", c: "d" });
});

test("a correct token is accepted from any address, including loopback (no localhost bypass)", () => {
  const a = new Authenticator("secret-token-123456");
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "203.0.113.9"]) {
    assert.equal(a.check(req(), ip).ok, false, `no token from ${ip} must be refused`);
    assert.equal(a.check(req({ headers: { authorization: "Bearer secret-token-123456" } }), ip).ok, true);
  }
});

test("wrong tokens are refused, then rate limited with growing backoff; the right token still works", () => {
  let now = 1_000_000;
  const a = new Authenticator("secret-token-123456", { freeFailures: 3, baseLockMs: 1000, now: () => now });
  const bad = req({ headers: { authorization: "Bearer nope" } });
  for (let i = 0; i < 3; i++) assert.deepEqual(a.check(bad, "1.1.1.1"), { ok: false, status: 401 });
  const fourth = a.check(bad, "1.1.1.1");
  assert.equal(fourth.status, 401); // this failure sets the first lock
  const locked = a.check(bad, "1.1.1.1");
  assert.equal(locked.ok, false);
  assert.equal(locked.status, 429);
  assert.ok(locked.retryAfter >= 1);
  assert.equal(a.check(bad, "2.2.2.2").status, 401, "other addresses are unaffected");
  assert.equal(a.check(req({ headers: { authorization: "Bearer secret-token-123456" } }), "1.1.1.1").ok, true, "the owner is never locked out");
  now += 5000;
  assert.equal(a.check(bad, "1.1.1.1").status, 401, "lock expires");
});

test("requests without credentials do not count as guesses", () => {
  const a = new Authenticator("secret-token-123456", { freeFailures: 1 });
  for (let i = 0; i < 10; i++) assert.equal(a.check(req(), "9.9.9.9").status, 401);
});
