import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  PaletteBridgeProps,
  PaletteGroupDTO,
} from "../screen-contracts.js";
import PaletteScreen from "./PaletteScreen.js";

type PaletteRun = NonNullable<PaletteGroupDTO["items"][number]["run"]>;

const buildRun = vi.fn<PaletteRun>();
const browseRun = vi.fn<PaletteRun>();
const appRun = vi.fn<PaletteRun>();

function groupsFor(query: string): PaletteGroupDTO[] {
  const build: PaletteGroupDTO = {
    group: "Build",
    items: [
      {
        label: query ? `Build ${query}` : "Build a new app",
        iconHtml: "<svg></svg>",
        variant: "action",
        accent: true,
        kbd: "↵",
        run: buildRun,
      },
      {
        label: "Browse templates",
        iconHtml: "",
        variant: "action",
        run: browseRun,
      },
    ],
  };
  const apps: PaletteGroupDTO = {
    group: "Apps · 1",
    items: [
      {
        label: "Todos",
        sub: "A todo app",
        iconHtml: "<svg></svg>",
        variant: "app",
        appMark: { colorKey: "ochre", iconKey: "Check" },
        meta: "2h",
        run: appRun,
      },
    ],
  };
  return [build, apps];
}

function makeProps(over: Partial<PaletteBridgeProps> = {}): PaletteBridgeProps {
  return {
    buildGroups: vi.fn<PaletteBridgeProps["buildGroups"]>(groupsFor),
    onClose: vi.fn<PaletteBridgeProps["onClose"]>(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
describe("screens/PaletteScreen", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });
  function mount(props: PaletteBridgeProps): HTMLDivElement {
    container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container as HTMLDivElement);
      root.render(<PaletteScreen {...props} />);
    });
    return container;
  }

  const rows = (el: HTMLElement): HTMLButtonElement[] =>
    [...el.querySelectorAll(".row")] as HTMLButtonElement[];

  describe(PaletteScreen, () => {
    it("renders grouped rows with the first row active", () => {
      const el = mount(makeProps());
      expect(el.querySelectorAll(".group")).toHaveLength(2);
      expect(rows(el)).toHaveLength(3);
      expect(rows(el)[0]?.dataset.active).toBe("true");
      // app-variant rows carry the shared single-tone mark.
      expect(el.querySelector('[data-app-mark="single-tone"]')).toBeTruthy();
    });

    it("moves the active row with ArrowDown and runs it on Enter", () => {
      const el = mount(makeProps());
      const input = el.querySelector(".input") as HTMLInputElement;
      void act(() =>
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
        )
      );
      expect(rows(el)[1]?.dataset.active).toBe("true");
      void act(() =>
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
        )
      );
      expect(browseRun).toHaveBeenCalledOnce();
      expect(buildRun).not.toHaveBeenCalled();
    });

    it("runs a row on click", () => {
      const el = mount(makeProps());
      void act(() =>
        rows(el)[2]?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      expect(appRun).toHaveBeenCalledOnce();
    });

    it("recomputes groups from the query and passes it to buildGroups", () => {
      const props = makeProps();
      const el = mount(props);
      const input = el.querySelector(".input") as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        globalThis.HTMLInputElement.prototype,
        "value"
      )?.set;
      act(() => {
        setter?.call(input, "notes");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(props.buildGroups).toHaveBeenCalledWith("notes");
      expect(el.textContent).toContain("Build notes");
    });

    it("renders an explicit no-results state", () => {
      const el = mount(
        makeProps({
          buildGroups: () => [],
        })
      );
      expect(el.querySelector("output")?.textContent).toContain("No results");
      expect(rows(el)).toHaveLength(0);
    });

    it("renders a group's icon marker with its identity hue (#708 §A point 2)", () => {
      const el = mount(
        makeProps({
          buildGroups: () => [
            {
              group: "Notes",
              icon: {
                html: "<svg data-icon='Book'></svg>",
                hue: "var(--c-slate)",
              },
              items: [
                {
                  label: "Trip notes",
                  kind: "note",
                  meta: "Aug 3",
                  iconHtml: "<svg></svg>",
                  variant: "action",
                  run: appRun,
                },
              ],
            },
          ],
        })
      );
      const groupIcon = el.querySelector(".groupIcon") as HTMLElement;
      expect(groupIcon).toBeTruthy();
      expect(groupIcon.style.getPropertyValue("--group-hue")).toBe(
        "var(--c-slate)"
      );
      // Row anatomy (point 3): kind (MONO) + the NUMERIC meta both render.
      expect(el.querySelector(".rowKind")?.textContent).toBe("note");
      expect(el.querySelector(".rowMeta")?.textContent).toBe("Aug 3");
    });

    it("shows suggestion chips only while the query is empty, and a click fills the field without running or closing (#708 §A point 4)", () => {
      const onClose = vi.fn<PaletteBridgeProps["onClose"]>();
      const el = mount(
        makeProps({
          onClose,
          suggestions: () => ["Alex Rivera", "Trip notes"],
        })
      );
      const chip = () =>
        [...el.querySelectorAll(".suggestionChip")] as HTMLButtonElement[];
      expect(chip().map((c) => c.textContent)).toStrictEqual([
        "Alex Rivera",
        "Trip notes",
      ]);

      void act(() =>
        chip()[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      const input = el.querySelector(".input") as HTMLInputElement;
      expect(input.value).toBe("Alex Rivera");
      expect(onClose).not.toHaveBeenCalled();
      expect(buildRun).not.toHaveBeenCalled();

      // Typing a query hides the chips — they're an empty-state affordance.
      expect(chip()).toHaveLength(0);
    });

    it("shows no chips when the palette has no suggestions to offer", () => {
      const el = mount(makeProps());
      expect(el.querySelectorAll(".suggestionChip")).toHaveLength(0);
    });

    it("closes on Escape and on backdrop click", () => {
      const props = makeProps();
      const el = mount(props);
      const input = el.querySelector(".input") as HTMLInputElement;
      void act(() =>
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        )
      );
      expect(props.onClose).toHaveBeenCalledOnce();
      const backdrop = el.querySelector(".backdrop") as HTMLElement;
      void act(() =>
        backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      expect(props.onClose).toHaveBeenCalledTimes(2);
    });
  });
});
