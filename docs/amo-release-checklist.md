# AMO release checklist

Ordered by what blocks what. Items 1–3 gate everything else.

## 1. Resolve the trademark problem — BLOCKING

"StealthWriter" is someone else's brand. Mozilla's add-on policies prohibit
using a third party's name or trademark in a way that implies affiliation or
endorsement, and a reviewer will see it in the add-on name, the ID, the icon
context, and the listing. This is the single most likely cause of rejection.

Pick one:

- **Rename.** Safest. Something descriptive that names the function, not the
  vendor — e.g. "Session Keeper", "Draft Restore", "Editor Session Saver".
  The listing description can factually state which site it works on; that's
  nominative use and is fine. What isn't fine is the brand in the *name*.
- **Get written permission** from StealthWriter and attach it to the review
  notes. Slower, and they may simply not reply.

If you rename, these change together: `manifest.json` (name, gecko id),
`popup.html` header, `README.md`, and the storage key if you want a clean
break (`sw_sessions_v3` → keep it, and write a one-time migration, rather
than orphaning existing users' data). Note the key intentionally still says
`v3` after the renumbering to 1.0 — it tracks the record format, not the
release, and changing it would strand saved sessions.

## 2. Clone question — RESOLVED

Tested on the live site: the clone was not interactive, and could never have
been. React resolves a click target to a component via expando properties on
the DOM node, which `cloneNode` does not copy. The swap is gone; snapshots render in the
extension's own panel.

**This constrains the listing copy.** Describe the feature honestly:
"restores your input text and a read-only copy of your last result" — not
"restores your editable session". Overpromising here is what generates the
1-star reviews that sink a single-site add-on.

## 3. Data disclosure and privacy policy — BLOCKING

The extension stores the user's full document text. Even though it never
leaves the machine, AMO requires you to disclose data handling, and Firefox
shows a data-consent screen. Prepare a short privacy policy stating:

- what is stored (input text, output text, timestamps, optional name)
- where (`storage.local`, on the user's own device)
- that nothing is transmitted anywhere, no analytics, no remote endpoints
- how to delete it (Delete per session; removing the add-on clears everything)
- that Export produces a plain-text JSON file the user is responsible for

## 4. Permission justification for reviewers

Have a one-liner ready for each, in the review notes:

| Permission | Why |
|---|---|
| `storage` | Persist sessions across browser restarts — the entire purpose |
| `tabs` | Find an open StealthWriter tab to restore into, and focus it |
| `*://*.stealthwriter.ai/*` | Read the editor contents and inject the save bar |

Reviewers flag `tabs` often. Say explicitly that it's used for
`tabs.query({url})` scoped to one host and never to read arbitrary tab content.

## 5. Code readiness

- [x] Cross-browser background key (`scripts` + `service_worker`)
- [x] No `eval`, no remote code, no injected external scripts — required
- [x] Plain, unminified source (no build step, so no source upload needed)
- [x] Session records hold plain text only, no page markup — smaller saves
      and less to disclose under item 3
- [ ] Remove `console.warn` noise or keep it behind a debug flag
- [ ] Decide on `unlimitedStorage` — currently *not* requested, and saves fail
      gracefully instead. Fewer permissions is better for review; the graceful
      failure is the right trade.

## 6. Listing assets

- [ ] Summary under 250 characters
- [ ] Long description — state plainly that this is unofficial and not
      affiliated with the site it works on
- [ ] At least one screenshot (the popup with 2–3 sessions, and the in-page
      save bar)
- [ ] Icon already present at 16/48/128
- [ ] Category: likely "Other" or "Productivity"
- [ ] Support email or issue tracker URL

## 7. Before you submit

- [ ] Test on a clean Firefox profile, not your dev profile
- [ ] Test the full loop: save → close browser → reopen → restore
- [ ] Test export → wipe storage → import → restore
- [ ] Restore a session exported before 1.0 — exercises the legacy markup path
- [ ] `web-ext lint` clean (`npx web-ext lint`)
- [x] Version set to 1.0 for the first public release

## 8. After approval

Signed builds install permanently, which finally solves the temporary-add-on
problem — you stop re-loading it from `about:debugging` every morning. If you
want that *before* review completes, submit as **unlisted** in parallel: you
get a signed `.xpi` for yourself in about a minute, with no public review.
