/*
 * The session manager: what it draws, and what it writes back.
 *
 * The escaping tests here use the shape check rather than a list of
 * payloads. Render the same session twice, once with a hostile string in a
 * field and once with an inert one, and require the two cards to have the
 * same elements with the same attributes in the same order. Content that
 * cannot change the shape of the markup cannot inject anything, whatever it
 * says, and there is no payload list to keep up to date.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createWorld } = require("./harness.js");
const { DomEvent } = require("./dom.js");

const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script>" onmouseover="alert(3)';
const INERT = "ordinary text";

/* Elements and attributes in document order, which is what must not vary. */
function shapeOf(element) {
  const shape = [];
  const walk = node => {
    for (const child of node.children) {
      shape.push(child.tagName + "[" + Object.keys(child.attributes).sort().map(
        name => name + "=" + child.getAttribute(name)).join("|") + "]");
      walk(child);
    }
  };
  walk(element);
  return shape;
}

async function cardFor(session) {
  const world = createWorld();
  world.seed([session]);
  const popup = world.loadPopup();
  await world.flush();
  return { world, popup, card: popup.cards()[0] };
}

/* ── Rendering ─────────────────────────────────────────────────────────── */

test("an empty list says so and hides the search row", async () => {
  const world = createWorld();
  world.seed([]);
  const popup = world.loadPopup();
  await world.flush();

  assert.equal(popup.cards().length, 0);
  assert.match(popup.document.getElementById("session-list").textContent, /No sessions saved yet/);
  assert.equal(popup.document.getElementById("search-row").style.display, "none");
});

test("a card shows the name, the counts and the relative time", async () => {
  const { popup } = await cardFor({
    id: "a1", savedAt: 1758240000000 - 90 * 60 * 1000, name: "Blog post",
    inputText: "one two three", outputText: "a b", wordCount: 3, outputWords: 2,
  });
  const card = popup.cards()[0];
  assert.equal(card.querySelector(".card-label").textContent, "Blog post");
  assert.equal(card.querySelectorAll(".pill")[0].textContent, "3 words in");
  assert.equal(card.querySelectorAll(".pill")[1].textContent, "2 words out");
  assert.match(card.querySelector(".card-meta").textContent, /1h ago/);
  assert.ok(card.querySelector(".card-date"), "a named session also shows its date");
});

test("an unnamed session is titled by its date and shows no second date line", async () => {
  const { popup } = await cardFor({ id: "a1", savedAt: 1758240000000, inputText: "x", wordCount: 1 });
  const card = popup.cards()[0];
  assert.match(card.querySelector(".card-label").textContent, /\d/);
  assert.equal(card.querySelector(".card-date"), null);
});

test("a session with no output says so", async () => {
  const { popup } = await cardFor({ id: "a1", savedAt: 1758240000000, inputText: "x", wordCount: 1 });
  assert.equal(popup.cards()[0].querySelectorAll(".pill")[1].textContent, "no output");
});

test("a pre-1.0 session falls back to its sentence count", async () => {
  const { popup } = await cardFor({
    id: "a1", savedAt: 1758240000000, inputText: "x", wordCount: 1, sentCount: 7,
  });
  assert.equal(popup.cards()[0].querySelectorAll(".pill")[1].textContent, "7 sentences");
});

test("more than four sessions reveals the search row", async () => {
  const world = createWorld();
  world.seed([1, 2, 3, 4, 5].map(n => world.session({ id: "s" + n, name: "S" + n })));
  const popup = world.loadPopup();
  await world.flush();
  assert.equal(popup.document.getElementById("search-row").style.display, "block");
});

test("search filters by title and by input text, and reports the count", async () => {
  const world = createWorld();
  world.seed([
    world.session({ id: "s1", name: "Essay", inputText: "alpha" }),
    world.session({ id: "s2", name: "Letter", inputText: "beta" }),
    world.session({ id: "s3", name: "Notes", inputText: "alpha again" }),
  ]);
  const popup = world.loadPopup();
  await world.flush();

  await popup.search("Letter");
  assert.deepEqual(popup.titles(), ["Letter"]);
  assert.match(popup.document.getElementById("section-label").textContent, /\(1 of 3\)/);

  await popup.search("alpha");
  assert.deepEqual(popup.titles(), ["Essay", "Notes"]);

  await popup.search("nothing here");
  assert.equal(popup.cards().length, 0);
  assert.match(popup.document.getElementById("session-list").textContent, /No matches/);
});

/* ── Escaping ──────────────────────────────────────────────────────────── */

test("a hostile name cannot change the shape of the card", async () => {
  const hostile = await cardFor({ id: "a1", savedAt: 1758240000000, name: HOSTILE, inputText: "x", wordCount: 1 });
  const inert = await cardFor({ id: "a1", savedAt: 1758240000000, name: INERT, inputText: "x", wordCount: 1 });
  assert.deepEqual(shapeOf(hostile.card), shapeOf(inert.card));
  assert.equal(hostile.card.querySelectorAll("img").length, 0);
});

test("a hostile id cannot break out of the data-id attribute", async () => {
  const hostile = await cardFor({ id: '" onclick="alert(1)', savedAt: 1758240000000, inputText: "x" });
  const inert = await cardFor({ id: "plain", savedAt: 1758240000000, inputText: "x" });
  assert.equal(shapeOf(hostile.card).length, shapeOf(inert.card).length);
  for (const button of hostile.card.querySelectorAll("button")) {
    assert.equal(button.getAttribute("onclick"), null);
    assert.equal(button.getAttribute("onmouseover"), null);
  }
  assert.equal(hostile.card.querySelector(".btn-restore").dataset.id, '" onclick="alert(1)');
});

test("a wordCount that is not a number cannot inject anything", async () => {
  /* The field that was interpolated raw. It is a number by the time render()
   * sees it and it is escaped anyway; this asserts both ends. */
  const hostile = await cardFor({
    id: "a1", savedAt: 1758240000000, inputText: "x", wordCount: HOSTILE, outputWords: 5,
  });
  const inert = await cardFor({
    id: "a1", savedAt: 1758240000000, inputText: "x", wordCount: 4, outputWords: 5,
  });
  assert.equal(hostile.card.querySelectorAll("img").length, 0);
  assert.equal(hostile.card.querySelectorAll("script").length, 0);
  assert.deepEqual(shapeOf(hostile.card), shapeOf(inert.card));
  assert.equal(hostile.card.querySelectorAll(".pill")[0].textContent, "0 words in");

  /* outputWords is interpolated through the same template. */
  const both = await cardFor({
    id: "a1", savedAt: 1758240000000, inputText: "x", wordCount: HOSTILE, outputWords: HOSTILE,
  });
  assert.equal(both.card.querySelectorAll("img").length, 0);
  assert.equal(both.card.querySelectorAll(".pill")[1].textContent, "no output");
});

test("a hostile sentCount is escaped in the fallback pill", async () => {
  const { card } = await cardFor({
    id: "a1", savedAt: 1758240000000, inputText: "x", sentCount: HOSTILE,
  });
  assert.equal(card.querySelectorAll("img").length, 0);
});

test("the shape check would fail on markup that really is injectable", () => {
  /* Without this, a shapeOf() that returned a constant would make every test
   * above pass and prove nothing. */
  const { Element } = require("./dom.js");
  const build = value => {
    const div = new Element("div");
    div.innerHTML = `<span class="pill">${value} words in</span>`;
    return div;
  };
  assert.notDeepEqual(shapeOf(build(HOSTILE)), shapeOf(build(INERT)));
});

/* ── Rename ────────────────────────────────────────────────────────────── */

test("renaming writes the new name and leaves the others alone", async () => {
  const world = createWorld();
  world.seed([world.session({ id: "s1", name: "One" }), world.session({ id: "s2", name: "Two" })]);
  const popup = world.loadPopup();
  await world.flush();

  await popup.rename(popup.cards()[0], "Renamed");
  assert.match(popup.status(), /Name updated/);
  assert.deepEqual(world.read("sw_sessions_v3").map(s => s.name), ["Renamed", "Two"]);
});

test("Escape abandons a rename, and a following blur does not resurrect it", async () => {
  const world = createWorld();
  world.seed([world.session({ id: "s1", name: "One" })]);
  const popup = world.loadPopup();
  await world.flush();

  popup.clickIn(popup.cards()[0], ".btn-rename");
  const input = popup.document.querySelector(".rename-input");
  input.value = "Abandoned";
  input.dispatchEvent(new DomEvent("keydown", { key: "Escape" }));
  input.dispatchEvent(new DomEvent("blur", {}));
  await world.flush();

  assert.equal(world.read("sw_sessions_v3")[0].name, "One");
  assert.equal(popup.document.querySelector(".rename-input"), null);
});

test("a rename commits once, not twice", async () => {
  const world = createWorld();
  world.seed([world.session({ id: "s1", name: "One" })]);
  const popup = world.loadPopup();
  await world.flush();

  const input = await popup.rename(popup.cards()[0], "Once");
  input.dispatchEvent(new DomEvent("blur", {}));
  await world.flush();

  assert.equal(world.read("sw_sessions_v3")[0].name, "Once");
  assert.equal(world.read("sw_sessions_v3").length, 1);
});

test("an empty name falls back to the date", async () => {
  const world = createWorld();
  world.seed([world.session({ id: "s1", name: "Named", savedAt: 1758240000000 })]);
  const popup = world.loadPopup();
  await world.flush();

  await popup.rename(popup.cards()[0], "   ");
  assert.equal(world.read("sw_sessions_v3")[0].name, "");
  assert.equal(popup.cards()[0].querySelector(".card-date"), null);
});

/* ── Delete ────────────────────────────────────────────────────────────── */

test("delete asks once and then does it", async () => {
  const world = createWorld();
  world.seed([world.session({ id: "s1", name: "One" }), world.session({ id: "s2", name: "Two" })]);
  const popup = world.loadPopup();
  await world.flush();

  const button = popup.clickIn(popup.cards()[0], ".btn-delete");
  assert.equal(button.textContent, "Confirm");
  assert.ok(button.classList.contains("armed"));
  assert.equal(world.read("sw_sessions_v3").length, 2, "one click deletes nothing");

  popup.clickIn(popup.cards()[0], ".btn-delete");
  await world.flush();
  assert.deepEqual(world.read("sw_sessions_v3").map(s => s.id), ["s2"]);
  assert.match(popup.status(), /Session deleted/);
});

test("an armed delete disarms itself after four seconds", async () => {
  const world = createWorld();
  world.seed([world.session({ id: "s1", name: "One" })]);
  const popup = world.loadPopup();
  await world.flush();

  popup.clickIn(popup.cards()[0], ".btn-delete");
  world.clock.advance(4001);
  await world.flush();
  assert.equal(popup.cards()[0].querySelector(".btn-delete").textContent, "Delete");

  popup.clickIn(popup.cards()[0], ".btn-delete");
  await world.flush();
  assert.equal(world.read("sw_sessions_v3").length, 1, "the next click arms again rather than deleting");
});

test("arming a delete and then searching disarms it", async () => {
  const world = createWorld();
  world.seed([1, 2, 3, 4, 5].map(n => world.session({ id: "s" + n, name: "S" + n })));
  const popup = world.loadPopup();
  await world.flush();

  popup.clickIn(popup.cards()[0], ".btn-delete");
  await popup.search("S1");
  popup.clickIn(popup.cards()[0], ".btn-delete");
  await world.flush();
  assert.equal(world.read("sw_sessions_v3").length, 5, "the click after a re-render arms rather than deletes");
});

/* ── Two windows at once ───────────────────────────────────────────────── */

test("a rename in a stale window keeps the sessions saved since it opened", async () => {
  const world = createWorld();
  world.seed([world.session({ id: "one", name: "One" })]);

  const manager = world.loadPopup();
  await world.flush();

  /* Another context saves two sessions while this window sits there. */
  const other = world.loadPopup();
  await world.flush();
  other.evaluate(`chrome.storage.local.set({ sw_sessions_v3: [
    { id: "three", savedAt: 1758239200000, name: "Three", inputText: "c", outputText: "", wordCount: 1, outputWords: 0 },
    { id: "two",   savedAt: 1758239100000, name: "Two",   inputText: "b", outputText: "", wordCount: 1, outputWords: 0 },
    ...${JSON.stringify(world.read("sw_sessions_v3"))}
  ] })`);
  await world.flush();

  await manager.rename(manager.cards().find(c => c.querySelector(".card-label").textContent === "One"), "One renamed");

  const after = world.read("sw_sessions_v3");
  assert.deepEqual(after.map(s => s.id).sort(), ["one", "three", "two"]);
  assert.equal(after.find(s => s.id === "one").name, "One renamed");
});

test("a window refreshes itself when another context changes storage", async () => {
  const world = createWorld();
  world.seed([world.session({ id: "one", name: "One" })]);
  const manager = world.loadPopup();
  const other = world.loadPopup();
  await world.flush();
  assert.deepEqual(manager.titles(), ["One"]);

  other.evaluate(`chrome.storage.local.set({ sw_sessions_v3: [
    { id: "two", savedAt: 1758239900000, name: "Two", inputText: "b", outputText: "", wordCount: 1, outputWords: 0 },
    { id: "one", savedAt: 1758239000000, name: "One", inputText: "a", outputText: "", wordCount: 1, outputWords: 0 }
  ] })`);
  await world.flush();

  assert.deepEqual(manager.titles(), ["Two", "One"]);
});

test("a storage change does not destroy a rename in progress", async () => {
  const world = createWorld();
  world.seed([world.session({ id: "one", name: "One" })]);
  const manager = world.loadPopup();
  const other = world.loadPopup();
  await world.flush();

  manager.clickIn(manager.cards()[0], ".btn-rename");
  const input = manager.document.querySelector(".rename-input");
  input.value = "Half typed";

  other.evaluate(`chrome.storage.local.set({ sw_sessions_v3: [
    { id: "two", savedAt: 1758239900000, name: "Two", inputText: "b", outputText: "", wordCount: 1, outputWords: 0 },
    { id: "one", savedAt: 1758239000000, name: "One", inputText: "a", outputText: "", wordCount: 1, outputWords: 0 }
  ] })`);
  await world.flush();

  assert.equal(manager.document.querySelector(".rename-input").value, "Half typed");

  input.dispatchEvent(new DomEvent("keydown", { key: "Enter" }));
  await world.flush();
  const after = world.read("sw_sessions_v3");
  assert.equal(after.find(s => s.id === "one").name, "Half typed");
  assert.ok(after.some(s => s.id === "two"), "and the session saved mid-edit survived");
});

test("deleting a session another window already deleted says so rather than resurrecting it", async () => {
  const world = createWorld();
  world.seed([world.session({ id: "one", name: "One" }), world.session({ id: "two", name: "Two" })]);
  const manager = world.loadPopup();
  await world.flush();

  const card = manager.cards()[0];
  manager.clickIn(card, ".btn-delete");

  /* Gone from underneath, without notifying: storage written directly. */
  world.storage.sw_sessions_v3 = [world.session({ id: "two", name: "Two" })];

  manager.clickIn(card, ".btn-delete");
  await world.flush();

  assert.match(manager.status(), /no longer saved/);
  assert.deepEqual(world.read("sw_sessions_v3").map(s => s.id), ["two"]);
});

/* ── Storage failures ──────────────────────────────────────────────────── */

test("a failed write is reported and the list is put back", async () => {
  const world = createWorld();
  world.seed([world.session({ id: "one", name: "One" })]);
  const popup = world.loadPopup();
  await world.flush();

  world.storageFailure = { message: "QUOTA_BYTES quota exceeded" };
  await popup.rename(popup.cards()[0], "Longer name");

  assert.match(popup.status(), /Could not save the name.*quota/i);
  assert.equal(popup.document.getElementById("status").className, "status err");
  assert.equal(world.read("sw_sessions_v3")[0].name, "One");
});

/* ── Export ────────────────────────────────────────────────────────────── */

test("export writes every session, not just the filtered ones", async () => {
  const world = createWorld();
  world.seed([
    world.session({ id: "s1", name: "Alpha" }),
    world.session({ id: "s2", name: "Beta" }),
  ]);
  const popup = world.loadPopup();
  await world.flush();
  await popup.search("Alpha");

  const blobs = [];
  popup.sandbox.Blob = class { constructor(parts) { blobs.push(parts.join("")); } };
  popup.click("btn-export");
  await world.flush();

  const payload = JSON.parse(blobs[0]);
  assert.equal(payload.format, "stealthwriter-sessions");
  assert.equal(payload.version, 1);
  assert.deepEqual(payload.sessions.map(s => s.id), ["s1", "s2"]);
  assert.match(popup.status(), /Exported 2 sessions/);
});

test("exporting nothing says so instead of writing an empty file", async () => {
  const world = createWorld();
  world.seed([]);
  const popup = world.loadPopup();
  await world.flush();

  let made = 0;
  popup.sandbox.Blob = class { constructor() { made++; } };
  popup.click("btn-export");
  await world.flush();

  assert.equal(made, 0);
  assert.match(popup.status(), /Nothing to export/);
});

/* ── The open/switch button ────────────────────────────────────────────── */

test("the button offers to open StealthWriter when no tab is on it", async () => {
  const world = createWorld();
  world.seed([]);
  const popup = world.loadPopup();
  await world.flush();
  assert.equal(popup.document.getElementById("btn-open").textContent, "Open StealthWriter");

  popup.click("btn-open");
  await world.flush();
  assert.equal(world.log.find(e => e.type === "tabs.create").props.url,
    "https://stealthwriter.ai/dashboard/humanizer");
});

test("the button offers to switch when a tab is already there", async () => {
  const world = createWorld();
  world.seed([]);
  const tab = world.addTab("https://stealthwriter.ai/dashboard/humanizer", 1);
  const popup = world.loadPopup();
  await world.flush();
  assert.equal(popup.document.getElementById("btn-open").textContent, "Switch to StealthWriter");

  popup.click("btn-open");
  await world.flush();
  const activated = world.log.find(e => e.type === "tabs.update" && e.props.active);
  assert.equal(activated.tabId, tab.id);
});
