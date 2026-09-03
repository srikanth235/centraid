import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const TYPES_PATH = path.resolve(import.meta.dirname, "types.ts");
const SCHEMA_PATH = path.resolve(
  import.meta.dirname,
  "../../../vault/src/schema/domains-locker.ts"
);

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
  it("the schema's own list still names fifteen types — else this tripwire is stale", () => {
    expect(schemaLockerItemTypes()).toHaveLength(15);
  });

  it("types.ts's union matches domains-locker.ts's CHECK constraint exactly", () => {
    expect(declaredLockerItemTypes().toSorted()).toStrictEqual(
      schemaLockerItemTypes().toSorted()
    );
  });
});
