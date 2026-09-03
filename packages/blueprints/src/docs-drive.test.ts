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
  people: string | null;
  modified: string | null;
  source: string | null;
}
interface SharedWith {
  grant_id: string;
  label: string;
  via: "document" | "folder";
}
interface Row {
  document_id: string;
  media_type: string | null;
  custody_state: string | null;
  created_at: string;
  updated_at: string;
  shared_with: SharedWith[] | null;
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
  liveAxes: (rows?: readonly Row[]) => readonly FilterAxis[];
  liveOptions: (axis: FilterAxis, rows?: readonly Row[]) => readonly string[];
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
  shared_with: [],
  ...over,
});

const share = (label: string, via: "document" | "folder" = "document") => ({
  grant_id: `grant-${label}-${via}`,
  label,
  via,
});

describe("the filter row (§4.2)", () => {
  it("offers only the axes this drive can answer", () => {
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
    expect(
      filters
        .liveAxes([row({ document_id: "a", shared_with: [share("Family")] })])
        .map((axis) => axis.id)
    ).toStrictEqual(["type", "people", "modified", "source"]);
  });

  it("derives one People option per audience the rows actually name", () => {
    const people = copy.DFILTERS.find((axis) => axis.id === "people")!;
    const rows = [
      row({ document_id: "a", shared_with: [share("Family")] }),
      row({ document_id: "b", shared_with: [share("Family", "folder")] }),
      row({ document_id: "c", shared_with: [share("Ana and Tom")] }),
      row({ document_id: "d", shared_with: null }),
    ];
    expect(filters.liveOptions(people, rows)).toStrictEqual([
      "Shared with Ana and Tom",
      "Shared with Family",
    ]);
    expect(people.options).toStrictEqual([]);
  });

  it("narrows to one audience, and never matches a row whose shares are unknown", () => {
    const rows = [
      row({ document_id: "a", shared_with: [share("Family", "folder")] }),
      row({ document_id: "b", shared_with: [share("Ravi")] }),
      row({ document_id: "c", shared_with: [] }),
      row({ document_id: "d", shared_with: null }),
    ];
    expect(
      filters
        .applyFilters(rows, {
          ...filters.NO_FILTERS,
          people: "Shared with Family",
        })
        .map((r) => r.document_id)
    ).toStrictEqual(["a"]);
  });

  it("offers only the options it has a predicate for", () => {
    const source = copy.DFILTERS.find((axis) => axis.id === "source")!;
    const live = filters.liveOptions(source);
    expect(live).toContain("On this device");
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
// @vitest-environment jsdom
