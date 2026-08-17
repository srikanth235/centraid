// @vitest-environment jsdom
// THE NAMING CONVERSATION (issue #816), on the web.
//
// `place-phrase.test.ts` proves the ladder; this proves the app ASKS. Four
// claims, and each of them is a way the surface could regress into printing a
// coordinate or into asking a question nobody can answer:
//
//   1. THE ASK STANDS WHERE THE FALLBACK STANDS. A section whose place has no
//      readable name gets the prompt; a named one gets nothing to answer, and
//      neither ever renders the digits as a heading.
//   2. A COORDINATE LABEL IS NOT A NAME. `findOrCreatePlaceTx` names a fresh
//      place after its own coordinate, so "37.4419, -122.1430" must read as
//      unnamed here and draw the prompt like any other.
//   3. TYPING A NAME WRITES ONE — through `name-place`, with the place id the
//      heading was drawn from, and nothing else in the input.
//   4. "This is home" IS ONE TAP and carries `kind: 'home'`, which is the
//      declaration every relative phrase anchors on.
//
// A real render (createRoot + act) rather than static markup, because the
// prompt holds state and the point of the file is what a press writes.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createElement, act } from "react";
import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const app = (rel: string): string =>
  pathToFileURL(path.resolve(import.meta.dirname, "..", rel)).href;

interface Asset {
  asset_id: string;
  scope_id?: string | null;
  place?: { place_id: string; name: string } | null;
}
interface PlaceSection {
  key: string;
  name: string | null;
  assets: Asset[];
  lat: number | null;
  lng: number | null;
}
interface PlacesShelfProps {
  sections: readonly PlaceSection[];
  containerWidth: number;
  targetHeight: number;
  rung: number;
  selectMode: boolean;
  selectedIds: Set<string>;
  vaultOf: (scopeId: string | null | undefined) => undefined;
  refresh: () => Promise<void>;
  onOpen: (key: string) => void;
  onToggleSelect: (key: string) => void;
  onEnterSelectMode: () => void;
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Write {
  action: string;
  input?: Record<string, unknown>;
  scope?: string;
}
let writes: Write[] = [];
let refreshes = 0;

// The shell's client seam, as much of it as this surface reaches for. `write`
// answers "executed" so the component takes the success path.
(window as unknown as { centraid: unknown }).centraid = {
  write: (request: Write) => {
    writes.push(request);
    return Promise.resolve({ status: "executed" });
  },
};

const { PlacesShelf } = (await import(app("components/Places.tsx"))) as {
  PlacesShelf: ComponentType<PlacesShelfProps>;
};
const { PLACE_UNNAMED } = (await import(app("view-copy.ts"))) as {
  PLACE_UNNAMED: string;
};

function section(key: string, name: string | null): PlaceSection {
  return {
    key,
    name,
    assets: [{ asset_id: `${key}-a`, scope_id: "" }],
    lat: 37.4419,
    lng: -122.143,
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(sections: readonly PlaceSection[]): void {
  act(() => {
    root = createRoot(container!);
    root.render(
      createElement(PlacesShelf, {
        sections,
        containerWidth: 800,
        targetHeight: 160,
        rung: 2,
        selectMode: false,
        selectedIds: new Set<string>(),
        vaultOf: () => undefined,
        refresh: () => {
          refreshes += 1;
          return Promise.resolve();
        },
        onOpen: () => undefined,
        onToggleSelect: () => undefined,
        onEnterSelectMode: () => undefined,
      })
    );
  });
}

const buttons = (): HTMLButtonElement[] =>
  Array.from(container!.querySelectorAll("button"));

const pressing = (label: string): HTMLButtonElement | undefined =>
  buttons().find((button) => button.textContent === label);

function click(button: HTMLButtonElement | undefined): void {
  expect(button).toBeDefined();
  act(() => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

/** Type into the open input and press Enter, the way `InlineInput` submits. */
function type(text: string): void {
  const input = container!.querySelector("input");
  expect(input).toBeDefined();
  act(() => {
    input!.value = text;
    input!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    );
  });
}

describe("naming a place from the Places shelf", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    writes = [];
    refreshes = 0;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("asks on the section whose place has no name, and prints no coordinate", () => {
    render([section("p-coord", "37.4419, -122.1430")]);
    expect(container!.textContent).toContain(PLACE_UNNAMED);
    expect(container!.textContent).not.toContain("37.4419");
    expect(pressing("Name this place?")).toBeDefined();
    expect(pressing("This is home")).toBeDefined();
  });

  it("asks nothing of a place the member already named", () => {
    render([section("p-named", "Grandma's house")]);
    expect(container!.textContent).toContain("Grandma's house");
    expect(pressing("Name this place?")).toBeUndefined();
    expect(pressing("This is home")).toBeUndefined();
  });

  it("asks nothing of the group whose place is unknown — there is no row to name", () => {
    render([section("", null)]);
    expect(container!.textContent).toContain(PLACE_UNNAMED);
    expect(pressing("Name this place?")).toBeUndefined();
  });

  it("writes the name the member typed, for the place the heading named", async () => {
    render([section("p-coord", "37.4419, -122.1430")]);
    click(pressing("Name this place?"));
    type("  Grandma's house  ");
    // The write and the re-read are one chain of promises; let it settle before
    // asking whether the surface was told to re-phrase.
    await act(async () => undefined);
    expect(writes).toStrictEqual([
      {
        action: "name-place",
        input: { place_id: "p-coord", name: "Grandma's house" },
      },
    ]);
    expect(refreshes).toBe(1);
  });

  it("declares home in one tap, with the kind every relative phrase anchors on", () => {
    render([section("p-coord", "37.4419, -122.1430")]);
    click(pressing("This is home"));
    expect(writes).toStrictEqual([
      {
        action: "name-place",
        input: { place_id: "p-coord", name: "Home", kind: "home" },
      },
    ]);
  });

  it("writes nothing when the member abandons the input", () => {
    render([section("p-coord", "37.4419, -122.1430")]);
    click(pressing("Name this place?"));
    const input = container!.querySelector("input");
    act(() => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    expect(writes).toStrictEqual([]);
    expect(pressing("Name this place?")).toBeDefined();
  });
});
