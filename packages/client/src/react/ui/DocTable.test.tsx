import { act } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DocTable from "./DocTable.js";

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

function setViewport(compact: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    addEventListener: () => {},
    matches: compact,
    media: query,
    removeEventListener: () => {},
  }));
}

const HEADERS = { kind: "Kind", record: "Record", written: "Written" };
const ROWS = [
  {
    id: "1",
    kind: "pdf",
    title: "Survey — 14 Bridge Street",
    written: "12 Aug 2026",
  },
  { id: "2", kind: "heic", title: "IMG_4417", written: "11 Aug 2026" },
];

describe("ui/DocTable", () => {
  beforeEach(() => setViewport(false));

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("draws the three column headers under a pointer", () => {
    const el = mount(
      <DocTable ariaLabel="Records" headers={HEADERS} rows={ROWS} />
    );
    const heads = [...el.querySelectorAll(".headCell")].map(
      (n) => n.textContent
    );
    expect(heads).toStrictEqual(["Record", "Kind", "Written"]);
  });

  it("reserves the row menu's own width in the header, as a spacer and not a control", () => {
    const el = mount(
      <DocTable ariaLabel="Records" headers={HEADERS} rows={ROWS} />
    );
    const slot = el.querySelector(".head .menuSlot") as HTMLElement;
    expect(slot.tagName).toBe("SPAN");
    expect(slot.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders every row's three cells", () => {
    const el = mount(
      <DocTable ariaLabel="Records" headers={HEADERS} rows={ROWS} />
    );
    expect(el.querySelectorAll(".row")).toHaveLength(2);
    expect(el.querySelector(".row .title")?.textContent).toBe(
      "Survey — 14 Bridge Street"
    );
    expect(el.querySelector(".row .cell.kind")?.textContent).toBe("pdf");
  });

  it("drops the header and folds the fixed columns into a snip line on compact", () => {
    setViewport(true);
    const el = mount(
      <DocTable ariaLabel="Records" headers={HEADERS} rows={ROWS} />
    );
    expect(el.querySelector(".head")).toBeNull();
    expect((el.querySelector(".table") as HTMLElement).dataset.compact).toBe(
      "true"
    );
    expect(el.querySelector(".snip")?.textContent).toBe("pdf · 12 Aug 2026");
  });

  it("labels each row's overflow control — an icon-only button without one does not ship", () => {
    const el = mount(
      <DocTable
        ariaLabel="Records"
        headers={HEADERS}
        menu={[{ icon: "Pencil", id: "edit", label: "Edit" }]}
        rows={ROWS}
      />
    );
    const labels = [...el.querySelectorAll("button")].map((b) =>
      b.getAttribute("aria-label")
    );
    expect(labels).toStrictEqual([
      "More for Survey — 14 Bridge Street",
      "More for IMG_4417",
    ]);
  });

  it("opens the overflow menu from the row and reports the picked item with its row", () => {
    const onMenuPick = vi.fn<(rowId: string, itemId: string) => void>();
    const el = mount(
      <DocTable
        ariaLabel="Records"
        headers={HEADERS}
        menu={[{ icon: "Pencil", id: "edit", label: "Edit" }]}
        onMenuPick={onMenuPick}
        rows={ROWS}
      />
    );
    act(() => {
      (el.querySelector("button") as HTMLButtonElement).click();
    });
    const item = [...document.querySelectorAll("button")].find(
      (node) =>
        node.textContent?.includes("Edit") && !node.getAttribute("aria-label")
    );
    act(() => item?.click());
    expect(onMenuPick).toHaveBeenCalledWith("1", "edit");
  });

  it("renders no row control at all when the table has no menu", () => {
    const el = mount(
      <DocTable ariaLabel="Records" headers={HEADERS} rows={ROWS} />
    );
    expect(el.querySelectorAll("button")).toHaveLength(0);
  });

  it("carries the caption under the table when there is one", () => {
    const el = mount(
      <DocTable
        ariaLabel="Records"
        caption="The first 6 of 1,908, newest first."
        headers={HEADERS}
        rows={ROWS}
      />
    );
    expect(el.querySelector(".caption")?.textContent).toBe(
      "The first 6 of 1,908, newest first."
    );
  });
});
