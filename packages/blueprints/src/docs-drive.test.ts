// @vitest-environment jsdom
// The drive family, the reading/editor pair and the details rail (Docs spec
// §4.1, §4.2, §4.6, §6, §8) — the rules Stage C introduced, tested where they
// actually live: in pure modules.
//
// Every assertion here is on a rule the app would otherwise express as an
// inline condition in a render function:
//
//   * a filter axis is only offered where this drive can ANSWER it, and the
//     axes compose (filters.ts);
//   * a breadcrumb chain goes through the place the member reached the shelf
//     from, and the trailing crumb is not a link (drive-copy.ts `crumbsFor`);
//   * a write has seven visible outcomes and only three of them may be pressed
//     (document-copy.ts `DSAVE`);
//   * whether Docs can SHOW a kind is a separate fact from what the kind is
//     (format.ts `canRender`).
//
// The app sources are loaded by file URL, like every other blueprint-app
// fixture here: `src/` is its own tsconfig rootDir, so the types the
// assertions need are declared locally rather than imported across it. The
// jsdom environment is required only because `format.ts` reaches the shared
// component kit, whose custom-element base class needs `HTMLElement` at import
// time — nothing asserted below touches a DOM.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

const app = (rel: string): string =>
  pathToFileURL(path.resolve(import.meta.dirname, "../apps/docs", rel)).href;

interface FilterAxis {
  id: string;
  label: string;
  options: readonly string[];
  live: boolean;
}
interface DriveFilters {
  type: string | null;
  modified: string | null;
  source: string | null;
}
interface Row {
  document_id: string;
  media_type: string | null;
  custody_state: string | null;
  created_at: string;
  updated_at: string;
}
interface SaveOutcome {
  id: string;
  label: string;
  status: string;
  note: string;
  commit: string;
  commits: boolean;
  net: boolean;
  action?: string;
}
interface Crumb {
  label: string;
  shelf?: string | null;
}

const filters = (await import(app("filters.ts"))) as {
  NO_FILTERS: DriveFilters;
  filtersActive: (f: DriveFilters) => boolean;
  liveAxes: () => readonly FilterAxis[];
  liveOptions: (axis: FilterAxis) => readonly string[];
  applyFilters: (
    rows: readonly Row[],
    f: DriveFilters,
    now?: number
  ) => readonly Row[];
};
const copy = (await import(app("drive-copy.ts"))) as {
  DFILTERS: readonly FilterAxis[];
  crumbsFor: (
    id: string | null,
    opts?: {
      folderName?: string;
      searching?: boolean;
      title?: string;
      tail?: string;
    }
  ) => readonly Crumb[];
  TRASH_ASK: { eyebrow: string; title: string };
  TRASH_FALLBACK: string;
  WINDOW_FAILED: string;
};
const docCopy = (await import(app("document-copy.ts"))) as {
  DSAVE: Record<string, SaveOutcome>;
  savedStatus: (opts?: {
    version?: number | null;
    at?: string | null;
  }) => string;
  refusedStatus: (reason?: string | null) => string;
  RAIL_TABS: readonly { id: string; label: string }[];
};
const format = (await import(app("format.ts"))) as {
  canRender: (doc: { media_type?: string | null }) => boolean;
};
const blobText = (await import(app("blob-text.ts"))) as {
  loadBlobText: (uri: string) => Promise<string>;
};
const shelves = (await import(app("shelves.ts"))) as {
  FOLDERS: string;
  TRASH: string;
  folderShelf: (id: string) => string;
};

const row = (over: Partial<Row> & { document_id: string }): Row => ({
  media_type: "application/pdf",
  custody_state: "replicated",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("the filter row (§4.2)", () => {
  it("offers only the axes this drive can answer", () => {
    // People is in the table and is not on screen: nothing this app reads
    // knows who owns a document or who it was shared with, so every one of
    // that axis' options would silently match nothing.
    expect(copy.DFILTERS.map((axis) => axis.id)).toStrictEqual([
      "type",
      "people",
      "modified",
      "source",
    ]);
    expect(filters.liveAxes().map((axis) => axis.id)).toStrictEqual([
      "type",
      "modified",
      "source",
    ]);
  });

  it("offers only the options it has a predicate for", () => {
    const source = copy.DFILTERS.find((axis) => axis.id === "source")!;
    const live = filters.liveOptions(source);
    expect(live).toContain("On this device");
    // How a document ARRIVED is not in the drive projection.
    expect(live).not.toContain("Scanned here");
    expect(live).not.toContain("From the share sheet");
  });

  it("composes: each axis narrows what the last one left", () => {
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    const rows = [
      row({ document_id: "a", updated_at: "2026-05-31T12:00:00.000Z" }),
      row({
        document_id: "b",
        media_type: "image/jpeg",
        updated_at: "2026-05-31T12:00:00.000Z",
      }),
      row({ document_id: "c", updated_at: "2024-01-01T00:00:00.000Z" }),
    ];
    const byType = filters.applyFilters(
      rows,
      { ...filters.NO_FILTERS, type: "PDF" },
      now
    );
    expect(byType.map((r) => r.document_id)).toStrictEqual(["a", "c"]);
    const both = filters.applyFilters(
      rows,
      { ...filters.NO_FILTERS, type: "PDF", modified: "Last 7 days" },
      now
    );
    expect(both.map((r) => r.document_id)).toStrictEqual(["a"]);
  });

  it("narrows by where the bytes are, not by a guess", () => {
    const rows = [
      row({ document_id: "here", custody_state: "local-only" }),
      row({ document_id: "away", custody_state: "remote-only" }),
    ];
    expect(
      filters
        .applyFilters(rows, { ...filters.NO_FILTERS, source: "Gateway only" })
        .map((r) => r.document_id)
    ).toStrictEqual(["away"]);
  });

  it("knows whether anything is narrowing the set", () => {
    expect(filters.filtersActive(filters.NO_FILTERS)).toBe(false);
    expect(
      filters.filtersActive({ ...filters.NO_FILTERS, modified: "Today" })
    ).toBe(true);
  });
});

describe("the breadcrumb (§1.6)", () => {
  it("takes a folder through Folders, because that is where it was reached from", () => {
    const crumbs = copy.crumbsFor(shelves.folderShelf("f1"), {
      folderName: "Property",
    });
    expect(crumbs.map((c) => c.label)).toStrictEqual([
      "Docs",
      "Folders",
      "Property",
    ]);
    expect(crumbs[1]?.shelf).toBe(shelves.FOLDERS);
  });

  it("never makes the trailing crumb a link — it is where you are", () => {
    for (const id of [null, shelves.TRASH, shelves.FOLDERS]) {
      const crumbs = copy.crumbsFor(id);
      expect(crumbs.at(-1)?.shelf).toBeUndefined();
      expect(crumbs[0]?.label).toBe("Docs");
    }
  });

  it("gives a screen under one document its own chain", () => {
    expect(
      copy
        .crumbsFor(null, { title: "Notes on the house", tail: "History" })
        .map((c) => c.label)
    ).toStrictEqual(["Docs", "Notes on the house", "History"]);
  });
});

describe("the seven write outcomes (§6.3)", () => {
  it("has exactly seven, each with its own sentence", () => {
    const ids = Object.keys(docCopy.DSAVE);
    expect(ids).toHaveLength(7);
    expect(
      new Set(Object.values(docCopy.DSAVE).map((o) => o.status)).size
    ).toBe(7);
  });

  it("keeps 'held for a person' and 'held for a gateway' apart", () => {
    expect(docCopy.DSAVE["approval"]!.status).toContain("approval");
    // The two held states are told apart by what holds them — a person in
    // Notifications, or an unreachable gateway — not by a sentence denying
    // the other one.
    expect(docCopy.DSAVE["approval"]!.note).toContain("Notifications");
    expect(docCopy.DSAVE["queued"]!.note).toContain("gateway is back");
    expect(docCopy.DSAVE["queued"]!.status).toContain("gateway is unreachable");
  });

  it("only lets a commit be pressed where there is something to commit", () => {
    const pressable = Object.values(docCopy.DSAVE)
      .filter((o) => o.commits)
      .map((o) => o.id)
      .sort();
    // "A filled control that cannot be pressed stops being filled" (§6.3):
    // saving, saved and the two held states offer no press.
    expect(pressable).toStrictEqual(["nochange", "refused", "unsaved"]);
  });

  it("prints live numbers only when it has them", () => {
    expect(docCopy.savedStatus()).toBe("Saved");
    expect(docCopy.savedStatus({ version: 7, at: "14:02" })).toBe(
      "Saved · version 7 · 14:02"
    );
    expect(docCopy.refusedStatus()).toBe("Refused · this document is not text");
    expect(
      docCopy.refusedStatus("a body can only be set on a text document")
    ).toBe("Refused · a body can only be set on a text document");
  });
});

describe("what Docs can show (§10.1) and what it asks for (§4.3)", () => {
  it("loads an inline-shell document through the authenticated blob primitive", async () => {
    const host = globalThis as unknown as {
      centraid: { blobText?: (uri: string) => Promise<string | null> };
    };
    const previous = host.centraid;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const read = vi.fn<(uri: string) => Promise<string>>(
      async () => "Body painted from the vault"
    );
    host.centraid = { blobText: read } as never;
    try {
      await expect(
        blobText.loadBlobText("/centraid/_vault/blobs/body-sha")
      ).resolves.toBe("Body painted from the vault");
      expect(read.mock.calls).toStrictEqual([
        ["/centraid/_vault/blobs/body-sha"],
      ]);
      expect(fetchSpy.mock.calls).toStrictEqual([]);
    } finally {
      host.centraid = previous;
      fetchSpy.mockRestore();
    }
  });

  it("keeps served document URIs on the same-origin fetch path", async () => {
    const host = globalThis as unknown as {
      centraid: { blobText?: (uri: string) => Promise<string | null> };
    };
    const previous = host.centraid;
    host.centraid = {};
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("Served document body"));
    try {
      await expect(blobText.loadBlobText("/documents/body.txt")).resolves.toBe(
        "Served document body"
      );
      expect(fetchSpy.mock.calls).toStrictEqual([["/documents/body.txt"]]);
    } finally {
      host.centraid = previous;
      fetchSpy.mockRestore();
    }
  });

  it("separates the kind from whether Docs can render it", () => {
    expect(format.canRender({ media_type: "application/pdf" })).toBe(true);
    expect(format.canRender({ media_type: "text/markdown" })).toBe(true);
    expect(format.canRender({ media_type: "image/png" })).toBe(true);
    expect(
      format.canRender({
        media_type:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      })
    ).toBe(false);
    expect(format.canRender({ media_type: "application/vnd.ms-excel" })).toBe(
      false
    );
  });

  it("draws trash's ask without a destroy verb", () => {
    // A label and one sentence: the eyebrow says it is not a control that
    // failed, and the fallback says why destruction is scheduled. The design
    // rationale is a comment in drive-copy.ts, never printed at a member.
    expect(copy.TRASH_ASK.eyebrow).toBe("Not available yet");
    expect(copy.TRASH_ASK.title).toBe("Delete forever and Empty trash");
    expect(copy.TRASH_FALLBACK).toContain("cannot be emptied");
    expect(JSON.stringify(copy.TRASH_ASK)).not.toContain("destroy verb");
  });

  it("says nothing about a window still in flight, and one thing about a failed one", () => {
    expect(copy.WINDOW_FAILED).toBe("could not be fetched");
  });
});

describe("the details rail (§8)", () => {
  it("is one rail with three tabs", () => {
    expect(docCopy.RAIL_TABS.map((tab) => tab.id)).toStrictEqual([
      "props",
      "facts",
      "names",
    ]);
  });
});
