#!/usr/bin/env node
/**
 * Browser flow of the new-session path and auth UX: token form, ?token= -> cookie + clean URL, nothing secret in localStorage,
 * agent buttons from config, directory presets, spawn via the dialog, typing into the session, session survives a page reload,
 * dictation button hidden without transcribeUrl, manifest link, split view and search smoke, no console errors.
 * Run: PLAYWRIGHT_MODULE=... node test/e2e/ui-flow.test.mjs
 */
import { cleanup, loadPlaywright, makeChecker, makeSandbox, sleep, startApp, until } from "./helpers.mjs";

// xterm renders to WebGL/canvas, so read the screen through the page's own "Screen" (copy visible text) button via a clipboard-bridge stub.
const CLIP_STUB = () => { window.__clipWritten = ""; window.nativeClipboard = { postMessage(m) { const j = JSON.parse(m); if (j.t === "write") window.__clipWritten = j.text; }, addEventListener() {} }; };
const screenText = async (page) => { await page.evaluate(() => { window.__clipWritten = ""; }); await page.evaluate(() => document.getElementById("copy-screen-btn").click()); await sleep(250); return page.evaluate(() => window.__clipWritten); };

const { chromium } = await loadPlaywright();
const { state, check } = makeChecker();
const sb = makeSandbox("ui");
const agents = [
  { id: "shell", label: "Shell", command: "bash", args: ["--norc", "--noprofile", "-i"] },
  { id: "echo", label: "Echo Agent", command: "sh", args: ["-c", "echo ECHO_AGENT_READY; exec cat"], resumeArgs: ["x"] },
];
let app = null, browser = null;
try {
  app = await startApp(sb, { agents, extraEnv: { AGENT_TERMINAL_CWD_PRESETS: `~,${sb.tmp}` } });
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  // 1. no token -> form
  errors.length = 0;
  await page.goto(app.base + "/");
  check("without a token the page is a token form", (await page.locator('input[name="token"]').count()) === 1 && !(await page.content()).includes(sb.token));
  const consoleBefore = errors.length; // the 401 for the page itself is not a page error
  await page.fill('input[name="token"]', sb.token);
  await page.click('button[type="submit"]');
  await page.waitForSelector("#new-session-btn", { timeout: 10000 });
  check("submitting the form signs in and the URL no longer contains the token", !page.url().includes(sb.token), page.url());
  void consoleBefore;
  errors.length = 0; // the 401 that served the token form is expected

  // 2. token URL path
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx2.addInitScript(CLIP_STUB);
  const p2 = await ctx2.newPage();
  p2.on("pageerror", (e) => errors.push("pageerror(p2): " + e.message));
  p2.on("console", (m) => { if (m.type() === "error") errors.push("console(p2): " + m.text()); });
  await p2.goto(app.url("&ui=en"));
  await p2.waitForSelector("#new-session-btn");
  check("?token= URL is replaced by a clean URL (query kept, token dropped)", p2.url() === `${app.base}/?ui=en`, p2.url());
  const stored = await p2.evaluate(() => JSON.stringify([Object.entries(localStorage), document.cookie]));
  check("the token is in no JS-visible storage (HttpOnly cookie only)", !stored.includes(sb.token), stored);
  const cookies = await ctx2.cookies();
  check("cookie is HttpOnly + SameSite=Strict", cookies.length === 1 && cookies[0].httpOnly && cookies[0].sameSite === "Strict", JSON.stringify(cookies.map((c) => [c.name, c.httpOnly, c.sameSite])));
  check("manifest is linked and dictation button is hidden (no transcribeUrl)", (await p2.locator('link[rel="manifest"]').getAttribute("href")) === "/manifest.webmanifest" && !(await p2.locator("#mic-btn").isVisible()));

  // 3. spawn through the dialog
  await p2.click("#empty-new-btn");
  await p2.waitForSelector("#agent-toggle button");
  const labels = await p2.locator("#agent-toggle button").allTextContents();
  check("agent buttons come from config", JSON.stringify(labels) === JSON.stringify(["Shell", "Echo Agent"]), JSON.stringify(labels));
  const presets = await p2.locator("#cwd-presets button").allTextContents();
  check("directory presets come from config", presets.includes("~") && presets.includes(sb.tmp), JSON.stringify(presets));
  check("resume box only for agents with resumeArgs", !(await p2.locator("#spawn-resume").isVisible()));
  await p2.click('#agent-toggle button:has-text("Echo Agent")');
  check("resume box appears for an agent with resumeArgs", await p2.locator("#spawn-resume").isVisible());
  await p2.click('#cwd-presets button:has-text("' + sb.tmp + '")');
  await p2.click("#spawn-go");
  await p2.waitForSelector(".xterm-helper-textarea", { timeout: 10000 });
  await until(async () => (await screenText(p2)).includes("ECHO_AGENT_READY"), 10000, "agent banner");
  check("spawned the chosen agent and its output reaches xterm", true);
  const row = await p2.locator(".session-item .sub").first().innerText();
  check("sidebar shows the working directory", row.includes(sb.tmp), row);

  await p2.keyboard.type("hello-agent");
  await p2.keyboard.press("Enter");
  await until(async () => ((await screenText(p2)).match(/hello-agent/g) || []).length >= 2, 8000, "cat echo");
  check("typing reaches the agent (cat echoes it back)", true);

  // 4. reload keeps the session; split view + search smoke
  await p2.reload();
  await p2.waitForSelector(".session-item");
  check("session is still listed after a page reload", (await p2.locator(".session-item").count()) === 1);
  await p2.locator(".session-item").first().click();
  await until(async () => (await screenText(p2)).includes("hello-agent"), 10000, "scrollback replay");
  check("scrollback is replayed on reattach", true);
  await p2.click("#search-btn");
  check("search bar opens", await p2.locator("#search-bar").isVisible());
  await p2.fill("#search-input", "hello-agent");
  await p2.keyboard.press("Enter");
  await sleep(200);
  await p2.keyboard.press("Escape");
  p2.on("dialog", (d) => d.accept()); // "End this session?" confirms
  await p2.click("#new-session-btn");
  await p2.click('#agent-toggle button:has-text("Shell")');
  await p2.click("#spawn-go");
  await until(async () => (await p2.locator(".session-item").count()) === 2, 10000, "second session");
  await p2.click("#split-btn");
  check("split view opens with two sessions", await p2.locator("#split-container").isVisible());
  await p2.click("#split-btn");
  check("split view closes", !(await p2.locator("#split-container").isVisible()));

  // closing sessions from the sidebar ends them
  for (let i = 0; i < 2; i++) { await p2.locator(".session-item .close-btn").first().click(); await sleep(300); }
  await until(async () => (await p2.locator(".session-item").count()) === 0, 8000, "closed");
  check("closing sessions removes them", true);

  check("no console / page errors", errors.length === 0, errors.join(" | "));
  await ctx.close(); await ctx2.close();
} catch (e) {
  state.fail++;
  console.log("FAIL exception", e?.stack || e);
  console.log((app?.logs || "").slice(-2000));
} finally {
  if (browser) await browser.close();
  if (app) await app.stop();
  cleanup(sb);
}
console.log(`\n${state.pass}/${state.pass + state.fail} passed`);
process.exit(state.fail ? 1 : 0);
