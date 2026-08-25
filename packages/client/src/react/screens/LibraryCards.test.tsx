import { act } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HomeAppItemDTO,
  HomeAutoItemDTO,
  HomeMenuAnchor,
} from "../screen-contracts.js";
import { AppCard, AutoCard } from "./LibraryCards.js";

// The card family's own coverage (it moved out of HomeScreen when Home became
// the springboard, #708). Starred and the automations overview both draw
// these, so the click/context/more-menu contract is tested once, here.

const appItem: HomeAppItemDTO = {
  id: "todos",
  name: "Todos",
  desc: "Small things",
  iconKey: "Todo",
  tile: { background: "#000", glyphColor: "#fff" },
  tone: null,
  stamp: "2h ago",
  starred: false,
};
const starredItem: HomeAppItemDTO = {
  id: "draft1",
  name: "Starred App",
  desc: "",
  iconKey: "Sparkle",
  tile: { background: "#111", glyphColor: "#fff" },
  tone: null,
  stamp: "saved",
  starred: true,
};
const autoItem: HomeAutoItemDTO = {
  ref: "a@1",
  name: "Digest",
  blurb: "Summarize inbox",
  glyphIcon: "Bolt",
  hue: "indigo",
  statusKind: "active",
  statusLabel: "Active",
  triggerIcon: "Clock",
  triggerLabel: "Daily",
  integrations: ["Gmail"],
  footTimeLabel: "2h ago",
  footOk: true,
  starred: false,
};

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

function click(el: Element | null): void {
  void act(() => el?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("screens/LibraryCards", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  describe(AppCard, () => {
    it("opens an installed app and names the tile from the name node", () => {
      const onOpen = vi.fn<(id: string) => void>();
      const el = mount(
        <AppCard
          a={appItem}
          onOpen={onOpen}
          onContext={vi.fn<(id: string, anchor: HomeMenuAnchor) => void>()}
        />
      );
      const card = el.querySelector('[data-testid="app-tile"]');
      expect(card?.getAttribute("aria-labelledby")).toBe("app-tile-name-todos");
      expect(el.querySelector("#app-tile-name-todos")?.textContent).toBe(
        "Todos"
      );
      click(card);
      expect(onOpen).toHaveBeenCalledWith("todos");
    });

    it("flags a starred tile", () => {
      const onOpen = vi.fn<(id: string) => void>();
      const el = mount(
        <AppCard
          a={starredItem}
          onOpen={onOpen}
          onContext={vi.fn<(id: string, anchor: HomeMenuAnchor) => void>()}
        />
      );
      click(el.querySelector('[data-testid="app-tile"]'));
      expect(onOpen).toHaveBeenCalledWith("draft1");
      expect(el.querySelector(".starFlag")).toBeTruthy();
    });

    it("right-click anchors the context menu at the pointer", () => {
      const onContext = vi.fn<(id: string, anchor: HomeMenuAnchor) => void>();
      const el = mount(
        <AppCard
          a={appItem}
          onOpen={vi.fn<(id: string) => void>()}
          onContext={onContext}
        />
      );
      void act(() =>
        el.querySelector('[data-testid="app-tile"]')?.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            clientX: 5,
            clientY: 6,
          })
        )
      );
      expect(onContext).toHaveBeenCalledWith("todos", {
        kind: "point",
        x: 5,
        y: 6,
      });
    });

    it("the more button anchors the same menu on the button's rect", () => {
      const onContext = vi.fn<(id: string, anchor: HomeMenuAnchor) => void>();
      const el = mount(
        <AppCard
          a={appItem}
          onOpen={vi.fn<(id: string) => void>()}
          onContext={onContext}
        />
      );
      click(el.querySelector('button[aria-label="More actions"]'));
      expect(onContext).toHaveBeenCalledWith(
        "todos",
        expect.objectContaining({ kind: "rect" })
      );
    });
  });

  describe(AutoCard, () => {
    it("renders the status/trigger strip and opens the automation", () => {
      const onOpen = vi.fn<(ref: string) => void>();
      const el = mount(
        <AutoCard
          r={autoItem}
          onOpen={onOpen}
          onMenu={vi.fn<(ref: string, anchor: HomeMenuAnchor) => void>()}
        />
      );
      expect(el.textContent).toContain("Digest");
      expect(el.textContent).toContain("Active");
      expect(el.textContent).toContain("Daily");
      click(el.querySelector('[data-kind="automation"]'));
      expect(onOpen).toHaveBeenCalledWith("a@1");
    });

    it("the more button opens the automation menu on a rect anchor", () => {
      const onMenu = vi.fn<(ref: string, anchor: HomeMenuAnchor) => void>();
      const el = mount(
        <AutoCard
          r={autoItem}
          onOpen={vi.fn<(ref: string) => void>()}
          onMenu={onMenu}
        />
      );
      click(el.querySelector('button[aria-label="More actions"]'));
      expect(onMenu).toHaveBeenCalledWith(
        "a@1",
        expect.objectContaining({ kind: "rect" })
      );
    });
  });
});
