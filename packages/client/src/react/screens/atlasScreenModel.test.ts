import { describe, expect, it } from "vitest";

import type {
  AtlasCensusPayload,
  AtlasGraphPayload,
  AtlasPulsePayload,
  BrowseColumnsResult,
} from "../../gateway-client.js";
import {
  censusStamp,
  countLine,
  dayLabel,
  defaultSortKey,
  gridColumnsFrom,
  gridRowsFrom,
  healthDetail,
  holdsMeta,
  isCensusPayload,
  kindCount,
  kindMeta,
  kindRowsFrom,
  kindWritten,
  largestRecords,
  meterShare,
  relationRowsFrom,
  sortLabel,
  tableCaption,
} from "./atlasScreenModel.js";

// The Data route's sentences (issue #765). Every one of them is a claim about
// the vault, so each is tested for what it says AND for what it refuses to say
// when the payload cannot support it.

const NOW = Date.parse("2026-07-17T12:00:00.000Z");

const stats: AtlasCensusPayload = {
  generatedAt: "2026-07-17T12:00:00.000Z",
  method: "dbstat",
  fileBytesTotal: 4_000_000,
  packs: [
    {
      pack: "core",
      packLabel: "Core",
      packKind: "ontology",
      file: "vault",
      rows: 214,
      bytes: 2_000_000,
      tables: [
        {
          logical: "core.party",
          physical: "core_party",
          table: "party",
          label: "Party",
          rows: 214,
          bytes: 2_000_000,
          pages: 40,
        },
        {
          logical: "core.place",
          physical: "core_place",
          table: "place",
          label: "Place",
          rows: 0,
          bytes: 0,
          pages: 0,
        },
      ],
    },
    {
      pack: "journal",
      packLabel: "Journal",
      packKind: "machinery",
      file: "journal",
      rows: 9000,
      bytes: 400,
      tables: [
        {
          logical: "journal.segment",
          physical: "journal_segment",
          table: "segment",
          label: "Segment",
          rows: 9000,
          bytes: 400,
          pages: 3,
        },
      ],
    },
  ],
  totals: { rows: 9214, bytes: 2_000_400, kinds: 3, populatedKinds: 2 },
};

const pulse: AtlasPulsePayload = {
  generatedAt: "2026-07-17T12:00:00.000Z",
  since: "2026-06-17T12:00:00.000Z",
  windowDays: 30,
  live: true,
  series: [
    {
      entityType: "core.party",
      physical: "core_party",
      pack: "core",
      label: "Party",
      total: 15,
      days: [
        { day: "2026-07-16", count: 3 },
        { day: "2026-07-17", count: 12 },
      ],
    },
  ],
};

describe("screens/atlasScreenModel", () => {
  describe("kinds", () => {
    it("lists every kind the schema defines, fullest first inside each group", () => {
      const rows = kindRowsFrom(stats, pulse, NOW);
      expect(rows.map((r) => r.logical)).toStrictEqual([
        "core.party",
        "core.place",
        "journal.segment",
      ]);
      // Plumbing sorts below life data, and a never-written kind sorts to the
      // foot of its own group rather than being dropped from the list.
      expect(rows[2]?.machinery).toBe(true);
      expect(rows.map(kindWritten)).toStrictEqual([true, false, true]);
    });

    it("says what a kind holds, and today's writes when there are some", () => {
      const [party, place, segment] = kindRowsFrom(stats, pulse, NOW);
      // The pack has its own cell on the meter row, so it is no longer a
      // prefix on the count: one fact, one place.
      expect(kindCount(party!)).toBe("214 records · 1.9 MB · 12 written today");
      expect(kindCount(segment!)).toBe("9,000 records · 400 B");
      // Never written says so rather than claiming a count that has moved,
      // in the same words the chip that isolates those rows uses.
      expect(kindCount(place!)).toBe("Never written");
      expect(party!.packLabel).toBe("Core");
      expect(segment!.packLabel).toBe("Journal");
    });

    it("reports the last write at the granularity the pulse actually has", () => {
      const [party, place, segment] = kindRowsFrom(stats, pulse, NOW);
      expect(kindMeta(party!, NOW)).toBe("Today");
      expect(kindMeta(segment!, NOW)).toBe("Quiet");
      // "Quiet" is a lull; a kind that never held anything has had none.
      expect(kindMeta(place!, NOW)).toBeUndefined();
    });

    it("says nothing about writes at all when the pulse never landed", () => {
      const [party] = kindRowsFrom(stats, null, NOW);
      expect(kindMeta(party!, NOW)).toBeUndefined();
      expect(kindCount(party!)).toBe("214 records · 1.9 MB");
    });

    it("heads the section with what is written of what is defined", () => {
      expect(holdsMeta(stats)).toBe("2 of 3 kinds written · 9,214 records");
    });

    it("scales the meter against the largest kind, never the total", () => {
      const rows = kindRowsFrom(stats, pulse, NOW);
      const largest = largestRecords(rows);
      expect(largest).toBe(9000);
      const [party, place, segment] = rows;
      // Share of the largest: the fullest kind fills its track, and the one
      // beside it is read against that rather than against a total that would
      // round both to nothing.
      expect(meterShare(segment!, largest)).toBe(100);
      expect(meterShare(party!, largest)).toBe(2);
      // A kind nothing has written draws no bar at all.
      expect(meterShare(place!, largest)).toBe(0);
      // And a census with nothing in it never divides by zero.
      expect(meterShare(party!, 0)).toBe(0);
      expect(largestRecords([])).toBe(0);
    });

    it("counts the vault in the app bar's one line", () => {
      expect(countLine(stats)).toBe("2 kinds · 9,214 records · 1.9 MB");
    });

    it("says a vault with nothing written has no kinds yet", () => {
      expect(
        countLine({
          ...stats,
          totals: { rows: 0, bytes: 0, kinds: 3, populatedKinds: 0 },
        })
      ).toBe("No kinds yet");
    });

    it("does not throw when packs or totals are missing", () => {
      const empty = {} as AtlasCensusPayload;
      expect(() => kindRowsFrom(empty, null, NOW)).not.toThrow();
      expect(kindRowsFrom(empty, null, NOW)).toStrictEqual([]);
      expect(() => holdsMeta(empty)).not.toThrow();
      expect(holdsMeta(empty)).toBe("");
      expect(() => countLine(empty)).not.toThrow();
      expect(countLine(empty)).toBe("");
      expect(
        kindRowsFrom(
          {
            ...stats,
            packs: [{ ...stats.packs[0]!, tables: undefined as never }],
          },
          null,
          NOW
        )
      ).toStrictEqual([]);
    });

    it("rejects a 200 body that is not a census", () => {
      expect(isCensusPayload({})).toBe(false);
      expect(isCensusPayload({ packs: [] })).toBe(false);
      expect(isCensusPayload({ totals: {} })).toBe(false);
      expect(isCensusPayload(stats)).toBe(true);
    });

    it("names yesterday and dates anything older", () => {
      expect(dayLabel("2026-07-16", NOW)).toBe("Yesterday");
      expect(dayLabel("2026-07-01", NOW)).not.toBe("Yesterday");
    });
  });

  describe("health", () => {
    it("carries both clauses when both reads landed", () => {
      // The backup clause is relative to the real clock (`relativeWhen`), so
      // the stamp is built from it rather than from the census' frozen day.
      const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
      expect(healthDetail(pulse, anHourAgo, NOW)).toBe(
        "Last write today. Last backup 1h ago."
      );
    });

    it("drops the clause it cannot support rather than guessing", () => {
      expect(healthDetail(pulse, null, NOW)).toBe("Last write today.");
      expect(healthDetail(null, null, NOW)).toBe(
        "Every kind opened without error."
      );
    });
  });

  describe("relations", () => {
    const graph: AtlasGraphPayload = {
      generatedAt: "2026-07-17T12:00:00.000Z",
      center: "core_party",
      nodes: [
        {
          physical: "core_party",
          logical: "core.party",
          table: "party",
          label: "Party",
          pack: "core",
          packKind: "ontology",
          packLabel: "Core",
          friendly: "People",
          hopDistance: 0,
          selfRef: false,
        },
        {
          physical: "knowledge_note",
          logical: "knowledge.note",
          table: "note",
          label: "Note",
          pack: "knowledge",
          packKind: "ontology",
          packLabel: "Knowledge",
          friendly: "Notes",
          hopDistance: 1,
          selfRef: false,
        },
      ],
      fkEdges: [
        {
          fromTable: "knowledge_note",
          fromLogical: "knowledge.note",
          fromPack: "knowledge",
          col: "author_party_id",
          toTable: "core_party",
          toLogical: "core.party",
          toPack: "core",
          notnull: false,
          childRows: 88,
          fill: 74,
          ghost: false,
          selfRef: false,
        },
      ],
      authoredLinks: [],
      island: [],
      edgeCount: 1,
      centerEdgeCount: 1,
      selfRefCount: 0,
    };

    it("prefers what a person authored, quoted in their own words", () => {
      const { rows, authored } = relationRowsFrom({
        ...graph,
        authoredLinks: [
          {
            relationConceptId: "wrote",
            relationLabel: "wrote",
            fromType: "core.party",
            toType: "knowledge.note",
            count: 41,
          },
          {
            relationConceptId: "edited",
            relationLabel: "edited",
            fromType: "core.party",
            toType: "knowledge.note",
            count: 3,
          },
        ],
      });
      expect(authored).toBe(true);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe("People → Notes");
      expect(rows[0]?.sub).toBe("“wrote”, “edited” · 44 links");
      expect(rows[0]?.logical).toBe("core.party");
    });

    it("falls back to what the schema enforces, and says so", () => {
      const { rows, authored } = relationRowsFrom(graph);
      expect(authored).toBe(false);
      expect(rows[0]?.title).toBe("Notes → People");
      expect(rows[0]?.sub).toBe("linked by author_party_id · 74 records");
    });

    it("has nothing to say before the graph lands", () => {
      expect(relationRowsFrom(null).rows).toStrictEqual([]);
    });

    it("does not throw when a fulfilled graph is an empty object", () => {
      expect(() => relationRowsFrom({} as AtlasGraphPayload)).not.toThrow();
      expect(relationRowsFrom({} as AtlasGraphPayload).rows).toStrictEqual([]);
    });
  });

  describe("the records table", () => {
    const cols: BrowseColumnsResult = {
      logical: "knowledge.note",
      physical: "knowledge_note",
      keysetKey: "note_id",
      displayField: "title",
      machinery: false,
      columns: ["note_id", "title", "kind", "updated_at", "secret"].map(
        (name) => ({
          name,
          type: "TEXT",
          notnull: false,
          pk: name === "note_id" ? 1 : 0,
          defaultValue: null,
          fkTable: null,
          fkColumn: null,
          fkLogical: null,
          sealed: name === "secret",
        })
      ),
    };

    it("declares every column the store has, in the store's own order", () => {
      expect(gridColumnsFrom(cols)).toStrictEqual([
        { key: "note_id", label: "note_id", pk: true, register: "mono" },
        { key: "title", label: "title" },
        { key: "kind", label: "kind" },
        { key: "updated_at", label: "updated_at" },
        { key: "secret", label: "secret", sealed: true },
      ]);
    });

    it("names what a reference points at, and puts it in the numeric register", () => {
      const [column] = gridColumnsFrom({
        ...cols,
        columns: [
          {
            ...cols.columns[1]!,
            fkColumn: "party_id",
            fkLogical: "core.party",
            fkTable: "core_party",
            name: "author_id",
          },
        ],
      });
      expect(column).toStrictEqual({
        fk: "core.party",
        key: "author_id",
        label: "author_id",
        register: "mono",
      });
    });

    it("passes the values through untouched — the grid is the store's reading", () => {
      const row = { note_id: "n1", title: "Lease", updated_at: 1_700_000_000 };
      expect(gridRowsFrom(cols, [row])).toStrictEqual([
        { id: "n1", name: "Lease", values: row },
      ]);
    });

    it("never prints a sealed value, even as a record's name", () => {
      const [row] = gridRowsFrom(cols, [{ note_id: "n1", title: "«sealed»" }]);
      expect(row?.name).toBe("Sealed");
    });

    it("opens on the kind's own time column, and on the keyset key without one", () => {
      expect(defaultSortKey(cols)).toBe("updated_at");
      expect(
        defaultSortKey({ ...cols, columns: cols.columns.slice(0, 2) })
      ).toBe("note_id");
    });

    it("states the order in the words that fit what is being ordered", () => {
      expect(sortLabel({ dir: "desc", key: "updated_at" }, "updated_at")).toBe(
        "Newest first"
      );
      expect(sortLabel({ dir: "asc", key: "updated_at" }, "updated_at")).toBe(
        "Oldest first"
      );
      expect(sortLabel({ dir: "asc", key: "title" }, "updated_at")).toBe(
        "title A–Z"
      );
      expect(sortLabel({ dir: "desc", key: "title" }, "updated_at")).toBe(
        "title Z–A"
      );
    });

    it("says how much of the kind is on screen, in the order it is in", () => {
      expect(tableCaption(6, 1908, "Newest first")).toBe(
        "The first 6 of 1,908, newest first — the table scrolls rather than pages."
      );
      expect(tableCaption(6, 1908, "title A–Z")).toContain("title a–z");
    });
  });

  describe("the census stamp", () => {
    it("says when the census was read, and nothing while it has not been", () => {
      expect(censusStamp(new Date(Date.now() - 3_600_000).toISOString())).toBe(
        "read 1h ago"
      );
      expect(censusStamp(null)).toBeUndefined();
    });
  });
});
