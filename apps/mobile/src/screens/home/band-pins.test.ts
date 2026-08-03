/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = new Map<string, unknown>();

vi.mock(import("../../storage"), () => ({
  Store: {
    get<T>(key: string, fallback: T): T {
      return memory.has(key) ? (memory.get(key) as T) : fallback;
    },
    set<T>(key: string, value: T): void {
      memory.set(key, value);
    },
    async hydrate<T>(key: string, fallback: T): Promise<T> {
      if (!memory.has(key)) memory.set(key, fallback);
      return memory.get(key) as T;
    },
  },
}));

import { DEFAULT_PINS, MAX_PINS, sanitizePins } from "./band";
import { getPins, isPinned, setPins, togglePin } from "./band-pins";

describe(sanitizePins, () => {
  it("de-duplicates while preserving order", () => {
    expect(sanitizePins(["docs", "photos", "docs"])).toStrictEqual([
      "docs",
      "photos",
    ]);
  });

  it("caps at MAX_PINS — the band's hard 5-tab ceiling", () => {
    const many = ["a", "b", "c", "d", "e", "f", "g"];
    expect(sanitizePins(many)).toStrictEqual(many.slice(0, MAX_PINS));
    expect(sanitizePins(many)).toHaveLength(MAX_PINS);
  });
});

describe("pin state", () => {
  beforeEach(() => {
    memory.clear();
    setPins(DEFAULT_PINS);
  });

  it("ships with exactly five default pins, Assistant among them", () => {
    expect(DEFAULT_PINS).toHaveLength(MAX_PINS);
    expect(DEFAULT_PINS).toContain("assistant");
    expect(getPins()).toStrictEqual(DEFAULT_PINS);
  });

  it("unpins an app and reports it as no longer pinned", () => {
    togglePin("photos", false);
    expect(isPinned("photos")).toBe(false);
    expect(getPins()).toHaveLength(MAX_PINS - 1);
  });

  it("pins a new app once room exists", () => {
    togglePin("photos", false);
    togglePin("notes", true);
    expect(isPinned("notes")).toBe(true);
    expect(getPins()).toHaveLength(MAX_PINS);
  });

  it("refuses to pin past the cap", () => {
    togglePin("notes", true);
    expect(isPinned("notes")).toBe(false);
    expect(getPins()).toStrictEqual(DEFAULT_PINS);
  });

  it("pinning an already-pinned app is a no-op", () => {
    togglePin("photos", true);
    expect(getPins()).toStrictEqual(DEFAULT_PINS);
  });
});
