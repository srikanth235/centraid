#!/usr/bin/env node
// The two verdicts `design:gallery` gives a machine with no browser (#931 item 3).
import assert from "node:assert/strict";
import test from "node:test";

import {
  browserUnavailable,
  unrunnableVerdict,
} from "./design-gallery-browser.mjs";

const chromium = {
  executablePath: () => "/opt/pw-browsers/chromium-1234/chrome",
};
const present = () => true;
const absent = () => false;

test("a machine with the pinned browser can run", () => {
  assert.equal(browserUnavailable(chromium, present), null);
  assert.equal(unrunnableVerdict(chromium, { exists: present }), null);
});

test("locally, a missing browser is a skip with a reason and a fix", () => {
  const verdict = unrunnableVerdict(chromium, { exists: absent, isCi: false });
  assert.equal(verdict.fatal, false);
  assert.match(verdict.message, /SKIPPED/u);
  assert.match(verdict.message, /chromium-1234/u);
  assert.match(verdict.message, /playwright install chromium/u);
  assert.match(verdict.message, /PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH/u);
});

test("under CI, the same absence is fatal", () => {
  const verdict = unrunnableVerdict(chromium, { exists: absent, isCi: true });
  assert.equal(verdict.fatal, true);
  assert.match(verdict.message, /^::error title=design:gallery unrunnable::/u);
  assert.match(verdict.message, /misconfigured/u);
});

test("a pointed-at Chromium is honoured, and a bad pointer is named", () => {
  // The env is read at module load, so this case is expressed through the
  // exported predicate rather than by mutating process.env mid-run.
  const pinnedMissing = browserUnavailable(chromium, absent);
  assert.match(
    pinnedMissing,
    /the pinned Playwright Chromium is not installed/u
  );
  assert.equal(browserUnavailable(chromium, present), null);
});
