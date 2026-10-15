# StealthWriter Sessions

A browser extension that saves and restores your work on StealthWriter's
humanizer, so closing a tab or rebooting does not cost you a draft.

> **Unofficial.** Not affiliated with, endorsed by, or connected to
> StealthWriter. It is an independent tool that runs against their web app.

---

## What it does

It adds a **Save Session** bar under the site header on the humanizer page.
One click stores the text in the editor and the humanized result in browser
storage, where they survive tab closes, browser restarts and reboots. The
toolbar popup lists what you have saved and puts any of it back.

- Save input and output together, with an optional name
- Restore: the input goes back into the editor, the output opens in a
  read-only panel
- Rename, search and delete saved sessions
- Export and import the whole lot as a JSON file
- Everything stays on your machine; the extension makes no network requests
  of any kind

---

## Install

Firefox 121 or later, or a Chromium browser with MV3. There is no build step:
the folder is the extension.

**Firefox.** Download or clone this repository somewhere you will not move or
delete — the browser loads the files from disk rather than copying them. Open
`about:debugging` → **This Firefox** → **Load Temporary Add-on…** and pick
`manifest.json`. Temporary add-ons disappear on restart; to keep one, submit
the folder to [addons.mozilla.org](https://addons.mozilla.org) as an
**unlisted** add-on and you get a signed `.xpi` back in about a minute with no
public review. [`docs/amo-release-checklist.md`](docs/amo-release-checklist.md)
covers what a public listing needs, and the first item on it is unresolved.

**Chromium.** `chrome://extensions` → **Developer mode** → **Load unpacked**,
and pick the folder. The manifest declares a service worker as well as
Firefox's background scripts, so one copy of the source runs on both.

Then open the humanizer page. The **Save Session** bar appears under the
header.

---

## Using it

**Saving.** Click **Save Session**, optionally give it a name, press Enter.
It works with input alone, with input and a result, or with a restored
snapshot still open — in that last case the snapshot's text is what gets
saved, so carrying a session forward does not lose the output.

**Restoring.** Open the popup, pick a session, click **Restore**. If a
StealthWriter tab is open it is brought to the front and the restore happens
in place. If the tab is on some other page of the site, or there is no tab at
all, the extension opens the humanizer and restores once the editor has
rendered — it waits up to thirty seconds for that rather than firing at a
fixed delay and missing on a slow morning.

**Backing up.** **Export backup** writes every saved session to a JSON file.
**Import backup** merges one back in, skipping anything already saved. Worth
doing before you reinstall the browser or clear site data. The exported file
is plain text and contains everything you have written, so treat it the way
you would treat the documents themselves — `.gitignore` deliberately excludes
`backup.json` for that reason.

---

## Limitations

**Restored output is read-only.** You can read it and copy it; you cannot
click sentences to regenerate them. This is not a missing feature — it cannot
be built. React resolves a click to a component through expando properties
(`__reactFiber$…`) that it writes onto the DOM nodes it owns. Saved markup has
no fiber behind it, and nothing a content script can do will attach one. Run
Humanize again when you need an editable result; that output is React's own
and is fully interactive.

**It is tied to one site's markup.** The editor and the output block are found
with CSS selectors, and a redesign can break them. Paste
[`docs/check-selectors.js`](docs/check-selectors.js) into the page console to
see which one drifted.

**Storage is finite.** Sessions live in `storage.local`, which browsers cap at
around 10 MB. A session holds plain text only, so a long document is roughly
30–50 KB. A failed write is reported in the page console and the saved-session
count does not move, which is the visible signal that nothing was stored.

**Uninstalling deletes everything.** Removing the extension clears its
storage. Export first.

---

## How it is put together

```
manifest.json     MV3 manifest, with both background forms
content.js        Runs on the page: save bar, capture, restore panel
popup.html/js     The session manager
background.js     Opens the manager when the in-page badge is clicked
styles.css        Styles for what content.js injects
docs/             Selector check, AMO release checklist
tests/            The test suite and the browser it runs against
```

Four decisions are worth knowing before changing anything, because each one
was arrived at the hard way.

**Restored output is mounted on `document.body`, outside React's tree.**
Anything inserted into a React-managed container is discarded on the next
re-render, and putting the input text back triggers one immediately. An
earlier build mounted the panel next to the input card and it vanished a frame
after it appeared.

**Restore never clicks Humanize for you.** An early version did, to make the
output container exist. That spent a daily humanization credit to display text
the extension already had.

**A restore is sent as a message, and the content script answers it.** If a
listener returns without calling `sendResponse`, the port closes and the
sender's callback runs with `runtime.lastError` set to *"The message port
closed before a response was received"* — which is indistinguishable from a
content script that is not there. The popup has a self-heal path for that case
which queues the restore and reloads the tab, and it used to run on every
single restore. The reply is not optional.

**Nothing read out of storage is trusted.** A session can have come from an
imported file, and the popup's card template, its title function and its
search filter were all written for the shape `content.js` produces.
`normalizeSession()` in `popup.js` is the one place that enforces it, on the
way in and on the way out.

### Staying attached to a single-page app

The site changes route without navigating and re-renders the header, either of
which takes the save bar away. Three signals cover that: a `MutationObserver`
on the header's parent, which puts the bar back the moment it goes;
`popstate`, `hashchange` and the Navigation API for route changes where the
browser offers them; and a backstop timer for what none of those cover — a
`pushState` in a browser with no Navigation API, which today means Firefox.
The timer starts at one second and backs off to thirty while nothing is
changing, returning to one second the moment anything does.

### Reloading during development

- **Changed `content.js`, `popup.*` or `styles.css`:** click **Reload** in
  `about:debugging`, then hard-refresh the StealthWriter tab (`Ctrl+Shift+R`).
- **Changed `manifest.json`:** **Remove** and load it again. Reload is not
  enough.

The hard refresh matters. Reloading an add-on leaves already-running content
scripts in place: they keep their DOM, so the save bar still looks fine, but
they lose their connection to the extension and stop doing anything. The
extension detects that and replaces the bar with a refresh prompt, but
refreshing is the habit that avoids it.

### Debug tracing

Right-click the popup → **Inspect**, then:

```js
chrome.storage.local.set({ sw_debug: true });
```

Hard-refresh the page and watch the page console for `[SW Sessions]` lines.

| Failing file | Console |
|---|---|
| `content.js` | Page console (F12 on the StealthWriter tab) |
| `background.js` | `about:debugging` → **Inspect** |
| `popup.js` | Right-click the popup → **Inspect** |

---

## Tests

```bash
node --test "tests/*.test.js"
```

144 checks, no dependencies and no test framework — Node 18 or later is all
that is needed.

The extension has no seam: `content.js` and `popup.js` are classic scripts
that run their whole setup at load time against `document`, `chrome` and a
timer. So the suite brings a browser instead of carving the code up.
`tests/dom.js` is a DOM with a real HTML parser, working attribute selectors
and a `MutationObserver`; `tests/harness.js` is one `chrome.storage.local`,
one tab table and one virtual clock, with a `chrome` namespace per context, so
a test can open the background worker, a content script and two popups in the
same world and watch them interfere with each other.

Two parts of it are worth knowing about before you extend it.

**The message port is modelled exactly.** `tabs.sendMessage` sets
`runtime.lastError` when no listener answers, which is the behaviour the
restore bug depended on. A shim that just called the callback would have made
the broken code look correct.

**`tests/original.test.js` runs the original files.** It finds the baseline
commit by its subject line, loads `content.js`, `popup.js` and
`background.js` out of git into the same harness, and asserts that each defect
this project claims to have fixed really was there. Nothing in it is a
transcription. If the baseline moves, it fails loudly rather than quietly
asserting nothing.

`tests/dom.test.js` tests the harness itself, because a shim that is wrong
about the behaviour a bug depends on hides the bug behind a passing test.

Three things the suite cannot reach, because nothing here drives a browser:
whether Chrome and Firefox agree with the port semantics above, whether the
selectors still match the live site, and what the injected bar and panel
actually look like.

---

## Privacy

Everything stays on your machine in `storage.local`. There are no network
requests, no analytics and no remote code, and the test suite asserts that
none of the three scripts contains a network call.

| Permission | Why |
|---|---|
| `storage` | Persist sessions across restarts — the entire purpose |
| `tabs` | Find a StealthWriter tab to restore into, and focus it |
| `*://*.stealthwriter.ai/*` | Read the editor and inject the save bar |

`tabs` is used only for `tabs.query({ url })` scoped to that one host, never
to read the contents of arbitrary tabs.

---

## License

Free for personal, non-commercial use. You may use, study and modify this
software for yourself, but you may not use it commercially, and you may not
share or publish it, in its original form or modified. See [LICENSE](LICENSE)
for the full terms.

[`docs/amo-release-checklist.md`](docs/amo-release-checklist.md) lists the
rest of what a public release would need, starting with the trademark
question in the add-on's name.
