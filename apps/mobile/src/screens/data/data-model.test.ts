import { describe, expect, it } from "vitest";

import type {
  AtlasCensus,
  AtlasGraph,
  BrowseRowsPage,
  BrowseTable,
} from "../../lib/atlas";
import {
  browseRecords,
  censusDetail,
  censusKinds,
  filterKinds,
  kindSub,
  pickBrowseTable,
  recordCount,
  relationRows,
  tableCaption,
  timeColumn,
} from "./data-model";

function census(over: Partial<AtlasCensus> = {}): AtlasCensus {
  return {
    fileBytesTotal: 4096,
    generatedAt: "2026-08-13T09:00:00.000Z",
    method: "dbstat",
    packs: [
      {
        bytes: 2048,
        file: "vault",
        pack: "core",
        packKind: "ontology",
        packLabel: "Core",
        rows: 1994,
        tables: [
          {
            bytes: 1_288_490_188,
            label: "documents",
            logical: "documents",
            physical: "core_doc",
            rows: 1908,
            table: "core_doc",
          },
          {
            bytes: 2_097_152,
            label: "people",
            logical: "people",
            physical: "core_party",
            rows: 86,
            table: "core_party",
          },
          {
            bytes: 0,
            label: "events",
            logical: "events",
            physical: "core_event",
            rows: 0,
            table: "core_event",
          },
        ],
      },
      {
        bytes: 512,
        file: "journal",
        pack: "engine",
        packKind: "machinery",
        packLabel: "Engine",
        rows: 19_208,
        tables: [
          {
            bytes: 220_200_960,
            label: "audit",
            logical: "audit",
            physical: "eng_audit",
            rows: 19_208,
            table: "eng_audit",
          },
        ],
      },
    ],
    totals: { bytes: 1_510_000_000, kinds: 4, populatedKinds: 3, rows: 21_202 },
    ...over,
  };
}

function graph(over: Partial<AtlasGraph> = {}): AtlasGraph {
  return {
    authoredLinks: [],
    edgeCount: 0,
    fkEdges: [],
    generatedAt: "2026-08-13T09:00:00.000Z",
    nodes: [],
    ...over,
  };
}

describe(censusKinds, () => {
  it("drops kinds nothing has written to yet", () => {
    expect(censusKinds(census()).map((row) => row.logical)).not.toContain(
      "events"
    );
  });

  it("puts the engine's own bookkeeping after what apps wrote", () => {
    expect(censusKinds(census()).map((row) => row.logical)).toStrictEqual([
      "documents",
      "people",
      "audit",
    ]);
  });
});

describe(kindSub, () => {
  it("carries records and size when the census measured bytes", () => {
    expect(kindSub({ bytes: 2_097_152, rows: 86 })).toBe("86 records · 2.0 MB");
  });

  it("says nothing about size when the census only estimated", () => {
    expect(kindSub({ bytes: null, rows: 1 })).toBe("1 record");
  });
});

describe(recordCount, () => {
  it("agrees with its count", () => {
    expect(recordCount(1)).toBe("1 record");
    expect(recordCount(1908)).toBe("1,908 records");
  });
});

describe(filterKinds, () => {
  const rows = censusKinds(census());

  it("keeps everything by default", () => {
    expect(filterKinds(rows, "all")).toHaveLength(3);
  });

  it("keeps only the engine's own for that chip", () => {
    expect(
      filterKinds(rows, "machinery").map((row) => row.logical)
    ).toStrictEqual(["audit"]);
  });

  it("orders the largest by size, across both halves", () => {
    expect(
      filterKinds(rows, "largest").map((row) => row.logical)
    ).toStrictEqual(["documents", "audit", "people"]);
  });
});

describe(relationRows, () => {
  it("names both ends by their friendly names and counts the links", () => {
    const rows = relationRows(
      graph({
        authoredLinks: [
          {
            count: 1204,
            fromType: "documents",
            relationConceptId: "sent_to",
            relationLabel: "sent to",
            toType: "people",
          },
        ],
        nodes: [
          {
            friendly: "Documents",
            label: "documents",
            logical: "documents",
            pack: "core",
            packKind: "ontology",
            physical: "core_doc",
          },
          {
            friendly: "People",
            label: "people",
            logical: "people",
            pack: "core",
            packKind: "ontology",
            physical: "core_party",
          },
        ],
      })
    );
    expect(rows[0]?.title).toBe("Documents → People");
    expect(rows[0]?.sub).toBe("sent to · 1,204 links");
    expect(rows[0]?.browse).toBe("documents");
  });

  it("falls back to the schema's own rules when nothing has been linked", () => {
    const rows = relationRows(
      graph({
        edgeCount: 1,
        fkEdges: [
          {
            childRows: 1908,
            col: "author_id",
            fill: 0.5,
            fromLogical: "documents",
            fromTable: "core_doc",
            notnull: false,
            selfRef: false,
            toLogical: "people",
            toTable: "core_party",
          },
        ],
      })
    );
    expect(rows[0]?.title).toBe("documents → people");
    expect(rows[0]?.sub).toBe("author_id · 50% of 1,908 records");
  });
});

describe(browseRecords, () => {
  function page(over: Partial<BrowseRowsPage> = {}): BrowseRowsPage {
    return {
      columns: ["id", "title", "kind", "updated_at"],
      dir: "desc",
      logical: "documents",
      nextCursor: null,
      orderBy: "updated_at",
      physical: "core_doc",
      rows: [],
      ...over,
    };
  }

  it("reads title, kind and written out of the raw column map", () => {
    const [view] = browseRecords(
      page({
        rows: [
          {
            id: "doc-1",
            kind: "pdf",
            title: "Lease — 14 Sitwell Road.pdf",
            updated_at: Date.now(),
          },
        ],
      })
    );
    expect(view?.record.title).toBe("Lease — 14 Sitwell Road.pdf");
    expect(view?.record.kind).toBe("pdf");
    expect(view?.record.written).toBe("just now");
    expect(view?.id).toBe("doc-1");
  });

  it("shows the id rather than inventing a title, and no written line", () => {
    const [view] = browseRecords(
      page({ columns: ["id", "blob"], rows: [{ blob: {}, id: "row-9" }] })
    );
    expect(view?.record.title).toBe("row-9");
    expect(view?.record.written).toBe("");
    expect(view?.record.kind).toBe("");
  });
});

describe(timeColumn, () => {
  it("prefers the most recent write over the first", () => {
    expect(timeColumn(["created_at", "updated_at"])).toBe("updated_at");
  });

  it("answers nothing when the store keeps no times", () => {
    expect(timeColumn(["id", "payload"])).toBeUndefined();
  });
});

describe(tableCaption, () => {
  it("claims newest first only when the page was ordered that way", () => {
    expect(tableCaption(6, 1908, true)).toBe(
      "The first 6 of 1,908, newest first. The table scrolls rather than pages, the way the drive does."
    );
    expect(tableCaption(6, 1908, false)).toBe(
      "The first 6 of 1,908, in the order the store keeps them. The table scrolls rather than pages, the way the drive does."
    );
  });
});

describe(pickBrowseTable, () => {
  const tables: BrowseTable[] = [
    {
      label: "documents",
      logical: "documents",
      machinery: false,
      pack: "core",
      packKind: "ontology",
      packLabel: "Core",
      physical: "core_doc",
      rows: 1908,
      singlePk: true,
    },
    {
      label: "audit",
      logical: "audit",
      machinery: true,
      pack: "engine",
      packKind: "machinery",
      packLabel: "Engine",
      physical: "eng_audit",
      rows: 19_208,
      singlePk: true,
    },
  ];

  it("opens on the kind it was navigated to", () => {
    expect(pickBrowseTable(tables, "audit")?.logical).toBe("audit");
  });

  it("otherwise opens on the biggest thing the member's apps wrote", () => {
    expect(pickBrowseTable(tables)?.logical).toBe("documents");
    expect(pickBrowseTable(tables, "nothing-like-this")?.logical).toBe(
      "documents"
    );
  });

  it("has nothing to open when the vault is empty", () => {
    expect(pickBrowseTable([])).toBeUndefined();
  });
});

describe(censusDetail, () => {
  it("reads the totals the census counted, and only those", () => {
    expect(censusDetail(census())).toBe("3 kinds · 21,202 records · 1.4 GB");
    expect(
      censusDetail(census({ totals: { ...census().totals, bytes: null } }))
    ).toBe("3 kinds · 21,202 records");
  });
});
