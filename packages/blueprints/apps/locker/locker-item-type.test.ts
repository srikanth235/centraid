/*
 * Tripwire for `types.ts`'s `LockerItemType` (#712).
 *
 * `types.ts` is deliberately type-only (no runtime members — see its own
 * header), so the union cannot be exported as a value and compared directly
 * against the schema. Instead this scans both files' SOURCE TEXT for their
 * literal lists, the same technique `placement-registry.test.ts` uses for
 * vault's `SHAREABLE_ITEM_TYPES`, and fails loudly the moment the six
 * spellings drift instead of failing silently at a browser runtime that
 * never typechecks against the real CHECK constraint.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const TYPES_PATH = path.resolve(import.meta.dirname, "types.ts");
const SCHEMA_PATH = path.resolve(
  import.meta.dirname,
  "../../../vault/src/schema/domains-locker.ts"
);

/** Pull the six quoted members out of `export type LockerItemType = ...`. */
function declaredLockerItemTypes(): string[] {
  const source = readFileSync(TYPES_PATH, "utf8");
  const match = source.match(
    /export type LockerItemType =\s*(?<literal>(?:\s*\|\s*"[^"]+")+)/u
  );
  if (!match) {
    throw new Error(
      "LockerItemType union not found in types.ts — this tripwire's regex " +
        "needs updating to match the new shape."
    );
  }
  return [...match[1]!.matchAll(/"(?<name>[^"]+)"/gu)].map((m) => m[1]!);
}

/** Pull the CHECK constraint's members out of `locker_item.type`. */
function schemaLockerItemTypes(): string[] {
  const source = readFileSync(SCHEMA_PATH, "utf8");
  const match = source.match(
    /type\s+TEXT NOT NULL CHECK \(type IN \((?<literal>[^)]+)\)\)/u
  );
  if (!match) {
    throw new Error(
      "locker_item.type's CHECK constraint not found in " +
        "packages/vault/src/schema/domains-locker.ts — this tripwire's " +
        "regex needs updating to match the new shape."
    );
  }
  return [...match[1]!.matchAll(/'(?<name>[^']+)'/gu)].map((m) => m[1]!);
}

describe("LockerItemType mirrors the schema's CHECK constraint (issue #712 C4)", () => {
  it("the schema's own list still names six types — else this tripwire is stale", () => {
    expect(schemaLockerItemTypes()).toHaveLength(6);
  });

  it("types.ts's union matches domains-locker.ts's CHECK constraint exactly", () => {
    expect(declaredLockerItemTypes().toSorted()).toStrictEqual(
      schemaLockerItemTypes().toSorted()
    );
  });
});
