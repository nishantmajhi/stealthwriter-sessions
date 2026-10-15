/**
 * StealthWriter Sessions v1.0 - popup
 */

const STORAGE_KEY  = 'sw_sessions_v3';
const PENDING_KEY  = 'sw_pending_restore';
const SW_MATCH     = '*://*.stealthwriter.ai/*';
const HUMANIZER_URL = 'https://stealthwriter.ai/dashboard/humanizer';

let _all = [];
let _filter = '';
let _armedDelete = null; // id of the delete button waiting for confirmation
let _armTimer = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000)    return 'just now';
  if (d < 3600000)  return Math.floor(d / 60000) + 'm ago';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
  return Math.floor(d / 86400000) + 'd ago';
}

function fullDate(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function cardTitle(session) {
  return (session.name && session.name.trim()) ? session.name.trim() : fullDate(session.savedAt);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function status(msg, isError) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status' + (isError ? ' err' : '');
  el.style.display = msg ? 'block' : 'none';
  if (msg) setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// ── Session shape ─────────────────────────────────────────────────────────────
//
// Everything that reaches this file from storage has been through an import
// at some point, and an import is a file the user chose. The card template
// interpolates numbers, cardTitle() calls .trim() on the name, and the search
// filter calls .toLowerCase() on the input text - so a field of the wrong
// type is not a cosmetic problem. A string where wordCount should be is
// written into innerHTML unescaped; a number where name should be throws
// inside render(), after the import has already been written to storage,
// which leaves the popup showing an empty list on every open with no way back
// that does not involve the storage inspector.
//
// So nothing is trusted on the way in or on the way out: normalise once here,
// and every reader downstream can assume the shape it was written for.

const MAX_NAME = 60;

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function asCount(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (!Number.isFinite(raw.savedAt)) return null;

  // Same acceptance rule as before: at least one of the three text fields has
  // to be present as a string. outputHTML is the pre-1.0 form.
  const hasText = typeof raw.inputText  === 'string' ||
                  typeof raw.outputText === 'string' ||
                  typeof raw.outputHTML === 'string';
  if (!hasText) return null;

  const session = {
    id: raw.id,
    savedAt: raw.savedAt,
    name: asText(raw.name).slice(0, MAX_NAME),
    inputText: asText(raw.inputText),
    outputText: asText(raw.outputText),
    wordCount: asCount(raw.wordCount),
    outputWords: asCount(raw.outputWords),
  };
  // Carried through untouched so old sessions still restore; content.js reads
  // it with DOMParser and renders the result as text, never as markup.
  if (typeof raw.outputHTML === 'string') session.outputHTML = raw.outputHTML;
  if (Number.isFinite(raw.sentCount)) session.sentCount = Math.floor(raw.sentCount);
  return session;
}

function normalizeAll(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeSession).filter(Boolean);
}

function loadSessions(cb) {
  chrome.storage.local.get([STORAGE_KEY], r => cb(normalizeAll(r[STORAGE_KEY])));
}

function saveSessions(sessions, onOk, onErr) {
  chrome.storage.local.set({ [STORAGE_KEY]: sessions }, () => {
    if (chrome.runtime.lastError) { onErr?.(chrome.runtime.lastError.message); return; }
    onOk?.();
  });
}

// ── Mutating the stored list ──────────────────────────────────────────────────
//
// Two copies of this page can be open at once: the toolbar popup, and the
// standalone window background.js opens when the in-page badge is clicked.
// That window is not dismissed by clicking away, so it can sit there for an
// hour with an hour-old copy of the session list in `_all`.
//
// Every mutation used to write the whole of `_all` back, so renaming one
// session in that window destroyed every session saved since it opened. The
// write is not the user's copy any more: re-read, apply the one change, write
// that. `change` returns the new array, or null if the session it wanted is
// no longer there - which is its own message rather than a failure of
// whichever operation asked for it.

function mutateSessions(change, onOk, onErr) {
  loadSessions(current => {
    const next = change(current);
    if (!next) { status('That session is no longer saved.', true); refresh(); return; }
    saveSessions(next,
      () => { _all = next; render(); onOk?.(); },
      err => { refresh(); onErr?.(err); });
  });
}

// ── Open/Switch button ────────────────────────────────────────────────────────

function checkSwTab() {
  chrome.tabs.query({ url: SW_MATCH }, tabs => {
    const btn = document.getElementById('btn-open');
    if (tabs.length > 0) {
      btn.textContent = 'Switch to StealthWriter';
      btn.dataset.mode = 'switch';
    } else {
      btn.textContent = 'Open StealthWriter';
      btn.dataset.mode = 'open';
    }
  });
}

// ── Render ────────────────────────────────────────────────────────────────────

function visible() {
  if (!_filter) return _all;
  const q = _filter.toLowerCase();
  return _all.filter(s =>
    cardTitle(s).toLowerCase().includes(q) ||
    (s.inputText || '').toLowerCase().includes(q)
  );
}

function render() {
  const list  = document.getElementById('session-list');
  const label = document.getElementById('section-label');
  const searchRow = document.getElementById('search-row');
  list.innerHTML = '';

  searchRow.style.display = _all.length > 4 ? 'block' : 'none';

  if (_all.length === 0) {
    label.textContent = 'Saved Sessions';
    list.innerHTML = `
      <div class="empty">
        <strong>No sessions saved yet</strong>
        Open StealthWriter and click<br>
        <em>Save Session</em> at the top of the page.
      </div>`;
    return;
  }

  const rows = visible();
  label.textContent = `Saved Sessions (${rows.length}${rows.length !== _all.length ? ' of ' + _all.length : ''})`;

  if (rows.length === 0) {
    list.innerHTML = `<div class="empty"><strong>No matches</strong>Try a different search term.</div>`;
    return;
  }

  rows.forEach(session => {
    const card = document.createElement('div');
    card.className = 'session-card';
    card.dataset.id = session.id;

    // Sessions saved before 1.0 carry sentCount instead of outputWords. Fall
    // back to it so old cards still show that output was saved.
    const outWords = session.outputWords || 0;
    const outPill  = outWords          ? `${outWords} words out`
                   : session.sentCount ? `${session.sentCount} sentences`
                   : null;
    const hasName = session.name && session.name.trim();

    // Everything interpolated below goes through escHtml, including the two
    // values that are numbers by the time they get here. normalizeSession()
    // is what makes them numbers, and this is what makes that unnecessary to
    // know: the template no longer has a field it trusts.
    card.innerHTML = `
      <div class="card-label">${escHtml(cardTitle(session))}</div>
      ${hasName ? `<div class="card-date">${escHtml(fullDate(session.savedAt))}</div>` : ''}
      <div class="card-meta">
        <span class="pill">${escHtml(session.wordCount || 0)} words in</span>
        ${outPill
          ? `<span class="pill green">${escHtml(outPill)}</span>`
          : `<span class="pill">no output</span>`}
        <span style="color:#4b5563">${escHtml(timeAgo(session.savedAt))}</span>
      </div>
      <div class="card-actions">
        <button class="btn-restore" data-id="${escHtml(session.id)}">Restore</button>
        <button class="btn-rename"  data-id="${escHtml(session.id)}">Rename</button>
        <button class="btn-delete"  data-id="${escHtml(session.id)}">Delete</button>
      </div>`;

    list.appendChild(card);
  });
}

function refresh(cb) {
  loadSessions(sessions => { _all = sessions; render(); cb?.(); });
}

// ── Restore ───────────────────────────────────────────────────────────────────

function isStealthWriterUrl(url) {
  return /^https?:\/\/([^/]*\.)?stealthwriter\.ai(\/|$)/.test(url || '');
}

// Hand the session to the content script. If the content script can't be
// reached, queue it and reload the tab - a fresh content script consumes the
// queued restore on load. This is the self-heal for an orphaned content script,
// which is what you get after reloading the add-on without refreshing the page.
function deliverRestore(tab, session) {
  chrome.tabs.sendMessage(tab.id, { type: 'SW_RESTORE', session }, () => {
    if (!chrome.runtime.lastError) { window.close(); return; }

    chrome.storage.local.set({ [PENDING_KEY]: session }, () => {
      if (chrome.runtime.lastError) {
        status('Could not save the pending restore. Try again.', true);
        return;
      }
      status('Page not responding - reloading it to restore…');
      chrome.tabs.reload(tab.id);
      setTimeout(() => window.close(), 700);
    });
  });
}

function restoreSession(id) {
  const session = _all.find(s => s.id === id);
  if (!session) {
    // The button has already been switched to "Restoring…" by the click
    // handler, so leaving quietly strands it there for as long as the window
    // stays open.
    status('That session is no longer saved.', true);
    render();
    return;
  }

  // Which tab the user is actually looking at. Restoring into some other
  // window's stale tab is never what was meant.
  chrome.tabs.query({ active: true, currentWindow: true }, activeTabs => {
    const active = activeTabs && activeTabs[0];

    chrome.tabs.query({ url: SW_MATCH }, tabs => {
      if (!tabs || tabs.length === 0) {
        chrome.storage.local.set({ [PENDING_KEY]: session }, () => {
          chrome.tabs.create({ url: HUMANIZER_URL }, () => window.close());
        });
        return;
      }

      // Preference order:
      //   1. the tab in front of the user, if it is a StealthWriter tab
      //   2. a humanizer tab in the current window
      //   3. any humanizer tab
      //   4. any StealthWriter tab
      const inWindow = active ? tabs.filter(t => t.windowId === active.windowId) : [];
      const target =
        (active && isStealthWriterUrl(active.url) && tabs.find(t => t.id === active.id)) ||
        inWindow.find(t => (t.url || '').includes('humanizer')) ||
        tabs.find(t => (t.url || '').includes('humanizer')) ||
        inWindow[inWindow.length - 1] ||
        tabs[tabs.length - 1];

      if (target.id !== active?.id) {
        chrome.tabs.update(target.id, { active: true });
        chrome.windows.update(target.windowId, { focused: true });
      }

      // On StealthWriter but not the humanizer: queue and navigate.
      if (!(target.url || '').includes('humanizer')) {
        chrome.storage.local.set({ [PENDING_KEY]: session }, () => {
          chrome.tabs.update(target.id, { url: HUMANIZER_URL }, () => window.close());
        });
        return;
      }

      deliverRestore(target, session);
    });
  });
}

// ── Rename ────────────────────────────────────────────────────────────────────

function startRename(id) {
  const card = document.querySelector(`.session-card[data-id="${CSS.escape(id)}"]`);
  const session = _all.find(s => s.id === id);
  if (!card || !session) return;
  if (card.querySelector('.rename-input')) return;

  const labelEl = card.querySelector('.card-label');
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.type = 'text';
  input.maxLength = 60;
  input.value = session.name || '';
  input.placeholder = 'Leave blank to use the date';

  labelEl.replaceWith(input);
  input.focus();
  input.select();

  let committed = false;
  const commit = () => {
    // Enter commits and then re-renders, which removes the input; on some
    // paths that fires blur as well, and a second write is at best noise.
    if (committed) return;
    committed = true;
    const name = input.value.trim().slice(0, MAX_NAME);
    mutateSessions(
      current => {
        const index = current.findIndex(s => s.id === id);
        if (index < 0) return null;
        const next = current.slice();
        next[index] = { ...next[index], name };
        return next;
      },
      () => status('Name updated.'),
      err => status('Could not save the name: ' + err, true));
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    // Escape has to close the edit for good. Removing the input is not always
    // enough on its own: where the browser fires blur on removal, the blur
    // handler would commit the very text the user just abandoned.
    if (e.key === 'Escape') { e.preventDefault(); committed = true; render(); }
  });
  input.addEventListener('blur', commit);
}

// ── Delete (two-step, no native confirm) ──────────────────────────────────────

function handleDelete(btn, id) {
  if (_armedDelete !== id) {
    disarmDelete();
    _armedDelete = id;
    btn.textContent = 'Confirm';
    btn.classList.add('armed');
    _armTimer = setTimeout(disarmDelete, 4000);
    return;
  }

  disarmDelete();
  mutateSessions(
    current => (current.some(s => s.id === id) ? current.filter(s => s.id !== id) : null),
    () => status('Session deleted.'),
    err => status('Could not delete: ' + err, true));
}

function disarmDelete() {
  clearTimeout(_armTimer);
  _armTimer = null;
  if (_armedDelete) {
    const b = document.querySelector(`.btn-delete[data-id="${CSS.escape(_armedDelete)}"]`);
    if (b) { b.textContent = 'Delete'; b.classList.remove('armed'); }
    _armedDelete = null;
  }
}

// ── Export / Import ───────────────────────────────────────────────────────────

function exportBackup() {
  if (_all.length === 0) { status('Nothing to export yet.', true); return; }

  const payload = {
    format: 'stealthwriter-sessions',
    version: 1,
    exportedAt: new Date().toISOString(),
    sessions: _all
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `stealthwriter-sessions-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  status(`Exported ${_all.length} session${_all.length !== 1 ? 's' : ''}.`);
}

function importBackup(file) {
  const reader = new FileReader();

  reader.onerror = () => status('Could not read that file.', true);
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch {
      status('That file is not valid JSON.', true);
      return;
    }

    // A file containing `null` parses fine and is not an object, so reading
    // .sessions off it threw inside the reader callback - no message, no
    // status line, nothing at all on screen.
    const incoming = Array.isArray(parsed) ? parsed
                   : (parsed && typeof parsed === 'object' ? parsed.sessions : null);
    if (!Array.isArray(incoming)) {
      status('No sessions found in that file.', true);
      return;
    }

    const clean = normalizeAll(incoming);

    if (clean.length === 0) {
      status('No usable sessions in that file.', true);
      return;
    }

    // Re-read rather than merging into this page's copy: another popup, or
    // the page itself, may have saved something since this one was opened.
    loadSessions(current => {
      const seen = new Set(current.map(s => s.id));
      const added = [];
      for (const session of clean) {
        // A backup can repeat an id within itself as well as collide with one
        // already stored. Both used to get through, and two sessions sharing
        // an id means restore picks one of them and delete removes both.
        if (seen.has(session.id)) continue;
        seen.add(session.id);
        added.push(session);
      }

      if (added.length === 0) {
        _all = current;
        render();
        status('All sessions in that file are already saved.');
        return;
      }

      const merged = [...current, ...added].sort((a, b) => b.savedAt - a.savedAt);
      saveSessions(merged,
        () => {
          _all = merged;
          render();
          status(`Imported ${added.length} session${added.length !== 1 ? 's' : ''}.`);
        },
        () => status('Could not save the import - storage may be full.', true));
    });
  };

  reader.readAsText(file);
}

// ── Events ────────────────────────────────────────────────────────────────────

document.getElementById('session-list').addEventListener('click', e => {
  const restore = e.target.closest('.btn-restore');
  const rename  = e.target.closest('.btn-rename');
  const del     = e.target.closest('.btn-delete');

  if (restore) {
    restore.textContent = 'Restoring…';
    restore.classList.add('restoring');
    restoreSession(restore.dataset.id);
    return;
  }
  if (rename) { disarmDelete(); startRename(rename.dataset.id); return; }
  if (del)    { handleDelete(del, del.dataset.id); }
});

document.getElementById('search').addEventListener('input', e => {
  _filter = e.target.value.trim();
  disarmDelete();
  render();
});

document.getElementById('btn-export').addEventListener('click', exportBackup);

document.getElementById('btn-import').addEventListener('click', () =>
  document.getElementById('file-input').click());

document.getElementById('file-input').addEventListener('change', e => {
  const file = e.target.files?.[0];
  if (file) importBackup(file);
  e.target.value = '';
});

document.getElementById('btn-open').addEventListener('click', () => {
  const btn = document.getElementById('btn-open');
  if (btn.dataset.mode === 'switch') {
    chrome.tabs.query({ url: SW_MATCH }, tabs => {
      if (tabs.length > 0) {
        const t = tabs.find(x => (x.url || '').includes('humanizer')) || tabs[tabs.length - 1];
        chrome.tabs.update(t.id, { active: true });
        chrome.windows.update(t.windowId, { focused: true });
      }
      window.close();
    });
  } else {
    chrome.tabs.create({ url: HUMANIZER_URL });
    window.close();
  }
});

// A session saved on the page, or deleted in the other copy of this window,
// changes what this one should be showing. The manager window opened by
// background.js is not dismissed by clicking away, so without this it shows
// whatever was true when it opened for as long as it stays open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORAGE_KEY]) return;
  // Do not pull a half-typed rename out from under the user. The commit path
  // re-reads storage for itself, so nothing is lost by leaving the list until
  // the edit is finished.
  if (document.querySelector('.rename-input')) {
    loadSessions(sessions => { _all = sessions; });
    return;
  }
  disarmDelete();
  refresh();
});

// ── Init ──────────────────────────────────────────────────────────────────────

checkSwTab();
refresh();
