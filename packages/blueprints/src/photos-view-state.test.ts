import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const app = (rel: string): string =>
  pathToFileURL(path.resolve(import.meta.dirname, "../apps/photos", rel)).href;

interface EmptyStateView {
  visible: boolean;
  title: string;
  body: string;
  offersImport: boolean;
  offersCamera: boolean;
}

const { emptyStateView, libraryReachability, NO_EMPTY_STATE, shelfAfterRead } =
  (await import(app("view-state.ts"))) as {
    emptyStateView: (input: Record<string, unknown>) => EmptyStateView;
    libraryReachability: (input: {
      hostStatus?: string | null;
      readFailed: boolean;
    }) => string;
    NO_EMPTY_STATE: EmptyStateView;
    shelfAfterRead: (shelf: unknown, albumIds: readonly string[]) => unknown;
  };
const { EMPTY_TITLE, OFFLINE_COPY, shelfCopy } = (await import(
  app("view-copy.ts")
)) as {
  EMPTY_TITLE: string;
  OFFLINE_COPY: { status: string; banner: string; retry: string };
  shelfCopy: (id: unknown) => { title: string; unit: string };
};
const { TRASH, ALBUMS } = (await import(app("constants.ts"))) as {
  TRASH: string;
  ALBUMS: string;
};
const { STORAGE } = (await import(app("shelves.ts"))) as { STORAGE: string };
const { OfflineBanner } = (await import(
  app("components/OfflineBanner.tsx")
)) as {
  OfflineBanner: ComponentType<{ onRetry: () => void }>;
};
const { LoadingGrid } = (await import(app("components/LoadingGrid.tsx"))) as {
  LoadingGrid: ComponentType<{
    containerWidth: number;
    targetHeight: number;
    phone: boolean;
  }>;
};

const unread = { loaded: false, count: 0, shelf: null };

describe("an un-loaded library is never an empty one (§14)", () => {
  it("says NOTHING while the first read is in flight", () => {
    const view = emptyStateView(unread);
    expect(view.visible).toBe(false);
    expect(view.title).toBe("");
    expect(view.body).toBe("");
    expect(view).toStrictEqual(NO_EMPTY_STATE);
  });

  it("still says nothing when every read so far has FAILED", () => {
    expect(emptyStateView({ ...unread, loaded: false }).visible).toBe(false);
  });

  it("speaks the moment a read lands and the library really is empty", () => {
    const view = emptyStateView({ loaded: true, count: 0, shelf: null });
    expect(view.visible).toBe(true);
    expect(view.title).toBe(EMPTY_TITLE);
  });

  it("says nothing once there is something to show", () => {
    expect(
      emptyStateView({ loaded: true, count: 6214, shelf: null }).visible
    ).toBe(false);
  });

  it("does not call a shelf empty while its own lazy read is pending", () => {
    expect(
      emptyStateView({ loaded: true, count: 0, shelf: null, suppressed: true })
        .visible
    ).toBe(false);
  });

  it("paints packed skeleton tiles at the grid's own geometry", () => {
    const html = renderToStaticMarkup(
      createElement(LoadingGrid, {
        containerWidth: 1000,
        targetHeight: 176,
        phone: false,
      })
    );
    const heights = [...html.matchAll(/height:(?<h>\d+(?:\.\d+)?)px/gu)].map(
      (m) => Number(m.groups!.h)
    );
    expect(heights.length).toBeGreaterThan(20);
    for (const height of heights) {
      expect(height).toBeGreaterThan(176 * 0.7);
      expect(height).toBeLessThan(176 * 1.3);
    }
    expect(html).toMatch(/width:\s*\d+px/u);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toMatch(/Loading|No photographs|Nothing here/u);
  });
});

describe("offline is explained, never left as a grey mosaic (§14)", () => {
  it("treats a failed read as the evidence it is", () => {
    expect(libraryReachability({ readFailed: true })).toBe("unreachable");
    expect(libraryReachability({ readFailed: false })).toBe("reachable");
  });

  it("prefers the host's own verdict over the app's inference", () => {
    expect(libraryReachability({ hostStatus: "down", readFailed: false })).toBe(
      "unreachable"
    );
    expect(libraryReachability({ hostStatus: "up", readFailed: true })).toBe(
      "reachable"
    );
    expect(
      libraryReachability({ hostStatus: undefined, readFailed: false })
    ).toBe("reachable");
  });

  it("draws a bordered banner with the reason and a way to retry", () => {
    const html = renderToStaticMarkup(
      createElement(OfflineBanner, { onRetry: () => {} })
    );
    expect(html).toContain(OFFLINE_COPY.banner);
    expect(html).toContain(OFFLINE_COPY.retry);
    expect(html).not.toContain("kit-btn primary");
  });

  it("names what still renders, and never says the meaning is gone", () => {
    for (const phrase of [
      "meaning reads from this device",
      "shape and colour",
    ]) {
      expect(OFFLINE_COPY.banner).toContain(phrase);
    }
    expect(OFFLINE_COPY.status).toContain("local replica");
  });
});

describe("every shelf is empty on its own terms (§14)", () => {
  it("keeps the member on Trash when the trash is empty", () => {
    expect(shelfAfterRead(TRASH, [])).toBe(TRASH);
    const view = emptyStateView({ loaded: true, count: 0, shelf: TRASH });
    expect(view.visible).toBe(true);
    expect(view.body).toBe("Trash is empty.");
  });

  it("keeps every other built-in shelf too", () => {
    for (const shelf of [null, ALBUMS, STORAGE, "tag:coast"]) {
      expect(shelfAfterRead(shelf, [])).toBe(shelf);
    }
  });

  it("drops only an album that no longer exists", () => {
    expect(shelfAfterRead("col_1", ["col_1", "col_2"])).toBe("col_1");
    expect(shelfAfterRead("col_1", ["col_2"])).toBeNull();
  });
});

describe("the empty state is the right object, and says where the bytes go", () => {
  it("states where the originals stay, on a new library", () => {
    const view = emptyStateView({ loaded: true, count: 0, shelf: null });
    expect(view.title).toBe("Nothing here yet");
    expect(view.body).toContain("the originals stay on your gateway");
  });

  it("offers Import where importing would land a photograph, and nowhere else", () => {
    expect(
      emptyStateView({ loaded: true, count: 0, shelf: null }).offersImport
    ).toBe(true);
    expect(
      emptyStateView({ loaded: true, count: 0, shelf: TRASH }).offersImport
    ).toBe(false);
    expect(
      emptyStateView({
        loaded: true,
        count: 0,
        shelf: null,
        query: "ferry",
      }).offersImport
    ).toBe(false);
  });

  it("offers the camera only on the compact surface (§15)", () => {
    expect(
      emptyStateView({ loaded: true, count: 0, shelf: null, phone: true })
        .offersCamera
    ).toBe(true);
    expect(
      emptyStateView({ loaded: true, count: 0, shelf: null, phone: false })
        .offersCamera
    ).toBe(false);
    expect(
      emptyStateView({ loaded: true, count: 0, shelf: TRASH, phone: true })
        .offersCamera
    ).toBe(false);
  });

  it("leads with what the member just did, when that is the state", () => {
    const view = emptyStateView({
      loaded: true,
      count: 0,
      shelf: null,
      query: "ferry",
    });
    expect(view.title).toContain("ferry");
  });

  it("names a person's own empty timeline with their name", () => {
    const view = emptyStateView({
      loaded: true,
      count: 0,
      shelf: "person:p1",
      personName: "Ana",
    });
    expect(view.body).toContain("Ana");
  });
});

describe("the orchestrator is wired to these rules", () => {
  const source = readFileSync(
    path.resolve(import.meta.dirname, "../apps/photos/app-root.tsx"),
    "utf8"
  );

  it("gates the empty state on a read having landed", () => {
    expect(source).toContain("emptyStateView({");
    expect(source).toMatch(/loaded,\n\s*count,/u);
    expect(source).not.toMatch(/empty\.hidden = shown\.length > 0/u);
    expect(source).not.toMatch(/if \(shown\.length === 0\) applyEmptyState/u);
  });

  it("never redirects Trash to the library", () => {
    expect(source).not.toMatch(/shelf === TRASH && trash\.length === 0/u);
    expect(source).toContain("shelfAfterRead(");
  });

  it("drives the banner and the status line off the reachability verdict", () => {
    expect(source).toContain("libraryReachability({");
    expect(source).toContain("OfflineBanner");
    expect(source).toContain("OFFLINE_COPY.status");
    expect(source).not.toContain("retrying when you come back");
  });

  it("keeps exactly one filled Import in the view (§18)", () => {
    expect(source).toContain("!emptyBlockOffersImport()");
  });
});

describe("Storage names both halves of what it opens", () => {
  it("titles the bar `Storage and backup` (proto 4972)", () => {
    expect(shelfCopy(STORAGE).title).toBe("Storage and backup");
  });
});
// @vitest-environment jsdom
