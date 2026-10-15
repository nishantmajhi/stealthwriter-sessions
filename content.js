/**
 * StealthWriter Sessions - content script
 *
 * Injects the Save Session bar into the humanizer page, captures the editor
 * contents, and restores saved sessions.
 *
 * Restored output is deliberately rendered in an extension-owned panel mounted
 * on document.body rather than written into the page. Read "Restored output is
 * read-only" under Limitations in README.md before changing that.
 */

const STORAGE_KEY   = 'sw_sessions_v3';
const PENDING_KEY   = 'sw_pending_restore';
const SEL_TEXTAREA  = 'textarea[placeholder="Paste your AI-generated text here..."]';

// Block-level tags, for htmlToText(). See the comment there.
const SEL_BLOCK = 'address,article,aside,blockquote,div,dd,dl,dt,fieldset,' +
  'figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,' +
  'p,pre,section,table,td,th,tr,ul';

// ── Find elements ─────────────────────────────────────────────────────────────

function getTextarea() {
  return document.querySelector(SEL_TEXTAREA);
}

// Returns the output container, or null when no humanization has been rendered.
// Null on a fresh page is expected and handled by the caller.
function getOutputDiv() {
  for (const h3 of document.querySelectorAll('h3')) {
    if (h3.textContent.trim() === 'Humanized Result') {
      const card = h3.closest('.rounded-xl') ||
                   h3.closest('[class*="rounded"]') ||
                   h3.parentElement?.parentElement;
      if (card) {
        const prose = card.querySelector('.whitespace-pre-wrap');
        if (prose) return prose;
      }
    }
  }
  for (const el of document.querySelectorAll('.whitespace-pre-wrap')) {
    if (el.querySelector('span[role="button"]')) return el;
  }
  for (const el of document.querySelectorAll('div')) {
    if (el.querySelector(':scope > span[role="button"]')) return el;
  }
  return null;
}

// True once the editor exists, which is the signal that React has mounted the
// humanizer. Polled by consumePendingRestore() before it restores into a page
// that may still be rendering.
function pageLooksFamiliar() {
  return !!getTextarea();
}

// ── Session name modal ────────────────────────────────────────────────────────
//
// Resolves with a string (possibly empty) when the user confirms, or null when
// the user cancels. An early build used `resolve(v ?? '')`, which turned the
// cancel signal into an empty string and made the `name === null` check dead
// code. Keep the two outcomes distinguishable.

function promptSessionName() {
  return new Promise(resolve => {
    document.getElementById('sw-name-modal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'sw-name-modal';
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0',
      background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: '2147483646',
      fontFamily: 'system-ui,sans-serif',
    });

    overlay.innerHTML = `
      <div role="dialog" aria-modal="true" aria-label="Name this session" style="
        background:#18181b;border:1px solid rgba(99,102,241,0.35);
        border-radius:14px;padding:22px 24px;width:320px;
        box-shadow:0 8px 40px rgba(0,0,0,0.6);">
        <div style="font-size:14px;font-weight:700;color:#e0e7ff;margin-bottom:4px;">Name this session</div>
        <div style="font-size:12px;color:#6b7280;margin-bottom:14px;">Optional - leave blank to use the date &amp; time.</div>
        <input id="sw-name-input" type="text" placeholder="e.g. Blog post draft #1" maxlength="60"
          style="width:100%;background:#0f0f1a;border:1px solid rgba(99,102,241,0.3);
          border-radius:8px;padding:9px 12px;font-size:13px;color:#e0e7ff;
          outline:none;box-sizing:border-box;margin-bottom:14px;font-family:inherit;"/>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="sw-name-cancel" style="padding:7px 16px;background:transparent;color:#6b7280;
            border:1px solid rgba(255,255,255,0.1);border-radius:7px;font-size:12px;
            font-weight:600;cursor:pointer;font-family:inherit;">Cancel</button>
          <button id="sw-name-save" style="padding:7px 18px;background:#6366f1;color:#fff;
            border:none;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;
            font-family:inherit;">Save</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    setTimeout(() => document.getElementById('sw-name-input')?.focus(), 30);

    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      overlay.remove();
      resolve(value); // string = confirmed, null = cancelled
    };

    const input = document.getElementById('sw-name-input');
    const confirm = () => finish(input.value.trim());

    document.getElementById('sw-name-save').addEventListener('click', confirm);
    document.getElementById('sw-name-cancel').addEventListener('click', () => finish(null));
    overlay.addEventListener('click', e => { if (e.target === overlay) finish(null); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); confirm(); }
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    });
  });
}

// ── Debug logging ─────────────────────────────────────────────────────────────
// Set the flag from the popup console: chrome.storage.local.set({sw_debug:true})

let _debug = false;
try {
  chrome.storage?.local?.get(['sw_debug'], r => { _debug = !!(r && r.sw_debug); });
} catch { /* context already dead */ }

function log(...args) {
  if (_debug) console.log('[SW Sessions]', ...args);
}

// ── Extension liveness ────────────────────────────────────────────────────────
//
// Reloading the add-on in about:debugging does not remove content scripts that
// are already running. They keep their DOM (so the save bar stays on screen)
// but lose their connection to the extension - chrome.runtime.id goes
// undefined, messages never arrive, and storage calls throw. The page then
// looks completely healthy while doing nothing at all. Detect it and say so.

function extensionAlive() {
  try { return !!(chrome.runtime && chrome.runtime.id); }
  catch { return false; }
}

function markBarStale() {
  const bar = document.getElementById('sw-save-bar');
  if (!bar || bar.dataset.stale === '1') return;
  bar.dataset.stale = '1';
  bar.innerHTML = '';

  const msg = document.createElement('span');
  msg.className = 'sw-stale-msg';
  msg.textContent = 'Extension was reloaded — refresh this page to reconnect';

  const btn = document.createElement('button');
  btn.className = 'sw-save-btn';
  btn.textContent = 'Refresh page';
  btn.addEventListener('click', () => location.reload());

  bar.append(msg, btn);
}

// ── Storage ───────────────────────────────────────────────────────────────────

function loadSessions(cb) {
  if (!extensionAlive()) { markBarStale(); cb([]); return; }
  try {
  chrome.storage.local.get([STORAGE_KEY], r => {
    if (chrome.runtime.lastError) {
      console.warn('[SW Sessions] read failed:', chrome.runtime.lastError.message);
      cb([]);
      return;
    }
    cb(r[STORAGE_KEY] || []);
  });
  } catch { markBarStale(); cb([]); }
}

function saveSessions(sessions, onOk, onErr) {
  if (!extensionAlive()) {
    markBarStale();
    onErr?.('Extension was reloaded - refresh the page.');
    return;
  }
  try {
    chrome.storage.local.set({ [STORAGE_KEY]: sessions }, () => {
      if (chrome.runtime.lastError) {
        onErr?.(chrome.runtime.lastError.message);
        return;
      }
      onOk?.();
    });
  } catch (e) {
    markBarStale();
    onErr?.(String(e && e.message || e));
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────

// A millisecond alone is not an identity. Two sessions saved in the same
// millisecond used to share an id, and so did a session imported from a
// backup taken on another machine; the popup keys restore, rename and delete
// by id, so a collision means one session shadows the other and delete
// removes both. The random half makes the class of bug impossible rather
// than merely unlikely.
function newSessionId() {
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${Date.now()}-${rand}`;
}

async function saveCurrentSession() {
  const ta = getTextarea();

  const out = getOutputDiv();

  const inputText = ta ? ta.value : '';

  // The page's markup is read for its text and then discarded. Nothing renders
  // saved HTML any more - the restore panel sets textContent - so persisting it
  // only burned storage against the ~10 MB storage.local cap.
  const outputHTML = out ? out.innerHTML : '';

  // If no live output is on screen but a restored snapshot is open, keep that
  // text rather than silently saving a session with no output.
  const panelBody  = document.querySelector('#sw-restored-panel .sw-panel-body');
  const outputText = outputHTML ? htmlToText(outputHTML)
                   : (panelBody ? panelBody.textContent : '');

  if (!inputText.trim() && !outputText.trim()) {
    console.warn('[SW Sessions] nothing to save - editor is empty.');
    return;
  }

  const name = await promptSessionName();
  if (name === null) return;

  const countWords = s => s.trim().split(/\s+/).filter(Boolean).length;
  const wordCount   = countWords(inputText);
  // Output size in words, not sentences. The old sentence count came from the
  // clickable-sentence spans and implied structure a read-only snapshot cannot
  // deliver, which is exactly the overpromise the AMO checklist warns about.
  const outputWords = countWords(outputText);

  const session = {
    id: newSessionId(), savedAt: Date.now(), name,
    inputText, outputText, wordCount, outputWords
  };

  loadSessions(sessions => {
    sessions.unshift(session);
    saveSessions(
      sessions,
      () => log('saved', { name, wordCount, outputWords }),
      err => {
        // No in-page notice any more: the session count in the save bar is the
        // only success signal, and it will not move if the write failed.
        console.warn('[SW Sessions] write failed - storage may be full:', err);
      }
    );
  });
}

// ── Restore ───────────────────────────────────────────────────────────────────
//
// WHY THERE IS NO CLONE SWAP
//
// Early builds wrote the saved HTML into React's own output node, then replaced
// that node with a deep clone, on the theory that React's delegated listener at
// the root would still see clicks from anything inside the root.
//
// It does see the clicks. It just can't do anything with them. React maps an
// event target back to a component through expando properties it sets directly
// on the DOM node (__reactFiber$xxx / __reactProps$xxx). cloneNode(true) copies
// attributes and children - it does NOT copy expando properties. So the clone
// is byte-identical HTML with no fiber attached, React's lookup returns nothing,
// and no handler runs. Restored sentences were never clickable in any version.
//
// The swap also detached React's real output node, so a later humanization
// rendered off-screen, which is what the "reload the page" notice was papering
// over.
//
// So we stopped fighting React. Restored output goes into a panel we own
// outright. React's node is never touched, so:
//   - no reload is ever required
//   - a fresh humanization renders normally and IS fully interactive
//   - restore works on a page with no output card at all, costing no credit
// The trade is that a restored snapshot is read-only, which is what it always
// actually was.

const PANEL_ID = 'sw-restored-panel';

function htmlToText(html) {
  // DOMParser does not execute scripts or fetch subresources, unlike assigning
  // innerHTML to a detached div.
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // A <script> is a text node to textContent, so its source would be saved as
  // part of the user's output. Nothing runs either way - DOMParser does not
  // execute what it parses - but the text does not belong in the snapshot.
  doc.querySelectorAll('script,style,noscript,template').forEach(el => el.remove());

  doc.querySelectorAll('br').forEach(br => br.replaceWith('\n'));

  // A block element is a line break even though it contributes no character
  // of its own. textContent does not know that, so two paragraphs of output
  // came back joined at the seam - "...at the end.Beginning again..." - and
  // the read-only panel has nothing but this text to render. Appending the
  // newline inside each block puts the break in the right place however the
  // blocks are nested; the collapse below tidies up the doubling.
  doc.querySelectorAll(SEL_BLOCK).forEach(el => el.appendChild(doc.createTextNode('\n')));

  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

function sessionOutputText(session) {
  if (session.outputText && session.outputText.trim()) return session.outputText;
  // Legacy read path. Sessions saved before 1.0 stored markup and no plain
  // text; new saves never set outputHTML. Keep this so old sessions and old
  // exported backups still restore.
  if (session.outputHTML && session.outputHTML.trim()) return htmlToText(session.outputHTML);
  return '';
}

// Write a value into a React-controlled textarea. Assigning .value directly is
// invisible to React: it caches the previous value on its own props, so the
// input event it receives looks like a no-op and state never updates. Calling
// the native prototype setter updates the DOM without React's descriptor
// noticing, and the dispatched events then drive the state change.
function setReactValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  )?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function restoreSession(session) {
  if (!session) return;
  log('restore requested', { name: session.name, hasInput: !!session.inputText,
                             hasText: !!session.outputText,
                             legacyHTML: !!session.outputHTML });

  const ta = getTextarea();
  if (!ta) {
    console.warn('[SW Sessions] editor not found - the site layout may have changed.');
    return;
  }

  if (session.inputText) setReactValue(ta, session.inputText);

  const text = sessionOutputText(session);
  log('output text length', text.length);
  if (!text) {
    log('input restored; session had no saved output');
    return;
  }

  showRestoredPanel(session, text);
}

// ── Restored-output panel ─────────────────────────────────────────────────────

let _panelObserver = null;
let _panelTimeout  = null;

function closeRestoredPanel() {
  document.getElementById(PANEL_ID)?.remove();
  if (_panelObserver) { _panelObserver.disconnect(); _panelObserver = null; }
  if (_panelTimeout)  { clearTimeout(_panelTimeout);  _panelTimeout = null; }
}

function showRestoredPanel(session, text) {
  closeRestoredPanel();

  const words = text.split(/\s+/).filter(Boolean).length;
  const title = (session.name && session.name.trim()) ? session.name.trim() : 'Untitled session';
  const when  = new Date(session.savedAt).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  const panel = document.createElement('section');
  panel.id = PANEL_ID;
  panel.setAttribute('aria-label', 'Restored session output');

  const hdr = document.createElement('div');
  hdr.className = 'sw-panel-hdr';

  const meta = document.createElement('div');
  meta.className = 'sw-panel-meta';
  const h = document.createElement('div');
  h.className = 'sw-panel-title';
  h.textContent = `Saved output — ${title}`;
  const sub = document.createElement('div');
  sub.className = 'sw-panel-sub';
  sub.textContent = `${when} · ${words} word${words === 1 ? '' : 's'} of saved output`;
  meta.append(h, sub);

  const actions = document.createElement('div');
  actions.className = 'sw-panel-actions';
  const copyBtn  = document.createElement('button');
  copyBtn.className = 'sw-panel-btn';
  copyBtn.textContent = 'Copy text';
  const foldBtn = document.createElement('button');
  foldBtn.className = 'sw-panel-btn';
  foldBtn.textContent = 'Hide text';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'sw-panel-btn';
  closeBtn.textContent = 'Close';
  actions.append(copyBtn, foldBtn, closeBtn);

  hdr.append(meta, actions);

  // textContent, never innerHTML - stored data is never parsed as markup.
  const body = document.createElement('div');
  body.className = 'sw-panel-body';
  body.textContent = text;

  const foot = document.createElement('div');
  foot.className = 'sw-panel-foot';
  foot.textContent = 'Read-only copy of what you saved. Your text is back in the editor above — run Humanize when you want an editable version.';

  panel.append(hdr, body, foot);
  // MOUNT OUTSIDE REACT
  // An earlier build inserted this next to the input card, which is inside
  // React's tree. setReactValue() fires an input event, React re-renders it,
  // and reconciliation discards DOM it does not own - so the panel vanished a
  // frame after it appeared. document.body is outside the React root, so React
  // never reconciles it and the panel simply stays.
  document.body.appendChild(panel);
  log('panel mounted', { words });

  // If something still removes it, leave a trace rather than failing silently.
  setTimeout(() => {
    if (!document.getElementById(PANEL_ID)) {
      console.warn('[SW Sessions] restored panel was removed by the page.');
    }
  }, 1200);

  closeBtn.addEventListener('click', closeRestoredPanel);
  copyBtn.addEventListener('click', () => copyText(text, copyBtn));
  foldBtn.addEventListener('click', () => {
    const folded = panel.classList.toggle('sw-folded');
    foldBtn.textContent = folded ? 'Show text' : 'Hide text';
  });

  log('restored', { title, words });

  watchForFreshOutput();
}

function copyText(text, btn) {
  const done = () => {
    const original = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = original; }, 1500);
  };
  const fallback = () => {
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.style.position = 'fixed';
    scratch.style.opacity = '0';
    document.body.appendChild(scratch);
    scratch.select();
    try { document.execCommand('copy'); done(); }
    catch {
      btn.textContent = 'Copy failed';
      setTimeout(() => { btn.textContent = 'Copy text'; }, 2000);
    }
    scratch.remove();
  };

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else {
    fallback();
  }
}

// Two output blocks on screen is confusing, so retire the snapshot as soon as a
// real humanization produces something new.
function watchForFreshOutput() {
  const baseline = getOutputDiv()?.textContent?.trim() || '';

  _panelObserver = new MutationObserver(() => {
    const out = getOutputDiv();
    if (!out) return;
    const now = out.textContent.trim();
    if (now && now !== baseline) {
      closeRestoredPanel();
      log('fresh output detected; saved copy closed');
    }
  });
  _panelObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Don't leave an observer on a SPA forever.
  _panelTimeout = setTimeout(() => {
    if (_panelObserver) { _panelObserver.disconnect(); _panelObserver = null; }
  }, 15 * 60 * 1000);
}

// ── Save bar ──────────────────────────────────────────────────────────────────

function injectSaveButton() {
  if (document.getElementById('sw-save-bar')) return;
  const header = document.querySelector('header');
  if (!header) return;

  const bar = document.createElement('div');
  bar.id = 'sw-save-bar';
  bar.innerHTML = `
    <button id="sw-save-btn" class="sw-save-btn">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
        <polyline points="17 21 17 13 7 13 7 21"/>
        <polyline points="7 3 7 8 15 8"/>
      </svg>
      Save Session
    </button>
    <button id="sw-session-count" class="sw-count-btn" title="Browse and restore saved sessions"></button>
  `;
  header.insertAdjacentElement('afterend', bar);

  document.getElementById('sw-save-btn').addEventListener('click', saveCurrentSession);
  document.getElementById('sw-session-count').addEventListener('click', () => {
    if (!extensionAlive()) { markBarStale(); return; }
    try { chrome.runtime.sendMessage({ type: 'SW_OPEN_POPUP' }); }
    catch { markBarStale(); }
  });
  updateCount();
  watchHeader();
}

function updateCount() {
  loadSessions(sessions => {
    const el = document.getElementById('sw-session-count');
    if (!el) return;
    if (sessions.length === 0) {
      el.textContent = '';
      el.style.display = 'none';
    } else {
      el.textContent = `${sessions.length} saved session${sessions.length !== 1 ? 's' : ''}`;
      el.style.display = 'inline-flex';
    }
  });
}

// Keep the badge honest when sessions are deleted or imported from the popup.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORAGE_KEY]) updateCount();
  if (changes[PENDING_KEY]?.newValue) consumePendingRestore();
});

// ── Messages from the popup ───────────────────────────────────────────────────
//
// THE REPLY IS NOT OPTIONAL.
//
// The popup calls tabs.sendMessage with a callback. A listener that returns
// without calling sendResponse, and without returning true, closes the port,
// and the sender's callback is then invoked with runtime.lastError set to
// "The message port closed before a response was received." The popup cannot
// tell that apart from an unreachable content script, so it took its
// self-heal branch - store a pending restore, reload the tab - on every
// single restore, on a page that was listening and would have restored
// instantly. The user saw "Page not responding", lost the page they were on,
// and waited for a reload that was never needed.
//
// restoreSession() is synchronous, so answering synchronously is enough and
// there is no need to return true.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'SW_RESTORE') return;
  restoreSession(msg.session);
  sendResponse({ ok: true });
});

// ── Pending restore ───────────────────────────────────────────────────────────
//
// An early build checked this once, 3 seconds after load. On a slow morning
// that fired before React had mounted the textarea and the restore was
// silently lost. Now we wait for the editor to exist, with a deadline.

let _consuming = false;

function consumePendingRestore() {
  if (_consuming) return;
  if (!onHumanizer()) return;
  if (!extensionAlive()) { markBarStale(); return; }

  // Claimed before the read, not after it. The storage read is asynchronous,
  // so the init call and the storage.onChanged call both used to get past the
  // guard before either had set it, and the same pending session was restored
  // twice.
  _consuming = true;

  chrome.storage.local.get([PENDING_KEY], res => {
    const session = res?.[PENDING_KEY];
    if (!session) { _consuming = false; return; }

    const deadline = Date.now() + 30000;

    const attempt = () => {
      if (pageLooksFamiliar()) {
        chrome.storage.local.remove([PENDING_KEY], () => {
          _consuming = false;
          restoreSession(session);
        });
        return;
      }
      if (Date.now() > deadline) {
        _consuming = false;
        console.warn('[SW Sessions] gave up waiting for the editor; restore not applied.');
        return;
      }
      setTimeout(attempt, 400);
    };
    attempt();
  });
}

// ── Staying attached ──────────────────────────────────────────────────────────
//
// Two things can take the save bar away, and neither fires an event the page
// can be asked for directly. The site is a single-page app, so a route change
// is a pushState with no navigation; and React re-renders the header, which
// takes anything sitting next to it along.
//
// The original answered both by re-running the whole check once a second, for
// as long as the tab was open - 3,600 wakeups an hour on a page that changes
// a handful of times in a sitting, and it kept ticking after the extension
// had been reloaded out from under it.
//
// Now each cause has its own signal. A MutationObserver on the header's
// parent puts the bar back the moment React removes it. popstate, hashchange
// and the Navigation API cover route changes wherever the browser offers
// them. The timer stays only as a backstop for what none of those cover - a
// pushState in a browser with no Navigation API, which is Firefox today - and
// it backs off from one second to thirty while nothing is happening, dropping
// straight back to one second the moment anything does.

const POLL_MIN_MS = 1000;
const POLL_MAX_MS = 30000;

let _lastPath   = location.pathname;
let _pollDelay  = POLL_MIN_MS;
let _pollTimer  = null;
let _headerObs  = null;

function onHumanizer() {
  return location.pathname.includes('humanizer');
}

function init() {
  if (!onHumanizer()) return;
  injectSaveButton();
  consumePendingRestore();
}

// Returns true when it had something to do, which is what resets the backoff.
function reattach() {
  let acted = false;

  if (location.pathname !== _lastPath) {
    _lastPath = location.pathname;
    closeRestoredPanel();
    setTimeout(init, 1000);
    acted = true;
  }

  if (onHumanizer() && !document.getElementById('sw-save-bar')) {
    injectSaveButton();
    acted = true;
  }

  return acted;
}

function poll() {
  _pollTimer = null;
  // A dead context cannot be healed by checking again, so stop rather than
  // tick on forever against a runtime that is no longer there.
  if (!extensionAlive()) { markBarStale(); return; }
  _pollDelay = reattach() ? POLL_MIN_MS : Math.min(POLL_MAX_MS, _pollDelay * 2);
  _pollTimer = setTimeout(poll, _pollDelay);
}

// Something happened that the timer would otherwise have waited to notice.
function wake() {
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
  _pollDelay = POLL_MIN_MS;
  poll();
}

// The bar is inserted after <header>, so its parent is the header's parent:
// that is the node whose child list changes when React discards it.
function watchHeader() {
  const header = document.querySelector('header');
  if (!header || !header.parentElement) return;
  if (_headerObs) _headerObs.disconnect();
  _headerObs = new MutationObserver(() => {
    if (onHumanizer() && !document.getElementById('sw-save-bar')) wake();
  });
  _headerObs.observe(header.parentElement, { childList: true });
}

window.addEventListener('popstate', wake);
window.addEventListener('hashchange', wake);
// Chrome only; Firefox has no Navigation API as of 121, which is why the
// timer below is still here.
if (typeof navigation !== 'undefined' && navigation && navigation.addEventListener) {
  navigation.addEventListener('navigatesuccess', wake);
}

_pollTimer = setTimeout(poll, POLL_MIN_MS);
setTimeout(init, 1200);
