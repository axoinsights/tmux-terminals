#!/usr/bin/env node
/**
 * Terminal page on Android typing straight into xterm's helper textarea (compose bar OFF): the diff-based input mirror must send IME
 * text exactly once. Gboard is simulated through CDP (Input.imeSetComposition / insertText / dispatchKeyEvent) under an Android user agent;
 * a desktop UA must keep xterm's normal path. Real server on a random port, private tmux socket; the session runs a real bash.
 * Run: PLAYWRIGHT_MODULE=$HOME/.npm-global/lib/node_modules/playwright/index.mjs node test/e2e/ime-direct.test.mjs
 */
import { loadPlaywright, shellSandbox, sleep, until, tmux } from "./helpers.mjs";
const { chromium } = await loadPlaywright();

const S = await shellSandbox("imd");
const { sid } = S;
const pane = S.pane;
let pass = 0, fail = 0;
const check = (name, ok, info = "") => { ok ? pass++ : fail++; console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + String(info).slice(0, 600))); };
const clearLine = async () => { tmux(S.socket, "send-keys", "-t", "=at-" + sid + ":", "C-u"); await sleep(250); };

const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
// Replays pty_input frames like a line editor (DEL erases the previous char) -> the text the shell line ends up with.
const replay = (frames) => { let out = ""; for (const ch of Array.from(frames.join(""))) { if (ch === "\x7f") out = Array.from(out).slice(0, -1).join(""); else out += ch; } return out; };
const count = (text, line) => text.split("\n").filter((l) => l === line).length;

const browser = await chromium.launch();
async function openPage(ctx, errors, tag) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror(${tag}): ` + e.message));
  const rec = { frames: [] };
  page.on("websocket", (ws) => ws.on("framesent", (f) => { try { const j = JSON.parse(f.payload); if (j.type === "pty_input" && !/^\x1b\[[IO]$/.test(j.data)) rec.frames.push(j.data); /* focus-in/out reports (CSI I / O) are dropped */ } catch { /* not json */ } }));
  await page.goto(S.app.url("&ui=en"));
  await page.waitForSelector(".session-item", { timeout: 15000 });
  if (await page.locator("#hamburger").isVisible()) { await page.click("#hamburger"); await sleep(300); }
  await page.locator(".session-item").first().click();
  await until(() => page.evaluate(() => !!document.querySelector(".xterm-helper-textarea")), 10000, "terminal attached");
  await until(() => /PROMPT\$/.test(pane()), 10000, "bash prompt");
  await sleep(700);
  // the re-attach replays the screen and xterm answers old terminal queries into the prompt line: clear it first
  await clearLine();
  rec.frames.length = 0;
  return { page, rec };
}

try {
    const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: ANDROID_UA });
  const { page, rec } = await openPage(ctx, errors, "android");
  const cdp = await ctx.newCDPSession(page);
  // framesent events arrive asynchronously: settle after each simulated keyboard action
  const ime = async (text) => { await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length }); await sleep(80); };
  const commit = async (text) => { await cdp.send("Input.insertText", { text }); await sleep(80); };
  const key = (type, k, code, vk, extra = {}) => cdp.send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...extra });
  const press = async (k, code, vk) => { await key("rawKeyDown", k, code, vk); await key("keyUp", k, code, vk); };
  const val = () => page.evaluate(() => document.querySelector(".xterm-helper-textarea").value);
  const focusTa = async () => { await page.evaluate(() => { const t = document.querySelector(".xterm-helper-textarea"); t.blur(); t.focus(); }); await sleep(100); };
  const ctrl = async (c) => { await page.click(`#key-toolbar [data-ctrl="${c}"]`); await sleep(150); };

  check("compose bar is off", !(await page.locator("#compose-bar").isVisible()));
  await focusTa();

  // ── Gboard-style typing: compose, grow, commit, suggestion replacement, space, second phrase, Enter ──
  await commit("echo ");
  await ime("dur"); await ime("durin"); await ime("during");
  await commit("during"); // commit replaces the composition
  check("composition + commit leaves 'echo during' (no partial words, no repeats)", replay(rec.frames) === "echo during", JSON.stringify(rec.frames));
  // suggestion tap: select the last word in the helper textarea and replace it
  await page.evaluate(() => { const t = document.querySelector(".xterm-helper-textarea"); t.setSelectionRange(t.value.length - 6, t.value.length); });
  await commit("walking");
  check("suggestion replacement sends backspaces + the new word", replay(rec.frames) === "echo walking" && rec.frames.join("").includes("\x7f"), JSON.stringify(rec.frames));
  await commit(" ");
  await ime("not"); await commit("not"); await commit(" ");
  await ime("su"); await ime("sure"); await commit("sure");
  check("typed phrase is exactly once before Enter", replay(rec.frames) === "echo walking not sure", JSON.stringify(rec.frames));
  await press("Enter", "Enter", 13);
  await until(() => count(pane(), "walking not sure") === 1, 8000, "output").catch((e) => { console.log("DEBUG", JSON.stringify(rec.frames), JSON.stringify(pane())); throw e; });
  await sleep(400);
  check("bash printed the line once, no garbage commands", count(pane(), "walking not sure") === 1 && !/command not found/.test(pane()), JSON.stringify(pane()));
  check("pty received exactly the text + \\r (net)", replay(rec.frames) === "echo walking not sure\r", JSON.stringify(rec.frames));
  check("textarea cleared after Enter", (await val()) === "", JSON.stringify(await val()));

  // ── soft-keyboard Enter via beforeinput only (keyCode 229 keydown) ──
  rec.frames.length = 0;
  await commit("echo bi");
  await key("rawKeyDown", "Unidentified", "", 229);
  await page.evaluate(() => document.querySelector(".xterm-helper-textarea").dispatchEvent(new InputEvent("beforeinput", { inputType: "insertLineBreak", bubbles: true, cancelable: true })));
  await until(() => count(pane(), "bi") === 1, 8000, "bi output");
  check("insertLineBreak beforeinput sends \\r once", replay(rec.frames) === "echo bi\r", JSON.stringify(rec.frames));

  // ── Backspace with an empty textarea deletes in the shell ──
  await focusTa();
  rec.frames.length = 0;
  await press("Backspace", "Backspace", 8); await sleep(100);
  check("Backspace on an empty textarea sends exactly one \\x7f", rec.frames.join("") === "\x7f", JSON.stringify(rec.frames));
  rec.frames.length = 0;
  await commit("abc"); await press("Backspace", "Backspace", 8); await sleep(150);
  check("Backspace on a non-empty textarea is sent once through the diff", replay(rec.frames) === "ab" && rec.frames.join("") === "abc\x7f", JSON.stringify(rec.frames));
  await ctrl("u");

  // ── arrow key still goes through xterm ──
  await focusTa();
  rec.frames.length = 0;
  await key("rawKeyDown", "ArrowUp", "ArrowUp", 38); await key("keyUp", "ArrowUp", "ArrowUp", 38); await sleep(150);
  check("ArrowUp still goes through xterm (ESC [ A, or ESC O A in application-cursor mode)", /^\x1b[\[O]A$/.test(rec.frames.join("")), JSON.stringify(rec.frames));
  await clearLine();

  // ── toolbar ^C resets the mirror ──
  await focusTa();
  rec.frames.length = 0;
  await commit("junk");
  await ctrl("c");
  check("toolbar ^C sent and the mirror textarea cleared", (await val()) === "" && rec.frames.join("") === "junk\x03", JSON.stringify([await val(), rec.frames]));
  rec.frames.length = 0;
  await commit("ok");
  check("typing after ^C sends only the new text (no stale backspaces)", rec.frames.join("") === "ok", JSON.stringify(rec.frames));
  await ctrl("c");

  // ── paste into the helper textarea is sent once ──
  await focusTa();
  rec.frames.length = 0;
  await page.evaluate(() => { const t = document.querySelector(".xterm-helper-textarea"); const dt = new DataTransfer(); dt.setData("text/plain", "echo pasted-once"); t.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); });
  await sleep(300);
  check("paste is sent once (bracketed) and the textarea stays empty", rec.frames.join("").replace(/\x1b\[20[01]~/g, "") === "echo pasted-once" && (await val()) === "", JSON.stringify([rec.frames, await val()]));
  await ctrl("c");

  // ── long input trims the textarea at a non-composing moment, sends everything once ──
  await focusTa();
  rec.frames.length = 0;
  const chunk = "abcdefghij".repeat(25);
  await commit(chunk); await sleep(100);
  await commit("Z");
  check("textarea is reset past ~200 chars and the text still arrives once", replay(rec.frames) === chunk + "Z" && (await val()).length < 200, JSON.stringify([replay(rec.frames).length, (await val()).length]));
  await ctrl("c");

  check("no console / page errors (android)", errors.length === 0, errors.join(" | "));
  await ctx.close();

  // ── desktop UA: xterm's normal path is untouched ──
  await clearLine();
  const dctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const d = await openPage(dctx, errors, "desktop");
  check("desktop UA is not Android", !(await d.page.evaluate(() => /Android/i.test(navigator.userAgent))));
  await d.page.locator(".xterm-helper-textarea").focus();
  await d.page.keyboard.type("echo x");
  await d.page.keyboard.press("Enter");
  await until(() => d.rec.frames.join("").includes("\r"), 8000, "desktop Enter sent").catch((e) => { console.log("DEBUG", JSON.stringify(d.rec.frames), JSON.stringify(pane())); throw e; });
  check('desktop typing "echo x" + Enter runs once through xterm', d.rec.frames.join("") === "echo x\r", JSON.stringify(d.rec.frames));
  check("no console / page errors (desktop)", errors.length === 0, errors.join(" | "));
  await dctx.close();
} catch (e) {
  fail++; console.log("FAIL exception", e?.stack || e);
  console.log(S.app.logs.slice(-2000));
} finally {
  await browser.close();
  await S.cleanup();
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
