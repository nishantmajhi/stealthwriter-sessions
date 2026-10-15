/*
 * The harness DOM is test infrastructure, so it is tested before anything is
 * tested with it. Every case here exists because some assertion elsewhere in
 * this suite would be worthless if it were wrong: the escaping tests need a
 * parser that really builds elements, `getOutputDiv()` needs `[class*=]` and
 * `:scope >`, and every rename and delete test needs CSS escapes in a quoted
 * attribute value to decode.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DOMParser, DomEvent, Element, HtmlDocument, HTMLTextAreaElement,
  cssEscape, cssUnescape, parseFragment,
} = require("./dom.js");

test("innerHTML builds elements rather than stripping tags", () => {
  const div = new Element("div");
  div.innerHTML = '<span class="pill">4 words</span><b>x</b>';
  assert.equal(div.children.length, 2);
  assert.equal(div.children[0].tagName, "span");
  assert.equal(div.children[0].getAttribute("class"), "pill");
  assert.equal(div.textContent, "4 wordsx");
});

test("an injected element in interpolated data really becomes an element", () => {
  const div = new Element("div");
  div.innerHTML = `<span class="pill">${'<img src=x onerror=alert(1)>'} words in</span>`;
  assert.equal(div.querySelectorAll("img").length, 1,
    "if this is 0 the escaping tests would pass against injectable markup");
  assert.equal(div.querySelector("img").getAttribute("onerror"), "alert(1)");
});

test("escaped data does not become an element", () => {
  const div = new Element("div");
  div.innerHTML = '<span class="pill">&lt;img src=x&gt; words in</span>';
  assert.equal(div.querySelectorAll("img").length, 0);
  assert.equal(div.textContent, "<img src=x> words in");
});

test("attributes survive quoting, entities and unquoted values", () => {
  const [el] = parseFragment('<input type=file accept="application/json,.json" data-x="a&amp;b">');
  assert.equal(el.getAttribute("type"), "file");
  assert.equal(el.getAttribute("accept"), "application/json,.json");
  assert.equal(el.getAttribute("data-x"), "a&b");
});

test("a > inside a quoted attribute value does not end the tag", () => {
  const [el] = parseFragment('<div title="a > b"><span>in</span></div>');
  assert.equal(el.getAttribute("title"), "a > b");
  assert.equal(el.querySelectorAll("span").length, 1);
});

test("void elements do not swallow their siblings", () => {
  const div = new Element("div");
  div.innerHTML = "a<br>b<br>c";
  assert.equal(div.querySelectorAll("br").length, 2);
  assert.equal(div.childNodes.length, 5);
});

test("dataset reads and writes data- attributes", () => {
  const el = new Element("div");
  el.dataset.id = "1758239000000";
  assert.equal(el.getAttribute("data-id"), "1758239000000");
  el.setAttribute("data-stale", "1");
  assert.equal(el.dataset.stale, "1");
  assert.equal(el.dataset.missing, undefined);
});

test("classList add, remove, toggle and contains", () => {
  const el = new Element("div");
  el.className = "a b";
  assert.ok(el.classList.contains("b"));
  assert.equal(el.classList.toggle("c"), true);
  assert.equal(el.className, "a b c");
  el.classList.remove("a", "c");
  assert.equal(el.className, "b");
});

test("selectors: tag, class, id, attribute, *=, :scope > and descendant", () => {
  const doc = new HtmlDocument(`<html><body>
    <div class="rounded-xl card"><h3>Humanized Result</h3>
      <div class="whitespace-pre-wrap"><span role="button">one</span></div></div>
    <div id="other"><p><span role="button">loose</span></p></div>
  </body></html>`);

  assert.equal(doc.querySelectorAll("h3").length, 1);
  assert.equal(doc.querySelector(".whitespace-pre-wrap").textContent, "one");
  assert.equal(doc.getElementById("other").tagName, "div");

  const h3 = doc.querySelector("h3");
  assert.equal(h3.closest(".rounded-xl").className, "rounded-xl card");
  assert.equal(h3.closest('[class*="rounded"]').className, "rounded-xl card");

  const prose = doc.querySelector(".whitespace-pre-wrap");
  assert.ok(prose.querySelector(':scope > span[role="button"]'));
  const loose = doc.getElementById("other");
  assert.equal(loose.querySelector(':scope > span[role="button"]'), null,
    ":scope > must not match a grandchild");
  assert.ok(loose.querySelector('span[role="button"]'));
});

test("an attribute selector matches a value containing spaces and dots", () => {
  const doc = new HtmlDocument(
    '<html><body><textarea placeholder="Paste your AI-generated text here..."></textarea></body></html>');
  assert.ok(doc.querySelector('textarea[placeholder="Paste your AI-generated text here..."]'));
});

test("an unsupported selector throws instead of quietly matching nothing", () => {
  const doc = new HtmlDocument();
  assert.throws(() => doc.querySelector("div:nth-child(2)"), /not supported/);
});

test("CSS.escape of a leading digit round-trips through a quoted selector", () => {
  const id = "1758239000000-a9f2";
  const escaped = cssEscape(id);
  assert.notEqual(escaped, id, "a leading digit must be escaped or this test proves nothing");
  assert.equal(cssUnescape(escaped), id);

  const doc = new HtmlDocument("<html><body></body></html>");
  const card = doc.createElement("div");
  card.className = "session-card";
  card.dataset.id = id;
  doc.body.appendChild(card);
  assert.equal(doc.querySelector(`.session-card[data-id="${escaped}"]`), card);
});

test("events bubble and carry the original target", () => {
  const doc = new HtmlDocument("<html><body><div id='list'><button class='btn-restore'>go</button></div></body></html>");
  const list = doc.getElementById("list");
  const button = list.querySelector("button");
  const seen = [];
  list.addEventListener("click", e => seen.push(e.target.closest(".btn-restore") ? "restore" : "other"));
  button.dispatchEvent(new DomEvent("click", { bubbles: true }));
  assert.deepEqual(seen, ["restore"]);
});

test("a non-bubbling event stays on its target", () => {
  const doc = new HtmlDocument("<html><body><div id='a'><input id='b'></div></body></html>");
  let outer = 0;
  doc.getElementById("a").addEventListener("blur", () => { outer++; });
  doc.getElementById("b").dispatchEvent(new DomEvent("blur", {}));
  assert.equal(outer, 0);
});

test("textarea value goes through a prototype accessor, as React's trick requires", () => {
  const doc = new HtmlDocument("<html><body></body></html>");
  const ta = doc.createElement("textarea");
  assert.ok(ta instanceof HTMLTextAreaElement);
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  assert.equal(typeof setter, "function");
  setter.call(ta, "written by the native setter");
  assert.equal(ta.value, "written by the native setter");
});

test("a parsed textarea is also an HTMLTextAreaElement", () => {
  const doc = new HtmlDocument('<html><body><textarea placeholder="p"></textarea></body></html>');
  assert.ok(doc.querySelector("textarea") instanceof HTMLTextAreaElement);
});

test("DOMParser produces a document with a body and does not execute anything", () => {
  const doc = new DOMParser().parseFromString("<p>one<br>two</p><script>throw new Error('ran')</script>", "text/html");
  assert.equal(doc.body.querySelectorAll("br").length, 1);
  assert.equal(doc.body.querySelectorAll("script").length, 1);
  assert.equal(doc.body.querySelector("script").textContent, "throw new Error('ran')");
});

test("replaceWith accepts a string and produces a text node", () => {
  const div = new Element("div");
  div.innerHTML = "a<br>b";
  div.querySelector("br").replaceWith("\n");
  assert.equal(div.textContent, "a\nb");
});

test("insertAdjacentElement afterend puts the node next to its sibling", () => {
  const doc = new HtmlDocument("<html><body><header>h</header><main>m</main></body></html>");
  const bar = doc.createElement("div");
  bar.id = "sw-save-bar";
  doc.querySelector("header").insertAdjacentElement("afterend", bar);
  assert.deepEqual(doc.body.children.map(c => c.tagName), ["header", "div", "main"]);
});

test("outerHTML round-trips through the parser", () => {
  const div = new Element("div");
  div.innerHTML = '<span class="pill">a &amp; b</span><br>';
  const again = new Element("div");
  again.innerHTML = div.innerHTML;
  assert.equal(again.innerHTML, div.innerHTML);
  assert.equal(again.textContent, "a & b");
});
