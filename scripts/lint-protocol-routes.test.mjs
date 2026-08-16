// Fail-path proof for `bun run lint:protocol-routes` (issue #656 Layer 1F).
//
// Drives the linter against a synthetic tree via its injectable root. Uses
// `mkdtempSync` rather than `@centraid/test-kit`'s `tempDir()`: that module
// registers a vitest `afterAll` at import time and throws
// ("Vitest failed to find the current suite") under `node --test`, which is the
// runner this lane uses. Same pattern as scripts/gateway-package/*.test.mjs.
import assert from "node:assert/strict";
// oxlint-disable-next-line no-restricted-imports -- (#781) node --test lane: the kit's tempDir() registers a vitest afterAll at import time and throws here; removal is registered at creation via t.after below.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { findRouteLiterals } from "./lint-protocol-routes.mjs";

const SCOPE = "apps/extension/src";

/** Build a throwaway repo root containing `files` (relative path → contents). */
function fixture(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), "centraid-protocol-routes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return root;
}

test("a hard-coded route literal is reported", (t) => {
  const root = fixture(t, {
    [`${SCOPE}/client.ts`]: 'fetch("/centraid/_gateway/info");\n',
  });
  assert.deepEqual(findRouteLiterals(root, [SCOPE]), [
    `${SCOPE}/client.ts: hard-coded /centraid/_gateway/info (import ROUTES from @centraid/core/protocol)`,
  ]);
});

test("importing ROUTES instead of the literal passes", (t) => {
  const root = fixture(t, {
    [`${SCOPE}/client.ts`]:
      'import { ROUTES } from "@centraid/core/protocol";\nfetch(ROUTES.gatewayInfo);\n',
  });
  assert.deepEqual(findRouteLiterals(root, [SCOPE]), []);
});

test("a route literal carrying a query string is reported", (t) => {
  const root = fixture(t, {
    [`${SCOPE}/pair.ts`]: "fetch(`/centraid/_gateway/pair?code=1`);\n",
  });
  assert.deepEqual(findRouteLiterals(root, [SCOPE]), [
    `${SCOPE}/pair.ts: hard-coded /centraid/_gateway/pair (import ROUTES from @centraid/core/protocol)`,
  ]);
});

test("a route literal in a nested directory is reported", (t) => {
  const root = fixture(t, {
    [`${SCOPE}/deep/nested/blobs.ts`]: "const p = '/centraid/_vault/blobs';\n",
  });
  assert.deepEqual(findRouteLiterals(root, [SCOPE]), [
    `${SCOPE}/deep/nested/blobs.ts: hard-coded /centraid/_vault/blobs (import ROUTES from @centraid/core/protocol)`,
  ]);
});

test("every hard-coded route in one file is reported", (t) => {
  const root = fixture(t, {
    [`${SCOPE}/all.ts`]: 'a("/centraid/_apps"); b("/centraid/_web/session");\n',
  });
  assert.equal(findRouteLiterals(root, [SCOPE]).length, 2);
});

test("test files are exempt from the route-literal check", (t) => {
  const root = fixture(t, {
    [`${SCOPE}/client.test.ts`]: 'fetch("/centraid/_gateway/info");\n',
    [`${SCOPE}/view.test.tsx`]: 'fetch("/centraid/_gateway/info");\n',
  });
  assert.deepEqual(findRouteLiterals(root, [SCOPE]), []);
});

test("non-source files are not scanned", (t) => {
  const root = fixture(t, {
    [`${SCOPE}/notes.md`]: 'see "/centraid/_gateway/info"\n',
  });
  assert.deepEqual(findRouteLiterals(root, [SCOPE]), []);
});

test("a path that merely contains a route is not a literal match", (t) => {
  const root = fixture(t, {
    [`${SCOPE}/client.ts`]: 'fetch("/centraid/_gateway/information");\n',
  });
  assert.deepEqual(findRouteLiterals(root, [SCOPE]), []);
});

test("an absent scope directory is skipped rather than throwing", (t) => {
  const root = fixture(t, { "README.md": "empty\n" });
  assert.deepEqual(findRouteLiterals(root, [SCOPE]), []);
});
