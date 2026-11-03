#!/usr/bin/env node
/**
 * Terminal page on a phone: compose bar (IME-friendly textarea), native clipboard bridge (window.nativeClipboard stub), Copy / Screen.
 * Runs the REAL server on its own random port with a private tmux socket and config dir, and drives web/index.html with Playwright
 * on a 412x900 touch viewport. The session runs a real bash so "echo hello" produces output.
 * Run: PLAYWRIGHT_MODULE=$HOME/.npm-global/lib/node_modules/playwright/index.mjs node test/e2e/ime.test.mjs
 */
import { loadPlaywright, shellSandbox, sleep, until, tmux } from "./helpers.mjs";
const { chromium } = await loadPlaywright();

const S = await shellSandbox("ime");
const { sid } = S;
const pane = S.pane;
let pass = 0, fail = 0;
const check = (name, ok, info = "") => { ok ? pass++ : fail++; console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + String(info).slice(0, 600))); };

// window.nativeClipboard as an androidx.webkit addWebMessageListener bridge exposes it: postMessage(string) to the app, replies via "message" events.
const NATIVE_CLIPBOARD_STUB = () => {
  window.__clipLog = []; window.__clipText = "";
  const ls = [];
  window.nativeClipboard = {
    postMessage(m) {
      const j = JSON.parse(m); window.__clipLog.push(j);
      if (j.t === "read") setTimeout(() => ls.forEach((f) => f({ data: JSON.stringify({ t: "clip", id: j.id, text: window.__clipText }) })), 10);
      if (j.t === "write") window.__clipWritten = j.text;
    },
    addEventListener(t, f) { if (t === "message") ls.push(f); },
    removeEventListener() {},
    onmessage: null,
  };
};

const browser = await chromium.launch();
try {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  let frames = [];
  page.on("websocket", (ws) => ws.on("framesent", (f) => { try { const j = JSON.parse(f.payload); if (j.type === "pty_input") frames.push(j.data); } catch { /* not json */ } }));
  const sentText = () => frames.join("");

  await page.goto(S.app.url("&ui=en"));
  await page.waitForSelector(".session-item", { timeout: 15000 });
  await page.click("#hamburger"); await sleep(300);
  await page.locator(".session-item").first().click();
  await until(() => page.evaluate(() => !!document.querySelector(".xterm-helper-textarea")), 10000, "terminal attached");
  await until(() => /PROMPT\$/.test(pane()), 10000, "bash prompt");
  await sleep(500);

  // ── compose toggle + persistence ──
  check("compose row hidden by default", !(await page.locator("#compose-bar").isVisible()));
  await page.tap("#compose-btn");
  check("Aa shows the compose row and focuses the textarea", (await page.locator("#compose-bar").isVisible()) && (await page.evaluate(() => document.activeElement?.id)) === "compose-input");
  const attrs = await page.evaluate(() => { const t = document.getElementById("compose-input"); return [t.getAttribute("autocorrect"), t.getAttribute("spellcheck"), t.getAttribute("autocapitalize")]; });
  check("textarea keeps autocorrect / spellcheck / autocapitalize on", JSON.stringify(attrs) === '["on","true","sentences"]', JSON.stringify(attrs));
  const lay = await page.evaluate(() => { const c = document.getElementById("compose-bar").getBoundingClientRect(), k = document.getElementById("key-toolbar").getBoundingClientRect(); return { cb: c.bottom, kt: k.top, kb: k.bottom, ih: innerHeight }; });
  check("compose row sits directly above the key toolbar, inside the viewport", Math.abs(lay.cb - lay.kt) < 1.5 && lay.kb <= lay.ih + 1, JSON.stringify(lay));
  await page.reload();
  await page.waitForSelector("#compose-bar.open", { timeout: 10000 }).then(() => check("compose state persists after reload", true), () => check("compose state persists after reload", false));
  await page.waitForSelector(".session-item"); await page.click("#hamburger"); await sleep(300); await page.locator(".session-item").first().click();
  await until(() => page.evaluate(() => !!document.querySelector(".xterm-helper-textarea")), 10000, "re-attached");
  await sleep(700);
  check("xterm textarea has inputmode=none while compose is open", await page.evaluate(() => document.querySelector(".xterm-helper-textarea").getAttribute("inputmode") === "none"));
  await page.tap("#term-container");
  check("tapping the terminal keeps focus in the compose box", (await page.evaluate(() => document.activeElement?.id)) === "compose-input");

  // ── type + Enter: output exactly once ──
  // the re-attach replays the screen and xterm answers old terminal queries (DA) into the prompt line: clear it first
  tmux(S.socket, "send-keys", "-t", "=at-" + sid + ":", "C-u"); await sleep(300);
  frames = [];
  await page.locator("#compose-input").click();
  await page.keyboard.type("echo hello");
  check("nothing reaches the pty while typing", sentText() === "", JSON.stringify(sentText()));
  await page.keyboard.press("Enter");
  await until(() => /^hello$/m.test(pane()), 8000, "hello output").catch((e) => { console.log("DEBUG", JSON.stringify(sentText()), JSON.stringify(pane())); throw e; });
  await sleep(400);
  const helloLines = pane().split("\n").filter((l) => l === "hello").length;
  check('"echo hello" + Enter prints hello exactly once', helloLines === 1 && sentText() === "echo hello\r", helloLines + " " + JSON.stringify(sentText()));
  check("box is cleared and keeps focus after sending", (await page.inputValue("#compose-input")) === "" && (await page.evaluate(() => document.activeElement?.id)) === "compose-input");

  // ── simulated IME replacement: only the final text is sent ──
  frames = [];
  await page.fill("#compose-input", "ech");
  await page.fill("#compose-input", "echo hi");
  await page.keyboard.press("Enter");
  await until(() => /^hi$/m.test(pane()), 8000, "hi output");
  check("IME replacement sends only the final text", sentText() === "echo hi\r" && !/ech: command not found/.test(pane()), JSON.stringify(sentText()));

  // ── empty box: Enter and Backspace drive the prompt ──
  frames = [];
  await page.keyboard.press("Enter");
  await page.keyboard.press("Backspace");
  await sleep(200);
  check("empty box: Enter sends \\r, Backspace sends DEL", sentText() === "\r\x7f", JSON.stringify(sentText()));

  // ── multi-line: bracketed paste when the shell enabled it ──
  frames = [];
  await page.fill("#compose-input", "echo l1\necho l2");
  await page.tap("#compose-send");
  await sleep(300);
  check("multi-line text is wrapped in bracketed paste (bash enables it) then \\r", sentText() === "\x1b[200~echo l1\recho l2\x1b[201~\r", JSON.stringify(sentText()));
  await until(() => /^l2$/m.test(pane()), 8000, "multi-line ran");
  // Shift+Enter inserts a newline instead of sending
  frames = [];
  await page.fill("#compose-input", "one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("two");
  check("Shift+Enter inserts a newline and sends nothing", (await page.inputValue("#compose-input")) === "one\ntwo" && sentText() === "", JSON.stringify(await page.inputValue("#compose-input")));
  const h1 = await page.evaluate(() => document.getElementById("compose-input").getBoundingClientRect().height);
  await page.fill("#compose-input", "1\n2\n3\n4\n5\n6\n7");
  const h2 = await page.evaluate(() => document.getElementById("compose-input").getBoundingClientRect().height);
  check("textarea grows with lines and stops at ~4", h2 > h1 && h2 < h1 * 5, h1 + " -> " + h2);
  await page.fill("#compose-input", "");

  // ── toolbar buttons don't blur the compose box ──
  frames = [];
  await page.locator("#compose-input").click();
  for (const sel of ['[data-key="Escape"]', '[data-key="ArrowUp"]', '[data-ctrl="u"]', '[data-key="Enter"]']) await page.click("#key-toolbar " + sel);
  check("toolbar keys work and keep focus in the compose box", sentText() === "\x1b\x1b[A\x15\r" && (await page.evaluate(() => document.activeElement?.id)) === "compose-input", JSON.stringify(sentText()));

  // ── native clipboard bridge ──
  const ctx2 = await browser.newContext({ viewport: { width: 412, height: 900 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await ctx2.addInitScript(NATIVE_CLIPBOARD_STUB);
  const p2 = await ctx2.newPage();
  p2.on("pageerror", (e) => errors.push("pageerror(p2): " + e.message));
  let frames2 = [];
  p2.on("websocket", (ws) => ws.on("framesent", (f) => { try { const j = JSON.parse(f.payload); if (j.type === "pty_input") frames2.push(j.data); } catch { /* */ } }));
  await p2.goto(S.app.url("&ui=en"));
  await p2.waitForSelector(".session-item"); await p2.click("#hamburger"); await sleep(300); await p2.locator(".session-item").first().click();
  await until(() => p2.evaluate(() => !!document.querySelector(".xterm-helper-textarea")), 10000, "p2 attached");
  await sleep(700);
  tmux(S.socket, "send-keys", "-t", "=at-" + sid + ":", "C-u"); await sleep(300); frames2 = [];
  await p2.evaluate(() => { window.__clipText = "echo pasted-ok"; });
  await p2.tap("#paste-btn");
  await until(() => /PROMPT\$ echo pasted-ok/.test(pane()), 8000, "pasted text typed").catch(async (e) => { console.log("DEBUG", JSON.stringify(pane().slice(0, 300)), JSON.stringify(frames2), JSON.stringify(await p2.evaluate(() => window.__clipLog)), await p2.textContent("#toast")); throw e; });
  await sleep(500);
  const pasteLines = pane().split("\n").filter((l) => l.includes("pasted-ok"));
  const log = await p2.evaluate(() => window.__clipLog);
  check("Paste uses window.nativeClipboard and pastes exactly once (through term.paste)", pasteLines.length === 1 && !/pasted-okecho/.test(pasteLines[0]) && log.some((m) => m.t === "read"), JSON.stringify(pasteLines) + JSON.stringify(log));
  check("bracketed paste markers used for the pasted text", frames2.join("").startsWith("\x1b[200~echo pasted-ok\x1b[201~"), JSON.stringify(frames2.join("")));
  await p2.click('#key-toolbar [data-ctrl="u"]');
  await sleep(700); // past the Paste button's 600 ms double-tap guard
  await p2.evaluate(() => { window.__clipText = ""; });
  await p2.tap("#paste-btn"); await sleep(300);
  check("empty bridge clipboard shows 'Clipboard empty'", (await p2.textContent("#toast")) === "Clipboard empty", await p2.textContent("#toast"));
  await p2.tap("#copy-screen-btn"); await sleep(300);
  const written = await p2.evaluate(() => window.__clipWritten);
  check("Screen copies the visible text through nativeClipboard", typeof written === "string" && /^hello$/m.test(written) && /^hi$/m.test(written) && !/\s$/.test(written), JSON.stringify(written));
  check("Screen text has right-trimmed lines", written.split("\n").every((l) => l === l.replace(/\s+$/, "")));
  // Copy without selection explains itself; with a selection it writes through the bridge
  await p2.evaluate(() => { window.__clipWritten = undefined; });
  await p2.tap("#copy-btn"); await sleep(300);
  check("Copy with no selection shows the hint", /Select text first/.test(await p2.textContent("#toast")) && (await p2.evaluate(() => window.__clipWritten)) === undefined, await p2.textContent("#toast"));
  const box = await p2.locator(".xterm-screen").first().boundingBox();
  await p2.mouse.dblclick(box.x + 20, box.y + 4);
  await sleep(300);
  await p2.tap("#copy-btn"); await sleep(400);
  const sel = await p2.evaluate(() => window.__clipWritten);
  check("Copy with a selection writes it through nativeClipboard", typeof sel === "string" && sel.length > 0, JSON.stringify(sel));
  await ctx2.close();

  check("no console / page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
} catch (e) {
  fail++; console.log("FAIL exception", e?.stack || e);
  console.log(S.app.logs.slice(-2000));
} finally {
  await browser.close();
  await S.cleanup();
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
