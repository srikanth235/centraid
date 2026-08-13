import { describe, expect, it } from "vitest";

import type {
  AtlasCensusPayload,
  AtlasGraphPayload,
  AtlasPulsePayload,
  BrowseColumnsResult,
} from "../../gateway-client.js";
import {
  countLine,
  dayLabel,
  docRowsFrom,
  healthDetail,
  kindGlyph,
  kindMeta,
  kindRowsFrom,
  kindSubLine,
  relationRowsFrom,
  tableCaption,
  writtenText,
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
    it("lists only written kinds, life data before plumbing", () => {
      const rows = kindRowsFrom(stats, pulse, NOW);
      expect(rows.map((r) => r.logical)).toStrictEqual([
        "core.party",
        "journal.segment",
      ]);
      expect(rows[1]?.machinery).toBe(true);
    });

    it("says what a kind holds, and adds today's writes only when there are some", () => {
      const [party, segment] = kindRowsFrom(stats, pulse, NOW);
      expect(kindSubLine(party!)).toBe(
        "214 records · 1.9 MB · 12 written today"
      );
      expect(kindSubLine(segment!)).toBe("9,000 records · 400 B");
    });

    it("reports the last write at the granularity the pulse actually has", () => {
      const [party, segment] = kindRowsFrom(stats, pulse, NOW);
      expect(kindMeta(party!, NOW)).toBe("Today");
      expect(kindMeta(segment!, NOW)).toBe("Quiet");
    });

    it("says nothing about writes at all when the pulse never landed", () => {
      const [party] = kindRowsFrom(stats, null, NOW);
      expect(kindMeta(party!, NOW)).toBeUndefined();
      expect(kindSubLine(party!)).toBe("214 records · 1.9 MB");
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

    it("draws the record, its own sub-kind, and when it was written", () => {
      const [row] = docRowsFrom(
        cols,
        [
          {
            note_id: "n1",
            title: "Lease — 14 Sitwell Road",
            kind: "pdf",
            updated_at: new Date(Date.now() - 300_000).toISOString(),
          },
        ],
        "Note"
      );
      expect(row).toMatchObject({
        icon: "Folder",
        id: "n1",
        kind: "pdf",
        title: "Lease — 14 Sitwell Road",
        written: "5m ago",
      });
    });

    it("falls back to the kind's own name, and leaves an unknown time empty", () => {
      const [row] = docRowsFrom(
        { ...cols, columns: cols.columns.slice(0, 2) },
        [{ note_id: "n1", title: "Untitled" }],
        "Note"
      );
      expect(row?.kind).toBe("Note");
      expect(row?.written).toBe("");
    });

    it("never prints a sealed value, even as a record's name", () => {
      const [row] = docRowsFrom(
        cols,
        [{ note_id: "n1", title: "«sealed»" }],
        "Note"
      );
      expect(row?.title).toBe("Sealed");
    });

    it("reads an epoch stamp as a moment", () => {
      expect(writtenText(Math.floor((Date.now() - 3_600_000) / 1000))).toBe(
        "1h ago"
      );
      expect(writtenText("not a date")).toBe("not a date");
    });

    it("says how much of the kind is on screen, and how the rest arrives", () => {
      expect(tableCaption(6, 1908)).toBe(
        "The first 6 of 1,908, newest first. The table scrolls rather than pages, the way the drive does."
      );
    });

    it("gives a kind a glyph from the ontology's own vocabulary", () => {
      expect(kindGlyph("core.party")).toBe("Users");
      expect(kindGlyph("media.photo")).toBe("Image");
      expect(kindGlyph("journal.segment")).toBe("Database");
    });
  });
});
