// Fail-path proof for `bun run lint:law-registry` (issue #656 Layer 4).
//
// A registry lint that cannot go red reads as protection while providing none,
// so every rule below is stated as "this violation is rejected" rather than
// "the real repo passes".
//
// Uses `mkdtempSync` rather than `@centraid/test-kit`'s `tempDir()`: that
// module registers a vitest `afterAll` at import time and throws under
// `node --test`, which is the runner this lane uses. Same pattern as
// scripts/lint-protocol-routes.test.mjs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { checkLawRegistry, collectLawTags } from "./lint-law-registry.mjs";

const OWNER = "packages/backup/src/engine.test.ts";
const OTHER = "packages/gateway/src/backup/backup-service.contract.test.ts";

function fixture(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), "centraid-law-registry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return root;
}

const laws = {
  "backup-no-change": {
    statement: "A backup run over an unchanged vault registers no snapshot.",
    owner: OWNER,
    flow: "backup-round-trip",
  },
};

function run(root, overrides = {}) {
  return checkLawRegistry({
    laws,
    tags: collectLawTags(root),
    flowIds: ["backup-round-trip"],
    files: [OWNER, OTHER],
    ...overrides,
  }).violations;
}

function noticesFor(root, overrides = {}) {
  return checkLawRegistry({
    laws,
    tags: collectLawTags(root),
    flowIds: ["backup-round-trip"],
    files: [OWNER, OTHER],
    ...overrides,
  }).notices;
}

test("the owner alone passes", (t) => {
  const root = fixture(t, {
    [OWNER]: 'test("[law:backup-no-change] no-change run registers nothing")\n',
  });
  assert.deepEqual(run(root), []);
});

test("several tests in the owning file are one home, not a duplicate", (t) => {
  const root = fixture(t, {
    [OWNER]: [
      'test("[law:backup-no-change] returns null")',
      'test("[law:backup-no-change] uploads nothing new")',
    ].join("\n"),
  });
  assert.deepEqual(run(root), []);
});

test("the same law in a second file is rejected", (t) => {
  const root = fixture(t, {
    [OWNER]: 'test("[law:backup-no-change] registers nothing")\n',
    [OTHER]: 'test("[law:backup-no-change] registers nothing")\n',
  });
  const violations = run(root);
  assert.equal(violations.length, 2);
  assert.match(violations[0], /claimed by 2 files/u);
  assert.match(violations[0], new RegExp(`${OTHER}:1`, "u"));
  assert.match(violations[1], /owned by packages\/backup/u);
});

test("a duplicate is caught even before the registry key exists", (t) => {
  const root = fixture(t, {
    [OWNER]: 'test("[law:backup-no-change] a")\n',
    [OTHER]: 'test("[law:backup-no-change] a")\n',
  });
  const violations = run(root, { laws: undefined });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /one law, one home/u);
  // The missing key is a notice, not a violation: the owner/orphan checks are
  // reported as inactive rather than silently passing, and the check that does
  // not need the registry still gates.
  const notices = noticesFor(root, { laws: undefined });
  assert.equal(notices.length, 1);
  assert.match(notices[0], /owner and orphan checking is NOT/u);
});

test("a tag used nowhere in the registry is rejected", (t) => {
  const root = fixture(t, {
    [OWNER]: 'test("[law:backup-invented] something")\n',
  });
  const violations = run(root);
  assert.ok(
    violations.some((v) => /is not in tests\/matrix\.json#laws/u.test(v))
  );
});

test("a registered law with no tagged test is rejected", (t) => {
  const root = fixture(t, { [OWNER]: 'test("untagged")\n' });
  const violations = run(root);
  assert.deepEqual(violations, [
    `law "backup-no-change": registered to ${OWNER}, but no test title there carries [law:backup-no-change] — the registry is describing a test that does not exist.`,
  ]);
});

test("a registry owner that is not a real test file is rejected", (t) => {
  const root = fixture(t, {
    [OWNER]: 'test("[law:backup-no-change] a")\n',
  });
  const violations = run(root, {
    laws: {
      "backup-no-change": {
        ...laws["backup-no-change"],
        owner: "packages/backup/src/gone.test.ts",
      },
    },
  });
  assert.ok(violations.some((v) => /does not exist in the test tree/u.test(v)));
});

test("a registry entry with no statement is rejected", (t) => {
  const root = fixture(t, {
    [OWNER]: 'test("[law:backup-no-change] a")\n',
  });
  const violations = run(root, {
    laws: { "backup-no-change": { owner: OWNER } },
  });
  assert.ok(violations.some((v) => /has no "statement"/u.test(v)));
});

test("a flow id the matrix does not define is rejected", (t) => {
  const root = fixture(t, {
    [OWNER]: 'test("[law:backup-no-change] a")\n',
  });
  const violations = run(root, {
    laws: {
      "backup-no-change": { ...laws["backup-no-change"], flow: "no-such-flow" },
    },
  });
  assert.ok(violations.some((v) => /is not a flow id/u.test(v)));
});

test("a malformed tag is reported rather than silently unowned", (t) => {
  const root = fixture(t, {
    [OWNER]: [
      'test("[law:Backup No Change] a")',
      'test("[law:backup-no-change] b")',
    ].join("\n"),
  });
  const violations = run(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /malformed law tag/u);
});

test("non-test files are not scanned for tags", (t) => {
  const root = fixture(t, {
    [OWNER]: 'test("[law:backup-no-change] a")\n',
    "docs/laws.md": "the [law:backup-no-change] tag is documented here\n",
  });
  assert.deepEqual(run(root), []);
});
