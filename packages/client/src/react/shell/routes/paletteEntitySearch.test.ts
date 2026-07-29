import { afterEach, describe, expect, it, vi } from "vitest";

import { createPaletteEntitySearch } from "./paletteEntitySearch.js";
import type { PaletteEntityHit } from "./paletteEntitySearch.js";

describe("palette entity search", () => {
  afterEach(() => vi.useRealTimers());

  it("debounces, caches, and refreshes FTS5 results", async () => {
    vi.useFakeTimers();
    const search = vi.fn<() => Promise<PaletteEntityHit[]>>(async () => [
      {
        appId: "notes",
        appLabel: "Notes",
        entity: "knowledge.note",
        id: "n1",
        label: "旅行 ✨",
        snippet: "Café plan",
      },
    ]);
    const refresh = vi.fn<() => void>();
    const source = createPaletteEntitySearch({ debounceMs: 20, search });
    source.setOnResults(refresh);

    source.ensure("café");
    source.ensure("café");
    await vi.advanceTimersByTimeAsync(20);

    expect(search).toHaveBeenCalledExactlyOnceWith("café");
    expect(source.results("CAFÉ")).toStrictEqual([
      expect.objectContaining({ id: "n1", label: "旅行 ✨" }),
    ]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("resets pending and cached searches", async () => {
    vi.useFakeTimers();
    const search = vi.fn<() => Promise<PaletteEntityHit[]>>(async () => []);
    const source = createPaletteEntitySearch({ debounceMs: 20, search });
    source.ensure("旅行");
    source.reset();
    await vi.advanceTimersByTimeAsync(30);
    expect(search).not.toHaveBeenCalled();
    expect(source.results("旅行")).toStrictEqual([]);
  });
});
