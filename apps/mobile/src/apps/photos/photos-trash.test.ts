// Empty trash: the two pure facts (apps/photos/photos-trash.ts). Order is the
// one a member would feel — the vault refuses to destroy a photograph an
// edited copy still names as its source, so a wrong order silently leaves
// originals behind — and the summary must never say Undo.
import { describe, expect, it } from "vitest";

import type { VaultAsset } from "./photos-selection-writes";
import {
  EMPTY_TRASH_CONFIRM,
  emptyTrashOrder,
  emptyTrashSummary,
} from "./photos-trash";

function target(assetId: string): VaultAsset {
  return {
    id: assetId,
    assetId,
    uri: "",
    previewUri: "",
    originalUri: "",
    capturedAt: "2026-08-01T00:00:00Z",
    kind: "photo",
    favorite: false,
    archived: false,
    deleted: true,
    backupState: "backed-up",
    source: "replica",
  };
}

const lineage = (map: Record<string, string>) => (assetId: string) =>
  map[assetId];

const ids = (list: readonly VaultAsset[]): string[] =>
  list.map((item) => item.assetId);

describe("purge order", () => {
  it("keeps the shelf order when nothing was derived from anything", () => {
    const targets = [target("c"), target("b"), target("a")];
    expect(ids(emptyTrashOrder(targets, lineage({})))).toStrictEqual([
      "c",
      "b",
      "a",
    ]);
  });

  it("puts an edited copy before the source it names", () => {
    const targets = [target("original"), target("crop")];
    expect(
      ids(emptyTrashOrder(targets, lineage({ crop: "original" })))
    ).toStrictEqual(["crop", "original"]);
  });

  it("walks a chain of edits, deepest copy first", () => {
    const targets = [target("original"), target("crop"), target("crop2")];
    expect(
      ids(
        emptyTrashOrder(targets, lineage({ crop: "original", crop2: "crop" }))
      )
    ).toStrictEqual(["crop2", "crop", "original"]);
  });

  it("ignores a source that is not itself in the trash", () => {
    const targets = [target("crop")];
    expect(
      ids(emptyTrashOrder(targets, lineage({ crop: "still-live" })))
    ).toStrictEqual(["crop"]);
  });

  it("returns every target exactly once on a lineage cycle", () => {
    const targets = [target("a"), target("b")];
    expect(
      ids(emptyTrashOrder(targets, lineage({ a: "b", b: "a" }))).sort()
    ).toStrictEqual(["a", "b"]);
  });
});

describe("the summary sentence", () => {
  it("says forever, and never offers an undo", () => {
    const text = emptyTrashSummary({ purged: 24, kept: 0 });
    expect(text).toBe("Deleted 24 photographs forever");
    expect(text.toLowerCase()).not.toContain("undo");
  });

  it("names what was kept back", () => {
    expect(emptyTrashSummary({ purged: 22, kept: 2 })).toBe(
      "Deleted 22 photographs forever · 2 kept"
    );
  });

  it("has something to say when nothing happened", () => {
    expect(emptyTrashSummary({ purged: 0, kept: 0 })).toBe("Nothing to delete");
  });
});

describe("the confirmation copy", () => {
  it("names the count and refuses to imply an undo", () => {
    expect(EMPTY_TRASH_CONFIRM.title(24)).toBe(
      "Delete 24 photographs forever?"
    );
    expect(EMPTY_TRASH_CONFIRM.body(24)).toContain("cannot be undone");
    expect(EMPTY_TRASH_CONFIRM.body(24)).toContain("Restore will not bring");
    expect(EMPTY_TRASH_CONFIRM.confirm(24)).toBe("Delete 24 forever");
  });

  it("reads correctly for a single photograph", () => {
    expect(EMPTY_TRASH_CONFIRM.title(1)).toBe("Delete 1 photograph forever?");
    expect(EMPTY_TRASH_CONFIRM.body(1)).toContain("It leaves your library now");
  });
});
