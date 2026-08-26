// @vitest-environment jsdom
// The Tile, its four overlay slots, and every state a tile can be in
// (v4 handoff §2.4, §4.3, §4.4, §14). Rendered to static markup rather than
// driven in jsdom (like photos-frame): the tile is a pure view over its props,
// so the markup IS the behaviour. Assertions key on `data-tile-state`, inline
// geometry, aria labels and visible copy — NEVER on a hashed CSS-module class
// name. jsdom, not node: the shared kit's custom-element base is evaluated at
// module load through `format.ts`; the render itself stays `renderToStaticMarkup`.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const app = (rel: string): string =>
  pathToFileURL(path.resolve(import.meta.dirname, "../apps/photos", rel)).href;

interface Asset {
  asset_id: string;
  scope_id?: string | null;
  title?: string | null;
  kind?: string | null;
  width?: number | null;
  height?: number | null;
  duration_s?: number | null;
  media_type?: string | null;
  content_uri?: string | null;
  thumb_uri?: string | null;
  taken_at?: string | null;
  place?: { place_id: string; name: string } | null;
}
interface Scope {
  id: string;
  label: string;
  canWrite: boolean;
  /** `false` is "somewhere other than my own" (§H). */
  personal?: boolean;
  color?: string;
}
interface TileVault {
  initial: string;
  label: string;
  hue: string;
}
interface TileProps {
  asset: Asset;
  width: number;
  height: number;
  rung: number;
  selected: boolean;
  selectMode: boolean;
  vaultMark: TileVault | null;
  state?: string;
  note?: string;
  onOpen: (key: string) => void;
  onToggleSelect: (key: string) => void;
  onEnterSelectMode: () => void;
}

const { Tile } = (await import(app("components/Tile.tsx"))) as {
  Tile: ComponentType<TileProps>;
};
const {
  initialMediaState,
  kindLabel,
  safeHue,
  showsKindSlot,
  showsVaultInitial,
  stateLine,
  vaultMarker,
} = (await import(app("tile-state.ts"))) as {
  initialMediaState: (asset: Asset) => string;
  kindLabel: (asset: Asset) => string | null;
  safeHue: (color: unknown) => string;
  showsKindSlot: (rung: number) => boolean;
  showsVaultInitial: (rung: number) => boolean;
  stateLine: (state: string) => string | null;
  vaultMarker: (scope: Scope | undefined) => TileVault | null;
};
const { TimelineBody } = (await import(app("components/Timeline.tsx"))) as {
  TimelineBody: ComponentType<Record<string, unknown>>;
};
const { dayMeta, groupByMonth, monthCount, monthTicks } = (await import(
  app("grouping.ts")
)) as {
  dayMeta: (assets: readonly Asset[]) => string;
  groupByMonth: (assets: readonly Asset[]) => {
    key: string;
    label: string;
    count: string;
    days: { key: string; meta: string; assets: Asset[] }[];
  }[];
  monthCount: (assets: readonly Asset[]) => string;
  monthTicks: (
    months: readonly { key: string; label: string }[]
  ) => { key: string; short: string }[];
};

/** A row with real bytes inline, so `gridSrc` has something to paint. */
const photo = (over: Partial<Asset> = {}): Asset => ({
  asset_id: "a1",
  title: "Cove",
  width: 1200,
  height: 800,
  media_type: "image/jpeg",
  content_uri: "data:image/jpeg;base64,AAAA",
  taken_at: "2026-08-14T10:00:00Z",
  ...over,
});

/** A row whose bytes are NOT on this device — nothing paintable at all. */
const offloaded = (over: Partial<Asset> = {}): Asset =>
  photo({ content_uri: "https://elsewhere.example/original.jpg", ...over });

const scope = (
  id: string,
  label: string,
  personal?: boolean,
  color?: string
): Scope => ({
  id,
  label,
  canWrite: true,
  ...(personal === undefined ? {} : { personal }),
  ...(color ? { color } : {}),
});

function tile(over: Partial<TileProps> = {}): string {
  return renderToStaticMarkup(
    createElement(Tile, {
      asset: photo(),
      width: 264,
      height: 176,
      rung: 2,
      selected: false,
      selectMode: false,
      vaultMark: null,
      onOpen: () => {},
      onToggleSelect: () => {},
      onEnterSelectMode: () => {},
      ...over,
    })
  );
}

/** The tile's direct children as tag+attribute heads — counts overlay slots
 *  without a hashed class name. */
function slotCount(markup: string): number {
  const inner = markup.replace(/^<div[^>]*>/u, "").replace(/<\/div>$/u, "");
  return [...inner.matchAll(/<(?:button|span|div)\b/gu)].length;
}

describe("the Tile's four overlay slots (§4.4)", () => {
  it("carries NOTHING but the media and the selection slot on a plain tile", () => {
    // Content-led: the media plus the one control, no chrome.
    expect(slotCount(tile())).toBe(2);
  });

  it("labels the selection slot, and outlines the tile when it is on", () => {
    const off = tile();
    expect(off).toContain('aria-label="Select Cove"');
    expect(off).toContain('aria-pressed="false"');
    const on = tile({ selected: true, selectMode: true });
    expect(on).toContain('aria-label="Deselect Cove"');
    expect(on).toContain('aria-pressed="true"');
  });

  it("draws the kind slot from rung S up, and never on a still", () => {
    const clip = photo({ media_type: "video/mp4", duration_s: 8 });
    expect(tile({ asset: clip, rung: 1 })).toContain("0:08");
    // XS is below the gate: not every tile carries the slot.
    expect(tile({ asset: clip, rung: 0 })).not.toContain("0:08");
    expect(showsKindSlot(0)).toBe(false);
    expect(showsKindSlot(1)).toBe(true);
    expect(kindLabel(photo())).toBeNull();
    expect(kindLabel(photo({ kind: "live" }))).toBe("live");
  });

  it("says one line of mono in the state slot, never a badge or a red dot", () => {
    expect(stateLine("pending")).toBeNull();
    expect(stateLine("bytes")).toBeNull();
    expect(stateLine("gateway")).toBe("on the gateway");
    expect(stateLine("failed")).toBe("could not decode");
  });

  it("lets the state slot carry Trash's purge countdown, media first", () => {
    expect(tile({ note: "purges in 12 days" })).toContain("purges in 12 days");
    // "could not decode" matters more than a deadline.
    const both = tile({ state: "failed", note: "purges in 12 days" });
    expect(both).toContain("could not decode");
    expect(both).not.toContain("purges in 12 days");
  });
});

describe("the vault slot fires on the record, never on a name (§4.4, §H)", () => {
  it("marks ANY scope but the member's own — where shares go included", () => {
    expect(vaultMarker(scope("shr", "Sharing", false))).toMatchObject({
      initial: "S",
      label: "Sharing",
    });
    expect(vaultMarker(scope("hh", "Beach House", false))).toMatchObject({
      initial: "B",
    });
  });

  it("leaves the member's own vault the UNMARKED default", () => {
    expect(vaultMarker(scope("own", "Home", true))).toBeNull();
    // A solo mount and any scope the host did not answer for stay unmarked —
    // a badge on every tile would be noise.
    expect(vaultMarker(scope("", "Library"))).toBeNull();
    expect(vaultMarker(undefined)).toBeNull();
  });

  it("is derived from `personal`, so renaming a vault cannot change it", () => {
    // Neither rename touches the marker; it derives from `personal`.
    expect(vaultMarker(scope("shr", "My own things", false))).not.toBeNull();
    expect(vaultMarker(scope("own", "Sharing", true))).toBeNull();
  });

  it("renders a rule always, and the initial only at rungs M and L", () => {
    const mark = vaultMarker(scope("shr", "Sharing", false))!;
    expect(showsVaultInitial(1)).toBe(false);
    expect(showsVaultInitial(2)).toBe(true);
    expect(tile({ vaultMark: mark, rung: 1 })).not.toContain(">S<");
    expect(tile({ vaultMark: mark, rung: 3 })).toContain(">S<");
    expect(tile({ vaultMark: mark })).toContain("Cove · in Sharing");
  });

  it("never pastes an unvetted colour into a style attribute", () => {
    expect(safeHue("#904e46")).toBe("#904e46");
    expect(safeHue("var(--c-teal)")).toBe("var(--c-teal)");
    expect(safeHue("url(javascript:alert(1))")).toBe("var(--app-identity)");
    expect(safeHue(undefined)).toBe("var(--app-identity)");
  });
});

describe("a tile holds its geometry from record to bytes to failure (§14)", () => {
  const box = 'style="width:264px;height:176px"';

  it("paints the skeleton at the EXACT geometry, before any bytes", () => {
    // The skeleton already occupies the box the photograph will — no reflow.
    expect(initialMediaState(photo())).toBe("pending");
    const pending = tile();
    expect(pending).toContain(box);
    expect(pending).toContain('data-tile-state="pending"');
    expect(pending).not.toContain("on the gateway");
    expect(pending).not.toContain("could not decode");
  });

  it("says `on the gateway` from the FIRST frame when nothing is local", () => {
    // From the FIRST frame — never a grey square with no words.
    expect(initialMediaState(offloaded())).toBe("gateway");
    const away = tile({ asset: offloaded() });
    expect(away).toContain(box);
    expect(away).toContain('data-tile-state="gateway"');
    expect(away).toContain("on the gateway");
  });

  it("keeps a FAILED tile's geometry, and never lets it vanish", () => {
    const failed = tile({ state: "failed" });
    expect(failed).toContain(box);
    expect(failed).toContain('data-tile-state="failed"');
    expect(failed).toContain("could not decode");
    expect(failed.match(/style="[^"]*"/u)?.[0]).toBe(
      tile().match(/style="[^"]*"/u)?.[0]
    );
  });
});

describe("the timeline the tiles sit in (§4.3, §4.5, §4.6)", () => {
  function timeline(over: Record<string, unknown> = {}): string {
    return renderToStaticMarkup(
      createElement(TimelineBody, {
        assets: [
          photo({ asset_id: "a", taken_at: "2026-08-14T12:00:00" }),
          photo({ asset_id: "b", taken_at: "2026-07-02T12:00:00" }),
        ],
        containerWidth: 900,
        targetHeight: 176,
        rung: 2,
        phone: false,
        memories: null,
        inAlbum: false,
        albumId: null,
        isTrash: false,
        refresh: async () => {},
        selectMode: false,
        selectedIds: new Set<string>(),
        truncated: false,
        libraryWindow: 2,
        selectedAlbum: null,
        searchQuery: "",
        vaultOf: () => undefined,
        onEnterSelectMode: () => {},
        onToggleSelect: () => {},
        onOpen: () => {},
        onShowMore: () => {},
        ...over,
      })
    );
  }

  it("heads each month with its own count, and each day with its own", () => {
    const markup = timeline();
    expect(markup).toContain('data-month="2026-08"');
    expect(markup).toContain('data-month="2026-07"');
    expect(markup).toContain("1 photograph");
  });

  it("carries a scrub rail labelled by month, reachable by pointer", () => {
    const markup = timeline();
    expect(markup).toContain('aria-label="Scrub by month"');
    // Every tick is a real button with a real name — never drag-only.
    expect(markup).toMatch(/aria-label="\w+ 2026"/u);
  });

  it("puts the memories strip at the HEAD of the timeline, not above it", () => {
    const markup = timeline({ memories: createElement("p", null, "Memories") });
    expect(markup.indexOf("Memories")).toBeLessThan(
      markup.indexOf('data-month="2026-08"')
    );
  });
});

describe("grouping and labels (§4.3)", () => {
  let seq = 0;
  const aug = (day: string, over: Partial<Asset> = {}): Asset =>
    photo({
      // Counter id: unique inside one case; unseeded randomness would make
      // a failure unreproducible.
      asset_id: `${day}-${(seq += 1)}`,
      taken_at: `2026-08-${day}T12:00:00`,
      ...over,
    });

  it("counts the month in the handoff's words, videos named separately", () => {
    expect(monthCount([aug("14"), aug("14")])).toBe("2 photographs");
    expect(
      monthCount([aug("14"), aug("14", { media_type: "video/mp4" })])
    ).toBe("1 photograph · 1 video");
    // A `· 0 videos` clause is noise about an absence.
    expect(monthCount([aug("14")])).toBe("1 photograph");
  });

  it("names the day's place only when every photograph shares one", () => {
    const lyme = { place_id: "p1", name: "Lyme Regis" };
    expect(
      dayMeta([aug("14", { place: lyme }), aug("14", { place: lyme })])
    ).toBe("2 · Lyme Regis");
    // Two places is no place: guessing one would be a lie.
    expect(
      dayMeta([
        aug("14", { place: lyme }),
        aug("14", { place: { place_id: "p2", name: "Charmouth" } }),
      ])
    ).toBe("2");
    expect(dayMeta([aug("14", { place: lyme }), aug("14")])).toBe("2");
  });

  it("buckets into months and days, preserving the caller's order", () => {
    const months = groupByMonth([
      aug("14"),
      aug("14"),
      aug("02"),
      photo({ asset_id: "jul", taken_at: "2026-07-30T12:00:00" }),
    ]);
    expect(months.map((m) => m.key)).toStrictEqual(["2026-08", "2026-07"]);
    expect(months[0]!.days.map((d) => d.key)).toStrictEqual([
      "2026-08-14",
      "2026-08-02",
    ]);
    expect(months[0]!.count).toBe("3 photographs");
    expect(months[0]!.days[0]!.meta).toBe("2");
  });

  it("gives the scrub rail one short label per month", () => {
    const ticks = monthTicks(groupByMonth([aug("14")]));
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.key).toBe("2026-08");
    expect(ticks[0]!.short).toMatch(/2026/u);
  });
});
