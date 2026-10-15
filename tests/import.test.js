/*
 * Reading a backup file.
 *
 * This is the only path by which data that the extension did not write can
 * reach storage, and everything downstream -- the card template, cardTitle(),
 * the search filter, the content script's restore -- was written on the
 * assumption that a session has the shape content.js gives it. So the tests
 * here are mostly about what a session is allowed to be, rather than about
 * the file format.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createWorld, unreadableFile } = require("./harness.js");

async function importing(json, existing) {
  const world = createWorld();
  world.seed(existing || []);
  const popup = world.loadPopup();
  await world.flush();
  await popup.importJson(typeof json === "string" ? json : JSON.stringify(json));
  return { world, popup, stored: () => world.read("sw_sessions_v3") || [] };
}

const GOOD = {
  id: "imported-1", savedAt: 1758239000000, name: "From a backup",
  inputText: "in", outputText: "out", wordCount: 1, outputWords: 1,
};

/* ── The envelope ──────────────────────────────────────────────────────── */

test("an exported backup imports", async () => {
  const { popup, stored } = await importing({
    format: "stealthwriter-sessions", version: 1, exportedAt: "2026-09-19T00:00:00Z",
    sessions: [GOOD],
  });
  assert.equal(stored().length, 1);
  assert.deepEqual(popup.titles(), ["From a backup"]);
  assert.match(popup.status(), /Imported 1 session\./);
});

test("a bare array of sessions imports too", async () => {
  const { stored } = await importing([GOOD]);
  assert.equal(stored().length, 1);
});

test("a file that is not JSON says so", async () => {
  const { popup, stored } = await importing("not json at all");
  assert.match(popup.status(), /not valid JSON/);
  assert.equal(stored().length, 0);
});

test("a file containing null says so instead of failing silently", async () => {
  const { popup, world } = await importing("null");
  assert.match(popup.status(), /No sessions found/);
  assert.deepEqual(world.errors, [], "and it does not throw");
});

test("a file containing a number, a string or an object with no sessions says so", async () => {
  for (const body of ["42", '"hello"', "{}", '{"sessions":"nope"}']) {
    const { popup, world } = await importing(body);
    assert.match(popup.status(), /No sessions found/, "for " + body);
    assert.deepEqual(world.errors, [], "for " + body);
  }
});

test("an unreadable file is reported", async () => {
  const world = createWorld();
  world.seed([]);
  const popup = world.loadPopup();
  await world.flush();
  await popup.importJson(unreadableFile());
  assert.match(popup.status(), /Could not read that file/);
});

test("a file of sessions that are all unusable says so", async () => {
  const { popup, stored } = await importing({ sessions: [null, 7, {}, { id: 5 }, { id: "x" }] });
  assert.match(popup.status(), /No usable sessions/);
  assert.equal(stored().length, 0);
});

/* ── Field types ───────────────────────────────────────────────────────── */

test("a session with no id, or a non-string id, is dropped", async () => {
  const { stored } = await importing({
    sessions: [
      { savedAt: 1758239000000, inputText: "a" },
      { id: 12345, savedAt: 1758239000000, inputText: "b" },
      { id: "", savedAt: 1758239000000, inputText: "c" },
      GOOD,
    ],
  });
  assert.deepEqual(stored().map(s => s.id), ["imported-1"]);
});

test("a session whose savedAt is not a finite number is dropped", async () => {
  const { stored } = await importing({
    sessions: [
      { id: "a", savedAt: "2026-09-19", inputText: "x" },
      { id: "b", savedAt: NaN, inputText: "x" },
      { id: "c", inputText: "x" },
      GOOD,
    ],
  });
  assert.deepEqual(stored().map(s => s.id), ["imported-1"]);
});

test("a session with no text field at all is dropped", async () => {
  const { stored } = await importing({
    sessions: [{ id: "a", savedAt: 1758239000000, wordCount: 5 }, GOOD],
  });
  assert.deepEqual(stored().map(s => s.id), ["imported-1"]);
});

test("a name that is not a string becomes an empty name, and the popup still draws", async () => {
  const { popup, stored, world } = await importing({
    sessions: [{ id: "a", savedAt: 1758240000000, inputText: "x", name: 42 }],
  });
  assert.deepEqual(world.errors, [], "this is the case that used to throw inside render()");
  assert.equal(stored()[0].name, "");
  assert.equal(popup.cards().length, 1);
  assert.match(popup.titles()[0], /\d/, "it falls back to the date, as an unnamed session does");
});

test("an over-long name is trimmed to the length the rename box allows", async () => {
  const { stored } = await importing({
    sessions: [{ id: "a", savedAt: 1758239000000, inputText: "x", name: "n".repeat(500) }],
  });
  assert.equal(stored()[0].name.length, 60);
});

test("text fields that are not strings become empty strings", async () => {
  const { stored, popup } = await importing({
    sessions: [{ id: "a", savedAt: 1758239000000, inputText: "real", outputText: { evil: true } }],
  });
  assert.equal(stored()[0].outputText, "");
  assert.equal(stored()[0].inputText, "real");
  await popup.search("real");
  assert.equal(popup.cards().length, 1, "and the search filter does not throw on them");
});

test("counts that are not numbers become zero, and fractions are floored", async () => {
  const { stored } = await importing({
    sessions: [
      { id: "a", savedAt: 1758239000000, inputText: "x", wordCount: "12", outputWords: -5 },
      { id: "b", savedAt: 1758239000001, inputText: "x", wordCount: 12.7, outputWords: Infinity },
    ],
  });
  const byId = Object.fromEntries(stored().map(s => [s.id, s]));
  assert.equal(byId.a.wordCount, 0);
  assert.equal(byId.a.outputWords, 0);
  assert.equal(byId.b.wordCount, 12);
  assert.equal(byId.b.outputWords, 0);
});

test("a pre-1.0 session with outputHTML and sentCount is kept, markup and all", async () => {
  const { stored } = await importing({
    sessions: [{
      id: "old", savedAt: 1758239000000,
      outputHTML: "<p>One.</p><p>Two.</p>", sentCount: 2,
    }],
  });
  assert.equal(stored()[0].outputHTML, "<p>One.</p><p>Two.</p>");
  assert.equal(stored()[0].sentCount, 2);
  assert.equal(stored()[0].outputText, "");
});

test("fields the format does not define are not carried into storage", async () => {
  const { stored } = await importing({
    sessions: [{ ...GOOD, __proto__: { polluted: true }, extra: "anything" }],
  });
  assert.equal(stored()[0].extra, undefined);
  assert.deepEqual(Object.keys(stored()[0]).sort(),
    ["id", "inputText", "name", "outputText", "outputWords", "savedAt", "wordCount"]);
});

/* ── Identity ──────────────────────────────────────────────────────────── */

test("a session already saved is skipped", async () => {
  const world = createWorld();
  world.seed([{ ...GOOD, name: "Mine" }]);
  const popup = world.loadPopup();
  await world.flush();
  await popup.importJson(JSON.stringify({ sessions: [{ ...GOOD, name: "Theirs" }] }));

  assert.equal(world.read("sw_sessions_v3").length, 1);
  assert.equal(world.read("sw_sessions_v3")[0].name, "Mine", "the local copy wins");
  assert.match(popup.status(), /already saved/);
});

test("a backup that repeats an id within itself imports it once", async () => {
  const { stored } = await importing({
    sessions: [
      { id: "dup", savedAt: 1758239000000, inputText: "first" },
      { id: "dup", savedAt: 1758239100000, inputText: "second" },
    ],
  });
  assert.equal(stored().length, 1);
  assert.equal(stored()[0].inputText, "first");
});

test("an import merges into what is in storage now, not what the window last saw", async () => {
  const world = createWorld();
  world.seed([world.session({ id: "mine", name: "Mine" })]);
  const popup = world.loadPopup();
  const other = world.loadPopup();
  await world.flush();

  /* Written directly, so this popup's `_all` never hears about it. */
  world.storage.sw_sessions_v3 = [
    world.session({ id: "later", name: "Saved later", savedAt: 1758239500000 }),
    world.session({ id: "mine", name: "Mine" }),
  ];

  await popup.importJson(JSON.stringify({ sessions: [GOOD] }));
  assert.deepEqual(world.read("sw_sessions_v3").map(s => s.id).sort(), ["imported-1", "later", "mine"]);
  assert.ok(other, "two windows were open throughout");
});

test("the merged list is newest first", async () => {
  const world = createWorld();
  world.seed([world.session({ id: "mid", savedAt: 1758239500000, name: "Mid" })]);
  const popup = world.loadPopup();
  await world.flush();
  await popup.importJson(JSON.stringify({
    sessions: [
      { id: "old", savedAt: 1758239000000, inputText: "x", name: "Old" },
      { id: "new", savedAt: 1758239900000, inputText: "x", name: "New" },
    ],
  }));
  assert.deepEqual(popup.titles(), ["New", "Mid", "Old"]);
});

test("a failed write during import is reported", async () => {
  const world = createWorld();
  world.seed([]);
  const popup = world.loadPopup();
  await world.flush();
  world.storageFailure = { message: "QUOTA_BYTES quota exceeded" };
  await popup.importJson(JSON.stringify({ sessions: [GOOD] }));

  assert.match(popup.status(), /storage may be full/);
  assert.equal(popup.document.getElementById("status").className, "status err");
});

test("the file input is cleared so the same file can be chosen twice", async () => {
  const world = createWorld();
  world.seed([]);
  const popup = world.loadPopup();
  await world.flush();
  await popup.importJson(JSON.stringify({ sessions: [GOOD] }));
  assert.equal(popup.document.getElementById("file-input").value, "");
});

/* ── Storage written by an older version ───────────────────────────────── */

test("a malformed record already in storage does not stop the popup drawing", async () => {
  const world = createWorld();
  /* What the original would have written after importing a hostile file. */
  world.seed([
    { id: "bad", savedAt: 1758239000000, inputText: "x", name: 42 },
    { id: "good", savedAt: 1758239100000, inputText: "y", name: "Fine" },
    "not even an object",
  ]);
  const popup = world.loadPopup();
  await world.flush();

  assert.deepEqual(world.errors, []);
  assert.equal(popup.cards().length, 2, "the poisoned record is repaired, the junk one dropped");
  assert.ok(popup.titles().includes("Fine"));
});

test("a rename after a repair writes the repaired list back", async () => {
  const world = createWorld();
  world.seed([
    { id: "bad", savedAt: 1758239000000, inputText: "x", name: 42 },
    "not even an object",
  ]);
  const popup = world.loadPopup();
  await world.flush();
  await popup.rename(popup.cards()[0], "Repaired");

  const stored = world.read("sw_sessions_v3");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].name, "Repaired");
});
