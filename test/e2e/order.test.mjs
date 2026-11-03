#!/usr/bin/env node
/**
 * Sidebar groups and drag-and-drop ordering, end to end.
 * Runs the REAL server on a random port with private tmux sockets (main + one watched "group" socket), a private config/state dir
 * and a logging tmux shim; drives web/index.html with Playwright: mouse drag on desktop, long-press drag with touch on a 360px phone
 * (CDP touch events), a quick swipe that must NOT reorder, move buttons, Alt+arrows, cross-group refusal, the order shared between two
 * devices (and kept across a reload), ES labels, attach + type into a watched-group session, new sessions at the end, ended ones dropping
 * out of the order. Screenshots: desktop + 360px, dark + light.
 * Run: PLAYWRIGHT_MODULE=$HOME/.npm-global/lib/node_modules/playwright/index.mjs node test/e2e/order.test.mjs [shotsDir=shots]
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT, TMUX_CONF as conf, cleanup, loadPlaywright, makeSandbox, sleep, startApp, tmux, until } from "./helpers.mjs";
const { chromium } = await loadPlaywright();

const OUT = path.resolve(process.argv[2] || path.join(ROOT, "shots"));
const sb = makeSandbox("order");
const TMP = sb.tmp, HUB = sb.socket, CC = sb.groupSocket;
const BIN = path.join(TMP, "bin"), TLOG = path.join(TMP, "tmux.log"), ORDER = path.join(sb.configDir, "order.json"), REG = path.join(sb.configDir, "sessions.json");
const REAL_TMUX = execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim();
fs.mkdirSync(BIN); fs.mkdirSync(sb.configDir, { recursive: true, mode: 0o700 }); fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(BIN, "tmux"), `#!/bin/sh\necho "$*" >> ${TLOG}\nexec ${REAL_TMUX} "$@"\n`, { mode: 0o755 });
let pass = 0, fail = 0;
const check = (name, ok, info = "") => { ok ? pass++ : fail++; console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + String(info).slice(0, 500))); };

// three main sessions (adopted at start-up) and two sessions on the watched group socket
const mains = ["alpha", "bravo", "charlie"].map((title, i) => ({ id: crypto.randomUUID(), title, startedAt: Date.now() - (10 - i) * 60000 }));
tmux(HUB, "-f", conf, "start-server");
for (const h of mains) tmux(HUB, "-f", conf, "new-session", "-d", "-s", "at-" + h.id, "-x", "100", "-y", "30", "-c", TMP, "cat");
fs.writeFileSync(REG, JSON.stringify(mains.map((h) => ({ id: h.id, agent: "shell", cwd: TMP, title: h.title, titleCustom: true, startedAt: h.startedAt }))));
const ccNew = (id, title) => { tmux(CC, "-f", conf, "new-session", "-d", "-s", id, "-x", "120", "-y", "40", "-c", TMP, "cat"); tmux(CC, "set-option", "-t", id, "@agent_terminal_title", title); };
tmux(CC, "-f", conf, "start-server");
ccNew("cc-aaaaaa", "agent task · fix the flaky test"); await sleep(1100); // distinct session_created seconds
ccNew("cc-bbbbbb", "agent task · add dark mode");

let app = null;
const url = (q = "") => app.url(q);
const logs = () => (app ? app.logs : "");
const titles = (page) => page.evaluate(() => [...document.querySelectorAll(".group")].map((g) => [...g.querySelectorAll(".session-item [data-title]")].map((t) => t.textContent)));
const savedOrder = () => { try { return JSON.parse(fs.readFileSync(ORDER, "utf8")).order; } catch { return []; } };
const idOf = (t) => (mains.find((h) => h.title === t)?.id) || t;
const itemOf = (page, title) => page.locator(".session-item").filter({ has: page.locator("[data-title]", { hasText: new RegExp("^" + title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$") }) });
// the sidebar is rebuilt on every pty_list broadcast: retry until the row is attached and laid out
const center = async (page, title) => { const b = await until(async () => { try { return await itemOf(page, title).boundingBox({ timeout: 1000 }); } catch { return null; } }, 5000, "row " + title); return { x: b.x + b.width / 2, y: b.y + b.height / 2, h: b.height }; };
const browser = await chromium.launch();
const written = [];
const shot = async (page, name) => { const f = path.join(OUT, name); await page.screenshot({ path: f }); written.push(f); };

try {
  app = await startApp(sb, { pathPrepend: BIN, groups: [{ label: "Watched", socket: CC }] });
  // ── desktop, dark ──
  const desk = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
  const dp = await desk.newPage();
  await dp.goto(url("&ui=en"));
  await until(async () => (await titles(dp)).flat().length === 5, 15000, "5 sessions listed").catch(async (e) => { console.log("DEBUG", JSON.stringify(await titles(dp)), await dp.evaluate(() => document.getElementById("session-list").innerText)); throw e; });
  let tt = await titles(dp);
  check("two groups: main sessions by start time, then watched-group sessions", JSON.stringify(tt) === JSON.stringify([["alpha", "bravo", "charlie"], ["agent task · fix the flaky test", "agent task · add dark mode"]]), JSON.stringify(tt));
  const heads = await dp.evaluate(() => [...document.querySelectorAll(".group-h span:first-child")].map((x) => x.textContent));
  check("group headers EN", JSON.stringify(heads) === '["Sessions","Watched"]', JSON.stringify(heads));
  await shot(dp, "terminal-desktop-dark.png");

  // mouse drag: charlie to the top
  const c = await center(dp, "charlie"), a = await center(dp, "alpha");
  await dp.mouse.move(c.x, c.y); await dp.mouse.down();
  for (let y = c.y; y >= a.y - a.h / 2 - 4; y -= 6) { await dp.mouse.move(c.x, y); await sleep(8); }
  await shot(dp, "terminal-desktop-dark-dragging.png");
  await dp.mouse.up();
  await until(async () => JSON.stringify((await titles(dp))[0]) === '["charlie","alpha","bravo"]', 5000, "drag result");
  check("mouse drag reorders and the server stores it", JSON.stringify(savedOrder().slice(0, 3)) === JSON.stringify(["charlie", "alpha", "bravo"].map(idOf)), JSON.stringify(savedOrder()));
  check("the click ending a drag does not open the session", await dp.evaluate(() => !document.querySelector(".session-item.active")?.textContent.includes("charlie")));

  // cross-group: a main session dragged into the watched group stays in its own group
  const al = await center(dp, "alpha"), cb = await center(dp, "agent task · add dark mode");
  await dp.mouse.move(al.x, al.y); await dp.mouse.down();
  for (let y = al.y; y <= cb.y + 10; y += 6) { await dp.mouse.move(al.x, y); await sleep(6); }
  await dp.mouse.up(); await sleep(400);
  tt = await titles(dp);
  check("never moves across groups (alpha only reaches the end of its own group)", JSON.stringify(tt[0]) === '["charlie","bravo","alpha"]' && tt[1].length === 2, JSON.stringify(tt));

  // keyboard: Alt+ArrowUp on the focused item, then the Move down button
  await itemOf(dp, "alpha").focus();
  await dp.keyboard.press("Alt+ArrowUp");
  await until(async () => JSON.stringify((await titles(dp))[0]) === '["charlie","alpha","bravo"]', 5000, "alt+up");
  const live = await dp.evaluate(() => document.getElementById("order-live").textContent);
  check("Alt+ArrowUp moves it up and announces the position", live === "Moved to position 2 of 3", live);
  check("focus stays on the moved item", await dp.evaluate(() => document.activeElement?.querySelector("[data-title]")?.textContent === "alpha"));
  await itemOf(dp, "charlie").hover();
  await itemOf(dp, "charlie").locator('[data-move="1"]').click();
  await until(async () => JSON.stringify((await titles(dp))[0]) === '["alpha","charlie","bravo"]', 5000, "move down button");
  check("Move down button", JSON.stringify(savedOrder().slice(0, 3)) === JSON.stringify(["alpha", "charlie", "bravo"].map(idOf)), JSON.stringify(savedOrder()));
  const upDisabled = await itemOf(dp, "alpha").locator('[data-move="-1"]').isDisabled();
  check("Move up is disabled on the first item", upDisabled);

  // ── phone (360px, touch), light: the same order; long-press drag in the watched group ──
  const phone = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: "light" });
  const pp = await phone.newPage();
  await pp.goto(url("&ui=en"));
  await until(async () => (await titles(pp)).flat().length === 5, 15000, "phone list");
  check("the phone shows the order the desktop set", JSON.stringify((await titles(pp))[0]) === '["alpha","charlie","bravo"]', JSON.stringify(await titles(pp)));
  await pp.click("#hamburger"); await sleep(400);
  await shot(pp, "terminal-360-light.png");
  const cdp = await phone.newCDPSession(pp);
  const touch = async (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  // a quick swipe (no long press) scrolls, it must not reorder
  let p1 = await center(pp, "agent task · add dark mode"), p0 = await center(pp, "agent task · fix the flaky test");
  await touch("touchStart", p1.x, p1.y);
  for (let y = p1.y; y >= p0.y - p0.h; y -= 8) { await touch("touchMove", p1.x, y); await sleep(10); }
  await touch("touchEnd"); await sleep(500);
  check("a quick swipe does not reorder", JSON.stringify((await titles(pp))[1]) === JSON.stringify(["agent task · fix the flaky test", "agent task · add dark mode"]), JSON.stringify(await titles(pp)));
  // long press, then drag up
  p1 = await center(pp, "agent task · add dark mode"); p0 = await center(pp, "agent task · fix the flaky test");
  await touch("touchStart", p1.x, p1.y); await sleep(650);
  check("long-press lifts the item", await pp.evaluate(() => !!document.querySelector(".session-item.dragging")));
  for (let y = p1.y; y >= p0.y - p0.h / 2 - 4; y -= 6) { await touch("touchMove", p1.x, y); await sleep(12); }
  await shot(pp, "terminal-360-light-dragging.png");
  await touch("touchEnd", p1.x, p0.y);
  await until(async () => (await titles(pp))[1][0] === "agent task · add dark mode", 5000, "touch drag result");
  check("long-press drag reorders the watched group on the phone", JSON.stringify(savedOrder().slice(3)) === '["g0-cc-bbbbbb","g0-cc-aaaaaa"]', JSON.stringify(savedOrder()));
  await until(async () => (await titles(dp))[1][0] === "agent task · add dark mode", 5000, "desktop follows");
  check("the desktop follows the phone's change without a reload", true);
  await pp.reload();
  await until(async () => (await titles(pp)).flat().length === 5, 15000, "phone list after reload");
  check("the order survives a reload", JSON.stringify(await titles(pp)) === JSON.stringify([["alpha", "charlie", "bravo"], ["agent task · add dark mode", "agent task · fix the flaky test"]]), JSON.stringify(await titles(pp)));
  await pp.click("#hamburger"); await sleep(300);
  await shot(pp, "terminal-360-light-after.png");

  // ── 360 dark + desktop light screenshots ──
  const pd = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: "dark" });
  const pdp = await pd.newPage(); await pdp.goto(url("&ui=en"));
  await until(async () => (await titles(pdp)).flat().length === 5, 15000, "360 dark list");
  await pdp.click("#hamburger"); await sleep(400);
  const ov = await pdp.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth, side: Math.round(document.getElementById("sidebar").getBoundingClientRect().right) }));
  check("360px: no horizontal overflow, sidebar fits", ov.doc <= ov.win && ov.side <= 360, JSON.stringify(ov));
  await shot(pdp, "terminal-360-dark.png");
  const dl = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });
  const dlp = await dl.newPage(); await dlp.goto(url("&ui=en"));
  await until(async () => (await titles(dlp)).flat().length === 5, 15000, "desktop light list");
  const bg = await dlp.evaluate(() => getComputedStyle(document.getElementById("sidebar")).backgroundColor);
  check("light theme: sidebar is light", bg === "rgb(255, 255, 255)", bg);
  await shot(dlp, "terminal-desktop-light.png");

  // ── ES labels ──
  const es = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "es-ES" });
  const ep = await es.newPage(); await ep.goto(url());
  await until(async () => (await titles(ep)).flat().length === 5, 15000, "es list");
  const esl = await ep.evaluate(() => ({ heads: [...document.querySelectorAll(".group-h span:first-child")].map((x) => x.textContent), up: document.querySelector('[data-move="-1"]').getAttribute("aria-label"), down: document.querySelector('[data-move="1"]').getAttribute("aria-label") }));
  check("ES: group headers and move buttons", JSON.stringify(esl) === '{"heads":["Sesiones","Watched"],"up":"Subir","down":"Bajar"}', JSON.stringify(esl));
  await ep.locator(".session-item").first().focus(); await ep.keyboard.press("Alt+ArrowDown");
  await until(async () => (await ep.evaluate(() => document.getElementById("order-live").textContent)) === "Movida a la posición 2 de 3", 5000, "es announce");
  check("ES: position announced in Spanish", true);
  await ep.keyboard.press("Alt+ArrowUp"); await sleep(300); // put it back
  await es.close();

  // ── attach + type into a watched-group session (its own socket) ──
  await itemOf(dp, "agent task · fix the flaky test").click();
  await sleep(600);
  await dp.keyboard.type("hello-from-test"); await dp.keyboard.press("Enter");
  await until(() => tmux(CC, "capture-pane", "-p", "-t", "=cc-aaaaaa:").includes("hello-from-test"), 5000, "typed into the task");
  check("attach + type into a watched-group session reaches its pane on the group socket", true);

  // ── a new task appears at the end of its group; an ended one drops out of the order ──
  ccNew("cc-cccccc", "agent task · tidy imports");
  await until(async () => (await titles(dp))[1].length === 3, 8000, "new task listed");
  check("a new watched-group session is listed at the end of its group", (await titles(dp))[1][2] === "agent task · tidy imports", JSON.stringify(await titles(dp)));
  tmux(CC, "kill-session", "-t", "=cc-aaaaaa");
  await until(() => !savedOrder().includes("g0-cc-aaaaaa"), 8000, "ended task dropped from the order");
  check("an ended session drops out of the stored order", !savedOrder().includes("g0-cc-aaaaaa") && savedOrder().includes("g0-cc-bbbbbb"), JSON.stringify(savedOrder()));

  // ── order file + sockets ──
  const mode = fs.statSync(ORDER).mode & 0o777;
  check("order file is private (0600)", mode === 0o600, mode.toString(8));
  const tl = fs.readFileSync(TLOG, "utf8");
  check("tmux: only the test sockets, never the default tmux server", tl.trim().split("\n").every((l) => l.startsWith("-L " + HUB + " ") || l.startsWith("-L " + CC + " ")) && tl.includes("-L " + CC) && tl.includes("-L " + HUB), tl.split("\n").slice(0, 3).join(" | "));
  await desk.close(); await phone.close(); await pd.close(); await dl.close();
  console.log("screenshots:\n" + written.map((w) => "  " + w).join("\n"));
} catch (e) {
  fail++; console.log("FAIL exception", e?.stack || e);
  if (!process.env.E2E_VERBOSE) console.log(logs().slice(-3000));
} finally {
  await browser.close();
  if (app) await app.stop();
  cleanup(sb);
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
