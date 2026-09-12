/* oxlint-disable vitest/no-import-node-test -- (#1018) node --test lane, not a vitest suite */
/* oxlint-disable vitest/prefer-importing-vitest-globals -- (#1018) node --test lane, not a vitest suite */
// THE DECLARED-WRITES VOCABULARY — that the vault's entity registry is read
// WHOLE, across the files it is composed from.
//
// Its own suite rather than a section of `lint-engine-conformance.test.mjs`:
// that file is the engine-conformance gate's cases, this one is the scanner
// underneath the `W declared writes` engine, and the two grew apart when the
// registry outgrew a single file (#996 wave 7).

import assert from "node:assert/strict";
// oxlint-disable-next-line no-restricted-imports -- (#996) node --test lane: the kit's tempDir() registers a vitest afterAll at import time and throws here; the fixture trees are removed in the `after` hook below. Same pattern as scripts/check-ledgers.test.mjs.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { vaultEntityNames } from "./lint-engine-conformance.ts";

test("the vault entity registry is read whole, not partially", () => {
  // The declared-writes lane compares every `writes:` entry against this set;
  // a scan that drifted to a handful of names would pass anything.
  const names = vaultEntityNames();
  assert.ok(names.size >= 90, `only ${names.size} entities`);
  for (const entity of [
    "core.content_item",
    "schedule.task",
    "locker.item_passkey",
    "share.authority",
    "share.subscription",
    "share.subscription_lineage",
  ])
    assert.ok(names.has(entity), entity);
  // Retired this wave — a stale name would pass a declaration that cannot happen.
  for (const gone of [
    "tally.expense_receipt",
    "social.contact_card",
    "share.commons_op",
  ])
    assert.ok(!names.has(gone), gone);
});

// THE REGISTRY IS COMPOSED ACROSS FILES, and the scan has to follow it.
// `entity-catalog.ts` outgrew the file-size rule in #996 wave 7 and now spreads
// `...VAULT_DOMAIN_ENTITIES` out of a second file. A scan of one file read 47
// names where the registry holds 96 — under the anti-vacuity floor, so the lane
// went red; had the floor been lower it would have passed every declaration
// made against a domain table instead.

const catalogRoots: string[] = [];
after(() => {
  for (const root of catalogRoots)
    rmSync(root, { force: true, recursive: true });
});

function catalogFixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "entity-catalog-"));
  catalogRoots.push(root);
  const dir = path.join(root, "packages", "vault", "src", "schema");
  mkdirSync(dir, { recursive: true });
  for (const [name, code] of Object.entries(files))
    writeFileSync(path.join(dir, name), code, "utf8");
  return root;
}

const DOMAINS = `
export const VAULT_DOMAIN_ENTITIES = {
  schedule: {
    task: { lifecycle: "mutable", label: "Tasks", blurb: "A { brace } in a label." },
    calendar: { lifecycle: "append-only", label: "Calendars" },
  },
};
`;

test("the entity scan follows a spread into the file that declares it", () => {
  const root = catalogFixture({
    "entity-catalog-domains.ts": DOMAINS,
    "entity-catalog.ts": `
import type { EntityRegistry } from "./entity-declaration.js";
import { VAULT_DOMAIN_ENTITIES } from "./entity-catalog-domains.js";

export const VAULT_ENTITIES: EntityRegistry = {
  core: { content_item: { lifecycle: "mutable", label: "Files" } },
  ...VAULT_DOMAIN_ENTITIES,
};
export const JOURNAL_ENTITIES = {
  audit: { receipt: { lifecycle: "append-only", label: "Receipts" } },
};
`,
  });
  assert.deepEqual([...vaultEntityNames(root)].toSorted(), [
    "audit.receipt",
    "core.content_item",
    "schedule.calendar",
    "schedule.task",
  ]);
});

test("a spread it cannot resolve FAILS rather than silently under-counting", () => {
  const root = catalogFixture({
    "entity-catalog.ts": `
export const VAULT_ENTITIES = {
  core: { content_item: { lifecycle: "mutable", label: "Files" } },
  ...SOME_OTHER_REGISTRY,
};
`,
  });
  // The names it CAN see would be a plausible-looking vocabulary, which is
  // exactly why a skip is not an option here.
  assert.throws(
    () => vaultEntityNames(root),
    /spreads SOME_OTHER_REGISTRY .*cannot resolve/su
  );
});

test("a spread of a file that is not there fails the same way", () => {
  const root = catalogFixture({
    "entity-catalog.ts": `
import { VAULT_DOMAIN_ENTITIES } from "./entity-catalog-domains.js";
export const VAULT_ENTITIES = {
  core: { content_item: { lifecycle: "mutable", label: "Files" } },
  ...VAULT_DOMAIN_ENTITIES,
};
`,
  });
  assert.throws(() => vaultEntityNames(root), /cannot be read/u);
});
