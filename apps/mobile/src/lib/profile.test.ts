/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
/**
 * Onboarding owner (issue #545 C4) — pure profile helpers the Onboarding
 * screen uses for greeting / initials / first-name and onboarded gate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = new Map<string, unknown>();

vi.mock(import("../storage"), () => ({
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

import {
  BRAND,
  firstNameOf,
  getProfileColor,
  getProfileName,
  greetingFor,
  initialsOf,
  isOnboarded,
  setOnboarded,
  setProfileColor,
  setProfileName,
} from "./profile";

describe("profile", () => {
  beforeEach(() => {
    memory.clear();
  });

  describe("onboarding profile helpers", () => {
    it("trims display name and reports onboarded flag", () => {
      expect(isOnboarded()).toBe(false);
      setProfileName("  Ada Lovelace  ");
      setOnboarded(true);
      expect(getProfileName()).toBe("Ada Lovelace");
      expect(isOnboarded()).toBe(true);
    });

    it("defaults profile color to the ink brand mark", () => {
      expect(getProfileColor()).toBe(BRAND);
      setProfileColor("#112233");
      expect(getProfileColor()).toBe("#112233");
    });

    it("derives initials and first name for avatar + greeting", () => {
      expect(initialsOf("")).toBe("·");
      expect(initialsOf("  ada  ")).toBe("A");
      expect(initialsOf("Ada Lovelace")).toBe("AL");
      expect(firstNameOf("Ada Lovelace")).toBe("Ada");
      expect(firstNameOf("   ")).toBe("");
    });

    it("picks time-of-day greeting buckets", () => {
      expect(greetingFor(new Date(2026, 0, 1, 8))).toBe("Good morning");
      expect(greetingFor(new Date(2026, 0, 1, 14))).toBe("Good afternoon");
      expect(greetingFor(new Date(2026, 0, 1, 20))).toBe("Good evening");
    });
  });
});
