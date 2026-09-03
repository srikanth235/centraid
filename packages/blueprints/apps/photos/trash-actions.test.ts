// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { emptyTrashOrder, emptyTrashSummary } from "./trash-actions.ts";
import type { Asset } from "./types.ts";

function asset(id: string, source?: string): Asset {
  return source === undefined
    ? { asset_id: id }
    : { asset_id: id, source_asset_id: source };
}

const ids = (list: readonly Asset[]): string[] =>
  list.map((item) => item.asset_id);

describe("purge order", () => {
  it("keeps the shelf's own order when nothing was derived from anything", () => {
    const trash = [asset("c"), asset("b"), asset("a")];
    expect(ids(emptyTrashOrder(trash))).toStrictEqual(["c", "b", "a"]);
  });

  it("puts an edited copy before the source it names", () => {
    const trash = [asset("original"), asset("crop", "original")];
    expect(ids(emptyTrashOrder(trash))).toStrictEqual(["crop", "original"]);
  });

  it("walks a chain of edits, deepest copy first", () => {
    const trash = [
      asset("original"),
      asset("crop", "original"),
      asset("crop-of-crop", "crop"),
    ];
    expect(ids(emptyTrashOrder(trash))).toStrictEqual([
      "crop-of-crop",
      "crop",
      "original",
    ]);
  });

  it("ignores a source that is not itself in the trash", () => {
    const trash = [asset("crop", "still-in-the-library")];
    expect(ids(emptyTrashOrder(trash))).toStrictEqual(["crop"]);
  });

  it("returns every asset exactly once, even on a lineage cycle", () => {
    const trash = [asset("a", "b"), asset("b", "a")];
    expect(ids(emptyTrashOrder(trash)).sort()).toStrictEqual(["a", "b"]);
  });
});

describe("the summary sentence", () => {
  it("says forever, and never offers an undo", () => {
    const text = emptyTrashSummary({ purged: 24, kept: 0, queued: 0 });
    expect(text).toBe("Deleted 24 photographs forever");
    expect(text.toLowerCase()).not.toContain("undo");
  });

  it("names what was kept back", () => {
    expect(emptyTrashSummary({ purged: 22, kept: 2, queued: 0 })).toBe(
      "Deleted 22 photographs forever · 2 kept"
    );
  });

  it("has something to say when nothing happened", () => {
    expect(emptyTrashSummary({ purged: 0, kept: 0, queued: 0 })).toBe(
      "Nothing to delete"
    );
  });
});
