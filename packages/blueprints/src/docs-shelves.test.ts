// Docs as a route inside the frame — the shelf model, the copy tables, and the
// view-state rules (Docs spec §1, §2, §4).
//
// These are the four pure modules the restructure introduced (`shelves.ts`,
// `view-copy.ts`, `view-state.ts`, `capabilities.ts`) plus the frame
// contribution (`frame.tsx`). Every assertion here is on a RULE the app used
// to express as an inline condition in a render function, where it could not
// be read and could not be tested:
//
//   * a shelf is one value the strip, the band, the app bar and the row set
//     all read, so they cannot disagree about what "Trash" is;
//   * the row state slot shows AT MOST ONE thing, in one order;
//   * nothing is empty until a read has landed, and a shelf is never silently
//     swapped for another one.
//
// The app sources are loaded by file URL, like every other blueprint-app
// fixture here: `src/` is its own tsconfig rootDir, so the types the
// assertions need are declared locally rather than imported across it.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const app = (rel: string): string =>
  pathToFileURL(path.resolve(import.meta.dirname, "../apps/docs", rel)).href;

type ShelfId = string | null;
interface Shelf {
  id: ShelfId;
  label: string;
  segment: string;
}
interface EmptyCopy {
  variant: string;
  display: boolean;
  title: string;
  body: string;
  action?: string;
  action2?: string;
}
interface RowStateMark {
  kind: "text" | "glyph";
  text: string;
  net: boolean;
}

const shelves = (await import(app("shelves.ts"))) as {
  DSHELVES: readonly Shelf[];
  BAND_DESTINATIONS: readonly { id: string; label: string }[];
  FOLDERS: string;
  RECENT: string;
  STARRED: string;
  DUE: string;
  TRASH: string;
  SEARCH: string;
  STORAGE: string;
  NEWDOC: string;
  SCAN: string;
  CAPABILITIES: string;
  folderShelf: (id: string) => string;
  folderIdFrom: (id: ShelfId) => string | null;
  shelfFromSegment: (segment: string) => ShelfId;
  shelfSegment: (id: ShelfId) => string;
  shelfRoute: (id: ShelfId) => string;
  shelfFromRoute: (route: string) => ShelfId;
  bandActiveId: (id: ShelfId) => string | undefined;
  stripShelf: (id: ShelfId) => ShelfId;
  showsDrive: (id: ShelfId) => boolean;
  showsViewToggle: (id: ShelfId) => boolean;
  allowsSelection: (id: ShelfId) => boolean;
  isTrash: (id: ShelfId) => boolean;
};

const copy = (await import(app("view-copy.ts"))) as {
  shelfCopy: (
    id: ShelfId,
    folderName?: string
  ) => { title: string; unit: string };
  SHELF_LABELS: Record<string, string>;
  captionFor: (
    id: ShelfId,
    opts?: { offline?: boolean; searchUnreadable?: number; folderName?: string }
  ) => string | null;
  folderCaption: (name: string) => string;
  SEARCH_CAPTION_SAMPLE: string;
  EMPTY_MODEL_NOTE: string;
  FILTER_EMPTY: EmptyCopy;
  folderEmpty: (name: string) => EmptyCopy;
  searchEmpty: (query: string) => EmptyCopy;
  emptyCopy: (
    id: ShelfId,
    opts?: {
      query?: string;
      filtered?: boolean;
      folderName?: string;
      driveIsEmpty?: boolean;
    }
  ) => EmptyCopy;
  rowStateMark: (input: Record<string, unknown>) => RowStateMark | null;
  MORE_TITLE: string;
  MORE_FOOTER: string;
  MORE_ROWS: readonly {
    shelf: ShelfId;
    label: string;
    meta?: string;
    live: boolean;
  }[];
  OFFLINE_BANNER: string;
  OFFLINE_BANNER_ACTION: string;
  RECENT_RULE: string;
  actionStatus: (label: string, count: number) => string;
};

const viewState = (await import(app("view-state.ts"))) as {
  shelfAfterRead: (
    shelf: ShelfId,
    folderIds: readonly string[]
  ) => { shelf: ShelfId; goneFolder: boolean };
  GONE_FOLDER_NOTE: string;
  NO_EMPTY_STATE: EmptyCopy & { visible: boolean };
  emptyStateView: (input: Record<string, unknown>) => EmptyCopy & {
    visible: boolean;
  };
  libraryReachability: (input: {
    hostStatus?: string | null;
    readFailed: boolean;
  }) => "reachable" | "unreachable";
};

const caps = (await import(app("capabilities.ts"))) as {
  DCAPS: readonly {
    id: string;
    name: string;
    what: string;
    where: string;
    leaves: string;
    writes: string;
  }[];
  CAPABILITIES_TITLE: string;
  CAPABILITIES_BODY: string;
  capabilityOn: (id: string) => boolean;
  capabilitiesOnCount: () => number;
};

const frame = (await import(app("frame.tsx"))) as {
  primaryLabel: (shelf: ShelfId) => string | null;
  barCount: (state: {
    shelf: ShelfId;
    count: number | null;
    folderName?: string;
    compact: boolean;
  }) => unknown;
  barTitle: (state: {
    shelf: ShelfId;
    count: number | null;
    folderName?: string;
    compact: boolean;
  }) => string;
};

describe("docs shelves", () => {
  it("is the strip the spec names, in the spec's order", () => {
    expect(shelves.DSHELVES.map((s) => s.label)).toStrictEqual([
      "All",
      "Folders",
      "Recently changed",
      "Starred",
      "Coming due",
      "Trash",
    ]);
    // All is the app's own root, with no segment: `docs` IS All.
    expect(shelves.DSHELVES[0]?.id).toBeNull();
    expect(shelves.DSHELVES[0]?.segment).toBe("");
  });

  it("routes on `docs`, never the prototype's `dx`", () => {
    expect(shelves.shelfRoute(null)).toBe("docs");
    expect(shelves.shelfRoute(shelves.TRASH)).toBe("docs/trash");
    expect(shelves.shelfRoute(shelves.folderShelf("f7"))).toBe(
      "docs/folder/f7"
    );
    expect(shelves.shelfRoute(shelves.SEARCH)).not.toContain("dx");
  });

  it("round-trips every routed shelf through its own segment", () => {
    for (const id of [
      null,
      shelves.FOLDERS,
      shelves.RECENT,
      shelves.STARRED,
      shelves.DUE,
      shelves.TRASH,
      shelves.SEARCH,
      shelves.STORAGE,
      shelves.NEWDOC,
      shelves.SCAN,
      shelves.CAPABILITIES,
      shelves.folderShelf("f7"),
    ]) {
      expect(shelves.shelfFromRoute(shelves.shelfRoute(id))).toBe(id);
      expect(shelves.shelfFromSegment(shelves.shelfSegment(id))).toBe(id);
    }
  });

  it("reads a foreign route as All rather than guessing", () => {
    expect(shelves.shelfFromRoute("photos/albums")).toBeNull();
    expect(shelves.shelfFromSegment("nonsense")).toBeNull();
  });

  it("claims four band destinations plus More", () => {
    expect(shelves.BAND_DESTINATIONS.map((d) => d.label)).toStrictEqual([
      "All",
      "Folders",
      "Coming due",
      "Search",
    ]);
  });

  it("lights no band tab for a shelf that has none", () => {
    expect(shelves.bandActiveId(null)).toBe("list");
    expect(shelves.bandActiveId(shelves.DUE)).toBe("due");
    // Trash is a strip tab and a More row — never a band tab, so the band
    // lights nothing rather than the wrong thing.
    expect(shelves.bandActiveId(shelves.TRASH)).toBeUndefined();
    // A folder is the Folders shelf's own sub-state.
    expect(shelves.bandActiveId(shelves.folderShelf("f7"))).toBe("folders");
  });

  it("lights the strip tab the member reached the screen from", () => {
    expect(shelves.stripShelf(shelves.folderShelf("f7"))).toBe(shelves.FOLDERS);
    expect(shelves.stripShelf(shelves.TRASH)).toBe(shelves.TRASH);
    // A sheet destination is not a strip tab; it lights All, not nothing —
    // the member is still inside the drive.
    expect(shelves.stripShelf(shelves.STORAGE)).toBeNull();
  });

  it("keeps the drive's tools on the shelves that draw rows", () => {
    expect(shelves.showsDrive(null)).toBe(true);
    expect(shelves.showsDrive(shelves.TRASH)).toBe(true);
    expect(shelves.showsDrive(shelves.folderShelf("f7"))).toBe(true);
    expect(shelves.showsDrive(shelves.FOLDERS)).toBe(false);
    expect(shelves.showsDrive(shelves.DUE)).toBe(false);
    expect(shelves.showsViewToggle(shelves.FOLDERS)).toBe(false);
    // Trash keeps selection: the bar's trash swap (Restore) is what makes it
    // work, exactly as it does in Photos.
    expect(shelves.allowsSelection(shelves.TRASH)).toBe(true);
    expect(shelves.isTrash(shelves.TRASH)).toBe(true);
    expect(shelves.isTrash(null)).toBe(false);
  });

  it("never confuses a folder id with a built-in", () => {
    expect(shelves.folderIdFrom(shelves.folderShelf("f7"))).toBe("f7");
    expect(shelves.folderIdFrom(shelves.TRASH)).toBeNull();
    expect(shelves.folderIdFrom(null)).toBeNull();
  });
});

describe("docs view copy", () => {
  it("gives a folder its own title, and every other shelf the spec's", () => {
    expect(copy.shelfCopy(null)).toStrictEqual({
      title: "Docs",
      unit: "documents",
    });
    expect(copy.shelfCopy(shelves.STARRED).title).toBe("Starred");
    expect(copy.shelfCopy(shelves.DUE).unit).toBe("obligations");
    expect(copy.shelfCopy(shelves.folderShelf("f7"), "Property").title).toBe(
      "Property"
    );
    expect(copy.SHELF_LABELS[shelves.RECENT]).toBe("Recently changed");
  });

  it("puts the offline caption above the shelf's own", () => {
    // A caption that still promised "on this gateway and on this device" while
    // the gateway was unreachable would be the one untrue line on screen.
    expect(copy.captionFor(shelves.TRASH, { offline: true })).toContain(
      "read from this device"
    );
    expect(copy.captionFor(shelves.TRASH)).toContain("purged 30 days after");
    expect(copy.captionFor(shelves.RECENT)).toContain("last change");
    expect(copy.captionFor(null)).toContain(
      "on this gateway and on this device"
    );
  });

  it("withholds the search caption until the count is real", () => {
    expect(copy.captionFor(shelves.SEARCH)).toBeNull();
    expect(copy.captionFor(shelves.SEARCH, { searchUnreadable: 12 })).toBe(
      "12 documents could not be looked inside; they were matched on title and filing only."
    );
    expect(copy.SEARCH_CAPTION_SAMPLE).toContain("could not be looked inside");
  });

  it("names the folder in its own caption", () => {
    expect(
      copy.captionFor(shelves.folderShelf("f7"), { folderName: "Property" })
    ).toBe(copy.folderCaption("Property"));
    expect(copy.captionFor(shelves.folderShelf("f7"))).toContain("This folder");
  });

  it("has five distinguishable empty states, and only one display serif", () => {
    const variants = [
      copy.emptyCopy(null, { driveIsEmpty: true }),
      copy.emptyCopy(shelves.folderShelf("f7"), { folderName: "Identity" }),
      copy.emptyCopy(shelves.TRASH),
      copy.emptyCopy(null, { filtered: true }),
      copy.emptyCopy(null, { query: "right of wat" }),
    ];
    expect(variants.map((v) => v.variant)).toStrictEqual([
      "drive",
      "folder",
      "shelf",
      "filter",
      "search",
    ]);
    expect(variants.filter((v) => v.display)).toHaveLength(1);
    expect(variants[0]?.display).toBe(true);
    expect(copy.EMPTY_MODEL_NOTE).toContain("Five empty states");
  });

  it("lets what the member just did win over the shelf", () => {
    // A query is typed over a filter, so it wins; both win over the shelf.
    expect(
      copy.emptyCopy(shelves.TRASH, { query: "lease", filtered: true })
    ).toStrictEqual(copy.searchEmpty("lease"));
    expect(copy.emptyCopy(shelves.TRASH, { filtered: true })).toStrictEqual(
      copy.FILTER_EMPTY
    );
    expect(copy.folderEmpty("Identity").title).toContain("Identity");
  });

  it("keeps each shelf empty on its own terms", () => {
    expect(copy.emptyCopy(shelves.TRASH).title).toBe("Trash is empty");
    expect(copy.emptyCopy(shelves.STARRED).body).toContain("Photos");
    expect(copy.emptyCopy(shelves.DUE).body).toContain("switched off");
  });

  describe("the row state slot", () => {
    it("shows nothing while a row beyond the window is still coming", () => {
      expect(
        copy.rowStateMark({ loadingBeyondWindow: true, deviceOnly: true })
      ).toBeNull();
    });

    it("shows the failure, and only the failure, once it fails", () => {
      expect(
        copy.rowStateMark({
          loadingBeyondWindow: true,
          fetchFailed: true,
          cannotRender: true,
          deviceOnly: true,
        })
      ).toStrictEqual({
        kind: "text",
        text: "could not be fetched",
        net: true,
      });
    });

    it("shows AT MOST ONE thing, in the spec's order", () => {
      // Every rung below is true at once. The ladder must pick exactly one,
      // and it must pick the highest — this is the case that used to put
      // three marks on one row.
      const all = {
        cannotRender: true,
        offline: true,
        bytesOnDevice: false,
        deviceOnly: true,
      };
      expect(copy.rowStateMark(all)?.text).toBe("cannot be shown");
      expect(copy.rowStateMark({ ...all, cannotRender: false })?.text).toBe(
        "will not open"
      );
      expect(
        copy.rowStateMark({ ...all, cannotRender: false, offline: false })
      ).toStrictEqual({
        kind: "glyph",
        text: "on this device only",
        net: false,
      });
    });

    it("gives the trash slot to the purge date, and nothing else", () => {
      expect(
        copy.rowStateMark({
          inTrash: true,
          cannotRender: true,
          deviceOnly: true,
          purgeInDays: 30,
        })
      ).toStrictEqual({ kind: "text", text: "purged in 30 days", net: false });
      expect(copy.rowStateMark({ inTrash: true, purgeInDays: 1 })?.text).toBe(
        "purged in 1 day"
      );
      // No computed date: the slot stays blank rather than printing a number
      // nobody worked out.
      expect(copy.rowStateMark({ inTrash: true })).toBeNull();
    });

    it("says nothing at all about an ordinary row", () => {
      expect(copy.rowStateMark({ bytesOnDevice: true })).toBeNull();
    });
  });

  it("carries the More sheet's own words, and draws no dead end", () => {
    expect(copy.MORE_TITLE).toBe("More in Docs");
    expect(copy.MORE_FOOTER).toBe(
      "Everything Docs can show. The vault mark in the head goes back to the rest of Centraid."
    );
    expect(copy.MORE_ROWS.map((r) => r.label)).toStrictEqual([
      "Recently changed",
      "Starred",
      "Trash",
      "Add a document",
      "Scan a document",
      "What Docs may read",
      "Kind and sort",
      "Storage",
    ]);
    // A row is only drawn once its destination exists. Everything live must
    // name a real shelf.
    for (const row of copy.MORE_ROWS.filter((r) => r.live)) {
      expect(shelves.shelfSegment(row.shelf)).not.toBe("");
    }
  });

  it("says the offline banner and the action status in the spec's words", () => {
    expect(copy.OFFLINE_BANNER).toContain("The gateway is unreachable.");
    expect(copy.OFFLINE_BANNER_ACTION).toBe("Retry");
    expect(copy.RECENT_RULE).toContain(
      "nothing records when a document was opened"
    );
    expect(copy.actionStatus("Moved to trash", 1)).toBe(
      "Moved to trash · 1 document"
    );
    expect(copy.actionStatus("Moved to trash", 4)).toBe(
      "Moved to trash · 4 documents"
    );
  });
});

describe("docs view state", () => {
  it("never says a view is empty before a read has landed", () => {
    expect(
      viewState.emptyStateView({ loaded: false, count: 0, shelf: null })
    ).toStrictEqual(viewState.NO_EMPTY_STATE);
    expect(
      viewState.emptyStateView({ loaded: true, count: 0, shelf: null }).visible
    ).toBe(true);
    expect(
      viewState.emptyStateView({ loaded: true, count: 3, shelf: null }).visible
    ).toBe(false);
    // Something else already answers the view.
    expect(
      viewState.emptyStateView({
        loaded: true,
        count: 0,
        shelf: null,
        suppressed: true,
      }).visible
    ).toBe(false);
  });

  it("leaves an empty trash exactly where it is", () => {
    expect(viewState.shelfAfterRead(shelves.TRASH, [])).toStrictEqual({
      shelf: shelves.TRASH,
      goneFolder: false,
    });
    expect(viewState.shelfAfterRead(null, [])).toStrictEqual({
      shelf: null,
      goneFolder: false,
    });
  });

  it("falls a gone folder back to Folders, and says so", () => {
    // NOT All: the folder was reached from Folders, and the move is announced
    // rather than silently performed.
    expect(
      viewState.shelfAfterRead(shelves.folderShelf("f7"), ["f1", "f2"])
    ).toStrictEqual({ shelf: shelves.FOLDERS, goneFolder: true });
    expect(
      viewState.shelfAfterRead(shelves.folderShelf("f7"), ["f7"])
    ).toStrictEqual({ shelf: shelves.folderShelf("f7"), goneFolder: false });
    expect(viewState.GONE_FOLDER_NOTE).toContain("no longer exists");
  });

  it("reads offline, and never invents it", () => {
    expect(viewState.libraryReachability({ readFailed: false })).toBe(
      "reachable"
    );
    expect(viewState.libraryReachability({ readFailed: true })).toBe(
      "unreachable"
    );
    // The host's own word wins over the app's inference in both directions.
    expect(
      viewState.libraryReachability({ hostStatus: "up", readFailed: true })
    ).toBe("reachable");
    expect(
      viewState.libraryReachability({ hostStatus: "down", readFailed: false })
    ).toBe("unreachable");
  });
});

describe("docs capabilities", () => {
  it("carries four capabilities, each with its own consent", () => {
    expect(caps.DCAPS.map((c) => c.id)).toStrictEqual([
      "read",
      "filing",
      "names",
      "due",
    ]);
    // Nothing leaves the device, and none of them changes a document.
    for (const cap of caps.DCAPS) {
      expect(cap.leaves).toBe("nothing");
      expect(cap.where).toBe("on this device");
      expect(cap.writes).not.toBe("");
    }
    expect(caps.CAPABILITIES_TITLE).toBe(
      "Four things Docs can do, each asked for on its own"
    );
    expect(caps.CAPABILITIES_BODY).toContain("All four are off");
  });

  it("answers `off` while there is no consent record to read", () => {
    expect(caps.DCAPS.every((c) => !caps.capabilityOn(c.id))).toBe(true);
    expect(caps.capabilitiesOnCount()).toBe(0);
  });
});

describe("docs frame contribution", () => {
  it("offers no verb on a shelf that has none", () => {
    expect(frame.primaryLabel(null)).toBe("New");
    expect(frame.primaryLabel(shelves.FOLDERS)).toBe("New folder");
    expect(frame.primaryLabel(shelves.folderShelf("f7"))).toBe("New");
    // The platform has no destroy verb, so Trash's bar is empty rather than
    // carrying an "Empty trash" that would refuse.
    expect(frame.primaryLabel(shelves.TRASH)).toBeNull();
    expect(frame.primaryLabel(shelves.SEARCH)).toBeNull();
    expect(frame.primaryLabel(shelves.CAPABILITIES)).toBeNull();
  });

  it("counts in the shelf's own noun, and contributes nothing for null", () => {
    expect(frame.barCount({ shelf: null, count: 1, compact: false })).toBe(
      "1 document"
    );
    expect(frame.barCount({ shelf: null, count: 9, compact: false })).toBe(
      "9 documents"
    );
    expect(
      frame.barCount({ shelf: shelves.FOLDERS, count: 4, compact: false })
    ).toBe("4 folders");
    expect(
      frame.barCount({ shelf: shelves.DUE, count: 3, compact: false })
    ).toBe("3 obligations");
    expect(
      frame.barCount({ shelf: shelves.DUE, count: null, compact: false })
    ).toBeUndefined();
  });

  it("titles a folder with the folder's own name", () => {
    expect(
      frame.barTitle({
        shelf: shelves.folderShelf("f7"),
        count: 0,
        folderName: "Property",
        compact: false,
      })
    ).toBe("Property");
    expect(frame.barTitle({ shelf: null, count: 0, compact: false })).toBe(
      "Docs"
    );
  });
});
