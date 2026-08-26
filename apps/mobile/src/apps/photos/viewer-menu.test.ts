// `viewerOverflowMenuGroups` — the viewer `···` chip's anchored menu, as pure
// data (#712). Asserted without a renderer, the same discipline
// `viewer-model.test.ts` uses for the rest of this module's shapes: the row
// set, the honesty omissions the header comment argues for, and the
// enabled/disabled logic a read-only grant drives.

import { describe, expect, test } from "vitest";

import type {
  MenuActionRow,
  MenuGroup,
} from "../../kit/components/AnchoredMenu";
import {
  NOT_IN_A_VAULT_YET_REASON,
  viewerOverflowMenuGroups,
} from "./viewer-menu";
import { READ_ONLY_VAULT_REASON } from "./viewer-model";

function noop(): void {
  // A stand-in for a callback the test does not care about firing.
}

function baseInput(
  overrides: Partial<Parameters<typeof viewerOverflowMenuGroups>[0]> = {}
) {
  return {
    albums: [],
    archived: false,
    hasVaultAsset: true,
    writable: true,
    onAddToAlbum: noop,
    onAdjustLocation: noop,
    onDelete: noop,
    onDownload: noop,
    onHide: noop,
    onMakeKeyPhoto: noop,
    onSendCopy: noop,
    onSlideshow: noop,
    ...overrides,
  };
}

/** Every group here carries plain action rows, never a submenu — flattening
 *  is safe and keeps the assertions below reading as a flat row set. */
function flatten(groups: readonly MenuGroup[]): MenuActionRow[] {
  return groups.flatMap((group) => group.rows as MenuActionRow[]);
}

describe("viewerOverflowMenuGroups — the row set", () => {
  test("carries exactly the rows this vault can honestly perform", () => {
    const rows = flatten(viewerOverflowMenuGroups(baseInput()));
    expect(rows.map((row) => row.key).sort()).toStrictEqual(
      [
        "add-to-album",
        "adjust-location",
        "delete",
        "download",
        "hide",
        "send-copy",
        "slideshow",
      ].sort()
    );
  });

  // The ORDER is the parity, not just the set. iOS reads Copy · Duplicate ·
  // Hide · Slideshow, then Add to Album, then the Adjust pair, then Delete
  // last; strike the two rows this vault cannot carry and the remainder must
  // still fall in that sequence, with Download / Send a copy — which iOS puts
  // behind its share chip and this vault has to state separately — sitting
  // above the destructive floor.
  test("keeps the row sequence iOS reads, minus what cannot be carried", () => {
    const rows = flatten(viewerOverflowMenuGroups(baseInput()));
    expect(rows.map((row) => row.key)).toStrictEqual([
      "hide",
      "slideshow",
      "add-to-album",
      "adjust-location",
      "download",
      "send-copy",
      "delete",
    ]);
  });

  test("Delete is the last row, and is marked destructive", () => {
    const groups = viewerOverflowMenuGroups(baseInput());
    const rows = flatten(groups);
    const last = rows.at(-1)!;
    expect(last.key).toBe("delete");
    expect(last.destructive).toBe(true);
    // Its own group: nothing may be placed under the destructive floor, and a
    // shared group would let a later row land there by accident.
    expect(groups.at(-1)!.rows.map((row) => row.key)).toStrictEqual(["delete"]);
  });

  test("Delete is refused on a photograph with no vault row to delete", () => {
    const rows = flatten(
      viewerOverflowMenuGroups(baseInput({ hasVaultAsset: false }))
    );
    expect(rows.find((row) => row.key === "delete")?.disabled).toBe(true);
  });

  test("never carries Copy, Duplicate or Adjust Date & Time — no honest write backs them", () => {
    const rows = flatten(viewerOverflowMenuGroups(baseInput()));
    const labels = rows.map((row) => row.label.toLowerCase());
    expect(
      labels.some((label) => label.includes("copy") && !label.includes("send"))
    ).toBe(false);
    expect(labels.some((label) => label.includes("duplicate"))).toBe(false);
    expect(labels.some((label) => label.includes("date"))).toBe(false);
  });
});

describe("viewerOverflowMenuGroups — Archive / Unarchive", () => {
  test("labels the row Archive when the photograph is not archived", () => {
    const rows = flatten(
      viewerOverflowMenuGroups(baseInput({ archived: false }))
    );
    const row = rows.find((candidate) => candidate.key === "hide");
    expect(row?.label).toBe("Archive");
  });

  test("labels the row Unarchive when the photograph is already archived", () => {
    const rows = flatten(
      viewerOverflowMenuGroups(baseInput({ archived: true }))
    );
    const row = rows.find((candidate) => candidate.key === "hide");
    expect(row?.label).toBe("Unarchive");
  });
});

describe("viewerOverflowMenuGroups — the read-only grant", () => {
  test("Add to Album is enabled and plainly labelled when the vault will take the write", () => {
    const rows = flatten(viewerOverflowMenuGroups(baseInput()));
    const row = rows.find((candidate) => candidate.key === "add-to-album");
    expect(row?.disabled).toBeFalsy();
    expect(row?.label).toBe("Add to Album");
  });

  test("Add to Album disables with READ_ONLY_VAULT_REASON reaching the row's own label — not a re-typed stub", () => {
    const rows = flatten(
      viewerOverflowMenuGroups(baseInput({ writable: false }))
    );
    const row = rows.find((candidate) => candidate.key === "add-to-album");
    expect(row?.disabled).toBe(true);
    expect(row?.label).toContain(READ_ONLY_VAULT_REASON);
  });

  test("Add to Album disables with its own reason when the photograph has no vault row yet", () => {
    const rows = flatten(
      viewerOverflowMenuGroups(baseInput({ hasVaultAsset: false }))
    );
    const row = rows.find((candidate) => candidate.key === "add-to-album");
    expect(row?.disabled).toBe(true);
    expect(row?.label).toContain(NOT_IN_A_VAULT_YET_REASON);
  });

  test("a read-only grant never disables Slideshow, Adjust Location, Download or Send a copy — none of them write", () => {
    const rows = flatten(
      viewerOverflowMenuGroups(
        baseInput({ hasVaultAsset: false, writable: false })
      )
    );
    for (const key of [
      "slideshow",
      "adjust-location",
      "download",
      "send-copy",
    ]) {
      const row = rows.find((candidate) => candidate.key === key);
      expect(row?.disabled).toBeFalsy();
    }
  });

  test("Archive is enabled and plainly labelled when the write will land", () => {
    const rows = flatten(viewerOverflowMenuGroups(baseInput()));
    const row = rows.find((candidate) => candidate.key === "hide");
    expect(row?.disabled).toBeFalsy();
    expect(row?.label).toBe("Archive");
  });

  test("Archive disables with READ_ONLY_VAULT_REASON reaching the row's own label on a read-only grant", () => {
    const rows = flatten(
      viewerOverflowMenuGroups(baseInput({ writable: false }))
    );
    const row = rows.find((candidate) => candidate.key === "hide");
    expect(row?.disabled).toBe(true);
    expect(row?.label).toContain(READ_ONLY_VAULT_REASON);
  });

  test("Archive disables with its own reason when the photograph has no row yet", () => {
    const rows = flatten(
      viewerOverflowMenuGroups(baseInput({ hasVaultAsset: false }))
    );
    const row = rows.find((candidate) => candidate.key === "hide");
    expect(row?.disabled).toBe(true);
    expect(row?.label).toContain(NOT_IN_A_VAULT_YET_REASON);
  });
});

describe("viewerOverflowMenuGroups — Make key photo (issue #721 B5)", () => {
  const ONE_ALBUM = [{ id: "album-1", label: "The coast road" }];
  const TWO_ALBUMS = [
    { id: "album-1", label: "The coast road" },
    { id: "album-2", label: "Kitchen" },
  ];

  test("is omitted entirely when the photograph is in no album", () => {
    const rows = flatten(viewerOverflowMenuGroups(baseInput({ albums: [] })));
    expect(rows.find((row) => row.key === "make-key-photo")).toBeUndefined();
  });

  test("renders once the photograph is in at least one album", () => {
    const rows = flatten(
      viewerOverflowMenuGroups(baseInput({ albums: ONE_ALBUM }))
    );
    const row = rows.find((candidate) => candidate.key === "make-key-photo");
    expect(row?.label).toBe("Make key photo");
    expect(row?.disabled).toBeFalsy();
  });

  test("still renders once, not once per album, when the photograph is in several", () => {
    const rows = flatten(
      viewerOverflowMenuGroups(baseInput({ albums: TWO_ALBUMS }))
    );
    expect(rows.filter((row) => row.key === "make-key-photo")).toHaveLength(1);
  });

  test("sits directly after Add to Album, in the same group", () => {
    const groups = viewerOverflowMenuGroups(baseInput({ albums: ONE_ALBUM }));
    const albumGroup = groups.find((group) => group.key === "album")!;
    expect(albumGroup.rows.map((row) => row.key)).toStrictEqual([
      "add-to-album",
      "make-key-photo",
    ]);
  });

  test("disables with READ_ONLY_VAULT_REASON on a read-only grant, same as Add to Album", () => {
    const rows = flatten(
      viewerOverflowMenuGroups(
        baseInput({ albums: ONE_ALBUM, writable: false })
      )
    );
    const row = rows.find((candidate) => candidate.key === "make-key-photo");
    expect(row?.disabled).toBe(true);
    expect(row?.label).toContain(READ_ONLY_VAULT_REASON);
  });

  test("disables with NOT_IN_A_VAULT_YET_REASON when the photograph has no vault row yet", () => {
    const rows = flatten(
      viewerOverflowMenuGroups(
        baseInput({ albums: ONE_ALBUM, hasVaultAsset: false })
      )
    );
    const row = rows.find((candidate) => candidate.key === "make-key-photo");
    expect(row?.disabled).toBe(true);
    expect(row?.label).toContain(NOT_IN_A_VAULT_YET_REASON);
  });

  test("fires onMakeKeyPhoto, not a copy of it", () => {
    const calls: string[] = [];
    const rows = flatten(
      viewerOverflowMenuGroups(
        baseInput({
          albums: ONE_ALBUM,
          onMakeKeyPhoto: () => calls.push("make-key-photo"),
        })
      )
    );
    rows.find((row) => row.key === "make-key-photo")?.onSelect();
    expect(calls).toStrictEqual(["make-key-photo"]);
  });
});

describe("viewerOverflowMenuGroups — wiring", () => {
  test("each row's onSelect fires the input callback it was given, not a copy of it", () => {
    const calls: string[] = [];
    const groups = viewerOverflowMenuGroups(
      baseInput({
        onAddToAlbum: () => calls.push("add-to-album"),
        onAdjustLocation: () => calls.push("adjust-location"),
        onDownload: () => calls.push("download"),
        onHide: () => calls.push("hide"),
        onSendCopy: () => calls.push("send-copy"),
        onSlideshow: () => calls.push("slideshow"),
      })
    );
    for (const row of flatten(groups)) row.onSelect();
    expect(calls.sort()).toStrictEqual(
      [
        "add-to-album",
        "adjust-location",
        "download",
        "hide",
        "send-copy",
        "slideshow",
      ].sort()
    );
  });

  test("Adjust Location opens the info sheet rather than carrying its own place editor", () => {
    // The row's presence and its wiring to `onAdjustLocation` (asserted
    // above) is the whole claim: there is no second `onSelect` branch here
    // that edits place data directly, which is what would have to exist for
    // this menu to duplicate `PhotoInfoSheet.tsx`'s editor.
    const rows = flatten(viewerOverflowMenuGroups(baseInput()));
    const row = rows.find((candidate) => candidate.key === "adjust-location");
    expect(row?.label).toBe("Adjust Location");
  });
});
