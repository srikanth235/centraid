import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HOME_FIRST_RUN_BODY,
  HOME_FIRST_RUN_PLACEHOLDERS,
  HOME_FIRST_RUN_TITLE,
} from "../../home-copy.js";
import { buildHomeTiles } from "../shell/routes/homeTiles.js";
import type { HomeTileContent } from "../shell/routes/homeTiles.js";
import HomeSpringboard from "./HomeSpringboard.js";
import type { HomeSpringboardProps } from "./HomeSpringboard.js";

const INSTALLED = [
  "agenda",
  "tasks",
  "photos",
  "notes",
  "docs",
  "people",
  "tally",
  "locker",
];

const CONTENT: HomeTileContent = {
  agenda: {
    events: [
      { at: "2026-08-03T14:00:00Z", title: "Dentist" },
      { at: "2026-08-03T16:00:00Z", title: "Standup" },
    ],
    total: 2,
  },
  docs: { title: "Lease agreement", total: 3 },
  locker: { compromised: 1, total: 11 },
  notes: { at: "2026-08-03T09:00:00Z", line: "Reading list", total: 4 },
  people: { names: ["Ada Lovelace", "Grace Hopper"], total: 2 },
  photos: { thumbs: ["blob:a", "blob:b"], total: 1_204 },
  tally: { balanceMinor: 2_500, currency: "USD" },
  tasks: {
    rows: [
      { done: false, title: "Renew passport" },
      { done: true, title: "Book flights" },
    ],
    total: 1,
  },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

describe("screens/HomeSpringboard", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  function mount(over: Partial<HomeSpringboardProps> = {}): HTMLDivElement {
    const props: HomeSpringboardProps = {
      firstRun: false,
      loading: false,
      onOpen: vi.fn<() => void>(),
      onSearch: vi.fn<() => void>(),
      tiles: buildHomeTiles({
        content: CONTENT,
        installedIds: INSTALLED,
        now: Date.parse("2026-08-03T12:00:00Z"),
      }),
      ...over,
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container as HTMLDivElement);
      root.render(<HomeSpringboard {...props} />);
    });
    return container;
  }

  const tile = (el: HTMLDivElement, id: string): HTMLElement =>
    el.querySelector(`[data-app-id="${id}"]`) as HTMLElement;

  describe("the invariant header", () => {
    it("gives every tile a mark, a name, and a count in the numeric register", () => {
      const el = mount();
      const tiles = el.querySelectorAll('[data-testid="home-tile"]');
      expect(tiles).toHaveLength(INSTALLED.length);
      for (const node of tiles) {
        expect(node.querySelector(".mark")).toBeTruthy();
        expect(node.querySelector(".name")?.textContent).toBeTruthy();
      }
      expect(tile(el, "photos").querySelector(".count")?.textContent).toBe(
        (1_204).toLocaleString()
      );
    });

    it("names the tile for a screen reader with its own count and unit", () => {
      expect(mount().querySelector('[data-app-id="locker"]')).toHaveProperty(
        "ariaLabel",
        `Locker, ${(11).toLocaleString()} items`
      );
    });

    it("spends the app's identity hue on the mark and nowhere else", () => {
      const el = mount();
      const mark = tile(el, "photos").querySelector(".mark") as HTMLElement;
      expect(mark.style.background).toContain("--c-amber");
      // The tile itself takes no hue — the shell spends none.
      expect(tile(el, "photos").getAttribute("style")).toBeNull();
    });

    it("omits the count for tally, whose figure IS the number", () => {
      expect(mount().querySelector('[data-app-id="tally"] .count')).toBeNull();
    });

    it("opens the app it names", () => {
      const onOpen = vi.fn<() => void>();
      const el = mount({ onOpen });
      act(() => (tile(el, "notes") as HTMLButtonElement).click());
      expect(onOpen).toHaveBeenCalledWith("notes");
    });
  });

  describe("the bodies are structurally different per app", () => {
    it("photos is a mosaic that bleeds to the tile edge", () => {
      const el = mount();
      expect(tile(el, "photos").querySelectorAll(".mosaicCell")).toHaveLength(
        2
      );
      expect(tile(el, "photos").querySelector(".mosaicMore")?.textContent).toBe(
        `+${(1_202).toLocaleString()}`
      );
    });

    it("docs and notes read in the reading register", () => {
      const el = mount();
      expect(tile(el, "docs").querySelector(".readingTitle")?.textContent).toBe(
        "Lease agreement"
      );
      expect(tile(el, "notes").querySelector(".reading")?.textContent).toBe(
        "Reading list"
      );
    });

    it("agenda pins its after-line below the next event", () => {
      const el = mount();
      expect(tile(el, "agenda").querySelector(".eventTitle")?.textContent).toBe(
        "Dentist"
      );
      expect(
        tile(el, "agenda").querySelector(".afterLine")?.textContent
      ).toContain("Standup");
    });

    it("people is a stack of initialled circles", () => {
      const faces = mount().querySelectorAll('[data-app-id="people"] .face');
      expect([...faces].map((face) => face.textContent)).toStrictEqual([
        "AL",
        "GH",
      ]);
    });

    it("tasks strikes through exactly the completed row", () => {
      const rows = mount().querySelectorAll<HTMLElement>(
        '[data-app-id="tasks"] .taskRow'
      );
      expect([...rows].map((row) => row.dataset.done)).toStrictEqual([
        "false",
        "true",
      ]);
    });

    it("tally is one figure with a caption", () => {
      const el = mount();
      expect(tile(el, "tally").querySelector(".figure")?.textContent).toContain(
        "25"
      );
    });

    it("locker is a state chip that warns when something is compromised", () => {
      const chip = mount().querySelector<HTMLElement>(
        '[data-app-id="locker"] .chip'
      );
      expect(chip?.dataset.tone).toBe("warn");
      expect(chip?.textContent).toBe("1 need attention");
    });

    it("an app with no content gets the DASHED empty body, not a blank tile", () => {
      const el = mount({
        tiles: buildHomeTiles({ content: {}, installedIds: ["docs"] }),
      });
      expect(tile(el, "docs").querySelector(".emptyBody")?.textContent).toBe(
        "File a document to keep it versioned and restorable."
      );
    });
  });

  describe("the grid's size classes", () => {
    it("gives Photos the 2×2, prose the 2×1, and everything else the 1×1", () => {
      const el = mount();
      const sizeOf = (id: string): string | undefined =>
        tile(el, id).dataset.size;
      expect(sizeOf("photos")).toBe("large");
      expect(sizeOf("docs")).toBe("medium");
      expect(sizeOf("notes")).toBe("medium");
      for (const id of ["agenda", "tasks", "people", "tally", "locker"])
        expect(sizeOf(id)).toBe("small");
    });
  });

  describe("search everything", () => {
    it("opens the ONE palette rather than a second search", () => {
      const onSearch = vi.fn<() => void>();
      const el = mount({ onSearch });
      act(() =>
        (
          el.querySelector(
            '[data-testid="home-search-everything"]'
          ) as HTMLButtonElement
        ).click()
      );
      expect(onSearch).toHaveBeenCalledOnce();
    });

    it("is there before the grid has anything to say", () => {
      const el = mount({
        firstRun: true,
        tiles: buildHomeTiles({ content: {}, installedIds: INSTALLED }),
      });
      expect(
        el.querySelector('[data-testid="home-search-everything"]')
      ).toBeTruthy();
    });
  });

  describe("first run and loading are different sentences", () => {
    it("first run replaces the grid with ONE instruction, not N empty tiles", () => {
      const el = mount({
        firstRun: true,
        tiles: buildHomeTiles({ content: {}, installedIds: INSTALLED }),
      });
      expect(el.querySelector('[data-testid="home-springboard"]')).toBeNull();
      const firstRun = el.querySelector('[data-testid="home-first-run"]');
      expect(firstRun?.querySelector(".firstRunTitle")?.textContent).toBe(
        HOME_FIRST_RUN_TITLE
      );
      expect(firstRun?.querySelector(".firstRunBody")?.textContent).toBe(
        HOME_FIRST_RUN_BODY
      );
      // FOUR placeholders — a picture of what Home becomes, not an inventory.
      expect(el.querySelectorAll(".firstRunStep")).toHaveLength(
        HOME_FIRST_RUN_PLACEHOLDERS
      );
    });

    it("first run still opens the app a placeholder names", () => {
      const onOpen = vi.fn<() => void>();
      const el = mount({
        firstRun: true,
        onOpen,
        tiles: buildHomeTiles({ content: {}, installedIds: ["photos"] }),
      });
      act(() =>
        (
          el.querySelector(
            '.firstRunStep[data-app-id="photos"]'
          ) as HTMLButtonElement
        ).click()
      );
      expect(onOpen).toHaveBeenCalledWith("photos");
    });

    it("loading shows static skeletons and no spinner, and is not first run", () => {
      const el = mount({ loading: true });
      expect(el.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
      expect(el.querySelector('[data-testid="home-first-run"]')).toBeNull();
      expect(el.querySelector('[data-testid="home-springboard"]')).toBeNull();
    });
  });

  describe("the vault-level conditions band", () => {
    it("renders out of room above the tiles when the signal fires", () => {
      const el = mount({
        outOfRoom: {
          action: { label: "Manage storage", run: vi.fn<() => void>() },
          cause: "Centraid has used all 20.0 GB of the disk budget you set.",
          consequence: "New photos and files will stop syncing to this device.",
          fractionUsed: 1,
          limitLabel: "20.0 GB",
          usedLabel: "20.0 GB",
        },
      });
      expect(el.querySelector(".outOfRoomConsequence")?.textContent).toBe(
        "New photos and files will stop syncing to this device."
      );
      expect(el.querySelector('[data-testid="home-springboard"]')).toBeTruthy();
    });

    it("shows nothing at all when there is no condition", () => {
      expect(mount().querySelector(".conditions")).toBeNull();
    });
  });
});
