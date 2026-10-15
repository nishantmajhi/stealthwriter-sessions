/*
 * Every defect this pass claims to have fixed, reproduced against the code as
 * it was, read out of git.
 *
 * Nothing here is a transcription. `harness.js` looks the baseline commit up
 * by its subject line and loads the real `content.js`, `popup.js` and
 * `background.js` out of it, in the same harness the rest of the suite uses,
 * so every "the original did X" sentence in review.md has a test behind it.
 * If the baseline moves, `baselineCommit()` throws and this whole file fails
 * loudly instead of quietly asserting nothing.
 *
 * The companion assertions -- that the current code does NOT do these things
 * -- are in the other files, next to the behaviour they belong to.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createWorld, baselineCommit, originalSource, textFile, sentences } = require("./harness.js");
const { DomEvent } = require("./dom.js");

const ORIGINAL = { original: true };

test("the baseline commit is findable and holds all four scripts", () => {
  assert.match(baselineCommit(), /^[0-9a-f]{40}$/);
  for (const file of ["content.js", "popup.js", "background.js", "popup.html"]) {
    assert.ok(originalSource(file).length > 0, file + " is missing from the baseline");
  }
});

/* ── P1: every restore reloaded the page ───────────────────────────────── */

async function restoreFirstCard(world, loadOptions) {
  const tab = world.addTab("https://stealthwriter.ai/dashboard/humanizer", 1);
  tab.active = true;
  const content = world.loadContent({ ...loadOptions, tab });
  world.clock.advance(1500);
  await world.flush();

  const popup = world.loadPopup(loadOptions);
  await world.flush();
  popup.clickIn(popup.cards()[0], ".btn-restore");
  await world.flush();
  world.clock.advance(1000);
  await world.flush();
  return { content, popup, tab };
}

test("ORIGINAL: restoring reloaded the tab even with a live content script", async () => {
  const world = createWorld();
  world.seed([world.session({ id: "a1", name: "Draft" })]);
  const { popup, content } = await restoreFirstCard(world, ORIGINAL);

  assert.ok(world.log.some(e => e.type === "tabs.reload"),
    "the original took its self-heal branch on a page that was listening");
  assert.match(popup.status(), /reloading it to restore/,
    "and told the user the page was not responding");

  /* The page was responding perfectly well. It picked the queued restore up
   * through the storage listener and rendered the panel -- so the reload, and
   * everything the user had on screen, was spent on nothing. */
  assert.ok(content.document.getElementById("sw-restored-panel"),
    "the restore landed anyway, which is what makes the reload pure cost");
});

test("ORIGINAL: the content script's listener answered nothing", () => {
  const source = originalSource("content.js");
  assert.match(source, /onMessage\.addListener\(\(msg\) => \{/,
    "the original listener took one argument, so it could not answer");
  assert.ok(!source.includes("sendResponse"),
    "the original never called sendResponse, which is why the port closed");
});

/* ── P1: an imported wordCount was written into innerHTML unescaped ────── */

async function importInto(world, popup, json) {
  const input = popup.document.getElementById("file-input");
  input.files = [textFile(json)];
  input.dispatchEvent(new DomEvent("change", { bubbles: true }));
  await world.flush();
  return popup;
}

test("ORIGINAL: a string wordCount in a backup became an element in the popup", async () => {
  const world = createWorld();
  world.seed([]);
  const popup = world.loadPopup(ORIGINAL);
  await world.flush();

  await importInto(world, popup, JSON.stringify({
    sessions: [{
      id: "evil", savedAt: 1758239000000, inputText: "x", outputText: "y",
      wordCount: '<img src=x onerror="alert(1)">',
    }],
  }));

  const card = popup.cards()[0];
  assert.ok(card, "the hostile session was imported");
  assert.equal(card.querySelectorAll("img").length, 1,
    "the interpolated string became a real element with an event-handler attribute");
  assert.equal(card.querySelector("img").getAttribute("onerror"), "alert(1)");
});

test("ORIGINAL: the import validator never looked at wordCount", () => {
  const source = originalSource("popup.js");
  const validator = source.slice(source.indexOf("const clean = incoming.filter"), source.indexOf("if (clean.length === 0)"));
  assert.ok(validator.includes("typeof s.savedAt === 'number'"));
  assert.ok(!validator.includes("wordCount"),
    "wordCount was unchecked on the way in and unescaped on the way out");
});

/* ── P1: a wrongly typed field bricked the popup permanently ───────────── */

test("ORIGINAL: a numeric name was stored and then threw on every render", async () => {
  const world = createWorld();
  world.seed([]);
  const popup = world.loadPopup(ORIGINAL);
  await world.flush();

  await importInto(world, popup, JSON.stringify({
    sessions: [{ id: "bad", savedAt: 1758239000000, inputText: "x", name: 42 }],
  }));

  assert.equal(world.read("sw_sessions_v3").length, 1,
    "the malformed session was written to storage before anything rendered");
  assert.ok(world.errors.some(e => e && e.name === "TypeError"),
    "render() threw on the way out");
  assert.equal(popup.cards().length, 0, "nothing was drawn");

  /* And it is not a one-off: every later open of the popup hits the same
   * record, so the list stays empty until someone edits storage by hand. */
  const second = world.loadPopup(ORIGINAL);
  await world.flush();
  assert.equal(second.cards().length, 0);
  assert.ok(world.errors.length >= 2);
});

/* ── P1: a second manager window destroyed everything saved since ──────── */

test("ORIGINAL: renaming in a stale window deleted the sessions saved after it opened", async () => {
  const world = createWorld();
  world.seed([world.session({ id: "one", name: "One" })]);

  /* The standalone window background.js opens. It stays open. */
  const manager = world.loadPopup(ORIGINAL);
  await world.flush();
  assert.equal(manager.cards().length, 1);

  /* Meanwhile the page saves two more sessions. */
  const current = world.read("sw_sessions_v3");
  world.storage.sw_sessions_v3 = [
    world.session({ id: "three", name: "Three" }),
    world.session({ id: "two", name: "Two" }),
    ...current,
  ];

  /* Back in the old window, rename the one session it knows about. */
  manager.clickIn(manager.cards()[0], ".btn-rename");
  const input = manager.document.querySelector(".rename-input");
  input.value = "One renamed";
  input.dispatchEvent(new DomEvent("keydown", { key: "Enter" }));
  await world.flush();

  const after = world.read("sw_sessions_v3");
  assert.equal(after.length, 1, "the two sessions saved in between are gone");
  assert.deepEqual(after.map(s => s.id), ["one"]);
});

/* ── P2: a wakeup every second, for ever ───────────────────────────────── */

test("ORIGINAL: the content script woke the main thread 3,600 times an hour", async () => {
  const world = createWorld();
  world.seed([]);
  const content = world.loadContent(ORIGINAL);
  world.clock.advance(2000);
  await world.flush();

  assert.deepEqual(world.clock.intervals(), [1000]);
  assert.equal(world.clock.wakeupsPer(3600 * 1000), 3600);

  /* Nothing changes on a page that is sitting still. */
  world.clock.advance(60 * 1000);
  await world.flush();
  assert.deepEqual(world.clock.intervals(), [1000]);

  /* And it kept ticking after the extension had been reloaded away. */
  content.kill();
  world.clock.advance(10 * 1000);
  assert.deepEqual(world.clock.intervals(), [1000],
    "a dead context cannot be healed by checking again every second");
});

/* ── P3: identity, duplicates and unreported failures ──────────────────── */

test("ORIGINAL: two sessions saved in the same millisecond shared an id", async () => {
  const world = createWorld();
  world.seed([]);
  const content = world.loadContent({ ...ORIGINAL, output: sentences("out") });
  world.clock.advance(1500);
  await world.flush();

  const save = async text => {
    content.document.querySelector("textarea").value = text;
    content.document.getElementById("sw-save-btn").dispatchEvent(new DomEvent("click", { bubbles: true }));
    await world.flush();
    content.document.getElementById("sw-name-save").dispatchEvent(new DomEvent("click", { bubbles: true }));
    await world.flush();
  };

  await save("first");
  await save("second");

  const ids = world.read("sw_sessions_v3").map(s => s.id);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1], "the clock did not move, so both ids are the same");
});

test("ORIGINAL: a backup repeating an id imported it twice", async () => {
  const world = createWorld();
  world.seed([]);
  const popup = world.loadPopup(ORIGINAL);
  await world.flush();

  await importInto(world, popup, JSON.stringify({
    sessions: [
      { id: "dup", savedAt: 1758239000000, inputText: "first" },
      { id: "dup", savedAt: 1758239100000, inputText: "second" },
    ],
  }));

  const stored = world.read("sw_sessions_v3");
  assert.equal(stored.length, 2);
  assert.equal(stored[0].id, stored[1].id);
});

test("ORIGINAL: a file containing null failed with nothing on screen", async () => {
  const world = createWorld();
  world.seed([]);
  const popup = world.loadPopup(ORIGINAL);
  await world.flush();

  await importInto(world, popup, "null");

  assert.equal(popup.status(), "", "no message at all");
  assert.ok(world.errors.some(e => e && e.name === "TypeError"),
    "it threw inside the FileReader callback instead");
});

/* ── P3: block elements ran together in saved output ───────────────────── */

test("ORIGINAL: two paragraphs of output were saved as one word", async () => {
  const world = createWorld();
  world.seed([]);
  const content = world.loadContent({
    ...ORIGINAL,
    output: "<p>This is the end.</p><p>Beginning again.</p>",
  });
  world.clock.advance(1500);
  await world.flush();

  content.document.querySelector("textarea").value = "input";
  content.document.getElementById("sw-save-btn").dispatchEvent(new DomEvent("click", { bubbles: true }));
  await world.flush();
  content.document.getElementById("sw-name-save").dispatchEvent(new DomEvent("click", { bubbles: true }));
  await world.flush();

  const saved = world.read("sw_sessions_v3")[0];
  assert.equal(saved.outputText, "This is the end.Beginning again.");
  assert.ok(saved.outputText.includes("end.Beginning"), "the two sentences are joined at the seam");
});

/* ── P3: a pending restore could be consumed twice ─────────────────────── */

test("ORIGINAL: the pending-restore guard was set after an async read", () => {
  const source = originalSource("content.js");
  const body = source.slice(source.indexOf("function consumePendingRestore"));
  const guard = body.indexOf("_consuming = true");
  const read = body.indexOf("chrome.storage.local.get");
  assert.ok(read < guard,
    "the read happens first, so two callers both get past `if (_consuming) return`");
});

/* ── Dispatching an undefined message threw ────────────────────────────── */

test("ORIGINAL: both listeners read .type off whatever arrived", () => {
  assert.match(originalSource("content.js"), /if \(msg\.type === 'SW_RESTORE'\)/);
  assert.match(originalSource("background.js"), /if \(msg\.type !== 'SW_OPEN_POPUP'\) return;/);
});
