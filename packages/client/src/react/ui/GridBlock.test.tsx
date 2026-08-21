import { act } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GRID_CLIP_AT } from "@centraid/design/blocks";
import type { GridSortData } from "@centraid/design/blocks";

import GridBlock from "./GridBlock.js";
import type { GridColumn, GridRowDef } from "./GridBlock.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(node: JSX.Element): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(node);
  });
  return container;
}

const click = (node: Element | null | undefined): void => {
  act(() => {
    node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

const COLUMNS: readonly GridColumn[] = [
  { key: "id", label: "id", pk: true, register: "mono" },
  { key: "name", label: "name" },
  { fk: "core.place", key: "place_id", label: "place_id" },
  { key: "secret", label: "secret", sealed: true },
  { fixed: true, key: "blob", label: "blob" },
];

const ROWS: readonly GridRowDef[] = [
  {
    id: "p1",
    name: "Alice",
    values: {
      blob: "",
      id: "p1",
      name: "Alice",
      place_id: null,
      secret: "«sealed»",
    },
  },
];

describe("ui/GridBlock", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    for (const stray of document.querySelectorAll('[role="menu"]'))
      stray.remove();
  });

  describe("the columns", () => {
    it("draws every declared column, badges and all", () => {
      const el = mount(
        <GridBlock ariaLabel="Party records" columns={COLUMNS} rows={ROWS} />
      );
      expect([...el.querySelectorAll("th[data-col]")].map((n) => n.textContent))
        .toMatchInlineSnapshot(`
          [
            "idpk",
            "name",
            "place_idfk",
            "secret",
            "blob",
          ]
        `);
    });

    it("names what a foreign key points at, so a reference says to WHAT", () => {
      const el = mount(
        <GridBlock
          ariaLabel="Party records"
          columns={COLUMNS}
          onSort={() => {}}
          rows={ROWS}
        />
      );
      expect(
        el.querySelector<HTMLElement>('th[data-col="place_id"] button')?.title
      ).toBe("→ core.place");
    });

    it("draws a column the store cannot order by as a label, not a control", () => {
      const el = mount(
        <GridBlock
          ariaLabel="Party records"
          columns={COLUMNS}
          onSort={() => {}}
          rows={ROWS}
        />
      );
      expect(el.querySelector('th[data-col="blob"] button')).toBeNull();
      expect(el.querySelector('th[data-col="name"] button')).not.toBeNull();
    });

    it("offers no header control at all when the caller cannot reorder", () => {
      const el = mount(
        <GridBlock ariaLabel="Party records" columns={COLUMNS} rows={ROWS} />
      );
      expect(el.querySelectorAll("th button")).toHaveLength(0);
    });
  });

  describe("the sort", () => {
    it("asks for ascending first and turns the same column round on the second ask", () => {
      const onSort = vi.fn<(next: GridSortData) => void>();
      const el = mount(
        <GridBlock
          ariaLabel="Party records"
          columns={COLUMNS}
          onSort={onSort}
          rows={ROWS}
        />
      );
      click(el.querySelector('th[data-col="name"] button'));
      expect(onSort).toHaveBeenCalledExactlyOnceWith({
        dir: "asc",
        key: "name",
      });
    });

    it("states the order it is in, for the eye and for assistive tech alike", () => {
      const el = mount(
        <GridBlock
          ariaLabel="Party records"
          columns={COLUMNS}
          onSort={() => {}}
          rows={ROWS}
          sort={{ dir: "desc", key: "name" }}
        />
      );
      const sorted = el.querySelector<HTMLElement>('th[data-col="name"]');
      expect(sorted?.getAttribute("aria-sort")).toBe("descending");
      expect(sorted?.textContent).toContain("▼");
      expect(
        el
          .querySelector<HTMLElement>('th[data-col="id"]')
          ?.getAttribute("aria-sort")
      ).toBeNull();
    });
  });

  describe("the cells", () => {
    it("tells an absent value apart from an empty one", () => {
      const el = mount(
        <GridBlock ariaLabel="Party records" columns={COLUMNS} rows={ROWS} />
      );
      expect(
        el.querySelector('td[data-col="place_id"] [data-absent="null"]')
          ?.textContent
      ).toBe("null");
      expect(
        el.querySelector('td[data-col="blob"] [data-absent="blank"]')
          ?.textContent
      ).toBe("empty");
    });

    it("never prints a sealed value, sentinel or not", () => {
      const el = mount(
        <GridBlock ariaLabel="Party records" columns={COLUMNS} rows={ROWS} />
      );
      expect(el.textContent).not.toContain("«sealed»");
      expect(
        el.querySelector('[data-testid="grid-sealed"]')?.textContent
      ).toContain("sealed");
    });

    it("carries the register on the cell, so one grid holds both", () => {
      const el = mount(
        <GridBlock ariaLabel="Party records" columns={COLUMNS} rows={ROWS} />
      );
      expect(
        el.querySelector<HTMLElement>('td[data-col="id"]')?.dataset.register
      ).toBe("mono");
      expect(
        el.querySelector<HTMLElement>('td[data-col="name"]')?.dataset.register
      ).toBe("text");
    });

    it("cuts a long value reversibly rather than eliding it for good", () => {
      const long = "y".repeat(GRID_CLIP_AT + 20);
      const el = mount(
        <GridBlock
          ariaLabel="Party records"
          columns={COLUMNS}
          rows={[{ id: "p1", name: "Alice", values: { name: long } }]}
        />
      );
      const cell = () =>
        el.querySelector<HTMLButtonElement>('td[data-col="name"] button');
      expect(cell()?.textContent).toBe(`${"y".repeat(GRID_CLIP_AT)}…`);
      click(cell());
      expect(cell()?.textContent).toBe(long);
      expect(cell()?.dataset.expanded).toBe("true");
      click(cell());
      expect(cell()?.dataset.expanded).toBeUndefined();
    });
  });

  describe("the row menu", () => {
    it("names each row's control by the record, not by the verb", () => {
      const el = mount(
        <GridBlock
          ariaLabel="Party records"
          columns={COLUMNS}
          menu={[{ icon: "Eye", id: "open", label: "Open the record" }]}
          menuLabel="More for"
          rows={ROWS}
        />
      );
      expect(el.querySelector('[aria-label="More for Alice"]')).not.toBeNull();
    });

    it("draws no row control when the caller offers no menu", () => {
      const el = mount(
        <GridBlock ariaLabel="Party records" columns={COLUMNS} rows={ROWS} />
      );
      expect(el.querySelectorAll("button")).toHaveLength(0);
    });
  });

  it("takes every string from props — the kit ships no page copy", () => {
    const el = mount(
      <GridBlock
        ariaLabel="Party records"
        caption="The first 1 of 214."
        columns={COLUMNS}
        rows={ROWS}
      />
    );
    expect(el.querySelector("table")?.getAttribute("aria-label")).toBe(
      "Party records"
    );
    expect(el.querySelector("p")?.textContent).toBe("The first 1 of 214.");
  });
});
