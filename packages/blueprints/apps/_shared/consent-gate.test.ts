/*
 * Tripwire for `consent-gate.ts`'s `ENRICH_DOMAINS` (issue #712 C4).
 *
 * Blueprints cannot import `@centraid/automation` (it depends back on
 * `@centraid/blueprints` — see its package.json — and blueprint apps are
 * served as browser ES modules besides), so `consent-gate.ts` restates the
 * domain union rather than importing it. This test keeps the restatement
 * honest with a source scan of `packages/automation/src/fire/enrich-gate.ts`,
 * the same technique `placement-registry.test.ts` uses for vault's
 * `SHAREABLE_ITEM_TYPES`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ENRICH_DOMAINS } from "./consent-gate.ts";

const ENRICH_GATE_PATH = path.resolve(
  import.meta.dirname,
  "../../../automation/src/fire/enrich-gate.ts"
);

/** Pull the quoted string literals out of automation's `ENRICH_DOMAINS`
 *  array — a source scan, not an import, per the header above. */
function automationEnrichDomains(): string[] {
  const source = readFileSync(ENRICH_GATE_PATH, "utf8");
  const match = source.match(
    /const ENRICH_DOMAINS[^=]*=\s*\[(?<literal>[^\]]*)\]/u
  );
  if (!match) {
    throw new Error(
      "ENRICH_DOMAINS not found in packages/automation/src/fire/enrich-gate.ts " +
        "— this tripwire's regex needs updating to match the new shape."
    );
  }
  return [...match[1]!.matchAll(/"(?<name>[^"]+)"/gu)].map((m) => m[1]!);
}

describe("EnrichDomain mirrors automation's ENRICH_DOMAINS (issue #712 C4)", () => {
  it("blueprints' restated union matches automation's source array exactly", () => {
    expect([...ENRICH_DOMAINS].toSorted()).toStrictEqual(
      automationEnrichDomains().toSorted()
    );
  });
});
