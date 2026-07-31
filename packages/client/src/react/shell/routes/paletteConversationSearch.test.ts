import { beforeEach, describe, expect, it, vi } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";

import { createPaletteConversationSearch } from "./paletteConversationSearch.js";
import type { PaletteConversationSearchOptions } from "./paletteConversationSearch.js";

describe("paletteConversationSearch", () => {
  beforeEach(() => {
    useFakeClock();
  });

  describe(createPaletteConversationSearch, () => {
    it("debounces, caches, and notifies when results arrive", async () => {
      const search = vi.fn<PaletteConversationSearchOptions["search"]>(
        async (q) => [{ id: `${q}-1`, title: q, snippet: "⟦x⟧" }]
      );
      const onResults =
        vi.fn<NonNullable<PaletteConversationSearchOptions["onResults"]>>();
      const src = createPaletteConversationSearch({
        search,
        onResults,
        debounceMs: 100,
      });

      // Nothing cached yet.
      expect(src.results("budget")).toStrictEqual([]);
      src.ensure("budget");
      src.ensure("budget"); // coalesced
      expect(search).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      expect(search).toHaveBeenCalledOnce();
      expect(onResults).toHaveBeenCalledOnce();
      expect(src.results("budget")).toStrictEqual([
        { id: "budget-1", title: "budget", snippet: "⟦x⟧" },
      ]);

      // A second ensure for the same (now cached) query is a no-op.
      src.ensure("budget");
      await vi.advanceTimersByTimeAsync(100);
      expect(search).toHaveBeenCalledOnce();
    });

    it("ignores queries shorter than two characters", () => {
      const search = vi.fn<PaletteConversationSearchOptions["search"]>();
      const src = createPaletteConversationSearch({
        search,
        onResults: () => undefined,
      });
      src.ensure("b");
      vi.advanceTimersByTime(500);
      expect(search).not.toHaveBeenCalled();
      expect(src.results("b")).toStrictEqual([]);
    });

    it("caches empty on failure and reset() clears everything", async () => {
      const search = vi.fn<PaletteConversationSearchOptions["search"]>(
        async () => {
          throw new Error("nope");
        }
      );
      const onResults =
        vi.fn<NonNullable<PaletteConversationSearchOptions["onResults"]>>();
      const src = createPaletteConversationSearch({
        search,
        onResults,
        debounceMs: 50,
      });
      src.ensure("trip");
      await vi.advanceTimersByTimeAsync(50);
      expect(src.results("trip")).toStrictEqual([]);
      expect(onResults).toHaveBeenCalledWith();
      src.reset();
      // After reset the same query fetches again.
      src.ensure("trip");
      await vi.advanceTimersByTimeAsync(50);
      expect(search).toHaveBeenCalledTimes(2);
    });
  });
});
