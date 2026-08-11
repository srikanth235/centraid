import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HOME_FIRST_RUN_BODY,
  HOME_FIRST_RUN_PLACEHOLDERS,
  HOME_FIRST_RUN_TITLE,
  HOME_SAMPLE_FILLING,
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
  docs: {
    excerpt: "The landlord agreed to the longer notice period.",
    title: "Lease agreement",
    total: 3,
  },
  locker: { compromised: 1, total: 11 },
  notes: { at: "2026-08-03T09:00:00Z", line: "Reading list", total: 4 },
  people: {
    directory: [
      { id: "party-ada", name: "Ada Lovelace" },
      { id: "party-grace", name: "Grace Hopper" },
    ],
    total: 2,
  },
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
      loading: false,
      onConnect: vi.fn<() => void>(),
      onOpen: vi.fn<() => void>(),
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
      // As the chip's VARIABLE, not as its background. The stylesheet
      // composites it at `ICON_CHIP_TINT` over `--bg` and strokes the glyph in
      // the full hue — the finish `design/src/tile.ts` defines and mobile's
      // `iconChipFinish` composites by hand. Painting `background` here is what
      // made Home's chips filled badges while the phone drew tinted labels.
      expect(mark.style.getPropertyValue("--chip-hue")).toContain("--c-amber");
      expect(mark.style.background).toBe("");
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

    it("only notes reads in the reading register", () => {
      const el = mount();
      expect(tile(el, "docs").querySelector(".readingTitle")?.textContent).toBe(
        "Lease agreement"
      );
      // Docs is NOT the reading register. Native draws this tile as a ruled
      // list of file names in sans (TileBody.tsx's `RuledRows`) and keeps
      // `Prose` for Notes alone; web drew both as serif, which is how two
      // prose blocks ended up on a grid that has one. The excerpt stays — the
      // web tile model carries an excerpt, not rows — but it is UI text.
      expect(tile(el, "docs").querySelector(".reading")).toBeNull();
      expect(tile(el, "docs").querySelector(".docExcerpt")?.textContent).toBe(
        "The landlord agreed to the longer notice period."
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

    it("an app with no content is not a tile at all", () => {
      const el = mount({
        tiles: buildHomeTiles({ content: {}, installedIds: ["docs"] }),
      });
      // An app with nothing to show is not a tile at all — it becomes a first
      // move under the grid. The dashed in-grid placeholder it used to draw was
      // the second spelling of a state that now has exactly one.
      expect(
        el.querySelector('[data-app-id="docs"][data-testid="home-tile"]')
      ).toBeNull();
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

  describe("day one, the start band, and loading are different sentences", () => {
    it("day one replaces the grid with ONE instruction and four real doors", () => {
      const el = mount({
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
      // FOUR moves — a picture of what Home becomes, not an inventory.
      expect(
        el.querySelectorAll('[data-testid="home-first-move"]')
      ).toHaveLength(HOME_FIRST_RUN_PLACEHOLDERS);
    });

    it("a move that names an app opens that app", () => {
      const onOpen = vi.fn<() => void>();
      const el = mount({
        onOpen,
        tiles: buildHomeTiles({ content: {}, installedIds: ["photos"] }),
      });
      act(() =>
        (
          el.querySelector(
            '[data-testid="home-first-move"][data-app-id="photos"]'
          ) as HTMLButtonElement
        ).click()
      );
      expect(onOpen).toHaveBeenCalledWith("photos");
    });

    it("the connect move goes to Connectors, NOT to an app id", () => {
      // The one move that is not an app. Routing it through `onOpen` would
      // navigate to an app called "connectors", which does not exist.
      const onConnect = vi.fn<() => void>();
      const onOpen = vi.fn<() => void>();
      const el = mount({
        onConnect,
        onOpen,
        tiles: buildHomeTiles({ content: {}, installedIds: INSTALLED }),
      });
      act(() =>
        (
          el.querySelector(
            '[data-testid="home-first-move"][data-app-id="connectors"]'
          ) as HTMLButtonElement
        ).click()
      );
      expect(onConnect).toHaveBeenCalledOnce();
      expect(onOpen).not.toHaveBeenCalled();
    });

    it("ONE piece of content does not resurrect seven apologies", () => {
      // The regression this whole treatment exists to prevent: the binary it
      // replaces flipped to "not first run" here and rendered all eight tiles,
      // seven of them empty. Now the grid holds exactly what has content and
      // the rest becomes a band.
      const el = mount({
        tiles: buildHomeTiles({
          content: { locker: { compromised: 0, total: 4 } },
          installedIds: INSTALLED,
        }),
      });
      const tiles = [...el.querySelectorAll('[data-testid="home-tile"]')];
      expect(tiles.map((t) => (t as HTMLElement).dataset.appId)).toStrictEqual([
        "locker",
      ]);
      expect(el.querySelector('[data-testid="home-first-run"]')).toBeNull();
      expect(
        el.querySelector('[data-testid="home-start-band"]')
      ).not.toBeNull();
    });

    it("a full vault gets the grid and no band at all", () => {
      const el = mount();
      expect(el.querySelector('[data-testid="home-start-band"]')).toBeNull();
      expect(el.querySelector('[data-testid="home-first-run"]')).toBeNull();
    });

    it("offers the sample UNDER the real moves, never above them", () => {
      // Ordering is an argument. An offer of invented data above "connect your
      // account" would say the demo matters more than the member's own archive,
      // on the screen where the opposite claim is made for the first time.
      const el = mount({
        sample: {
          canSeed: true,
          clearing: false,
          filling: null,
          loaded: false,
          onClear: vi.fn<() => void>(),
          onSeed: vi.fn<() => void>(),
        },
        tiles: buildHomeTiles({ content: {}, installedIds: INSTALLED }),
      });
      const moves = el.querySelector('[data-testid="home-first-run"]');
      const offer = el.querySelector('[data-testid="home-sample-offer"]');
      expect(moves).not.toBeNull();
      expect(offer).not.toBeNull();
      expect(
        moves!.compareDocumentPosition(offer!) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeGreaterThan(0);
    });

    it("still offers the sample once ONE tile has content — day one is not the gate", () => {
      // A vault holds a People row for its own owner from the moment it is
      // created, so a single live tile ends day one before the member has
      // added anything. Hanging the offer off that branch made it unreachable
      // in the exact state where it is most wanted — and left anyone who
      // cleared the sample with no way back to it.
      const el = mount({
        sample: {
          canSeed: true,
          clearing: false,
          filling: null,
          loaded: false,
          onClear: vi.fn<() => void>(),
          onSeed: vi.fn<() => void>(),
        },
      });
      expect(el.querySelector('[data-testid="home-first-run"]')).toBeNull();
      expect(
        el.querySelector('[data-testid="home-sample-offer"]')
      ).not.toBeNull();
    });

    it("makes no offer when the vault ships no scenario to load", () => {
      const el = mount({
        sample: {
          canSeed: false,
          clearing: false,
          filling: null,
          loaded: false,
          onClear: vi.fn<() => void>(),
          onSeed: vi.fn<() => void>(),
        },
        tiles: buildHomeTiles({ content: {}, installedIds: INSTALLED }),
      });
      expect(el.querySelector('[data-testid="home-sample-offer"]')).toBeNull();
    });

    it("says the data is a sample ONCE, at vault level — never per tile", () => {
      // Eight badges is the eight-apologies failure again, and it would make a
      // demo read as damage.
      const el = mount({
        sample: {
          canSeed: true,
          clearing: false,
          filling: null,
          loaded: true,
          onClear: vi.fn<() => void>(),
          onSeed: vi.fn<() => void>(),
        },
      });
      expect(
        el.querySelectorAll('[data-testid="home-sample-note"]')
      ).toHaveLength(1);
      // And the offer is gone — it has already been taken.
      expect(el.querySelector('[data-testid="home-sample-offer"]')).toBeNull();
    });

    it("keeps clearing the sample one act away while it is loaded", () => {
      const onClear = vi.fn<() => void>();
      const el = mount({
        sample: {
          canSeed: true,
          clearing: false,
          filling: null,
          loaded: true,
          onClear,
          onSeed: vi.fn<() => void>(),
        },
      });
      const note = el.querySelector('[data-testid="home-sample-note"]');
      act(() => note!.querySelector("button")!.click());
      expect(onClear).toHaveBeenCalledOnce();
    });

    it("names the app it is waiting on, and counts the run, while it fills", () => {
      // The fill is about ten seconds and the photo generator is most of it.
      // A control that only goes grey for that long is indistinguishable from
      // one that has hung, so the surface says which app and how many are
      // left — the same working state the rest of the shell uses.
      const el = mount({
        sample: {
          canSeed: true,
          clearing: false,
          filling: { appId: "photos", done: 4, total: 7 },
          loaded: false,
          onClear: vi.fn<() => void>(),
          onSeed: vi.fn<() => void>(),
        },
      });
      const offer = el.querySelector('[data-testid="home-sample-offer"]');
      expect(offer?.querySelector(".workingLabel")?.textContent).toBe(
        "Adding photographs…"
      );
      expect(offer?.querySelector(".workingCounts")?.textContent).toBe(
        "4 of 7 apps"
      );
      // The offer's control is GONE while the run owns the slot — a disabled
      // button beside a live progress line is two answers to one question.
      expect(offer?.querySelector("button")).toBeNull();
      // Determinate, and the announcement is the counts inside the live
      // region — never a spinner.
      expect(offer?.querySelector(".working")?.getAttribute("aria-live")).toBe(
        "polite"
      );
      expect(offer?.querySelector(".working")?.getAttribute("aria-busy")).toBe(
        "true"
      );
      expect(offer?.querySelector(".workingFill")).not.toBeNull();
    });

    it("names the closing replica catch-up rather than sitting on a full bar", () => {
      // Every generator has returned, so the counts are full — but the rows
      // are on the gateway and the tiles read the local replica. Unnamed, this
      // beat reads as "the bar filled and nothing happened".
      const el = mount({
        sample: {
          canSeed: true,
          clearing: false,
          filling: { done: 7, total: 7 },
          loaded: false,
          onClear: vi.fn<() => void>(),
          onSeed: vi.fn<() => void>(),
        },
      });
      const offer = el.querySelector('[data-testid="home-sample-offer"]');
      expect(offer?.querySelector(".workingLabel")?.textContent).toBe(
        "Catching up…"
      );
      expect(offer?.querySelector(".workingCounts")?.textContent).toBe(
        "7 of 7 apps"
      );
    });

    it("falls back to the generic sentence for an app with no line of its own", () => {
      const el = mount({
        sample: {
          canSeed: true,
          clearing: false,
          filling: { appId: "ledger", done: 0, total: 7 },
          loaded: false,
          onClear: vi.fn<() => void>(),
          onSeed: vi.fn<() => void>(),
        },
      });
      expect(
        el.querySelector('[data-testid="home-sample-offer"] .workingLabel')
          ?.textContent
      ).toBe(HOME_SAMPLE_FILLING);
    });

    it("staggers the grid only on the render that FOLLOWS a fill", () => {
      // Once, as the payoff for pressing. A grid that re-animates on every
      // return stops being a moment and becomes a tax.
      const gridOf = (el: HTMLDivElement): HTMLElement | null =>
        el.querySelector('[data-testid="home-springboard"]');
      expect(gridOf(mount({ justFilled: true }))?.dataset.filled).toBe("true");
      expect(gridOf(mount())?.dataset.filled).toBeUndefined();
    });

    it("loading shows static skeletons and no spinner, and is not day one", () => {
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
