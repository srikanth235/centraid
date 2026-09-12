/*
 * Tripwire for `types.ts`'s `LockerItemType` (#712).
 *
 * `types.ts` is deliberately type-only (no runtime members — see its own
 * header), so the union cannot be exported as a value and compared directly
 * against the schema. Instead this scans both files' SOURCE TEXT for their
 * literal lists, the same technique `placement-registry.test.ts` uses for
 * vault's `SHAREABLE_ITEM_TYPES`, and fails loudly the moment the
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
const MANIFEST_PATH = path.resolve(import.meta.dirname, "app.json");

/** Pull the quoted members out of `export type LockerItemType = ...`. */
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

/**
 * Pull `add-item`'s declared `type` enum out of the manifest.
 *
 * THE THIRD LEG OF THE TRIPWIRE (#1020, R-1020-35). The two legs above pin
 * `types.ts` to the CHECK constraint, and both were right while the manifest —
 * the schema the DISPATCHER validates an action body against
 * (`packages/server/src/engine/handlers/dispatcher.ts:439`, `:580`) — still
 * listed only the six column-backed types. So the type picker offered all
 * fifteen (`view-copy.ts`'s `ALL_TYPES`), `draft.ts` built a `TEMPLATE_ONLY`
 * payload for the nine, `locker.add_item` accepted all fifteen
 * (`packages/vault/src/commands/locker-types.ts`'s `LOCKER_ITEM_TYPES`), and
 * a member who picked "Passport" got `INVALID_INPUT` from the dispatcher
 * before any of that ran. Two lists agreeing is not the invariant; three are.
 */
function manifestAddItemTypes(): string[] {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    actions: { name: string; input: { properties?: Record<string, unknown> } }[];
  };
  const addItem = manifest.actions.find((action) => action.name === "add-item");
  if (!addItem) throw new Error("app.json declares no add-item action");
  const declared = (addItem.input.properties as
    | { type?: { enum?: string[] } }
    | undefined)?.type?.enum;
  if (!declared) {
    throw new Error(
      "add-item's input schema declares no type enum — this tripwire's third " +
        "leg needs updating to match the new shape."
    );
  }
  return declared;
}

describe("LockerItemType mirrors the schema's CHECK constraint (issue #712 C4)", () => {
  it("the schema's own list still names fifteen types — else this tripwire is stale", () => {
    // Six column-backed types plus the nine template-backed ones #872 added.
    expect(schemaLockerItemTypes()).toHaveLength(15);
  });

  it("types.ts's union matches domains-locker.ts's CHECK constraint exactly", () => {
    expect(declaredLockerItemTypes().toSorted()).toStrictEqual(
      schemaLockerItemTypes().toSorted()
    );
  });

  it("app.json's add-item enum matches the CHECK constraint exactly", () => {
    expect(manifestAddItemTypes().toSorted()).toStrictEqual(
      schemaLockerItemTypes().toSorted()
    );
  });
});
