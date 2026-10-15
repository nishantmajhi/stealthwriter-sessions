/*
 * Enough of a browser extension platform to load the real scripts.
 *
 * A world holds one `chrome.storage.local`, one tab table and one virtual
 * clock, and every context opened in it -- the background worker, a content
 * script in a tab, a popup -- gets its own `chrome` namespace wired back to
 * the same shared state. That is what makes two of this project's bugs
 * visible at all: one is a message that is never answered, and one is two
 * popups holding the same array.
 *
 * THE MESSAGE PORT IS MODELLED EXACTLY, AND ON PURPOSE.
 *
 * `chrome.tabs.sendMessage(id, msg, callback)` sets `runtime.lastError` when
 * no listener answers -- either "Receiving end does not exist" if the tab has
 * no content script, or "The message port closed before a response was
 * received" if a listener ran and returned without calling `sendResponse` and
 * without returning true. A shim that simply called the callback with no
 * error would make `deliverRestore()` look correct, when in the browser it
 * takes its failure branch on every single restore. See restore.test.js.
 *
 * Time is virtual. `world.clock.advance(ms)` runs the timers that fall in
 * that window and moves `Date.now()` with them, so a 30-second restore
 * deadline and a 15-minute observer timeout cost nothing to test and the
 * millisecond-based session ids are reproducible.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");

const dom = require("./dom.js");

const ROOT = path.join(__dirname, "..");
const BASELINE_SUBJECT = "Initial commit";

/* ── Reading the code under test ───────────────────────────────────────── */

function workingSource(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

let _baseline = null;

/*
 * The original code, read out of git by the commit's subject rather than by
 * its hash, so a rebase makes the tests fail loudly instead of quietly
 * asserting nothing. Every "this is what the original did" claim in this
 * suite is made against the real original file, not a transcription.
 */
function baselineCommit() {
  if (_baseline) return _baseline;
  const log = execFileSync("git", ["log", "--format=%H%x1f%s"], { cwd: ROOT, encoding: "utf8" });
  for (const line of log.split("\n")) {
    const [hash, subject] = line.split("\x1f");
    if (subject && subject.trim() === BASELINE_SUBJECT) { _baseline = hash; return hash; }
  }
  throw new Error(`no commit with subject ${JSON.stringify(BASELINE_SUBJECT)}; the baseline has moved`);
}

function originalSource(file) {
  return execFileSync("git", ["show", `${baselineCommit()}:${file}`], { cwd: ROOT, encoding: "utf8" });
}

function source(file, original) {
  return original ? originalSource(file) : workingSource(file);
}

/* ── Virtual clock ─────────────────────────────────────────────────────── */

function createClock(startMs) {
  let now = startMs;
  let nextId = 1;
  const timers = new Map();

  const api = {
    get now() { return now; },
    setTimeout(fn, delay, ...args) {
      const id = nextId++;
      timers.set(id, { at: now + (Number(delay) || 0), fn, args, every: null });
      return id;
    },
    setInterval(fn, delay, ...args) {
      const id = nextId++;
      const period = Math.max(1, Number(delay) || 0);
      timers.set(id, { at: now + period, fn, args, every: period });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    clearInterval(id) { timers.delete(id); },

    /* Fires everything due in the window, in time order, including timers
     * scheduled by the timers it fires. */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let soonest = null;
        for (const [id, timer] of timers) {
          if (timer.at > target) continue;
          if (!soonest || timer.at < soonest.timer.at || (timer.at === soonest.timer.at && id < soonest.id)) {
            soonest = { id, timer };
          }
        }
        if (!soonest) break;
        now = soonest.timer.at;
        if (soonest.timer.every) soonest.timer.at = now + soonest.timer.every;
        else timers.delete(soonest.id);
        soonest.timer.fn(...soonest.timer.args);
      }
      now = target;
    },

    pending() { return timers.size; },
    intervals() { return [...timers.values()].filter(t => t.every).map(t => t.every); },
    /* How many times a repeating timer would fire over a period. */
    wakeupsPer(ms) {
      return [...timers.values()].filter(t => t.every).reduce((sum, t) => sum + ms / t.every, 0);
    },
  };
  return api;
}

/* ── The extension world ───────────────────────────────────────────────── */

function createWorld(options) {
  const opts = options || {};
  const clock = createClock(opts.startMs === undefined ? 1758240000000 : opts.startMs);
  const storage = { ...(opts.storage || {}) };
  const contexts = [];
  const tabs = [];
  const windows = [];
  const log = [];
  let nextTabId = 100;
  let nextWindowId = 1;
  const microtasks = [];

  const queue = fn => { microtasks.push(fn); };

  /*
   * Drains queued callbacks. Storage and messaging are asynchronous in a
   * browser and are asynchronous here, so a test has to let them run.
   *
   * An exception thrown by one of them is recorded rather than rethrown,
   * because that is what a browser does: the storage write has already
   * happened, the rest of the page carries on, and the only trace is a line
   * in the console. Rethrowing here would make the original's import crash
   * look like a harness failure instead of the defect it is.
   */
  const errors = [];
  async function flush(rounds) {
    const drain = () => {
      while (microtasks.length) {
        const fn = microtasks.shift();
        try { fn(); } catch (e) { errors.push(e); }
      }
    };
    for (let i = 0; i < (rounds || 8); i++) {
      drain();
      await Promise.resolve();
    }
    drain();
  }

  function note(entry) { log.push(entry); }

  function storageAreaFor(ctx) {
    function fireChanged(changes) {
      for (const ctx2 of contexts) {
        if (!ctx2.alive) continue;
        for (const fn of ctx2.storageListeners.slice()) {
          queue(() => fn(changes, "local"));
        }
      }
    }

    return {
      get(keys, cb) {
        ctx.assertAlive();
        const wanted = Array.isArray(keys) ? keys : keys === null || keys === undefined ? Object.keys(storage) : [keys];
        const out = {};
        for (const key of wanted) if (key in storage) out[key] = clone(storage[key]);
        queue(() => ctx.withCallback(null, () => cb(out)));
      },
      set(items, cb) {
        ctx.assertAlive();
        const failure = ctx.world.storageFailure;
        queue(() => {
          if (failure) { ctx.withCallback(failure, () => cb && cb()); return; }
          const changes = {};
          for (const key of Object.keys(items)) {
            changes[key] = { oldValue: clone(storage[key]), newValue: clone(items[key]) };
            storage[key] = clone(items[key]);
          }
          ctx.withCallback(null, () => cb && cb());
          fireChanged(changes);
        });
      },
      remove(keys, cb) {
        ctx.assertAlive();
        const list = Array.isArray(keys) ? keys : [keys];
        queue(() => {
          const changes = {};
          for (const key of list) {
            if (!(key in storage)) continue;
            changes[key] = { oldValue: clone(storage[key]), newValue: undefined };
            delete storage[key];
          }
          ctx.withCallback(null, () => cb && cb());
          if (Object.keys(changes).length) fireChanged(changes);
        });
      },
      _raw: storage,
    };
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  /*
   * Delivers a message to a set of listeners with Chrome's port rules.
   * Returns nothing; the caller's callback is invoked through `finish`.
   */
  function deliver(targets, message, sender, finish) {
    if (targets.length === 0) {
      finish({ message: "Could not establish connection. Receiving end does not exist." }, undefined);
      return;
    }
    let responded = false;
    let keptOpen = false;
    for (const entry of targets) {
      const sendResponse = response => {
        if (responded) return;
        responded = true;
        /* Structured-cloned, as a real one is. It also keeps the value in the
         * caller's realm: an object handed straight across a vm boundary has
         * a different Object.prototype, and assert.deepStrictEqual rejects it
         * for that alone. */
        finish(null, clone(response));
      };
      const result = entry.fn(clone(message), sender, sendResponse);
      if (result === true) keptOpen = true;
    }
    if (responded) return;
    if (keptOpen) return; /* a real port would stay open; nothing here does */
    finish({ message: "The message port closed before a response was received." }, undefined);
  }

  const world = {
    clock,
    storage,
    tabs,
    windows,
    log,
    errors,
    contexts,
    storageFailure: null,
    flush,
    note,

    session(overrides) {
      return Object.assign({
        id: "1758239000000",
        savedAt: 1758239000000,
        name: "",
        inputText: "hello world",
        outputText: "humanized hello world",
        wordCount: 2,
        outputWords: 3,
      }, overrides || {});
    },

    seed(sessions) {
      storage.sw_sessions_v3 = clone(sessions);
      return world;
    },

    read(key) { return clone(storage[key]); },

    addTab(url, windowId) {
      const tab = { id: nextTabId++, url, windowId: windowId === undefined ? 1 : windowId, active: false };
      tabs.push(tab);
      return tab;
    },
  };

  /* ── One loaded script ── */

  function createContext(kind, extra) {
    const ctx = {
      kind,
      world,
      alive: true,
      messageListeners: [],
      storageListeners: [],
      chrome: null,
      sandbox: null,
      withCallback(error, fn) {
        if (error) ctx.chrome.runtime.lastError = typeof error === "string" ? { message: error } : error;
        try { fn(); }
        finally { delete ctx.chrome.runtime.lastError; }
      },
      assertAlive() {
        if (!ctx.alive) throw new Error("Extension context invalidated.");
      },
      kill() {
        ctx.alive = false;
        ctx.chrome.runtime.id = undefined;
      },
    };
    Object.assign(ctx, extra || {});

    const chromeNs = {
      runtime: {
        id: "stealthwriter-sessions@local",
        getURL: p => "chrome-extension://sws/" + p,
        onMessage: {
          addListener(fn) { ctx.messageListeners.push({ fn, ctx }); },
        },
        sendMessage(message, cb) {
          ctx.assertAlive();
          /* Goes to extension pages and the worker, never back to the sender
           * and never to another tab's content script. */
          const targets = contexts
            .filter(c => c.alive && c !== ctx && c.kind !== "content")
            .map(c => c.messageListeners).flat();
          queue(() => deliver(targets, message, { id: chromeNs.runtime.id, tab: ctx.tab },
            (error, response) => { if (cb) ctx.withCallback(error, () => cb(response)); }));
        },
      },
      storage: {
        local: storageAreaFor(ctx),
        onChanged: {
          addListener(fn) { ctx.storageListeners.push(fn); },
        },
      },
      tabs: {
        query(info, cb) {
          ctx.assertAlive();
          let found = tabs.slice();
          if (info.url) found = found.filter(t => matchPattern(info.url, t.url));
          if (info.active) found = found.filter(t => t.active);
          if (info.currentWindow) found = found.filter(t => t.windowId === world.focusedWindowId);
          queue(() => ctx.withCallback(null, () => cb(found.map(t => ({ ...t })))));
        },
        sendMessage(tabId, message, cb) {
          ctx.assertAlive();
          const targets = contexts
            .filter(c => c.alive && c.kind === "content" && c.tab && c.tab.id === tabId)
            .map(c => c.messageListeners).flat();
          queue(() => deliver(targets, message, { id: chromeNs.runtime.id },
            (error, response) => { if (cb) ctx.withCallback(error, () => cb(response)); }));
        },
        update(tabId, props, cb) {
          ctx.assertAlive();
          const tab = tabs.find(t => t.id === tabId);
          note({ type: "tabs.update", tabId, props });
          if (tab) {
            if (props.active) { tabs.forEach(t => { if (t.windowId === tab.windowId) t.active = false; }); tab.active = true; }
            if (props.url) tab.url = props.url;
          }
          queue(() => ctx.withCallback(null, () => cb && cb(tab && { ...tab })));
        },
        create(props, cb) {
          ctx.assertAlive();
          note({ type: "tabs.create", props });
          const tab = world.addTab(props.url, world.focusedWindowId);
          queue(() => ctx.withCallback(null, () => cb && cb({ ...tab })));
        },
        reload(tabId, cb) {
          ctx.assertAlive();
          note({ type: "tabs.reload", tabId });
          queue(() => ctx.withCallback(null, () => cb && cb()));
        },
      },
      windows: {
        create(props) {
          note({ type: "windows.create", props });
          const win = { id: nextWindowId++, ...props };
          windows.push(win);
          return win;
        },
        update(windowId, props) {
          note({ type: "windows.update", windowId, props });
          if (props.focused) world.focusedWindowId = windowId;
        },
      },
      action: {
        openPopup: opts.openPopup || (() => Promise.reject(new Error("not allowed"))),
      },
    };

    ctx.chrome = chromeNs;
    contexts.push(ctx);
    return ctx;
  }

  /*
   * Chrome match patterns, with the one rule that matters here: a host of
   * `*.example.com` matches `example.com` itself as well as its subdomains.
   * Treating the pattern as a plain glob makes `*://*.stealthwriter.ai/*`
   * miss the apex domain, which is the URL the extension actually opens --
   * and every restore test would then take the "no StealthWriter tab" path
   * and prove nothing.
   */
  function matchPattern(pattern, url) {
    if (!url) return false;
    const parts = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(pattern);
    if (!parts) throw new Error("not a match pattern: " + pattern);
    const [, scheme, host, pathGlob] = parts;
    let parsed;
    try { parsed = new URL(url); } catch { return false; }

    if (scheme !== "*" && parsed.protocol !== scheme + ":") return false;
    if (scheme === "*" && !/^https?:$/.test(parsed.protocol)) return false;

    if (host !== "*") {
      if (host.startsWith("*.")) {
        const base = host.slice(2);
        if (parsed.hostname !== base && !parsed.hostname.endsWith("." + base)) return false;
      } else if (parsed.hostname !== host) return false;
    }

    const rx = new RegExp("^" + pathGlob.split("*").map(s => s.replace(/[.+^${}()|[\]\\?]/g, "\\$&")).join(".*") + "$");
    return rx.test(parsed.pathname + parsed.search);
  }

  world.focusedWindowId = 1;

  /* ── Sandbox shared by every context ── */

  function baseSandbox(ctx, document, locationUrl) {
    const location = {
      href: locationUrl,
      get pathname() { return new URL(this.href).pathname; },
      reload() { note({ type: "location.reload", tab: ctx.tab && ctx.tab.id }); },
      assign(href) { this.href = href; },
    };

    const MutationObserver = dom.createMutationObserver(queue);

    const sandbox = {
      console: opts.quiet === false ? console : {
        log: (...a) => note({ type: "console.log", args: a }),
        warn: (...a) => note({ type: "console.warn", args: a }),
        error: (...a) => note({ type: "console.error", args: a }),
      },
      document,
      location,
      chrome: ctx.chrome,
      browser: ctx.chrome,
      MutationObserver,
      DOMParser: dom.DOMParser,
      Event: dom.DomEvent,
      CSS: { escape: dom.cssEscape },
      URL,
      Promise,
      JSON,
      Math,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Set,
      Map,
      Error,
      TypeError,
      RegExp,
      Symbol,
      isNaN,
      parseInt,
      parseFloat,
      queueMicrotask: queue,
      setTimeout: (...a) => clock.setTimeout(...a),
      clearTimeout: id => clock.clearTimeout(id),
      setInterval: (...a) => clock.setInterval(...a),
      clearInterval: id => clock.clearInterval(id),
      navigator: {
        clipboard: {
          writeText(text) { note({ type: "clipboard.write", text }); return Promise.resolve(); },
        },
      },
      Date: fakeDate(clock),
      Blob: class Blob {
        constructor(parts, options) { this.parts = parts; this.type = (options || {}).type; }
        text() { return Promise.resolve(this.parts.join("")); }
      },
      FileReader: makeFileReader(queue),
      HTMLTextAreaElement: dom.HTMLTextAreaElement,
    };
    /* `window` is the sandbox, so window.addEventListener has to live on it.
     * `ctx.fireWindow('popstate')` is how a test performs the SPA navigation
     * that has no navigation event of its own. */
    const windowListeners = Object.create(null);
    sandbox.addEventListener = (type, fn) => {
      (windowListeners[type] = windowListeners[type] || []).push(fn);
    };
    sandbox.removeEventListener = (type, fn) => {
      if (windowListeners[type]) windowListeners[type] = windowListeners[type].filter(f => f !== fn);
    };
    ctx.fireWindow = type => {
      (windowListeners[type] || []).slice().forEach(fn => fn({ type }));
    };
    ctx.windowListeners = windowListeners;

    /* The Navigation API exists in Chrome and not in Firefox, and the content
     * script has a branch for each. `opts.navigationApi` picks which browser
     * a given test is standing in. */
    if (opts.navigationApi) {
      const navListeners = Object.create(null);
      sandbox.navigation = {
        addEventListener(type, fn) { (navListeners[type] = navListeners[type] || []).push(fn); },
      };
      ctx.fireNavigation = type => {
        (navListeners[type] || []).slice().forEach(fn => fn({ type }));
      };
      ctx.navigationListeners = navListeners;
    } else {
      ctx.fireNavigation = () => { throw new Error("this world has no Navigation API"); };
      ctx.navigationListeners = null;
    }

    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    return sandbox;
  }

  /* ── Public loaders ── */

  world.loadBackground = function loadBackground(loadOptions) {
    const ctx = createContext("background", { tab: null });
    const document = new dom.HtmlDocument();
    const sandbox = baseSandbox(ctx, document, "chrome-extension://sws/_generated_background_page.html");
    ctx.sandbox = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source("background.js", (loadOptions || {}).original), sandbox, { filename: "background.js" });
    return ctx;
  };

  world.loadContent = function loadContent(loadOptions) {
    const o = loadOptions || {};
    const url = o.url || "https://stealthwriter.ai/dashboard/humanizer";
    const tab = o.tab || world.addTab(url, o.windowId === undefined ? 1 : o.windowId);
    tab.url = url;
    const ctx = createContext("content", { tab });
    const document = new dom.HtmlDocument(o.html === undefined ? pageHtml(o) : o.html);
    const sandbox = baseSandbox(ctx, document, url);
    ctx.sandbox = sandbox;
    ctx.document = document;
    vm.createContext(sandbox);
    vm.runInContext(source("content.js", o.original), sandbox, { filename: "content.js" });
    /* Top-level `const`s live in the context's global lexical scope rather
     * than on the sandbox object, so reaching them means evaluating in the
     * same scope. */
    ctx.evaluate = expression => vm.runInContext(expression, sandbox);

    ctx.bar = () => document.getElementById("sw-save-bar");
    ctx.panel = () => document.getElementById("sw-restored-panel");
    ctx.count = () => {
      const el = document.getElementById("sw-session-count");
      return el ? el.textContent : null;
    };
    ctx.editor = () => document.querySelector('textarea[placeholder="Paste your AI-generated text here..."]');
    ctx.type = text => { ctx.editor().value = text; };
    /* Click Save Session and answer the name modal. `name` of null cancels. */
    ctx.save = async name => {
      document.getElementById("sw-save-btn").dispatchEvent(new dom.DomEvent("click", { bubbles: true }));
      await flush();
      const modal = document.getElementById("sw-name-modal");
      if (!modal) return false;
      if (name === null) {
        document.getElementById("sw-name-cancel").dispatchEvent(new dom.DomEvent("click", { bubbles: true }));
      } else {
        document.getElementById("sw-name-input").value = name || "";
        document.getElementById("sw-name-save").dispatchEvent(new dom.DomEvent("click", { bubbles: true }));
      }
      await flush();
      return true;
    };
    /* Replace the rendered output the way a fresh humanization would. */
    ctx.setOutput = html => {
      const prose = document.querySelector(".whitespace-pre-wrap");
      if (!prose) throw new Error("this page has no output card");
      prose.innerHTML = html;
    };
    /* A pushState-style route change: the URL moves, nothing is dispatched. */
    ctx.navigate = path => { sandbox.location.href = "https://stealthwriter.ai" + path; };
    return ctx;
  };

  world.loadPopup = function loadPopup(loadOptions) {
    const o = loadOptions || {};
    const ctx = createContext("popup", { tab: null });
    const document = new dom.HtmlDocument(fs.readFileSync(path.join(ROOT, "popup.html"), "utf8"));
    const sandbox = baseSandbox(ctx, document, "chrome-extension://sws/popup.html");
    sandbox.window.close = () => note({ type: "popup.close" });
    sandbox.URL = Object.assign(function (...a) { return new URL(...a); }, {
      createObjectURL: () => "blob:sws/" + Math.random().toString(16).slice(2),
      revokeObjectURL: () => note({ type: "revokeObjectURL" }),
    });
    Object.setPrototypeOf(sandbox.URL, URL);
    ctx.sandbox = sandbox;
    ctx.document = document;
    vm.createContext(sandbox);
    vm.runInContext(source("popup.js", o.original), sandbox, { filename: "popup.js" });
    ctx.evaluate = expression => vm.runInContext(expression, sandbox);

    ctx.cards = () => document.getElementById("session-list").querySelectorAll(".session-card");
    ctx.status = () => document.getElementById("status").textContent;
    ctx.titles = () => ctx.cards().map(c => c.querySelector(".card-label").textContent);
    ctx.clickIn = (card, selector) => {
      const btn = card.querySelector(selector);
      if (!btn) throw new Error("no " + selector + " in card");
      btn.dispatchEvent(new dom.DomEvent("click", { bubbles: true }));
      return btn;
    };
    ctx.click = id => {
      document.getElementById(id).dispatchEvent(new dom.DomEvent("click", { bubbles: true }));
    };
    /* The import path, from the file chooser inwards. */
    ctx.importJson = async json => {
      const input = document.getElementById("file-input");
      input.files = [typeof json === "string" ? textFile(json) : json];
      input.dispatchEvent(new dom.DomEvent("change", { bubbles: true }));
      await flush();
    };
    ctx.rename = async (card, name, key) => {
      ctx.clickIn(card, ".btn-rename");
      const input = document.querySelector(".rename-input");
      input.value = name;
      input.dispatchEvent(new dom.DomEvent("keydown", { key: key || "Enter" }));
      await flush();
      return input;
    };
    ctx.search = async term => {
      const input = document.getElementById("search");
      input.value = term;
      input.dispatchEvent(new dom.DomEvent("input", { bubbles: true }));
      await flush();
    };
    return ctx;
  };

  return world;
}

/* `new Date()` and `Date.now()` follow the virtual clock; every other form
 * behaves normally, because the code does real arithmetic with them. */
function fakeDate(clock) {
  const Real = Date;
  function Fake(...args) {
    if (!new.target) return Real(...args);
    return args.length === 0 ? new Real(clock.now) : new Real(...args);
  }
  Fake.prototype = Real.prototype;
  Fake.now = () => clock.now;
  Fake.parse = Real.parse;
  Fake.UTC = Real.UTC;
  return Fake;
}

function makeFileReader(queue) {
  return class FileReader {
    constructor() { this.result = null; this.onload = null; this.onerror = null; }
    readAsText(file) {
      queue(() => {
        if (file && file._fails) { if (this.onerror) this.onerror(); return; }
        this.result = file && file._text !== undefined ? file._text : String(file);
        if (this.onload) this.onload();
      });
    }
  };
}

/* A file for the import path: `{ _text }`, or `{ _fails: true }`. */
function textFile(text) { return { _text: text, name: "backup.json" }; }
function unreadableFile() { return { _fails: true, name: "backup.json" }; }

/*
 * A stand-in for the humanizer page: a <header> for the save bar to attach
 * to, the editor textarea, and optionally a rendered output card with the
 * same three-deep structure `getOutputDiv()` walks.
 */
function pageHtml(options) {
  const o = options || {};
  const output = o.output === undefined ? null : o.output;
  const card = output === null ? "" : `
    <div class="rounded-xl border p-4">
      <h3>Humanized Result</h3>
      <div class="whitespace-pre-wrap">${output}</div>
    </div>`;
  return `<html><head></head><body>
    <header><nav>StealthWriter</nav></header>
    <main>
      <div class="rounded-xl input-card">
        <textarea placeholder="Paste your AI-generated text here..."></textarea>
      </div>
      ${card}
    </main>
  </body></html>`;
}

/* A sentence-span output block, the shape the real site renders. */
function sentences(...parts) {
  return parts.map(p => `<span role="button">${p}</span>`).join(" ");
}

module.exports = {
  ROOT,
  BASELINE_SUBJECT,
  baselineCommit,
  createClock,
  createWorld,
  dom,
  originalSource,
  pageHtml,
  sentences,
  textFile,
  unreadableFile,
  workingSource,
};
