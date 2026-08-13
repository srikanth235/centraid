import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";

import AtlasRecordsSection from "./AtlasRecordsSection.js";

// The records section self-fetches through the vault client (its props are the
// kind, not its rows), so the client module is mocked wholesale and each helper
// resolves from a per-test vi.fn. vitest hoists this above the import above.
vi.mock(import("../../gateway-client.js"), () => ({
  browseColumns: (...a: Parameters<typeof browseColumnsMock>) =>
    browseColumnsMock(...a),
  browseRows: (...a: Parameters<typeof browseRowsMock>) => browseRowsMock(...a),
  browseRow: (...a: Parameters<typeof browseRowMock>) => browseRowMock(...a),
  browseRefSearch: (...a: Parameters<typeof browseRefSearchMock>) =>
    browseRefSearchMock(...a),
  browseDependents: (...a: Parameters<typeof browseDependentsMock>) =>
    browseDependentsMock(...a),
  browseInsertRow: (...a: Parameters<typeof browseInsertRowMock>) =>
    browseInsertRowMock(...a),
  browseUpdateRow: (...a: Parameters<typeof browseUpdateRowMock>) =>
    browseUpdateRowMock(...a),
  browseDeleteRow: (...a: Parameters<typeof browseDeleteRowMock>) =>
    browseDeleteRowMock(...a),
}));

/** The mocked module, so each stub carries the helper's real signature. */
type GatewayClient = typeof import("../../gateway-client.js");

const browseColumnsMock = vi.fn<GatewayClient["browseColumns"]>();
const browseRowsMock = vi.fn<GatewayClient["browseRows"]>();
const browseRowMock = vi.fn<GatewayClient["browseRow"]>();
const browseRefSearchMock = vi.fn<GatewayClient["browseRefSearch"]>();
const browseDependentsMock = vi.fn<GatewayClient["browseDependents"]>();
const browseInsertRowMock = vi.fn<GatewayClient["browseInsertRow"]>();
const browseUpdateRowMock = vi.fn<GatewayClient["browseUpdateRow"]>();
const browseDeleteRowMock = vi.fn<GatewayClient["browseDeleteRow"]>();

const SEALED = "«sealed»"; // «sealed»

const col = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  type: "TEXT",
  notnull: false,
  pk: 0,
  defaultValue: null,
  fkTable: null,
  fkColumn: null,
  fkLogical: null,
  sealed: false,
  ...over,
});

const PARTY_COLS = {
  logical: "core.party",
  physical: "core_party",
  keysetKey: "party_id",
  displayField: "display_name",
  machinery: false,
  columns: [
    col("party_id", { pk: 1, notnull: true }),
    col("display_name", { notnull: true }),
    col("home_place_id", {
      fkTable: "core_place",
      fkColumn: "place_id",
      fkLogical: "core.place",
    }),
    col("secret", { sealed: true }),
  ],
};

const MACHINERY_COLS = {
  logical: "journal.segment",
  physical: "journal_segment",
  keysetKey: "seq",
  displayField: "seq",
  machinery: true,
  columns: [col("seq", { type: "INTEGER", pk: 1, notnull: true }), col("note")],
};

const partyRow = (id: string, name: string, place: string | null) => ({
  party_id: id,
  display_name: name,
  home_place_id: place,
  secret: SEALED,
});

const partyPage = (
  rows: Record<string, unknown>[],
  nextCursor: string | null
) => ({
  logical: "core.party",
  physical: "core_party",
  rows,
  columns: ["party_id", "display_name", "home_place_id", "secret"],
  nextCursor,
  orderBy: "party_id",
  dir: "desc" as const,
  keysetKey: "party_id",
});

describe("screens/AtlasRecordsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browseColumnsMock.mockImplementation((t: string) =>
      Promise.resolve(t === "journal.segment" ? MACHINERY_COLS : PARTY_COLS)
    );
    browseRowsMock.mockImplementation(({ table }: { table: string }) =>
      Promise.resolve(
        table === "journal.segment"
          ? {
              logical: "journal.segment",
              physical: "journal_segment",
              rows: [{ seq: 1, note: "boot" }],
              columns: ["seq", "note"],
              nextCursor: null,
              orderBy: "seq",
              dir: "desc",
              keysetKey: "seq",
            }
          : partyPage(
              [partyRow("p1", "Alice", "place-1"), partyRow("p2", "Bob", null)],
              null
            )
      )
    );
    browseRefSearchMock.mockResolvedValue([
      { id: "place-1", display: "Alice’s Home" },
    ]);
    browseDependentsMock.mockResolvedValue({
      logical: "core.party",
      physical: "core_party",
      id: "p1",
      dependents: [],
      hasEngineDependents: false,
      totalRows: 0,
    });
    browseInsertRowMock.mockResolvedValue({ ok: true, id: "new-1" });
    browseUpdateRowMock.mockResolvedValue({ ok: true, id: "p1" });
    browseDeleteRowMock.mockResolvedValue({ ok: true, id: "p1" });
  });

  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    // The row menu portals to <body>; a leftover would answer the next test.
    for (const stray of document.querySelectorAll('[role="menu"]'))
      stray.remove();
  });

  async function settle(n = 6): Promise<void> {
    await forEachSequentially(Array.from({ length: n }), async () => {
      await act(async () => {
        await Promise.resolve();
      });
    });
  }

  async function mount(
    logical = "core.party",
    label = "Party",
    records = 214
  ): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(
        <AtlasRecordsSection
          label={label}
          logical={logical}
          records={records}
        />
      );
    });
    await settle();
    return container;
  }

  const click = async (node: Element | null | undefined): Promise<void> => {
    await act(async () =>
      node?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    await settle(3);
  };

  const $ = (el: ParentNode, sel: string) => el.querySelector<HTMLElement>(sel);
  const $$ = (el: ParentNode, sel: string) => [
    ...el.querySelectorAll<HTMLElement>(sel),
  ];

  const buttonSaying = (el: ParentNode, text: string) =>
    $$(el, "button").find((b) => b.textContent?.includes(text));

  /** Open a record's overflow menu and pick an item by its words. */
  const pickFromRowMenu = async (
    el: HTMLElement,
    rowTitle: string,
    item: string
  ): Promise<void> => {
    await click($(el, `[aria-label="More for ${rowTitle}"]`));
    const entry = $$(document.body, '[role="menuitem"]').find((m) =>
      m.textContent?.includes(item)
    );
    await click(entry);
  };

  describe("the table", () => {
    it("reads the newest first and captions how much of the kind is shown", async () => {
      const el = await mount();
      expect(browseRowsMock.mock.calls[0]?.[0]).toMatchObject({
        dir: "desc",
        table: "core.party",
      });
      expect(el.textContent).toContain("Alice");
      expect(el.textContent).toContain("Bob");
      expect(el.textContent).toContain(
        "The first 2 of 214, newest first. The table scrolls rather than pages, the way the drive does."
      );
    });

    it("appends the next keyset page rather than replacing what is read", async () => {
      browseRowsMock
        .mockResolvedValueOnce(
          partyPage([partyRow("p1", "Alice", "place-1")], "cursor-1")
        )
        .mockResolvedValueOnce(partyPage([partyRow("p2", "Bob", null)], null));

      const el = await mount();
      expect(el.textContent).toContain("Alice");
      expect(el.textContent).not.toContain("Bob");

      await click(buttonSaying(el, "Show more records"));

      // Keyset, never OFFSET: the second read carried the prior cursor.
      expect(browseRowsMock.mock.calls.at(-1)?.[0].after).toBe("cursor-1");
      expect(el.textContent).toContain("Alice");
      expect(el.textContent).toContain("Bob");
    });
  });

  describe("the row menu", () => {
    it("opens the record and updates only edited, non-primary, unsealed fields", async () => {
      const el = await mount();
      await pickFromRowMenu(el, "Alice", "Open the record");

      await act(async () => {
        const input = $(
          el,
          '[data-testid="atlas-field"][data-col="display_name"]'
        ) as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value"
        )?.set;
        setter?.call(input, "Alice Cooper");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settle(3);
      await act(async () =>
        $(el, '[data-testid="atlas-row-editor"]')?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        )
      );
      await settle(3);

      expect(browseUpdateRowMock).toHaveBeenCalledExactlyOnceWith({
        table: "core.party",
        id: "p1",
        set: { display_name: "Alice Cooper" },
      });
    });

    it("asks what depends on a row before deleting it", async () => {
      browseDependentsMock.mockResolvedValue({
        logical: "core.party",
        physical: "core_party",
        id: "p1",
        dependents: [
          { table: "core_tag", via: "target_id", count: 3, mechanism: "poly" },
        ],
        hasEngineDependents: false,
        totalRows: 3,
      });
      const el = await mount();
      await pickFromRowMenu(el, "Alice", "Delete");

      expect(browseDependentsMock).toHaveBeenCalledWith("core.party", "p1");
      expect(
        $(document.body, '[data-testid="atlas-delete-warn"]')
      ).toBeTruthy();
      await click($(document.body, '[data-testid="atlas-delete-confirm"]'));
      expect(browseDeleteRowMock).toHaveBeenCalledWith({
        table: "core.party",
        id: "p1",
      });
    });

    it("blocks the delete when engine foreign keys still point at the row", async () => {
      browseDependentsMock.mockResolvedValue({
        logical: "core.party",
        physical: "core_party",
        id: "p1",
        dependents: [
          {
            table: "knowledge_note",
            via: "author_party_id",
            count: 12,
            mechanism: "fk",
          },
        ],
        hasEngineDependents: true,
        totalRows: 12,
      });
      const el = await mount();
      await pickFromRowMenu(el, "Alice", "Delete");

      expect(
        $(document.body, '[data-testid="atlas-delete-blocked"]')
      ).toBeTruthy();
      expect(
        (
          $(
            document.body,
            '[data-testid="atlas-delete-confirm"]'
          ) as HTMLButtonElement
        ).disabled
      ).toBe(true);
      expect(browseDeleteRowMock).not.toHaveBeenCalled();
    });
  });

  describe("writes", () => {
    it("inserts through the journalled path, storing a picked FK id", async () => {
      const el = await mount();
      await click(buttonSaying(el, "Insert a record"));
      expect($(el, '[data-testid="atlas-row-editor"]')).toBeTruthy();

      const typeInto = async (sel: string, value: string): Promise<void> => {
        await act(async () => {
          const input = $(el, sel) as HTMLInputElement;
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value"
          )?.set;
          setter?.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await settle(3);
      };

      await typeInto(
        '[data-testid="atlas-fk-input"][data-col="home_place_id"]',
        "ali"
      );
      expect(browseRefSearchMock).toHaveBeenCalledWith("core_place", "ali");
      await click($(el, '[data-testid="atlas-fk-hit"][data-id="place-1"]'));
      await typeInto(
        '[data-testid="atlas-field"][data-col="display_name"]',
        "Carol"
      );
      await act(async () =>
        $(el, '[data-testid="atlas-row-editor"]')?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        )
      );
      await settle(3);

      const arg = browseInsertRowMock.mock.calls[0]?.[0];
      expect(arg?.values.home_place_id).toBe("place-1"); // the id, not the text
      expect(arg?.values.display_name).toBe("Carol");
      expect(arg?.values.secret).toBeUndefined(); // sealed column never written
    });
  });

  describe("machinery", () => {
    it("locks writes until the unlock is toggled, and withholds Delete meanwhile", async () => {
      const el = await mount("journal.segment", "Segment", 4021);
      expect($(el, '[data-testid="atlas-machinery-locked"]')).toBeTruthy();
      expect(
        (buttonSaying(el, "Insert a record") as HTMLButtonElement).disabled
      ).toBe(true);

      await click($(el, '[aria-label="More for 1"]'));
      expect(
        $$(document.body, '[role="menuitem"]').some((m) =>
          m.textContent?.includes("Delete")
        )
      ).toBe(false);
      await click($(document.body, '[role="menuitem"]'));

      await click($(el, '[data-testid="atlas-machinery-unlock"]'));
      expect(
        (buttonSaying(el, "Insert a record") as HTMLButtonElement).disabled
      ).toBe(false);
    });
  });
});
