import { describe, expect, it, vi } from "vitest";

import {
  createPaletteRecents,
  suggestionsFromRecents,
} from "./paletteRecents.js";
import type { PaletteRecentHit } from "./paletteRecents.js";

function hit(over: Partial<PaletteRecentHit> = {}): PaletteRecentHit {
  return {
    appId: "notes",
    appLabel: "Notes",
    entity: "knowledge.note",
    kind: "note",
    id: "n1",
    label: "Trip notes",
    snippet: "",
    meta: "Aug 3",
    ...over,
  };
}

describe(createPaletteRecents, () => {
  it("fetches once, caches, and notifies onResults", async () => {
    const fetch = vi.fn<() => Promise<PaletteRecentHit[]>>(async () => [hit()]);
    const refresh = vi.fn<() => void>();
    const source = createPaletteRecents({ fetch });
    source.setOnResults(refresh);

    expect(source.items()).toStrictEqual([]);
    source.ensure();
    source.ensure(); // second call before the fetch settles must not refetch
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(source.items()).toStrictEqual([hit()]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("caches an empty result on fetch failure rather than retrying forever", async () => {
    const fetch = vi
      .fn<() => Promise<PaletteRecentHit[]>>()
      .mockRejectedValue(new Error("offline"));
    const source = createPaletteRecents({ fetch });
    source.ensure();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(source.items()).toStrictEqual([]);
    source.ensure();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reset() drops the cache so the next ensure() refetches", async () => {
    const fetch = vi.fn<() => Promise<PaletteRecentHit[]>>(async () => [hit()]);
    const source = createPaletteRecents({ fetch });
    source.ensure();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    source.reset();
    expect(source.items()).toStrictEqual([]);
    source.ensure();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe(suggestionsFromRecents, () => {
  it("takes one label per app, in recency order", () => {
    const hits = [
      hit({ appId: "notes", label: "Trip notes" }),
      hit({ appId: "people", label: "Alex Rivera", entity: "core.party" }),
      hit({ appId: "notes", label: "Older note" }),
    ];
    expect(suggestionsFromRecents(hits)).toStrictEqual([
      "Trip notes",
      "Alex Rivera",
    ]);
  });

  it("caps at four chips even with more distinct apps", () => {
    const hits = [
      hit({ appId: "notes", label: "N" }),
      hit({ appId: "people", label: "P" }),
      hit({ appId: "docs", label: "D" }),
      hit({ appId: "tally", label: "T" }),
      hit({ appId: "agenda", label: "A" }),
    ];
    expect(suggestionsFromRecents(hits)).toHaveLength(4);
  });

  it("returns no chips when there are no recents", () => {
    expect(suggestionsFromRecents([])).toStrictEqual([]);
  });
});
