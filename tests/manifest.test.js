/*
 * The manifest, and the files it points at.
 *
 * There is no build step here: what is in the folder is what gets loaded, so
 * a filename that does not exist, or a script the popup forgets to include,
 * is a broken extension with no compiler to say so. These are the checks a
 * build would otherwise have done.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { ROOT, workingSource } = require("./harness.js");

const manifest = JSON.parse(workingSource("manifest.json"));

function exists(relative) {
  return fs.existsSync(path.join(ROOT, relative));
}

test("every file the manifest names is present", () => {
  const named = [
    manifest.action.default_popup,
    manifest.background.service_worker,
    ...manifest.background.scripts,
    ...manifest.content_scripts.flatMap(entry => [...(entry.js || []), ...(entry.css || [])]),
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ];
  for (const file of named) assert.ok(exists(file), file + " is named in the manifest but not on disk");
});

test("the popup loads popup.js and nothing that is missing", () => {
  const html = workingSource("popup.html");
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(scripts, ["popup.js"]);
  for (const src of scripts) assert.ok(exists(src));
});

test("the host permission and the content script match", () => {
  assert.deepEqual(manifest.host_permissions, ["*://*.stealthwriter.ai/*"]);
  assert.deepEqual(manifest.content_scripts[0].matches, manifest.host_permissions);
});

test("only the permissions the code uses are asked for", () => {
  assert.deepEqual(manifest.permissions.sort(), ["storage", "tabs"]);

  const code = ["content.js", "popup.js", "background.js"].map(workingSource).join("\n");
  for (const permission of manifest.permissions) {
    assert.ok(code.includes("chrome." + permission + "."),
      permission + " is requested but never used");
  }
  /* The APIs that would need a permission this does not have. */
  for (const api of ["chrome.scripting", "chrome.cookies", "chrome.webRequest", "chrome.downloads"]) {
    assert.ok(!code.includes(api), api + " needs a permission that is not declared");
  }
});

test("nothing reaches the network", () => {
  const code = ["content.js", "popup.js", "background.js"].map(workingSource).join("\n");
  for (const sink of ["fetch(", "XMLHttpRequest", "new WebSocket", "sendBeacon", "importScripts"]) {
    assert.ok(!code.includes(sink), sink + " would be a network call from an extension that makes none");
  }
});

test("both background forms are declared, for both engines", () => {
  /* Chrome runs the service worker; Firefox 121 runs the scripts array. Both
   * point at the same file, which is what makes one source work on both. */
  assert.equal(manifest.background.service_worker, "background.js");
  assert.deepEqual(manifest.background.scripts, ["background.js"]);
});

test("the storage keys agree across the three scripts", () => {
  for (const file of ["content.js", "popup.js"]) {
    const source = workingSource(file);
    assert.match(source, /const STORAGE_KEY\s+= 'sw_sessions_v3';/, file);
    assert.match(source, /const PENDING_KEY\s+= 'sw_pending_restore';/, file);
  }
});

test("the developer helpers stay out of the shipped extension", () => {
  const shipped = new Set([
    manifest.action.default_popup,
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap(entry => [...(entry.js || []), ...(entry.css || [])]),
  ]);
  for (const helper of ["docs/check-selectors.js"]) {
    assert.ok(exists(helper), helper + " is referenced by the README");
    assert.ok(!shipped.has(helper), helper + " must not be loaded by the extension");
  }
  assert.ok(!workingSource("popup.html").includes("docs/"));
});

test("the tests are not part of the extension either", () => {
  const html = workingSource("popup.html");
  assert.ok(!html.includes("tests/"));
  const code = ["content.js", "popup.js", "background.js"].map(workingSource).join("\n");
  assert.ok(!code.includes("require("), "the shipped scripts have no module loader");
});
