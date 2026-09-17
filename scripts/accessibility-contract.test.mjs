import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

async function source(relative) {
  return readFile(path.join(root, relative), "utf8");
}

test("the element layer's status line (toast's replacement) keeps its accessibility contract", async () => {
  // #707 Phase 3: the floating `.kit-toast` stack is retired in favour of
  // ONE persistent status line, updated in place — this pins the same
  // role/aria-live contract the retired toast carried, on its replacement, so
  // the CONTRACT strength never lapses across the rename. #799 moved the line
  // off a `<kit-status-line>` custom element onto plain DOM built by
  // feedback.ts; the live region is now the persistent host itself rather
  // than a child the element re-created on every render.
  const statusLine = await source("packages/design/src/elements/feedback.ts");
  assert.match(statusLine, /setAttribute\("role", "status"\)/u);
  assert.match(statusLine, /setAttribute\("aria-live", "polite"\)/u);
  assert.doesNotMatch(
    await source("packages/design/src/elements/index.ts"),
    /kit-toast/u,
    "the element barrel still names the retired kit-toast component"
  );
});
