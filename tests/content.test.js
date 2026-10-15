/*
 * The in-page half: finding the editor and the output, saving what is on
 * screen, and showing a restored snapshot.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createWorld, sentences } = require("./harness.js");
const { DomEvent } = require("./dom.js");

async function onPage(options) {
  const world = createWorld();
  world.seed((options || {}).sessions || []);
  const content = world.loadContent(options);
  world.clock.advance(1500);
  await world.flush();
  return { world, content };
}

/* ── Finding things on the page ────────────────────────────────────────── */

test("the save bar is injected after the header, once", async () => {
  const { world, content } = await onPage({});
  assert.ok(content.bar());
  assert.equal(content.document.body.children.map(c => c.tagName).join(","), "header,div,main");

  world.clock.advance(60000);
  await world.flush();
  assert.equal(content.document.querySelectorAll("#sw-save-bar").length, 1);
});

test("nothing is injected outside the humanizer", async () => {
  const { content } = await onPage({ url: "https://stealthwriter.ai/dashboard/settings" });
  assert.equal(content.bar(), null);
});

test("the badge shows the saved count and hides itself at zero", async () => {
  const { world, content } = await onPage({});
  assert.equal(content.count(), "");
  assert.equal(content.document.getElementById("sw-session-count").style.display, "none");

  content.type("some input text here");
  await content.save("Named");
  await world.flush();
  assert.equal(content.count(), "1 saved session");

  content.type("more input");
  await content.save("Second");
  assert.equal(content.count(), "2 saved sessions");
});

test("the output div is found through the heading, and then through fallbacks", async () => {
  const withCard = await onPage({ output: sentences("One.", "Two.") });
  assert.equal(withCard.content.evaluate("getOutputDiv()").textContent.trim(), "One. Two.");

  /* No heading, but the sentence spans are still there. */
  const noHeading = await onPage({
    html: `<html><body><header>h</header><main>
      <textarea placeholder="Paste your AI-generated text here..."></textarea>
      <div class="whitespace-pre-wrap"><span role="button">Fallback.</span></div>
    </main></body></html>`,
  });
  assert.equal(noHeading.content.evaluate("getOutputDiv()").textContent, "Fallback.");

  /* Nothing rendered at all is expected, not an error. */
  const bare = await onPage({});
  assert.equal(bare.content.evaluate("getOutputDiv()"), null);
});

/* ── Saving ────────────────────────────────────────────────────────────── */

test("saving stores the input, the output and both word counts", async () => {
  const { world, content } = await onPage({ output: sentences("Humanized one.", "Humanized two.") });
  content.type("Some input text of five words");
  await content.save("Blog draft");

  const stored = world.read("sw_sessions_v3");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].name, "Blog draft");
  assert.equal(stored[0].inputText, "Some input text of five words");
  assert.equal(stored[0].outputText, "Humanized one. Humanized two.");
  assert.equal(stored[0].wordCount, 6);
  assert.equal(stored[0].outputWords, 4);
  assert.equal(stored[0].outputHTML, undefined, "markup is not persisted any more");
});

test("cancelling the name dialog saves nothing", async () => {
  const { world, content } = await onPage({ output: sentences("out") });
  content.type("input");
  await content.save(null);
  assert.equal(world.read("sw_sessions_v3").length, 0);
});

test("an empty name is allowed and is not the same as cancelling", async () => {
  const { world, content } = await onPage({ output: sentences("out") });
  content.type("input");
  await content.save("");
  assert.equal(world.read("sw_sessions_v3").length, 1);
  assert.equal(world.read("sw_sessions_v3")[0].name, "");
});

test("an empty editor with no output refuses to save", async () => {
  const { world, content } = await onPage({});
  content.type("   ");
  const opened = await content.save("Nothing");
  assert.equal(opened, false, "the name dialog is not even shown");
  assert.deepEqual(world.read("sw_sessions_v3"), []);
  assert.ok(world.log.some(e => e.type === "console.warn" && /nothing to save/.test(e.args[0])));
});

test("with no live output, an open restored panel is saved instead", async () => {
  const { world, content } = await onPage({
    sessions: [{ id: "p", savedAt: 1758239000000, name: "Earlier", inputText: "earlier in", outputText: "earlier out" }],
  });
  content.evaluate("restoreSession(" + JSON.stringify({
    id: "p", savedAt: 1758239000000, name: "Earlier", inputText: "earlier in", outputText: "earlier out",
  }) + ")");
  await world.flush();
  assert.ok(content.panel());

  content.type("new input");
  await content.save("Carried forward");
  const saved = world.read("sw_sessions_v3")[0];
  assert.equal(saved.outputText, "earlier out");
});

test("saved ids are unique even inside one millisecond", async () => {
  const { world, content } = await onPage({ output: sentences("out") });
  content.type("first");
  await content.save("A");
  content.type("second");
  await content.save("B");

  const ids = world.read("sw_sessions_v3").map(s => s.id);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  for (const id of ids) assert.match(id, /^\d+-[0-9a-z]{8}$/);
});

test("a save reads the current list rather than one it cached", async () => {
  const { world, content } = await onPage({ output: sentences("out") });
  world.storage.sw_sessions_v3 = [world.session({ id: "elsewhere", name: "Saved elsewhere" })];
  content.type("mine");
  await content.save("Mine");

  assert.deepEqual(world.read("sw_sessions_v3").map(s => s.name), ["Mine", "Saved elsewhere"]);
});

test("a failed write is logged and the badge does not move", async () => {
  const { world, content } = await onPage({ output: sentences("out") });
  world.storageFailure = { message: "QUOTA_BYTES quota exceeded" };
  content.type("input");
  await content.save("Too big");

  assert.equal(content.count(), "");
  assert.ok(world.log.some(e => e.type === "console.warn" && /storage may be full/.test(e.args[0])));
});

/* ── Text extraction ───────────────────────────────────────────────────── */

test("htmlToText keeps line breaks, paragraph breaks and entities", async () => {
  const { content } = await onPage({});
  const text = html => content.evaluate("htmlToText(" + JSON.stringify(html) + ")");

  assert.equal(text("one<br>two"), "one\ntwo");
  assert.equal(text("<p>This is the end.</p><p>Beginning again.</p>"), "This is the end.\nBeginning again.");
  assert.equal(text("<div>a</div><div>b</div>"), "a\nb");
  assert.equal(text("<ul><li>one</li><li>two</li></ul>"), "one\ntwo");
  assert.equal(text("Tom &amp; Jerry &lt;3"), "Tom & Jerry <3");
  assert.equal(text(sentences("One.", "Two.")), "One. Two.", "inline spans are not broken apart");
  assert.equal(text("<p>a</p><br><br><br><p>b</p>"), "a\n\nb", "runs of blank lines are collapsed");
  assert.equal(text(""), "");
});

test("htmlToText does not execute what it parses", async () => {
  const { world, content } = await onPage({});
  const text = content.evaluate(
    'htmlToText("<img src=x onerror=\\"globalThis.__ran = true\\"><script>globalThis.__ran = true<\\/script>hello")');
  assert.equal(text, "hello");
  assert.equal(content.evaluate("typeof globalThis.__ran"), "undefined");
  assert.deepEqual(world.errors, []);
});

/* ── The restored panel ────────────────────────────────────────────────── */

async function restored(world, content, session) {
  content.evaluate("restoreSession(" + JSON.stringify(session) + ")");
  await world.flush();
  return content.panel();
}

test("a restore fills the editor and shows the saved output read-only", async () => {
  const { world, content } = await onPage({});
  const panel = await restored(world, content, {
    id: "a", savedAt: 1758240000000 - 3600000, name: "Yesterday's draft",
    inputText: "restored input", outputText: "one two three",
  });

  assert.equal(content.editor().value, "restored input");
  assert.match(panel.querySelector(".sw-panel-title").textContent, /Yesterday's draft/);
  assert.match(panel.querySelector(".sw-panel-sub").textContent, /3 words of saved output/);
  assert.equal(panel.querySelector(".sw-panel-body").textContent, "one two three");
  assert.equal(panel.parentNode, content.document.body, "mounted outside React's tree");
});

test("saved text is rendered as text, never as markup", async () => {
  const { world, content } = await onPage({});
  const panel = await restored(world, content, {
    id: "a", savedAt: 1758240000000, inputText: "x",
    outputText: '<img src=x onerror="alert(1)"> and <b>bold</b>',
  });
  const body = panel.querySelector(".sw-panel-body");
  assert.equal(body.children.length, 0);
  assert.equal(body.textContent, '<img src=x onerror="alert(1)"> and <b>bold</b>');
});

test("a session with no output restores only the editor", async () => {
  const { world, content } = await onPage({});
  await restored(world, content, { id: "a", savedAt: 1758240000000, inputText: "just input", outputText: "" });
  assert.equal(content.editor().value, "just input");
  assert.equal(content.panel(), null);
});

test("restoring when the editor is missing warns and changes nothing", async () => {
  const { world, content } = await onPage({
    html: "<html><body><header>h</header><main></main></body></html>",
  });
  await restored(world, content, { id: "a", savedAt: 1758240000000, inputText: "x", outputText: "y" });
  assert.equal(content.panel(), null);
  assert.ok(world.log.some(e => e.type === "console.warn" && /editor not found/.test(e.args[0])));
});

test("the panel's buttons close it, fold it and copy its text", async () => {
  const { world, content } = await onPage({});
  const panel = await restored(world, content,
    { id: "a", savedAt: 1758240000000, inputText: "x", outputText: "copy me" });
  const [copy, fold, close] = panel.querySelectorAll(".sw-panel-btn");

  copy.dispatchEvent(new DomEvent("click", { bubbles: true }));
  await world.flush();
  assert.ok(world.log.some(e => e.type === "clipboard.write" && e.text === "copy me"));
  assert.equal(copy.textContent, "Copied");
  world.clock.advance(1600);
  assert.equal(copy.textContent, "Copy text");

  fold.dispatchEvent(new DomEvent("click", { bubbles: true }));
  assert.ok(panel.classList.contains("sw-folded"));
  assert.equal(fold.textContent, "Show text");

  close.dispatchEvent(new DomEvent("click", { bubbles: true }));
  assert.equal(content.panel(), null);
});

test("restoring twice leaves one panel", async () => {
  const { world, content } = await onPage({});
  const session = { id: "a", savedAt: 1758240000000, inputText: "x", outputText: "y" };
  await restored(world, content, session);
  await restored(world, content, session);
  assert.equal(content.document.querySelectorAll("#sw-restored-panel").length, 1);
});

test("a fresh humanization retires the restored snapshot", async () => {
  const { world, content } = await onPage({ output: sentences("Old output.") });
  await restored(world, content, { id: "a", savedAt: 1758240000000, inputText: "x", outputText: "saved copy" });
  assert.ok(content.panel());

  content.setOutput(sentences("Brand new output."));
  await world.flush();
  assert.equal(content.panel(), null, "two output blocks on screen is the thing being avoided");
});

test("the panel's observer is not left running for ever", async () => {
  const { world, content } = await onPage({ output: sentences("Old.") });
  await restored(world, content, { id: "a", savedAt: 1758240000000, inputText: "x", outputText: "y" });

  world.clock.advance(15 * 60 * 1000 + 1000);
  await world.flush();
  content.setOutput(sentences("New output arrives much later."));
  await world.flush();
  assert.ok(content.panel(), "after the deadline the observer has let go");
});

/* ── A reloaded extension ──────────────────────────────────────────────── */

test("an orphaned content script says so instead of looking healthy", async () => {
  const { world, content } = await onPage({});
  assert.ok(content.bar().querySelector("#sw-save-btn"));

  content.kill();
  world.clock.advance(2000);
  await world.flush();

  const bar = content.bar();
  assert.equal(bar.dataset.stale, "1");
  assert.match(bar.textContent, /refresh this page to reconnect/);
  const refresh = bar.querySelector(".sw-save-btn");
  refresh.dispatchEvent(new DomEvent("click", { bubbles: true }));
  assert.ok(world.log.some(e => e.type === "location.reload"));
});

test("the badge asks the worker to open the manager", async () => {
  const world = createWorld();
  world.seed([world.session({ id: "s1" })]);
  world.loadBackground();
  const content = world.loadContent({});
  world.clock.advance(1500);
  await world.flush();

  content.document.getElementById("sw-session-count").dispatchEvent(new DomEvent("click", { bubbles: true }));
  await world.flush();
  world.clock.advance(10);
  await world.flush();

  assert.ok(world.log.some(e => e.type === "windows.create" && /popup\.html$/.test(e.props.url)),
    "openPopup() is rejected in this world, so the standalone window is the fallback");
});
