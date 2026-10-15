/*
 * Getting a saved session back into the page.
 *
 * The headline case is the first one: a restore into a tab whose content
 * script is running has to be delivered by message and nothing else. The
 * original reloaded the tab every time, because of a rule about message
 * ports rather than anything to do with this extension -- see the comment
 * above the listener in content.js.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createWorld, sentences } = require("./harness.js");

function humanizerWorld(sessions, options) {
  const world = createWorld(options);
  world.seed(sessions);
  const tab = world.addTab("https://stealthwriter.ai/dashboard/humanizer", 1);
  tab.active = true;
  return { world, tab };
}

async function ready(world, tab, options) {
  const content = world.loadContent({ ...(options || {}), tab });
  world.clock.advance(1500);
  await world.flush();
  return content;
}

test("a restore into a live tab is delivered by message, with no reload", async () => {
  const { world, tab } = humanizerWorld([
    { id: "a1", savedAt: 1758239000000, name: "Draft", inputText: "the input", outputText: "the output", wordCount: 2, outputWords: 2 },
  ]);
  const content = await ready(world, tab, { output: sentences("old") });

  const popup = world.loadPopup();
  await world.flush();
  popup.clickIn(popup.cards()[0], ".btn-restore");
  await world.flush();
  world.clock.advance(1000);
  await world.flush();

  assert.ok(!world.log.some(e => e.type === "tabs.reload"), "the tab must not be reloaded");
  assert.equal(world.read("sw_pending_restore"), undefined, "nothing was queued");
  assert.equal(content.editor().value, "the input");
  assert.ok(content.panel(), "the saved output panel is on screen");
  assert.match(content.panel().textContent, /the output/);
  assert.ok(world.log.some(e => e.type === "popup.close"));
});

test("the content script answers the restore message", async () => {
  const { world, tab } = humanizerWorld([]);
  await ready(world, tab);

  const popup = world.loadPopup();
  await world.flush();

  let replied = null;
  let error = null;
  popup.sandbox.chrome.tabs.sendMessage(tab.id, { type: "SW_RESTORE", session: world.session() }, response => {
    error = popup.sandbox.chrome.runtime.lastError || null;
    replied = response;
  });
  await world.flush();

  assert.equal(error, null, "a listener that does not answer closes the port");
  assert.deepEqual(replied, { ok: true });
});

test("an unrelated message is ignored without an answer", async () => {
  const { world, tab } = humanizerWorld([]);
  await ready(world, tab);
  const popup = world.loadPopup();
  await world.flush();

  let error = null;
  popup.sandbox.chrome.tabs.sendMessage(tab.id, { type: "SOMETHING_ELSE" }, () => {
    error = popup.sandbox.chrome.runtime.lastError || null;
  });
  await world.flush();
  assert.match(error.message, /message port closed/,
    "only SW_RESTORE is answered, and that is the correct behaviour for the rest");
});

test("an undefined message does not throw in either listener", async () => {
  const { world, tab } = humanizerWorld([]);
  await ready(world, tab);
  world.loadBackground();
  const popup = world.loadPopup();
  await world.flush();

  popup.sandbox.chrome.tabs.sendMessage(tab.id, undefined, () => {});
  popup.sandbox.chrome.runtime.sendMessage(undefined);
  await world.flush();
  assert.deepEqual(world.errors, []);
});

test("a tab with no content script still queues and reloads", async () => {
  /* The self-heal path is not removed -- it is only stopped from firing when
   * the page is fine. An orphaned content script, which is what a reload of
   * the add-on leaves behind, is exactly what it is for. */
  const { world, tab } = humanizerWorld([{ id: "a1", savedAt: 1758239000000, inputText: "x" }]);
  const content = await ready(world, tab);
  content.kill();

  const popup = world.loadPopup();
  await world.flush();
  popup.clickIn(popup.cards()[0], ".btn-restore");
  await world.flush();
  world.clock.advance(1000);
  await world.flush();

  assert.ok(world.log.some(e => e.type === "tabs.reload"));
  assert.equal(world.read("sw_pending_restore").id, "a1");
  assert.match(popup.status(), /reloading it to restore/);
});

test("with no StealthWriter tab open, the restore is queued and a tab opened", async () => {
  const world = createWorld();
  world.seed([{ id: "a1", savedAt: 1758239000000, inputText: "x" }]);
  const popup = world.loadPopup();
  await world.flush();

  popup.clickIn(popup.cards()[0], ".btn-restore");
  await world.flush();

  assert.equal(world.read("sw_pending_restore").id, "a1");
  const created = world.log.find(e => e.type === "tabs.create");
  assert.equal(created.props.url, "https://stealthwriter.ai/dashboard/humanizer");
});

test("a StealthWriter tab that is not the humanizer is navigated there first", async () => {
  const world = createWorld();
  world.seed([{ id: "a1", savedAt: 1758239000000, inputText: "x" }]);
  const tab = world.addTab("https://stealthwriter.ai/dashboard/settings", 1);
  tab.active = true;

  const popup = world.loadPopup();
  await world.flush();
  popup.clickIn(popup.cards()[0], ".btn-restore");
  await world.flush();

  assert.equal(world.read("sw_pending_restore").id, "a1");
  const navigated = world.log.filter(e => e.type === "tabs.update" && e.props.url);
  assert.equal(navigated.length, 1);
  assert.equal(navigated[0].props.url, "https://stealthwriter.ai/dashboard/humanizer");
});

test("a humanizer tab in the current window beats one in another window", async () => {
  const world = createWorld();
  world.seed([{ id: "a1", savedAt: 1758239000000, inputText: "x" }]);
  const other = world.addTab("https://stealthwriter.ai/dashboard/humanizer", 2);
  const here = world.addTab("https://stealthwriter.ai/dashboard/humanizer", 1);
  const active = world.addTab("https://example.com/", 1);
  active.active = true;
  world.focusedWindowId = 1;

  const popup = world.loadPopup();
  await world.flush();
  await ready(world, here);
  await ready(world, other);

  popup.clickIn(popup.cards()[0], ".btn-restore");
  await world.flush();

  const activated = world.log.filter(e => e.type === "tabs.update" && e.props.active);
  assert.equal(activated.length, 1);
  assert.equal(activated[0].tabId, here.id);
});

test("a queued restore is applied once the editor exists", async () => {
  const { world, tab } = humanizerWorld([]);
  world.storage.sw_pending_restore = {
    id: "p1", savedAt: 1758239000000, name: "Queued",
    inputText: "queued input", outputText: "queued output",
  };

  /* React has not mounted yet: no textarea on the page. */
  const content = await ready(world, tab, { html: "<html><body><header>h</header><main></main></body></html>" });
  assert.equal(content.panel(), null);
  assert.equal(world.read("sw_pending_restore").id, "p1", "still queued while the page is bare");

  content.document.querySelector("main").innerHTML =
    '<textarea placeholder="Paste your AI-generated text here..."></textarea>';
  world.clock.advance(500);
  await world.flush();

  assert.equal(world.read("sw_pending_restore"), undefined, "consumed exactly once");
  assert.equal(content.editor().value, "queued input");
  assert.match(content.panel().textContent, /queued output/);
});

test("a queued restore is given up on after thirty seconds", async () => {
  const { world, tab } = humanizerWorld([]);
  world.storage.sw_pending_restore = { id: "p1", savedAt: 1758239000000, inputText: "never" };
  const content = await ready(world, tab, { html: "<html><body><header>h</header><main></main></body></html>" });

  world.clock.advance(31000);
  await world.flush();

  assert.ok(world.log.some(e => e.type === "console.warn" && /gave up waiting/.test(e.args[0])));
  assert.equal(content.panel(), null);
  assert.equal(world.read("sw_pending_restore").id, "p1",
    "and it is left in place rather than thrown away");
});

test("a pending restore is consumed once even when two callers race", async () => {
  const { world, tab } = humanizerWorld([]);
  const content = await ready(world, tab);

  /* Writing the key fires storage.onChanged, and init() is also looking. */
  const restores = [];
  world.storage.sw_pending_restore = { id: "p1", savedAt: 1758239000000, inputText: "once", outputText: "out" };
  content.sandbox.chrome.storage.local.set({
    sw_pending_restore: { id: "p1", savedAt: 1758239000000, inputText: "once", outputText: "out" },
  }, () => restores.push("set"));
  content.evaluate("consumePendingRestore()");
  content.evaluate("consumePendingRestore()");
  await world.flush();
  world.clock.advance(1000);
  await world.flush();

  assert.equal(world.read("sw_pending_restore"), undefined);
  assert.equal(content.document.querySelectorAll("#sw-restored-panel").length, 1);
});

test("restoring a session that has since been deleted says so and releases the button", async () => {
  const world = createWorld();
  world.seed([{ id: "gone", savedAt: 1758239000000, inputText: "x" }]);
  const popup = world.loadPopup();
  await world.flush();

  /* Deleted in the other window, after this one drew its list. */
  popup.evaluate("_all = []");
  popup.clickIn(popup.cards()[0], ".btn-restore");
  await world.flush();

  assert.match(popup.status(), /no longer saved/);
  assert.equal(popup.cards().length, 0);
});

test("a legacy session that stored markup instead of text still restores", async () => {
  const { world, tab } = humanizerWorld([{
    id: "old", savedAt: 1758239000000, name: "Pre-1.0",
    inputText: "in", outputHTML: "<p>First para.</p><p>Second para.</p>",
    sentCount: 2,
  }]);
  const content = await ready(world, tab);

  const popup = world.loadPopup();
  await world.flush();
  assert.match(popup.cards()[0].textContent, /2 sentences/);

  popup.clickIn(popup.cards()[0], ".btn-restore");
  await world.flush();

  assert.equal(content.panel().querySelector(".sw-panel-body").textContent,
    "First para.\nSecond para.");
});
