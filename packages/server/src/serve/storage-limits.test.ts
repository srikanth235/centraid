import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import {
  DEFAULT_WARN_AT_PERCENT,
  MIN_JOURNAL_LIMIT_BYTES,
  MIN_TOTAL_LIMIT_BYTES,
  StorageLimitsError,
  StorageLimitsStore,
  applyLimitsPatch,
  evaluateStorageLimit,
  loadStorageLimits,
} from "./storage-limits.js";
import type { StorageLimits } from "./storage-limits.js";

// The owner's two limits (#544). The rules worth pinning are the ones a
// wrong answer makes dangerous: a limit low enough to be unsatisfiable, a
// malformed file silently becoming a real limit, and — above all — that the
// disk budget classifies but never claims to block.

const dirs: string[] = [];

describe("storage-limits", () => {
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  async function storeDir(): Promise<string> {
    const dir = await tempDir("centraid-storage-limits-");
    dirs.push(dir);
    return dir;
  }

  const OFF: StorageLimits = {
    totalLimitBytes: null,
    warnAtPercent: DEFAULT_WARN_AT_PERCENT,
    journalLimitBytes: null,
  };

  describe(applyLimitsPatch, () => {
    it("sets and clears each limit independently", () => {
      const withBudget = applyLimitsPatch(OFF, {
        totalLimitBytes: 30 * 1024 ** 3,
      });
      expect(withBudget).toMatchObject({
        totalLimitBytes: 30 * 1024 ** 3,
        journalLimitBytes: null,
      });
      const withBoth = applyLimitsPatch(withBudget, {
        journalLimitBytes: 1024 ** 3,
      });
      expect(withBoth.totalLimitBytes).toBe(30 * 1024 ** 3);
      // Clearing one must not disturb the other — the two controls are separate
      // PUTs from the same panel.
      expect(
        applyLimitsPatch(withBoth, { totalLimitBytes: null })
      ).toMatchObject({
        totalLimitBytes: null,
        journalLimitBytes: 1024 ** 3,
      });
    });

    it("refuses a ledger limit archival could never satisfy", () => {
      expect(() => applyLimitsPatch(OFF, { journalLimitBytes: 1024 })).toThrow(
        StorageLimitsError
      );
      expect(
        applyLimitsPatch(OFF, { journalLimitBytes: MIN_JOURNAL_LIMIT_BYTES })
      ).toMatchObject({
        journalLimitBytes: MIN_JOURNAL_LIMIT_BYTES,
      });
    });

    it("refuses a budget too small to hold a usable vault", () => {
      expect(() => applyLimitsPatch(OFF, { totalLimitBytes: 1024 })).toThrow(
        StorageLimitsError
      );
      expect(
        applyLimitsPatch(OFF, { totalLimitBytes: MIN_TOTAL_LIMIT_BYTES })
      ).toMatchObject({
        totalLimitBytes: MIN_TOTAL_LIMIT_BYTES,
      });
    });

    it("refuses a warn threshold outside (0, 100]", () => {
      expect(() => applyLimitsPatch(OFF, { warnAtPercent: 0 })).toThrow(
        StorageLimitsError
      );
      expect(() => applyLimitsPatch(OFF, { warnAtPercent: 101 })).toThrow(
        StorageLimitsError
      );
      expect(applyLimitsPatch(OFF, { warnAtPercent: 100 }).warnAtPercent).toBe(
        100
      );
    });
  });

  describe(evaluateStorageLimit, () => {
    const limits: StorageLimits = {
      totalLimitBytes: 1000,
      warnAtPercent: 80,
      journalLimitBytes: null,
    };

    it("is ok with no budget set — an owner who never opted in is not unhealthy", () => {
      expect(evaluateStorageLimit(9_999_999, OFF)).toMatchObject({
        status: "ok",
        fractionUsed: null,
        limitBytes: null,
      });
    });

    it("classifies ok / degraded / error across the warn threshold and the limit", () => {
      expect(evaluateStorageLimit(500, limits).status).toBe("ok");
      expect(evaluateStorageLimit(799, limits).status).toBe("ok");
      expect(evaluateStorageLimit(800, limits).status).toBe("degraded");
      expect(evaluateStorageLimit(999, limits).status).toBe("degraded");
      expect(evaluateStorageLimit(1000, limits).status).toBe("error");
      expect(evaluateStorageLimit(4000, limits)).toMatchObject({
        status: "error",
        fractionUsed: 4,
      });
    });
  });

  describe(StorageLimitsStore, () => {
    it("round-trips through an atomic write and leaves no temp file behind", async () => {
      const dir = await storeDir();
      const store = new StorageLimitsStore(dir);
      await expect(store.load()).resolves.toMatchObject(OFF);

      await store.update({
        totalLimitBytes: 10 * 1024 ** 3,
        journalLimitBytes: 1024 ** 3,
      });
      await expect(loadStorageLimits(dir)).resolves.toMatchObject({
        totalLimitBytes: 10 * 1024 ** 3,
        journalLimitBytes: 1024 ** 3,
      });
      expect(
        (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"))
      ).toStrictEqual([]);
    });

    it("exposes the last-loaded limits synchronously for the sweep path", async () => {
      const dir = await storeDir();
      const store = new StorageLimitsStore(dir);
      // Before any load, the safe direction is "limits off" — one delayed sweep
      // beats archiving against a limit nobody set.
      expect(store.current().journalLimitBytes).toBeNull();
      await store.update({ journalLimitBytes: 2 * 1024 ** 3 });
      expect(store.current().journalLimitBytes).toBe(2 * 1024 ** 3);
    });

    it("treats a malformed stored value as unset rather than as a real limit", async () => {
      const dir = await storeDir();
      await fs.writeFile(
        path.join(dir, "storage-limits.json"),
        JSON.stringify({
          totalLimitBytes: "lots",
          warnAtPercent: 900,
          journalLimitBytes: -5,
        })
      );
      await expect(loadStorageLimits(dir)).resolves.toMatchObject({
        totalLimitBytes: null,
        warnAtPercent: DEFAULT_WARN_AT_PERCENT,
        journalLimitBytes: null,
      });
    });
  });
});
