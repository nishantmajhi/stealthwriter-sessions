# Code Review — StealthWriter Sessions

First reviewed 2026-09-04. **Remediated 2026-09-19** on branch
`cleanup/2026-09-19`, not pushed. This file is now a record rather than a
to-do list: what was fixed, what was deliberately left alone, and what is
still waiting on someone with a browser.

Scope of the pass: `manifest.json`, `content.js`, `popup.js`,
`background.js`, `README.md`, `docs/`.

---

## Corrections to the first review

The first review was right about both things it raised, and both are fixed.
It was not wrong anywhere. But it missed the two most consequential defects
in the project, and it is worth saying why, because the reason generalises.

**It read the code and never ran it.** Both misses are things that only
appear when two parts of the extension talk to each other: a message that is
never answered, and two copies of the popup holding the same array. Neither
is visible in either file on its own. The same lesson as
`Python/library_system` — a careful reading that never produced a value —
and the same shape as `Quadratic Parser/QIC` from the other side.

**"Very little here needs fixing" was the wrong conclusion from good code.**
The verdict was fair about the craftsmanship, and the comments in
`content.js` really are unusually good. But the headline feature — restore —
had never once worked the way it was written to. It worked by accident,
through a self-heal path meant for a rare failure, at the cost of a page
reload every single time.

---

## What was wrong, and what was done

Nine defects. Every one was reproduced against the original code first:
`tests/original.test.js` loads `content.js`, `popup.js` and `background.js`
out of the baseline commit and asserts each of them is there. Nothing in this
list is a claim without a test behind it.

### 1. Every restore reloaded the page — P1, not in the first review

`chrome.tabs.sendMessage(tabId, msg, callback)` sets `runtime.lastError` when
no listener answers. A listener that returns without calling `sendResponse`
and without returning `true` closes the port, and the sender's callback runs
with *"The message port closed before a response was received."* The content
script's listener did exactly that:

```js
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SW_RESTORE') restoreSession(msg.session);
});
```

So `deliverRestore()` in `popup.js` could not tell a healthy page from an
orphaned one, and took its self-heal branch — queue the session, tell the
user *"Page not responding - reloading it to restore…"*, reload the tab — on
every restore into a page that was listening and would have restored
instantly. The restore did land, through the pending-restore path after the
reload, which is why nobody noticed it was broken: it was slower and noisier
than intended rather than non-functional.

Fixed by answering the message. `restoreSession()` is synchronous, so a
synchronous `sendResponse({ ok: true })` is enough and there is no need to
return `true`. The self-heal path is untouched and still fires for a content
script that really is gone — there is a test for each.

### 2. A second manager window destroyed sessions — P1, not in the first review

`background.js` opens `popup.html` in a standalone window when the in-page
badge is clicked. That window is not dismissed by clicking away, so it can
sit open for hours with `_all` as it was when it opened. Rename, delete and
import all wrote the whole of `_all` back to storage, so a rename in that
window deleted every session saved since it opened, silently and with a
"Name updated." confirmation.

Fixed by making every mutation a read-modify-write: `mutateSessions()`
re-reads storage, applies the one change, and writes that. A
`chrome.storage.onChanged` listener also keeps the visible list current —
except while a rename input is open, because pulling a half-typed name out
from under the user to show a change made elsewhere is worse than waiting.

### 3. Unescaped `wordCount` in the card template — P1, as reported

`popup.js` escaped everything in the card except `${session.wordCount || 0}`,
and the import validator checked the types of `id`, `savedAt` and the three
text fields but not `wordCount`. A backup file with a string there executed
script in a page holding `storage` and `tabs`.

Fixed at both ends: the template escapes every interpolation including the
two that are numbers, and `normalizeSession()` makes them numbers. The first
review also noted `timeAgo(session.savedAt)` as safe-by-type-check; it is now
escaped as well, so the template no longer has a field it trusts.

The escaping tests use the shape check from
`Web/Frontend/With Libraries/docxDiff` rather than a payload list: render the
same card twice, once with a hostile string and once with an inert one, and
require the same elements with the same attributes in the same order. There
is a test asserting the shape function itself fails on genuinely injectable
markup, because without it a shape function that returned a constant would
make every escaping test pass.

### 4. A malformed backup bricked the popup permanently — P1, not in the first review

This is the same hole as (3) through a different field, and it is worse. A
session with a number where `name` should be passed the import validator, was
written to storage, and *then* threw inside `render()` — `session.name.trim`
is not a function. The list came up empty, and it came up empty on every
subsequent open, because the bad record was now in storage and there is no UI
that can remove a session that never draws. The only way back was the storage
inspector.

`normalizeSession()` now runs on the way in and on the way out, so a wrongly
typed field is repaired rather than stored, and a record already poisoned by
an earlier import is repaired on read. A session that cannot be made sense of
at all — no string id, no finite `savedAt`, no text field — is dropped. The
acceptance rule is otherwise exactly the original's.

### 5. A one-second interval, for ever — P2, as reported

`setInterval(..., 1000)` ran for the life of every tab on the site: 3,600
wakeups an hour on a page that changes a handful of times in a sitting. It
also kept ticking after the extension had been reloaded out from under it,
where checking again cannot possibly help.

Replaced with a signal per cause: a `MutationObserver` on the header's parent
for React discarding the bar, `popstate`/`hashchange`/the Navigation API for
route changes, and a backstop timer for the one case none of those cover — a
`pushState` in a browser with no Navigation API, which today means Firefox.
The timer backs off from one second to thirty while nothing is happening and
resets the moment anything does, and it stops scheduling once the context is
dead. Ten idle minutes now cost around twenty wakeups rather than 600, and
`tests/attach.test.js` counts them rather than asserting the shape of the
code.

### 6. Session ids collided — P3, as reported

`Date.now().toString()`. Two saves in the same millisecond shared an id, and
so did a session imported from a backup taken on another machine at the same
instant. The popup keys restore, rename and delete by id, so a collision
means one session shadows the other and delete removes both. Ids are now
`${Date.now()}-${8 random base-36 characters}`, and the import skips an id it
has already seen — including one repeated inside the same file, which the
original accepted twice.

### 7. A backup file containing `null` failed silently — P3, not in the first review

`JSON.parse("null")` succeeds, and `parsed.sessions` then threw inside the
`FileReader` callback. No status line, no message, nothing on screen at all.
Guarded, along with a file containing a bare number or string.

### 8. Block elements ran together in saved output — P3, not in the first review

`htmlToText()` replaced `<br>` with a newline and then took `textContent`,
which gives a block element no break of its own: two paragraphs of output
came back as `...at the end.Beginning again...`, and the read-only panel has
nothing but that text to render. Block elements now contribute a newline, and
`<script>`/`<style>` text is dropped rather than being saved as part of the
user's output. Nothing ever executed — `DOMParser` does not run what it
parses, which is why the function uses it — and there is a test for that too.

### 9. Smaller things

- A pending restore could be consumed twice, because `_consuming` was set
  after an asynchronous read that two callers could both get past. Claimed
  before the read now.
- Both message listeners read `.type` off whatever arrived, so `undefined`
  threw. Guarded.
- Clicking Restore on a session another window had deleted left the button
  stuck on "Restoring…" for as long as the window stayed open. It now says so
  and redraws.
- Pressing Escape during a rename removed the input, but where a browser
  fires `blur` on removal the blur handler would have committed the
  abandoned text. Both paths now go through one `committed` flag.

---

## Deliberately not done

**The storage-failure notice in the UI (first review, P3).** The standing
constraint on this archive is business logic only — no UI or UX changes — and
adding an in-page notice to `content.js` is a new piece of interface. The
existing signal is unchanged: the saved-session count does not move, and the
page console carries the reason. In `popup.js`, which already has a status
line, failures that used to be swallowed are now routed through it, because
that is using an existing channel rather than adding one.

**The trademark item (first review, P2).** `manifest.json` still ships
`"name": "StealthWriter Sessions"` and the gecko id
`stealthwriter-sessions@local`, and item 1 of
`docs/amo-release-checklist.md` is still the blocking one. Renaming changes
the add-on id, which means existing installs will not upgrade in place. That
is the author's decision, not a cleanup.

**The `outputHTML` intermediate copy in `saveCurrentSession()`.** The first
review called it a judgement call and it still is. The current form is
clearer and the copy is transient.

**The save bar is not removed when you navigate away from the humanizer.**
True before this pass and true after it. It is a UI behaviour, and removing
it is not obviously right — the site is a single-page app and you may be
about to come back.

**`manifest.json` declaring both `background.service_worker` and
`background.scripts`.** The first review wondered whether Chrome rejects the
unknown key. Nothing here can load a Chrome, so it was left exactly as it
was; it is the correct cross-browser form and changing it on a guess would be
worse than leaving it.

---

## Removed

`docs/test-restore.js`. Its header explained the right idea — load
`content.js` whole with only `chrome.*` faked, because a refactor once
dropped a function that fragment-level tests could not see — but it needed
`jsdom`, which is not installed and which the project has no
`package.json` to declare, so it could not be run. `tests/harness.js` does
the same thing for the whole extension with no dependencies, and drives the
restore through `tabs.sendMessage` rather than calling the listeners
directly, which is what would have caught defect (1).

`docs/check-selectors.js` stays. It needs the live site and nothing here
replaces it.

---

## The test suite

```bash
node --test "tests/*.test.js"
```

144 checks, no dependencies, no framework. Node 18 or later.

| File | What it covers |
|---|---|
| `tests/dom.js` | A DOM with a real HTML parser, attribute selectors and a `MutationObserver` |
| `tests/dom.test.js` | The above, because a shim that lies hides the bug it is lying about |
| `tests/harness.js` | One storage, one tab table, one virtual clock, a `chrome` namespace per context |
| `tests/original.test.js` | Every defect above, reproduced against the baseline commit |
| `tests/restore.test.js` | Delivery, tab preference, the pending-restore path |
| `tests/popup.test.js` | Rendering, escaping, rename, delete, two windows at once |
| `tests/import.test.js` | The backup format and what a session is allowed to be |
| `tests/content.test.js` | Saving, text extraction, the restored panel |
| `tests/attach.test.js` | Reattachment, and the cost of it |
| `tests/manifest.test.js` | What a build step would have checked, since there is none |

Two things in it are worth stealing.

**The message port is modelled exactly.** `tabs.sendMessage` sets
`runtime.lastError` when no listener answers — "Receiving end does not exist"
with no content script, "The message port closed before a response was
received" with one that does not reply. A harness that simply called the
callback with no error would have made the broken code look correct. If you
are testing extension messaging anywhere else in this archive, copy this
before you copy anything else.

**`tests/original.test.js` needs no transcription.** These files do nothing
at import time beyond registering listeners against the fake `chrome`, so the
`Python/library_system` trick applies: read the baseline out of `git show`,
run it in the same harness, assert against the real original. The baseline is
found by commit *subject*, so a rebase makes it fail loudly.

One trap that cost time: an object handed across a `vm` realm boundary has a
different `Object.prototype`, so `assert.deepStrictEqual` rejects a
structurally identical value. The harness structured-clones message responses,
which is both what a browser does and what keeps the value in the caller's
realm.

---

## Still needs a browser

Nothing here can drive one, so three things are unverified and all three are
quick.

1. **Restore, in Chrome and in Firefox.** This is the one worth doing. Save a
   session, open the popup, click Restore into a tab that is already on the
   humanizer. The page must **not** reload: the input should appear in the
   editor and the panel at the bottom right, immediately, with no "Page not
   responding" message. That is the whole of defect (1), and the port
   behaviour it depends on is the one thing the suite asserts about a browser
   rather than observing in one. Five minutes.

2. **The two-window case.** Click the in-page saved-session badge to open the
   standalone manager window. Leave it open. Save two more sessions on the
   page. The window's list should update on its own; rename something in it
   and confirm all three sessions are still there afterwards. That is defect
   (2), and the original lost the two new ones. Five minutes.

3. **The selectors still match the live site.** Unchanged by this pass, but
   nothing here has seen the site. Paste `docs/check-selectors.js` into the
   page console; everything should come back true with a non-zero sentence
   count.

Worth doing at the same time if you are already there: import a backup file
with `"wordCount": "<img src=x onerror=alert(1)>"` in it and confirm the card
reads "0 words in" and no dialog appears.

---

## Notes for a future session

Read the "why there is no clone swap" comment in `content.js` before touching
the restore path; it documents a dead end that has already been paid for
once. The comment above the `onMessage` listener is the other one to read
first — it is the whole of defect (1) and the reason the reply is not
optional.

`tests/dom.js` is the most capable DOM in this archive so far: a real parser,
selectors including `[class*=]` and `:scope >`, `dataset`, `classList`,
events that bubble, `CSS.escape` with the matching unescape in the selector
engine, and an asynchronous `MutationObserver`. It is about 700 lines with no
dependencies and it is reusable by anything here that has to drive a page. Its
own tests are in `tests/dom.test.js` and should be extended along with it.

The AMO checklist in `docs/` is a live document and item 1 is still
unresolved. Do not tick anything in it; it is the author's.

## Licence, 2026-10-02

The author chose one licence for all of their projects: free for personal,
non-commercial use, modifiable for the user's own use, and not to be
distributed, original or modified. No standard licence says that, so `LICENSE`
is a short custom text, the same in every project apart from the year and what
it excludes. The README's licence section says the same. Anything above that
calls the licence an open question, or calls the project MIT, is superseded.

## CI, 2026-10-02

`.github/workflows/ci.yml` runs the 144 node checks on `ubuntu-latest`.
Nothing has been pushed, so it has not run on GitHub yet. Every job was run
before committing, from a fresh clone of this branch, the way a runner would
run it: Linux jobs in a throwaway Ubuntu 24.04 (the image `ubuntu-latest`
uses) with the same tool versions. 144.

It fetches full history: `tests/harness.js` finds the baseline commit in `git
log`, and the suite fails in a one-commit clone (checked).
