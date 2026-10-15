/*
 * Staying attached to a single-page app without polling it to death.
 *
 * The original ran the whole check once a second for the life of the tab.
 * What replaced it has to do three things the timer did, and one it did not:
 * put the bar back when React takes it, notice a route change, keep working
 * in a browser with no Navigation API -- and stop waking the main thread when
 * nothing is happening.
 *
 * `world.clock.wakeupsPer(ms)` counts scheduled wakeups, so "cheaper" is an
 * assertion rather than a claim.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createWorld } = require("./harness.js");

async function settle(world, ms) {
  world.clock.advance(ms);
  await world.flush();
}

async function attached(options) {
  const world = createWorld(options);
  world.seed([]);
  const content = world.loadContent(options);
  await settle(world, 1500);
  return { world, content };
}

test("the bar goes up and the loop is not a one-second interval", async () => {
  const { world, content } = await attached({});
  assert.ok(content.bar());
  assert.deepEqual(world.clock.intervals(), [],
    "nothing here should be a setInterval at all any more");
});

test("an idle page backs off to one wakeup every thirty seconds", async () => {
  const { world } = await attached({});
  await settle(world, 120000);

  /* Ten minutes of sitting still, counted. */
  let wakeups = 0;
  const realSetTimeout = world.clock.setTimeout;
  world.clock.setTimeout = (...args) => { wakeups++; return realSetTimeout(...args); };
  await settle(world, 10 * 60 * 1000);
  world.clock.setTimeout = realSetTimeout;

  assert.ok(wakeups <= 22, `ten idle minutes cost ${wakeups} wakeups; the original cost 600`);
  assert.ok(wakeups >= 15, "but it does keep checking");
});

test("React removing the bar puts it back without waiting for the timer", async () => {
  const { world, content } = await attached({});
  await settle(world, 120000);
  const startedAt = world.clock.now;

  content.bar().remove();
  await world.flush();

  assert.ok(content.bar(), "the observer reattached it");
  assert.equal(world.clock.now, startedAt, "and did it without any time passing");
});

test("the bar is still restored when only the timer can see it go", async () => {
  /* The observer watches the header's parent. If the header itself is
   * replaced wholesale the observer may be watching a detached node, and the
   * backstop timer is what covers that. */
  const { world, content } = await attached({});
  await settle(world, 120000);

  content.document.body.innerHTML =
    '<header>fresh</header><main><textarea placeholder="Paste your AI-generated text here..."></textarea></main>';
  assert.equal(content.bar(), null);

  await settle(world, 31000);
  assert.ok(content.bar());
});

test("a pushState route change is noticed by the backstop timer in Firefox", async () => {
  const { world, content } = await attached({});
  assert.equal(content.sandbox.navigation, undefined, "this world has no Navigation API");

  content.navigate("/dashboard/settings");
  await settle(world, 31000);
  assert.equal(content.evaluate("_lastPath"), "/dashboard/settings");

  content.navigate("/dashboard/humanizer");
  await settle(world, 31000);
  assert.equal(content.evaluate("_lastPath"), "/dashboard/humanizer");
});

test("popstate is acted on immediately", async () => {
  const { world, content } = await attached({});
  await settle(world, 120000);
  const startedAt = world.clock.now;

  content.navigate("/dashboard/settings");
  content.fireWindow("popstate");
  await world.flush();

  assert.equal(content.evaluate("_lastPath"), "/dashboard/settings");
  assert.equal(world.clock.now, startedAt);
});

test("the Navigation API is used where the browser has one", async () => {
  const { world, content } = await attached({ navigationApi: true });
  await settle(world, 120000);
  const startedAt = world.clock.now;

  content.navigate("/dashboard/settings");
  content.fireNavigation("navigatesuccess");
  await world.flush();

  assert.equal(content.evaluate("_lastPath"), "/dashboard/settings");
  assert.equal(world.clock.now, startedAt);
});

test("leaving the humanizer closes an open restored panel", async () => {
  const { world, content } = await attached({});
  content.evaluate(`restoreSession({ id: "a", savedAt: ${Date.now()}, inputText: "x", outputText: "y" })`);
  await world.flush();
  assert.ok(content.panel());

  content.navigate("/dashboard/settings");
  content.fireWindow("popstate");
  await world.flush();
  assert.equal(content.panel(), null);
});

test("coming back to the humanizer re-injects the bar and looks for a pending restore", async () => {
  const { world, content } = await attached({});
  content.navigate("/dashboard/settings");
  content.fireWindow("popstate");
  await world.flush();
  content.bar().remove();

  world.storage.sw_pending_restore = {
    id: "p", savedAt: 1758239000000, inputText: "queued in", outputText: "queued out",
  };
  content.navigate("/dashboard/humanizer");
  content.fireWindow("popstate");
  await settle(world, 2000);

  assert.ok(content.bar());
  assert.match(content.panel().textContent, /queued out/);
});

test("the backoff resets as soon as something happens", async () => {
  const { world, content } = await attached({});
  await settle(world, 120000);

  content.bar().remove();
  await world.flush();
  assert.ok(content.bar());

  /* Back at the short interval: a second removal is caught by the timer
   * within a second even if the observer is not what sees it. */
  content.document.body.innerHTML =
    '<header>fresh</header><main><textarea placeholder="Paste your AI-generated text here..."></textarea></main>';
  await settle(world, 1100);
  assert.ok(content.bar());
});

test("a dead extension stops the loop instead of ticking against nothing", async () => {
  const { world, content } = await attached({});
  content.kill();
  await settle(world, 2000);
  assert.match(content.bar().textContent, /refresh this page to reconnect/);

  const before = world.clock.pending();
  await settle(world, 5 * 60 * 1000);
  assert.equal(world.clock.pending(), before,
    "no new wakeups are scheduled once the context is gone");
  assert.equal(world.clock.pending(), 0);
});

test("the loop does not run at all away from the humanizer", async () => {
  const world = createWorld();
  world.seed([]);
  const content = world.loadContent({ url: "https://stealthwriter.ai/dashboard/settings" });
  await settle(world, 120000);
  assert.equal(content.bar(), null);
  assert.deepEqual(world.errors, []);
});
