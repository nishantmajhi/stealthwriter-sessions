/*
 * A DOM small enough to read and faithful enough to be worth believing.
 *
 * Neither half of this extension has a seam. `content.js` and `popup.js` are
 * classic scripts that run their whole setup at load time against `document`,
 * `chrome` and a timer, so there is nothing to require and nothing to call.
 * The only way to test the real files is to give them a document and let them
 * load, which is what this and `harness.js` are for.
 *
 * Three things here exist because a bug depends on them, and a shim that
 * faked them would have hidden the bug behind a passing test:
 *
 *   - innerHTML really parses. A regex that strips tags would make the
 *     escaping tests pass against markup that injects an element, which is
 *     precisely the defect they exist to catch.
 *   - Attribute selectors really work, including `[class*="rounded"]` and
 *     `:scope >`, because `getOutputDiv()` is three fallback selectors deep
 *     and which one matches decides what gets saved.
 *   - CSS escapes in a quoted attribute value are decoded. Session ids start
 *     with a digit, so `CSS.escape('1758…')` is `\31 758…`, and a selector
 *     engine that compared that literally would fail every rename and delete
 *     test for a reason that does not exist in a browser.
 *
 * What it does not do: layout, CSS cascade, focus, or anything visual. Style
 * is a plain object, `focus()` and `select()` are no-ops. Nothing under test
 * reads any of it back.
 */

"use strict";

/* Elements that never have children, so the parser must not push them. */
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);

/* Block-level tags, for the text-extraction tests. Not used by the parser. */
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "div", "dl", "dd", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
  "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre",
  "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  middot: "·", mdash: "—", ndash: "–", hellip: "…",
};

function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

function escapeText(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text) {
  return String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/* ── CSS.escape and its inverse ────────────────────────────────────────── */

/* Enough of https://drafts.csswg.org/cssom/#serialize-an-identifier for the
 * strings this extension escapes: session ids and nothing else. */
function cssEscape(value) {
  const str = String(value);
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const code = str.charCodeAt(i);
    if (code === 0) { out += "�"; continue; }
    const isDigit = code >= 0x30 && code <= 0x39;
    if ((i === 0 && isDigit) ||
        (i === 1 && isDigit && str[0] === "-") ||
        (code >= 0x01 && code <= 0x1f) || code === 0x7f) {
      out += "\\" + code.toString(16) + " ";
      continue;
    }
    if (code >= 0x80 || ch === "-" || ch === "_" ||
        isDigit || /[a-zA-Z]/.test(ch)) {
      out += ch;
      continue;
    }
    out += "\\" + ch;
  }
  return out;
}

/* The selector parser's half of the same deal: `\31 758` is the character
 * "1" followed by "758", not a backslash. */
function cssUnescape(value) {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== "\\") { out += value[i]; continue; }
    const hex = /^[0-9a-fA-F]{1,6}/.exec(value.slice(i + 1));
    if (hex) {
      out += String.fromCodePoint(parseInt(hex[0], 16));
      i += hex[0].length;
      /* One optional whitespace character terminates a hex escape. */
      if (value[i + 1] === " ") i += 1;
      continue;
    }
    out += value[i + 1] === undefined ? "\\" : value[i + 1];
    i += 1;
  }
  return out;
}

/* ── Selector engine ───────────────────────────────────────────────────── */

/*
 * Supports what the extension actually writes: tag, #id, .class, [attr],
 * [attr="v"], [attr*="v"], :scope, and the descendant and child combinators.
 * A selector list separated by commas is supported too. Anything else throws
 * rather than silently matching nothing, so a future selector that this
 * cannot express fails loudly.
 */
function parseCompound(text) {
  const part = { tag: null, id: null, classes: [], attrs: [], scope: false };
  const re = /(^|)(?:([a-zA-Z][a-zA-Z0-9-]*)|#([\w-]+)|\.([\w-]+)|:scope|\[([\w-]+)(?:([*^$|~]?=)"([^"]*)")?\])/g;
  let consumed = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index !== consumed) break;
    consumed = re.lastIndex;
    if (m[2]) part.tag = m[2].toLowerCase();
    else if (m[3]) part.id = m[3];
    else if (m[4]) part.classes.push(m[4]);
    else if (m[5]) part.attrs.push({ name: m[5].toLowerCase(), op: m[6] || null, value: m[7] === undefined ? null : cssUnescape(m[7]) });
    else part.scope = true;
  }
  if (consumed !== text.length) {
    throw new Error("selector fragment not supported by this harness: " + JSON.stringify(text));
  }
  return part;
}

/*
 * Splits on whitespace and commas that are outside brackets and quotes. A
 * plain `.split(/\s+/)` tears `[placeholder="Paste your text"]` in half, and
 * a CSS hex escape ends in a space, so both of those have to survive here.
 */
function splitOutsideBrackets(selector, separators) {
  const out = [];
  let current = "";
  let depth = 0;
  let quote = null;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (quote) {
      current += ch;
      if (ch === "\\") { current += selector[++i] === undefined ? "" : selector[i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (depth === 0 && separators.includes(ch)) {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function parseSelector(selector) {
  return splitOutsideBrackets(String(selector), ",").map(alternative => {
    const steps = [];
    const tokens = splitOutsideBrackets(alternative, " \t\n\r\f");
    let combinator = null;
    for (const token of tokens) {
      if (token === ">") { combinator = ">"; continue; }
      if (token === "") continue;
      steps.push({ combinator: combinator || (steps.length ? " " : null), part: parseCompound(token) });
      combinator = null;
    }
    if (steps.length === 0) throw new Error("empty selector");
    return steps;
  });
}

function matchesCompound(element, part, scopeNode) {
  if (element.nodeType !== 1) return false;
  if (part.scope && element !== scopeNode) return false;
  if (part.tag && element.tagName !== part.tag) return false;
  if (part.id && element.getAttribute("id") !== part.id) return false;
  for (const cls of part.classes) if (!element.classList.contains(cls)) return false;
  for (const attr of part.attrs) {
    const actual = element.getAttribute(attr.name);
    if (actual === null) return false;
    if (attr.op === null) continue;
    if (attr.op === "=" && actual !== attr.value) return false;
    if (attr.op === "*=" && !actual.includes(attr.value)) return false;
    if (attr.op === "^=" && !actual.startsWith(attr.value)) return false;
    if (attr.op === "$=" && !actual.endsWith(attr.value)) return false;
  }
  return true;
}

/* Walks a parsed selector right to left from `element`. */
function matchesSteps(element, steps, scopeNode) {
  const last = steps[steps.length - 1];
  if (!matchesCompound(element, last.part, scopeNode)) return false;
  let node = element;
  for (let i = steps.length - 2; i >= 0; i--) {
    const step = steps[i + 1];
    const want = steps[i].part;
    if (step.combinator === ">") {
      node = node.parentElement;
      if (!node || !matchesCompound(node, want, scopeNode)) return false;
    } else {
      node = node.parentElement;
      while (node && !matchesCompound(node, want, scopeNode)) node = node.parentElement;
      if (!node) return false;
    }
  }
  return true;
}

/* ── Nodes ─────────────────────────────────────────────────────────────── */

let mutationSink = null;

function recordMutation(target) {
  if (mutationSink) mutationSink(target);
}

class DomNode {
  constructor() {
    this.parentNode = null;
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  replaceWith(...replacements) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.childNodes.indexOf(this);
    const nodes = replacements.map(r => (typeof r === "string" ? new TextNode(r) : r));
    for (const node of nodes) {
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = parent;
    }
    parent.childNodes.splice(index, 1, ...nodes);
    this.parentNode = null;
    recordMutation(parent);
  }
}

class TextNode extends DomNode {
  constructor(data) {
    super();
    this.nodeType = 3;
    this.data = String(data);
  }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); recordMutation(this.parentNode); }
  get outerHTML() { return escapeText(this.data); }
}

class ClassList {
  constructor(element) { this.el = element; }
  _list() {
    const value = this.el.getAttribute("class") || "";
    return value.split(/\s+/).filter(Boolean);
  }
  _write(list) { this.el.setAttribute("class", list.join(" ")); }
  contains(name) { return this._list().includes(name); }
  add(...names) {
    const list = this._list();
    for (const name of names) if (!list.includes(name)) list.push(name);
    this._write(list);
  }
  remove(...names) {
    this._write(this._list().filter(n => !names.includes(n)));
  }
  toggle(name) {
    if (this.contains(name)) { this.remove(name); return false; }
    this.add(name);
    return true;
  }
  get length() { return this._list().length; }
}

function datasetProxy(element) {
  const toAttr = key => "data-" + String(key).replace(/[A-Z]/g, c => "-" + c.toLowerCase());
  return new Proxy({}, {
    get(_t, key) {
      if (typeof key !== "string") return undefined;
      const value = element.getAttribute(toAttr(key));
      return value === null ? undefined : value;
    },
    set(_t, key, value) { element.setAttribute(toAttr(key), String(value)); return true; },
    has(_t, key) { return element.getAttribute(toAttr(key)) !== null; },
    deleteProperty(_t, key) { element.removeAttribute(toAttr(key)); return true; },
    ownKeys() {
      return Object.keys(element.attributes)
        .filter(a => a.startsWith("data-"))
        .map(a => a.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase()));
    },
    getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
  });
}

class Element extends DomNode {
  constructor(tagName) {
    super();
    this.nodeType = 1;
    this.tagName = String(tagName).toLowerCase();
    this.childNodes = [];
    this.attributes = Object.create(null);
    this.style = {};
    this.listeners = Object.create(null);
    this.classList = new ClassList(this);
    this.dataset = datasetProxy(this);
    this._value = undefined;
  }

  /* ── Attributes ── */

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return key in this.attributes ? this.attributes[key] : null;
  }
  setAttribute(name, value) {
    this.attributes[String(name).toLowerCase()] = String(value);
  }
  removeAttribute(name) { delete this.attributes[String(name).toLowerCase()]; }
  hasAttribute(name) { return String(name).toLowerCase() in this.attributes; }

  get className() { return this.getAttribute("class") || ""; }
  set className(value) { this.setAttribute("class", value); }
  get id() { return this.getAttribute("id") || ""; }
  set id(value) { this.setAttribute("id", value); }

  /* `maxLength`, `placeholder`, `type`, `accept`, `href`, `download` are all
   * reflected so that markup written by the code under test can be read back
   * the way a browser would. */
  get type() { return this.getAttribute("type") || ""; }
  set type(v) { this.setAttribute("type", v); }
  get placeholder() { return this.getAttribute("placeholder") || ""; }
  set placeholder(v) { this.setAttribute("placeholder", v); }
  get maxLength() { return Number(this.getAttribute("maxlength") || -1); }
  set maxLength(v) { this.setAttribute("maxlength", v); }
  get href() { return this.getAttribute("href") || ""; }
  set href(v) { this.setAttribute("href", v); }
  get download() { return this.getAttribute("download") || ""; }
  set download(v) { this.setAttribute("download", v); }

  get value() { return this._value === undefined ? (this.getAttribute("value") || "") : this._value; }
  set value(v) { this._value = String(v); }

  /* ── Tree ── */

  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }

  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    recordMutation(this);
    return node;
  }

  append(...nodes) {
    for (const node of nodes) {
      this.appendChild(typeof node === "string" ? new TextNode(node) : node);
    }
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index < 0) throw new Error("removeChild: not a child");
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    recordMutation(this);
    return node;
  }

  insertAdjacentElement(position, element) {
    const parent = this.parentNode;
    if (position === "afterend" || position === "beforebegin") {
      if (!parent) throw new Error("insertAdjacentElement: no parent");
      if (element.parentNode) element.parentNode.removeChild(element);
      const index = parent.childNodes.indexOf(this);
      parent.childNodes.splice(position === "afterend" ? index + 1 : index, 0, element);
      element.parentNode = parent;
      recordMutation(parent);
      return element;
    }
    if (position === "beforeend") return this.appendChild(element);
    if (position === "afterbegin") {
      if (element.parentNode) element.parentNode.removeChild(element);
      this.childNodes.unshift(element);
      element.parentNode = this;
      recordMutation(this);
      return element;
    }
    throw new Error("insertAdjacentElement: unsupported position " + position);
  }

  /* ── Content ── */

  get textContent() {
    return this.childNodes.map(n => n.textContent).join("");
  }
  set textContent(text) {
    this.childNodes.forEach(n => { n.parentNode = null; });
    this.childNodes = [];
    if (text !== "" && text !== null && text !== undefined) {
      this.appendChild(new TextNode(text));
    }
    recordMutation(this);
  }

  set innerHTML(html) {
    this.childNodes.forEach(n => { n.parentNode = null; });
    this.childNodes = [];
    for (const node of parseFragment(String(html))) this.appendChild(node);
    recordMutation(this);
  }
  get innerHTML() {
    return this.childNodes.map(n => n.outerHTML).join("");
  }
  get outerHTML() {
    const attrs = Object.keys(this.attributes)
      .map(name => ` ${name}="${escapeAttr(this.attributes[name])}"`)
      .join("");
    if (VOID.has(this.tagName)) return `<${this.tagName}${attrs}>`;
    return `<${this.tagName}${attrs}>${this.innerHTML}</${this.tagName}>`;
  }

  /* ── Queries ── */

  matches(selector) {
    return parseSelector(selector).some(steps => matchesSteps(this, steps, this));
  }

  closest(selector) {
    const alternatives = parseSelector(selector);
    let node = this;
    while (node) {
      if (alternatives.some(steps => matchesSteps(node, steps, node))) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    const alternatives = parseSelector(selector);
    const found = [];
    const walk = element => {
      for (const child of element.children) {
        if (alternatives.some(steps => matchesSteps(child, steps, this))) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  /* ── Events ── */

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners[type];
    if (list) this.listeners[type] = list.filter(f => f !== fn);
  }

  dispatchEvent(event) {
    if (!event.target) event.target = this;
    let node = this;
    while (node) {
      for (const fn of (node.listeners[event.type] || []).slice()) {
        event.currentTarget = node;
        fn.call(node, event);
      }
      if (!event.bubbles) break;
      node = node.parentElement || (node === node.ownerRoot ? null : node.parentNode);
    }
    return !event.defaultPrevented;
  }

  /* No-ops: nothing under test reads focus or selection back. */
  focus() {}
  select() {}
  click() { this.dispatchEvent(new DomEvent("click", { bubbles: true })); }
}

class HTMLTextAreaElement extends Element {
  constructor() { super("textarea"); }
}
/* React's descriptor trick in content.js reads the setter off this prototype,
 * so it has to genuinely be an accessor on the prototype rather than a field
 * on the instance -- which is the whole point of that code. */
Object.defineProperty(HTMLTextAreaElement.prototype, "value", {
  configurable: true,
  get() { return this._value === undefined ? "" : this._value; },
  set(v) { this._value = String(v); },
});

class DomEvent {
  constructor(type, init) {
    const options = init || {};
    this.type = type;
    this.bubbles = !!options.bubbles;
    this.target = null;
    this.currentTarget = null;
    this.defaultPrevented = false;
    this.key = options.key;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.bubbles = false; }
}

/* ── Parser ────────────────────────────────────────────────────────────── */

/*
 * A tokenizer, not a spec-compliant tree builder: it does not do implied end
 * tags or foster parenting. It handles what this project's markup contains --
 * nested elements, quoted and unquoted attributes, self-closing SVG shapes,
 * comments, doctypes, and <style>/<script> whose text is not markup.
 */
function parseFragment(html) {
  const roots = [];
  const stack = [];
  const push = node => {
    if (stack.length) stack[stack.length - 1].appendChild(node);
    else { roots.push(node); node.parentNode = null; }
  };
  const addText = raw => {
    if (!raw) return;
    push(new TextNode(decodeEntities(raw)));
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { addText(html.slice(i)); break; }
    addText(html.slice(i, lt));

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt)) {
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith("</", lt)) {
      const end = html.indexOf(">", lt);
      const name = html.slice(lt + 2, end < 0 ? html.length : end).trim().toLowerCase();
      for (let depth = stack.length - 1; depth >= 0; depth--) {
        if (stack[depth].tagName === name) { stack.length = depth; break; }
      }
      i = end < 0 ? html.length : end + 1;
      continue;
    }

    const tagMatch = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt));
    if (!tagMatch) { addText("<"); i = lt + 1; continue; }

    /* Find the end of the open tag, skipping > inside quoted values. */
    let cursor = lt + tagMatch[0].length;
    let quote = null;
    while (cursor < html.length) {
      const ch = html[cursor];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
      cursor++;
    }
    const inside = html.slice(lt + tagMatch[0].length, cursor);
    const selfClosing = /\/\s*$/.test(inside);
    const element = tagMatch[1].toLowerCase() === "textarea"
      ? new HTMLTextAreaElement()
      : new Element(tagMatch[1]);

    const attrRe = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let attr;
    while ((attr = attrRe.exec(inside)) !== null) {
      if (attr[1] === "/") continue;
      const raw = attr[2] !== undefined ? attr[2]
                : attr[3] !== undefined ? attr[3]
                : attr[4] !== undefined ? attr[4] : "";
      element.setAttribute(attr[1], decodeEntities(raw));
    }

    push(element);
    i = cursor + 1;

    if (VOID.has(element.tagName) || selfClosing) continue;

    /* <style> and <script> contain text, not markup. */
    if (element.tagName === "style" || element.tagName === "script") {
      const close = html.toLowerCase().indexOf("</" + element.tagName, i);
      const end = close < 0 ? html.length : close;
      if (end > i) element.appendChild(new TextNode(html.slice(i, end)));
      const gt = close < 0 ? html.length : html.indexOf(">", close);
      i = gt < 0 ? html.length : gt + 1;
      continue;
    }

    stack.push(element);
  }

  return roots;
}

/* ── Document ──────────────────────────────────────────────────────────── */

class HtmlDocument {
  constructor(html) {
    this.nodeType = 9;
    this.listeners = Object.create(null);
    this.documentElement = new Element("html");
    const nodes = parseFragment(html === undefined ? "<html><head></head><body></body></html>" : html);
    const flat = [];
    const collect = list => {
      for (const node of list) {
        if (node.nodeType === 1 && (node.tagName === "html")) collect(node.childNodes.slice());
        else flat.push(node);
      }
    };
    collect(nodes);
    for (const node of flat) this.documentElement.appendChild(node);
    this.head = this.documentElement.querySelector("head") ||
      this.documentElement.appendChild(new Element("head"));
    this.body = this.documentElement.querySelector("body");
    if (!this.body) {
      const body = new Element("body");
      /* A fragment with no <body> is treated the way a parser does: everything
       * that is not head content becomes the body. */
      for (const node of this.documentElement.childNodes.slice()) {
        if (node !== this.head) body.appendChild(node);
      }
      this.documentElement.appendChild(body);
      this.body = body;
    }
  }

  createElement(tag) {
    return String(tag).toLowerCase() === "textarea" ? new HTMLTextAreaElement() : new Element(tag);
  }
  createTextNode(text) { return new TextNode(text); }

  getElementById(id) {
    const walk = element => {
      for (const child of element.children) {
        if (child.getAttribute("id") === id) return child;
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this.documentElement);
  }

  querySelector(selector) { return this.documentElement.querySelector(selector); }
  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }

  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatch(type) { (this.listeners[type] || []).forEach(fn => fn({ type })); }

  execCommand() { return true; }
}

class DOMParser {
  parseFromString(markup, mime) {
    if (mime !== "text/html") throw new Error("this harness parses text/html only");
    return new HtmlDocument("<html><head></head><body>" + markup + "</body></html>");
  }
}

/* ── MutationObserver ──────────────────────────────────────────────────── */

/*
 * Real observers deliver in a microtask, and content.js closes the restored
 * panel from inside one, so delivery has to be asynchronous here too -- a
 * synchronous shim would let a test see a panel close that a browser would
 * still be showing.
 */
function createMutationObserver(schedule) {
  const observers = new Set();
  let pending = false;

  mutationSink = target => {
    if (observers.size === 0) return;
    let touched = false;
    for (const observer of observers) {
      if (observer._covers(target)) { observer._dirty = true; touched = true; }
    }
    if (!touched || pending) return;
    pending = true;
    schedule(() => {
      pending = false;
      for (const observer of [...observers]) {
        if (!observer._dirty) continue;
        observer._dirty = false;
        observer.callback([{ type: "childList" }], observer);
      }
    });
  };

  return class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      this._dirty = false;
    }
    observe(target, options) {
      this.targets.push({ target, subtree: !!(options && options.subtree) });
      observers.add(this);
    }
    disconnect() {
      this.targets = [];
      this._dirty = false;
      observers.delete(this);
    }
    _covers(node) {
      for (const entry of this.targets) {
        if (entry.target === node) return true;
        if (!entry.subtree) continue;
        let walk = node;
        while (walk) {
          if (walk === entry.target) return true;
          walk = walk.parentNode;
        }
      }
      return false;
    }
  };
}

module.exports = {
  BLOCK,
  ClassList,
  DOMParser,
  DomEvent,
  Element,
  HtmlDocument,
  HTMLTextAreaElement,
  TextNode,
  createMutationObserver,
  cssEscape,
  cssUnescape,
  decodeEntities,
  escapeAttr,
  escapeText,
  parseFragment,
  parseSelector,
};
