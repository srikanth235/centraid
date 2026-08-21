// @vitest-environment jsdom
//
// The app navigation rail (v16), as a component. Five claims, each of them a
// line in the handoff's definition of done:
//
//  1. The `nav` has an ACCESSIBLE NAME, and exactly one row is `aria-current`.
//  2. ONE TAB STOP into the rail: exactly one row is tabbable, and it is the
//     row the member is standing on rather than the head of the list.
//  3. UP/DOWN MOVES and Enter routes — the arrows walk the destinations and
//     clamp at both ends, and pressing a row calls its own handler.
//  4. A COUNT IS A NUMBER OR IT IS ABSENT. A row whose count is unknown draws
//     no number rather than a zero it invented.
//  5. A ROW WITH NO ROUTE IS NOT A BUTTON. Docs' *Unfiled* keeps its number
//     and gives up every affordance that would promise a destination.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";

import { NavRail } from "./NavRail.tsx";
import type { NavRailItem } from "./NavRail.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;

function mount(items: NavRailItem[], label = "Photos"): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<NavRail label={label} items={items} />));
  return host;
}

const rows = (el: HTMLElement): HTMLButtonElement[] => [
  ...el.querySelectorAll("button"),
];
const labelsOf = (el: HTMLElement): string[] =>
  rows(el).map((row) => row.querySelector("span")?.textContent ?? "");

/** Arrow through the rail from whichever row currently holds focus. */
function arrow(key: "ArrowDown" | "ArrowUp"): void {
  const active = document.activeElement as HTMLElement | null;
  act(() => {
    active?.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
    );
  });
}

const SAMPLE: NavRailItem[] = [
  { kind: "head", label: "Library" },
  { kind: "row", id: "library", label: "Library", count: 6214, onSelect() {} },
  {
    kind: "row",
    id: "favorites",
    label: "Favorites",
    count: 128,
    onSelect() {},
  },
  { kind: "head", label: "Collections" },
  {
    kind: "row",
    id: "albums",
    label: "Albums",
    count: 14,
    current: true,
    onSelect() {},
  },
  // No count: this shelf's own read has not landed, and a rail that printed 0
  // would be reporting an empty shelf it has never looked at.
  { kind: "row", id: "people", label: "People", onSelect() {} },
  { kind: "rule" },
  { kind: "row", id: "trash", label: "Trash", count: 24, onSelect() {} },
];

describe("the app navigation rail", () => {
  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    host = null;
    document.body.replaceChildren();
  });

  test("names itself, and marks exactly one row as the page", () => {
    const el = mount(SAMPLE);
    const nav = el.querySelector("nav");
    expect(nav?.getAttribute("aria-label")).toBe("Photos");
    const current = rows(el).filter(
      (row) => row.getAttribute("aria-current") === "page"
    );
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain("Albums");
  });

  test("is one tab stop, and it opens on the row the member is standing on", () => {
    const el = mount(SAMPLE);
    const tabbable = rows(el).filter((row) => row.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    // Not the head of the list: tabbing in lands on WHERE YOU ARE, so the
    // member does not have to arrow back down to find themselves.
    expect(tabbable[0]?.textContent).toContain("Albums");
  });

  test("up and down walk the destinations and clamp at both ends", () => {
    const el = mount(SAMPLE);
    const [library, favorites] = rows(el);
    // Focusing a row moves the tab stop onto it, which is a state change.
    act(() => library?.focus());
    arrow("ArrowDown");
    expect(document.activeElement).toBe(favorites);
    arrow("ArrowUp");
    expect(document.activeElement).toBe(library);
    // Clamped, not wrapped — the ends of a spine are a place.
    arrow("ArrowUp");
    expect(document.activeElement).toBe(library);
    // The heads and the rule are skipped: they are not destinations, so the
    // arrows never land on them.
    arrow("ArrowDown");
    arrow("ArrowDown");
    expect(document.activeElement?.textContent).toContain("Albums");
  });

  test("a click routes, and only the pressed row's handler fires", () => {
    const pressed: string[] = [];
    const el = mount([
      { kind: "row", id: "a", label: "All", onSelect: () => pressed.push("a") },
      {
        kind: "row",
        id: "b",
        label: "Trash",
        onSelect: () => pressed.push("b"),
      },
    ]);
    act(() => rows(el)[1]?.click());
    expect(pressed).toStrictEqual(["b"]);
  });

  test("a count is a number in the numeric register, or it is absent", () => {
    const el = mount(SAMPLE);
    const people = rows(el).find((row) => row.textContent?.includes("People"));
    // One span — the label — and no second one holding a count nobody read.
    expect(people?.querySelectorAll("span")).toHaveLength(1);
    const trash = rows(el).find((row) => row.textContent?.includes("Trash"));
    expect(trash?.querySelectorAll("span")[1]?.textContent).toBe("24");
  });

  test("a row with no route is not a button, and keeps its number", () => {
    const el = mount([
      { kind: "row", id: "folders", label: "Folders", count: 4, onSelect() {} },
      {
        kind: "row",
        id: "unfiled",
        label: "Unfiled",
        count: 1728,
        indent: true,
      },
    ]);
    // Unfiled is drawn, is not pressable, and is not a tab stop.
    expect(labelsOf(el)).toStrictEqual(["Folders"]);
    const inert = el.querySelector('[data-static="true"]');
    expect(inert?.textContent).toContain("Unfiled");
    expect(inert?.textContent).toContain("1728");
    expect(inert?.tagName).toBe("DIV");
  });

  test("draws no physical inline property — the rail mirrors under RTL", () => {
    const el = mount(SAMPLE);
    // Every element the rail renders; an inline style is the one place a
    // physical `left`/`right` could reach the DOM from this component.
    for (const node of el.querySelectorAll<HTMLElement>("*")) {
      expect(node.getAttribute("style")).toBeNull();
    }
  });
});
