import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";

import type {
  AtlasCensusPayload,
  AtlasGraphPayload,
  AtlasPulsePayload,
} from "../../gateway-client.js";
import { readVitals, resetVitals } from "../shell/routeVitals.js";
import { readRouteHealth, resetStatus } from "../shell/statusChannel.js";
import AtlasScreen from "./AtlasScreen.js";
import type { AtlasScreenProps } from "./AtlasScreen.js";

// The records section under the block list self-fetches through the vault
// client; stub those helpers so the page can be exercised without a gateway
// (the section's own behaviour is covered in AtlasRecordsSection.test.tsx).
// vitest hoists this mock above the imports above.
vi.mock(import("../../gateway-client.js"), () => ({
  browseColumns: () =>
    Promise.resolve({
      logical: "core.party",
      physical: "core_party",
      keysetKey: "party_id",
      displayField: "display_name",
      machinery: false,
      // Both columns are DECLARED, because the grid draws the columns the
      // store declares and nothing else — a value in a row the columns never
      // mentioned is a value the store did not offer.
      columns: [
        {
          name: "party_id",
          type: "TEXT",
          notnull: true,
          pk: 1,
          defaultValue: null,
          fkTable: null,
          fkColumn: null,
          fkLogical: null,
          sealed: false,
        },
        {
          name: "display_name",
          type: "TEXT",
          notnull: true,
          pk: 0,
          defaultValue: null,
          fkTable: null,
          fkColumn: null,
          fkLogical: null,
          sealed: false,
        },
      ],
    }),
  browseRows: () =>
    Promise.resolve({
      logical: "core.party",
      physical: "core_party",
      rows: [{ party_id: "p1", display_name: "Alice" }],
      columns: ["party_id", "display_name"],
      nextCursor: null,
      orderBy: "party_id",
      dir: "desc",
      keysetKey: "party_id",
    }),
  browseRow: () =>
    Promise.resolve({ logical: "", physical: "", row: {}, columns: [] }),
  browseRefSearch: () => Promise.resolve([]),
  browseDependents: () =>
    Promise.resolve({
      logical: "",
      physical: "",
      id: "",
      dependents: [],
      hasEngineDependents: false,
      totalRows: 0,
    }),
  browseInsertRow: () => Promise.resolve({ ok: true }),
  browseUpdateRow: () => Promise.resolve({ ok: true }),
  browseDeleteRow: () => Promise.resolve({ ok: true }),
}));

const GENERATED_AT = "2026-07-17T12:00:00.000Z";
const SINCE = "2026-06-17T12:00:00.000Z";

const table = (
  logical: string,
  label: string,
  rows: number,
  bytes: number | null
) => ({
  logical,
  physical: logical.replace(".", "_"),
  table: logical.split(".")[1] ?? logical,
  label,
  rows,
  bytes,
  pages: bytes === null ? null : 1,
});

function makeStats(over: Partial<AtlasCensusPayload> = {}): AtlasCensusPayload {
  return {
    generatedAt: GENERATED_AT,
    method: "dbstat",
    fileBytesTotal: 4_400_000_000,
    packs: [
      {
        pack: "core",
        packLabel: "Core",
        packKind: "ontology",
        file: "vault",
        rows: 214,
        bytes: 3_000_000,
        tables: [
          table("core.party", "Party", 214, 2_000_000),
          table("core.place", "Place", 0, 0),
        ],
      },
      {
        pack: "consent",
        packLabel: "Consent",
        packKind: "machinery",
        file: "vault",
        rows: 12,
        bytes: 40_000,
        tables: [table("consent.device", "Device", 12, 40_000)],
      },
    ],
    totals: { rows: 226, bytes: 3_040_000, kinds: 3, populatedKinds: 2 },
    ...over,
  };
}

/** A census with enough written kinds to tip the page into `full`. */
function makeFullStats(): AtlasCensusPayload {
  const tables = Array.from({ length: 10 }, (_u, i) =>
    table(`core.k${i}`, `Kind ${i}`, 100 - i, 1000 * (i + 1))
  );
  return makeStats({
    packs: [
      {
        pack: "core",
        packLabel: "Core",
        packKind: "ontology",
        file: "vault",
        rows: 955,
        bytes: 55_000,
        tables,
      },
    ],
    totals: { rows: 955, bytes: 55_000, kinds: 12, populatedKinds: 10 },
  });
}

function makePulse(): AtlasPulsePayload {
  return {
    generatedAt: GENERATED_AT,
    since: SINCE,
    windowDays: 30,
    live: true,
    series: [
      {
        entityType: "core.party",
        physical: "core_party",
        pack: "core",
        label: "Party",
        total: 9,
        days: [{ day: "2026-07-10", count: 9 }],
      },
    ],
  };
}

function makeGraph(over: Partial<AtlasGraphPayload> = {}): AtlasGraphPayload {
  return {
    generatedAt: GENERATED_AT,
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
    fkEdges: [],
    authoredLinks: [
      {
        relationConceptId: "wrote",
        relationLabel: "wrote",
        fromType: "core.party",
        toType: "knowledge.note",
        count: 41,
      },
    ],
    island: [],
    edgeCount: 1,
    centerEdgeCount: 1,
    selfRefCount: 0,
    ...over,
  };
}

function makeProps(over: Partial<AtlasScreenProps> = {}): AtlasScreenProps {
  return {
    loadStats: vi
      .fn<AtlasScreenProps["loadStats"]>()
      .mockResolvedValue(makeStats()),
    loadPulse: vi
      .fn<AtlasScreenProps["loadPulse"]>()
      .mockResolvedValue(makePulse()),
    loadGraph: vi
      .fn<AtlasScreenProps["loadGraph"]>()
      .mockResolvedValue(makeGraph()),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

describe("screens/AtlasScreen", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    resetVitals();
    resetStatus();
    vi.restoreAllMocks();
  });

  async function render(props: AtlasScreenProps): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(<AtlasScreen {...props} />);
    });
    return container;
  }

  async function settle(n = 8): Promise<void> {
    await forEachSequentially(Array.from({ length: n }), async () => {
      await act(async () => {
        await Promise.resolve();
      });
    });
  }

  async function mount(props: AtlasScreenProps): Promise<HTMLDivElement> {
    const el = await render(props);
    await settle();
    return el;
  }

  const $$ = (el: ParentNode, sel: string) => [
    ...el.querySelectorAll<HTMLElement>(sel),
  ];
  const rowsUnder = (el: HTMLElement, label: string) =>
    $$(el, `fieldset[aria-label="${label}"] .row`);
  const click = async (node: Element | null | undefined): Promise<void> => {
    await act(async () =>
      node?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    await settle(4);
  };

  describe("the block list", () => {
    it("lists every kind the schema defines, with whose it is and what it holds", async () => {
      const el = await mount(makeProps());
      const rows = rowsUnder(el, "Kinds");
      // Every kind, never-written ones included — the count and the list agree.
      expect(rows).toHaveLength(3);
      expect(rows[0]?.textContent).toContain("Party");
      expect(rows[0]?.textContent).toContain("Core"); // the pack, drawn at last
      expect(rows[0]?.textContent).toContain("214 records");
      expect(rows[0]?.textContent).toContain("1.9 MB");
      expect(el.textContent).toContain("showing 3 of 3");
    });

    it("draws a never-written kind as an inert ghost row rather than dropping it", async () => {
      const el = await mount(makeProps());
      const ghost = rowsUnder(el, "Kinds").find((r) =>
        r.textContent?.includes("Place")
      );
      expect(ghost?.textContent).toContain("Never written");
      expect(ghost?.dataset.off).toBe("true");
      const verb = ghost?.querySelector("button");
      // The verb keeps its word and refuses: there is nothing to browse.
      expect(verb?.textContent).toContain("Browse");
      expect((verb as HTMLButtonElement | null)?.disabled).toBe(true);
    });

    it("stamps the census with when it was read, and reads it again on ask", async () => {
      const loadStats = vi
        .fn<AtlasScreenProps["loadStats"]>()
        .mockResolvedValue(makeStats());
      const el = await mount(makeProps({ loadStats }));
      expect(el.textContent).toContain("read just now");
      await click(
        [...el.querySelectorAll("button")].find(
          (b) => b.textContent === "Refresh"
        )
      );
      expect(loadStats).toHaveBeenCalledTimes(2);
    });

    it("explains what a kind is, in the words the design pinned", async () => {
      const el = await mount(makeProps());
      expect(el.textContent).toContain(
        "A kind is a shape of record an app writes. Sizes include every version kept."
      );
    });

    it("names the relations a person authored and keeps the map reachable", async () => {
      const el = await mount(makeProps());
      const rows = rowsUnder(el, "How they relate");
      expect(rows[0]?.textContent).toContain("People → Notes");
      expect(rows[0]?.textContent).toContain("“wrote”");
      expect(rows[0]?.textContent).toContain("41 links");
      // The orrery is not a block shape, so it keeps a door rather than dying.
      expect(rows.at(-1)?.textContent).toContain("The whole map");
      expect(rows.at(-1)?.textContent).toContain("Open the map");
    });

    it("shows the fullest kind's records, and browses another on demand", async () => {
      const el = await mount(makeProps());
      expect(el.textContent).toContain("Alice"); // the records table
      const deviceRow = rowsUnder(el, "Kinds").find((r) =>
        r.textContent?.includes("Device")
      );
      await click(
        [...(deviceRow?.querySelectorAll("button") ?? [])].find((b) =>
          b.textContent?.includes("Browse")
        )
      );
      // The section head follows the kind that was asked for.
      expect(el.textContent).toContain("Device");
    });
  });

  describe("the frame's slots", () => {
    it("publishes the count line and the readable health from live data", async () => {
      await mount(makeProps());
      expect(readVitals("atlas")).toStrictEqual({
        count: "2 kinds · 226 records · 2.9 MB",
        state: "ready",
      });
      const health = readRouteHealth();
      expect(health?.text).toContain("Everything is readable");
      // No backup reader was given, so no backup clause is invented.
      expect(health?.text).not.toContain("backup");
    });

    it("carries the backup clause when the gateway can supply one", async () => {
      await mount(
        makeProps({
          loadLastBackupAt: () =>
            Promise.resolve(new Date(Date.now() - 3_600_000).toISOString()),
        })
      );
      expect(readRouteHealth()?.text).toContain("Last backup 1h ago.");
    });
  });

  describe("the five states", () => {
    it("holds the row geometry while it reads, and says why", async () => {
      const el = await render(
        makeProps({
          loadStats: vi
            .fn<AtlasScreenProps["loadStats"]>()
            .mockReturnValue(new Promise(() => {})),
        })
      );
      expect(
        el.querySelector('[aria-label="Reading your vault’s census"]')
      ).toBeTruthy();
      expect(el.textContent).toContain(
        "A row knows its shape before its content arrives"
      );
      expect(readVitals("atlas")?.state).toBe("loading");
    });

    it("says a vault with nothing in it is not a failure", async () => {
      const el = await mount(
        makeProps({
          loadStats: vi.fn<AtlasScreenProps["loadStats"]>().mockResolvedValue(
            makeStats({
              packs: [],
              totals: { rows: 0, bytes: 0, kinds: 0, populatedKinds: 0 },
            })
          ),
        })
      );
      expect(el.textContent).toContain("This vault is empty");
      expect(el.textContent).toContain(
        "Kinds appear here as apps write records. Nothing is created until an app or an import puts something in."
      );
      // Nothing to commit on an empty read surface.
      expect(el.querySelectorAll("button")).toHaveLength(0);
      expect(readVitals("atlas")?.state).toBe("empty");
    });

    it("says what failed, what is still safe, and one way forward", async () => {
      const loadStats = vi
        .fn<AtlasScreenProps["loadStats"]>()
        .mockRejectedValueOnce(new Error("permission denied"))
        .mockResolvedValue(makeStats());
      const el = await mount(makeProps({ loadStats }));
      expect(el.textContent).toContain("Cannot open the store");
      expect(el.textContent).toContain(
        "The vault is encrypted and present on disk. The gateway could not open it, which is usually a permissions problem on the machine rather than damage to the data."
      );
      expect(readVitals("atlas")?.state).toBe("error");

      await click(
        [...el.querySelectorAll("button")].find((b) =>
          b.textContent?.includes("Try again")
        )
      );
      expect(loadStats).toHaveBeenCalledTimes(2);
      expect(el.textContent).toContain("Party");
    });

    it("grows a filter row once the list is long, and filters on it", async () => {
      const el = await mount(
        makeProps({
          loadStats: vi
            .fn<AtlasScreenProps["loadStats"]>()
            .mockResolvedValue(makeFullStats()),
        })
      );
      expect(readVitals("atlas")?.state).toBe("full");
      const chips = $$(el, 'fieldset[aria-label="Filter kinds"] button');
      expect(chips.map((c) => c.textContent)).toStrictEqual([
        "All kinds",
        "Largest",
        "Written today",
        "Never written",
      ]);
      expect(rowsUnder(el, "Kinds")).toHaveLength(10);

      // Nothing was written today in this census, so the chip empties the list
      // rather than pretending otherwise.
      await click(chips.find((c) => c.textContent === "Written today"));
      expect(rowsUnder(el, "Kinds")).toHaveLength(0);
      expect(el.textContent).toContain("showing 0 of 12");
    });

    it("isolates the never-written kinds the count line names", async () => {
      const el = await mount(makeProps());
      const chips = $$(el, 'fieldset[aria-label="Filter kinds"] button');
      // Three kinds is under the threshold, so this census draws no chip row —
      // the filter is exercised on the long one, which is where it matters.
      expect(chips).toHaveLength(0);

      const full = await mount(
        makeProps({
          loadStats: vi
            .fn<AtlasScreenProps["loadStats"]>()
            .mockResolvedValue(makeFullStats()),
        })
      );
      await click(
        $$(full, 'fieldset[aria-label="Filter kinds"] button').find(
          (c) => c.textContent === "Never written"
        )
      );
      // This census has written every kind it declares, so the answer is
      // honestly empty rather than a list of the ones that DO hold something.
      expect(rowsUnder(full, "Kinds")).toHaveLength(0);
    });
  });
});
