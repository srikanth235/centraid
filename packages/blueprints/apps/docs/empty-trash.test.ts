// EMPTYING THE TRASH IS A DECLARED, CONFIRMED, ID-LESS WRITE (#1015, D1).
//
// Docs used to say "Delete forever and Empty trash — not available yet" while
// Photos shipped both, and the two seats disagreed about whether a member can
// finish a deletion. This pins the docs half of the answer at the manifest:
// the app holds an `act` grant on the vault command, the action asks for
// confirmation, and it takes no id — so a UI cannot quietly narrow it to a
// single row, and a member cannot fire it without being asked.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { docsPendingProjection } from "./pending-projection.ts";

interface Manifest {
  vault: { scopes: Array<{ schema: string; table?: string; verbs: string }> };
  actions: Array<{
    name: string;
    confirmation: string;
    input: { properties: Record<string, unknown>; required?: string[] };
    writes: string[];
  }>;
}

const manifest = JSON.parse(
  readFileSync(new URL("app.json", import.meta.url), "utf8")
) as Manifest;

const emptyTrash = manifest.actions.find(
  (action) => action.name === "empty-trash"
);

describe("the docs empty-trash action", () => {
  it("is declared, confirmed, and names no document", () => {
    expect(emptyTrash).toBeDefined();
    expect(emptyTrash!.confirmation).toBe("required");
    expect(Object.keys(emptyTrash!.input.properties)).toStrictEqual([]);
    expect(emptyTrash!.input.required).toBeUndefined();
    expect(emptyTrash!.writes).toStrictEqual(["core.document"]);
  });

  it("carries the act grant on the vault command it runs", () => {
    expect(manifest.vault.scopes).toContainEqual({
      schema: "core",
      table: "empty_document_trash",
      verbs: "act",
    });
  });

  it("is excluded from the pending overlay, because it stamps no row", () => {
    const projection = docsPendingProjection.actions["empty-trash"];
    expect(projection).toBeTypeOf("object");
    expect((projection as { excluded: boolean }).excluded).toBe(true);
  });
});
