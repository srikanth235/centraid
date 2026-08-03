import { describe, expect, it, vi } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";

import {
  createPaletteEntitySearch,
  formatMetaValue,
  PALETTE_ENTITY_TARGETS,
} from "./paletteEntitySearch.js";
import type { PaletteEntityHit } from "./paletteEntitySearch.js";

describe("palette entity search", () => {
  it("debounces, caches, and refreshes FTS5 results", async () => {
    const clock = useFakeClock();
    const search = vi.fn<() => Promise<PaletteEntityHit[]>>(async () => [
      {
        appId: "notes",
        appLabel: "Notes",
        entity: "knowledge.note",
        kind: "note",
        id: "n1",
        label: "旅行 ✨",
        snippet: "Café plan",
        meta: "",
      },
    ]);
    const refresh = vi.fn<() => void>();
    const source = createPaletteEntitySearch({ debounceMs: 20, search });
    source.setOnResults(refresh);

    source.ensure("café");
    source.ensure("café");
    await clock.advance(20);

    expect(search).toHaveBeenCalledExactlyOnceWith("café");
    expect(source.results("CAFÉ")).toStrictEqual([
      expect.objectContaining({ id: "n1", label: "旅行 ✨" }),
    ]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("resets pending and cached searches", async () => {
    const clock = useFakeClock();
    const search = vi.fn<() => Promise<PaletteEntityHit[]>>(async () => []);
    const source = createPaletteEntitySearch({ debounceMs: 20, search });
    source.ensure("旅行");
    source.reset();
    await clock.advance(30);
    expect(search).not.toHaveBeenCalled();
    expect(source.results("旅行")).toStrictEqual([]);
  });
});

describe("formatMetaValue (row anatomy's NUMERIC register, #708 §A)", () => {
  it("compacts a date to a fixed-locale, fixed-timezone short form", () => {
    expect(formatMetaValue("2026-08-03T10:00:00.000Z")).toBe("Aug 3");
  });

  it("passes non-date values through unchanged (e.g. a media type)", () => {
    expect(formatMetaValue("image/jpeg")).toBe("image/jpeg");
  });

  it("returns an empty string for an empty input", () => {
    expect(formatMetaValue("")).toBe("");
  });
});

describe("PALETTE_ENTITY_TARGETS (#708 §A row anatomy + Recents)", () => {
  it("gives every bundled entity a MONO kind label", () => {
    for (const target of PALETTE_ENTITY_TARGETS) {
      expect(target.kind, target.entity).toBeTruthy();
    }
  });

  it("excludes schedule.task from recentField — the schema has no edit-time column", () => {
    const task = PALETTE_ENTITY_TARGETS.find(
      (t) => t.entity === "schedule.task"
    );
    expect(task?.recentField).toBeUndefined();
  });

  it("gives every other bundled entity a recentField for Recents", () => {
    const others = PALETTE_ENTITY_TARGETS.filter(
      (t) => t.entity !== "schedule.task"
    );
    expect(others.length).toBeGreaterThan(0);
    for (const target of others) {
      expect(target.recentField, target.entity).toBeTruthy();
    }
  });
});
