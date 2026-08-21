// Photos as a route inside the frame (v4 handoff §3, §5, §H).
//
// Three behaviours, each of which used to be drawn by the app itself and is
// now either a contribution to the frame or a control that knows when NOT to
// render:
//
//   1. the shelf strip carries the current shelf on the TAB, not as a fill;
//   2. the app bar is CONTRIBUTED — title, count, Select, Import — and the one
//      filled ink element is never a disabled commit;
//   3. the toolbar row renders only when it carries something.
//
// Rendered to static markup rather than driven in jsdom: all three are pure
// views over their props, so the markup IS the behaviour, and a server render
// keeps the assertions free of act() scheduling noise.
//
// The app sources are loaded by file URL, like every other blueprint-app
// fixture here: `src/` is its own tsconfig rootDir, so the types the
// assertions need are declared locally rather than imported across it.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createElement } from "react";
import type { ComponentType, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const app = (rel: string): string =>
  pathToFileURL(path.resolve(import.meta.dirname, "../apps/photos", rel)).href;

interface Scope {
  id: string;
  label: string;
  canWrite: boolean;
  /** The founding marker. `false` is "somewhere other than my own"; absent is
   *  "the host did not say", which reads as the member's own (§H). */
  personal?: boolean;
}
interface Shelf {
  id: string | null;
  label: string;
  segment: string;
}
interface AppBarState {
  title: string;
  count: number | null;
  unit?: string;
  showSelect: boolean;
  selectMode: boolean;
  onToggleSelect: () => void;
  showImport: boolean;
  onImport: () => void;
  importDisabledReason?: string;
}
interface ToolbarProps {
  scopes: readonly Scope[];
  vaultsOn: ReadonlySet<string>;
  onToggleVault: (id: string) => void;
  kind: string;
  onSelectKind: (kind: string) => void;
  tileSize?: number;
  onStepTileSize?: (delta: number) => void;
}
interface StripProps {
  shelf: string | null;
  onSelect: (id: string | null) => void;
  narrow?: boolean;
}
interface Asset {
  media_type?: string;
  source?: string;
}

const { ALBUMS, FAVORITES, TRASH } = (await import(app("constants.ts"))) as {
  ALBUMS: string;
  FAVORITES: string;
  TRASH: string;
};

const { appBar, barCount } = (await import(app("frame.tsx"))) as {
  appBar: (state: AppBarState) => {
    title?: string;
    count?: ReactNode;
    actions?: ReactNode;
  };
  barCount: (state: AppBarState) => ReactNode;
};

const { ShelfStrip } = (await import(app("components/ShelfStrip.tsx"))) as {
  ShelfStrip: ComponentType<StripProps>;
};
const { ToolbarView } = (await import(app("components/Toolbar.tsx"))) as {
  ToolbarView: ComponentType<ToolbarProps>;
};

const {
  BAND_DESTINATIONS,
  SHELVES,
  bandActiveId,
  shelfFromRoute,
  shelfRoute,
  showsTileSize,
} = (await import(app("shelves.ts"))) as {
  BAND_DESTINATIONS: readonly {
    id: string;
    label: string;
    icon?: string;
  }[];
  SHELVES: readonly Shelf[];
  bandActiveId: (id: string | null) => string | undefined;
  shelfFromRoute: (route: string) => string | null;
  shelfRoute: (id: string | null) => string;
  showsTileSize: (id: string | null) => boolean;
};

const { filterByKind, isSharedScope, orderedScopes, scopeIsOn, writeScopeFor } =
  (await import(app("filters.ts"))) as {
    filterByKind: (list: Asset[], kind: string) => Asset[];
    isSharedScope: (scope: Scope | undefined) => boolean;
    orderedScopes: (scopes: readonly Scope[]) => readonly Scope[];
    scopeIsOn: (on: ReadonlySet<string>, id: string | null) => boolean;
    writeScopeFor: (on: ReadonlySet<string>) => string | null;
  };

const scope = (id: string, label: string, personal?: boolean): Scope => ({
  id,
  label,
  canWrite: true,
  ...(personal === undefined ? {} : { personal }),
});

const SOLO = [scope("", "Library")];
const TWO = [scope("own", "Home", true), scope("shr", "Sharing", false)];

function toolbar(overrides: Partial<ToolbarProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ToolbarView, {
      scopes: SOLO,
      vaultsOn: new Set<string>(),
      onToggleVault: () => {},
      kind: "all",
      onSelectKind: () => {},
      ...overrides,
    })
  );
}

const strip = (props: StripProps): string =>
  renderToStaticMarkup(createElement(ShelfStrip, props));

describe("the shelf strip", () => {
  it("draws the seven shelves in order — no Sharing place (#726)", () => {
    expect(SHELVES.map((s) => s.label)).toStrictEqual([
      "Library",
      "Favorites",
      "Albums",
      "Places",
      "People",
      "Duplicates",
      "Trash",
    ]);
  });

  it("carries exactly one current tab, and carries it on the tab itself", () => {
    const html = strip({ shelf: FAVORITES, onSelect: () => {} });
    expect([...html.matchAll(/data-current="true"/gu)]).toHaveLength(1);
    expect([...html.matchAll(/aria-selected="true"/gu)]).toHaveLength(1);
    expect(html).toContain('role="tablist"');
    expect([...html.matchAll(/role="tab"/gu)]).toHaveLength(7);
  });

  it("lights the Library tab at the app's root", () => {
    const html = strip({ shelf: null, onSelect: () => {} });
    const upToCurrent = html.slice(0, html.indexOf('data-current="true"'));
    expect(upToCurrent.match(/role="tab"/gu) ?? []).toHaveLength(1);
  });

  it("keeps shelf labels quiet and leaves counts to the overflow sheet", () => {
    const html = strip({
      shelf: null,
      onSelect: () => {},
    });
    expect(html).not.toContain("tabCount");
    expect(html).toContain(">Albums<");
  });

  it("takes the compact rung from the pane's own width, not a viewport", () => {
    expect(strip({ shelf: null, onSelect: () => {}, narrow: true })).toContain(
      'data-narrow="true"'
    );
  });
});

describe("the app bar contribution", () => {
  const base: AppBarState = {
    title: "Photos",
    count: 214,
    showSelect: true,
    selectMode: false,
    onToggleSelect: () => {},
    showImport: true,
    onImport: () => {},
  };
  const actions = (state: AppBarState): string =>
    renderToStaticMarkup(createElement("div", null, appBar(state).actions));

  it("contributes content, never styling", () => {
    const bar = appBar(base);
    expect(bar.title).toBe("Photos");
    // The count is a value the FRAME renders in its numeric register; the app
    // passes no class, colour or metric with it.
    expect(bar.count).toBe("214 photographs");
  });

  it("singularises the count rather than saying 1 photographs", () => {
    expect(barCount({ ...base, count: 1 })).toBe("1 photograph");
    expect(barCount({ ...base, count: 0 })).toBe("0 photographs");
  });

  it("contributes no count where one would have to be invented", () => {
    expect(barCount({ ...base, count: null })).toBeUndefined();
  });

  it("carries Select, then the ONE filled ink element, Import", () => {
    const html = actions(base);
    expect(html.indexOf("Select")).toBeLessThan(html.indexOf("Import"));
    expect([...html.matchAll(/kit-btn primary/gu)]).toHaveLength(1);
    // upload.ts drives this id; it moved here from the retired drawer.
    expect(html).toContain('id="uploadBtn"');
  });

  it("does not fill a disabled commit", () => {
    const html = actions({ ...base, importDisabledReason: "Read-only here" });
    expect(html).not.toContain("kit-btn primary");
    expect(html).toContain("disabled");
    // The reason rides the control rather than living only in a tooltip.
    expect(html).toContain("Read-only here");
  });

  it("turns Select into Done while selecting", () => {
    const html = actions({ ...base, selectMode: true });
    expect(html).toContain("Done");
    expect(html).not.toContain(">Select<");
  });
});

describe("the toolbar row", () => {
  it("renders nothing when it carries nothing", () => {
    // One vault to filter and no tiles to size: an empty band is chrome.
    expect(toolbar()).toBe("");
  });

  it("renders once it carries the tile-size control", () => {
    const html = toolbar({ tileSize: 2, onStepTileSize: () => {} });
    // Four segments, named by their own visible text, in one group whose name
    // states the property and the member's position in it.
    expect(html).toContain('aria-label="Tile size 3 of 4"');
    for (const rung of [">XS<", ">S<", ">M<", ">L<"])
      expect(html).toContain(rung);
  });

  it("renders once there is more than one vault to filter", () => {
    const html = toolbar({ scopes: TWO });
    expect(html).toContain("Home");
    expect(html).toContain("Sharing");
  });

  it("holds exactly one rung, and says which one it is", () => {
    // The range has ends rather than wrapping: at XS the group says `1 of 4`,
    // at L it says `4 of 4`, and one segment is pressed in each case.
    const first = toolbar({ tileSize: 0, onStepTileSize: () => {} });
    expect(first).toContain('aria-label="Tile size 1 of 4"');
    expect([...first.matchAll(/aria-pressed="true"/gu)]).toHaveLength(1);
    const last = toolbar({ tileSize: 3, onStepTileSize: () => {} });
    expect(last).toContain('aria-label="Tile size 4 of 4"');
    expect([...last.matchAll(/aria-pressed="true"/gu)]).toHaveLength(1);
  });

  it("keeps the tile-size control off shelves where tiles are not packed", () => {
    expect(showsTileSize(ALBUMS)).toBe(false);
    expect(showsTileSize(null)).toBe(true);
    expect(showsTileSize(TRASH)).toBe(true);
  });
});

describe("the shelf route", () => {
  it("keeps photos and photos/<sub> one destination", () => {
    expect(shelfRoute(null)).toBe("photos");
    expect(shelfRoute(ALBUMS)).toBe("photos/albums");
    for (const shelf of SHELVES) {
      expect(shelfFromRoute(shelfRoute(shelf.id))).toBe(shelf.id);
    }
  });

  it("claims five band destinations and no more", () => {
    expect(BAND_DESTINATIONS.map((d) => d.id)).toStrictEqual([
      "library",
      "albums",
      "people",
      "search",
    ]);
    expect(BAND_DESTINATIONS.length).toBeLessThanOrEqual(5);
    // Every tab is labelled — a glyph alone is not a name.
    expect(BAND_DESTINATIONS.every((d) => d.label.length > 0)).toBe(true);
    expect(BAND_DESTINATIONS.map((d) => d.icon)).toStrictEqual([
      "Image",
      "album",
      "person",
      "Search",
    ]);
  });

  it("lights no band tab rather than the wrong one", () => {
    expect(bandActiveId(null)).toBe("library");
    expect(bandActiveId(ALBUMS)).toBe("albums");
    expect(bandActiveId(TRASH)).toBeUndefined();
  });
});

describe("the vault filter reads the record, never a name", () => {
  it("marks any scope but the member's own as shared", () => {
    // Renaming changes nothing in EITHER direction: a shared place called
    // "Beach pics" is still shared, and a personal one called "Sharing" is
    // still only theirs.
    expect(isSharedScope(scope("s", "Beach pics", false))).toBe(true);
    expect(isSharedScope(scope("h", "Sharing", false))).toBe(true);
    expect(isSharedScope(scope("o", "Sharing", true))).toBe(false);
    // A host that did not answer leaves the tile unmarked rather than
    // marking every tile.
    expect(isSharedScope(scope("u", "Library"))).toBe(false);
    expect(isSharedScope(undefined)).toBe(false);
  });

  it("orders the filter: own first, then the rest in the shell's own order", () => {
    const listed = orderedScopes([
      scope("h", "Kitchen", false),
      scope("s", "Cove", false),
      scope("o", "Home", true),
    ]);
    expect(listed.map((s) => s.id)).toStrictEqual(["o", "h", "s"]);
  });

  it("reads an untouched filter as every vault, not none", () => {
    expect(scopeIsOn(new Set(), "anything")).toBe(true);
    expect(scopeIsOn(new Set(["own"]), "own")).toBe(true);
    expect(scopeIsOn(new Set(["own"]), "shr")).toBe(false);
  });

  it("only names a write target when one vault is unambiguous", () => {
    expect(writeScopeFor(new Set(["own"]))).toBe("own");
    expect(writeScopeFor(new Set())).toBeNull();
    expect(writeScopeFor(new Set(["own", "shr"]))).toBeNull();
  });
});

describe("the kind filter", () => {
  const asset = (media: string, source?: string): Asset => ({
    media_type: media,
    ...(source ? { source } : {}),
  });

  it("leaves the list alone at rest", () => {
    const list = [asset("image/jpeg"), asset("video/mp4")];
    expect(filterByKind(list, "all")).toBe(list);
  });

  it("reads the media type, never a filename", () => {
    const list = [asset("image/jpeg"), asset("video/mp4"), asset("audio/mp4")];
    expect(filterByKind(list, "video")).toHaveLength(1);
    expect(filterByKind(list, "audio")).toHaveLength(1);
    expect(filterByKind(list, "photo")).toHaveLength(1);
  });

  it("keeps a derived kind out of the list when the record does not say", () => {
    const list = [asset("image/jpeg"), asset("image/png", "screenshot")];
    expect(filterByKind(list, "screenshot")).toHaveLength(1);
    expect(filterByKind(list, "selfie")).toHaveLength(0);
  });
});
