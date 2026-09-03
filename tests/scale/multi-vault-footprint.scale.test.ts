import { describe, expect, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";
import {
  DEFAULT_VAULT_FOOTPRINT,
  MIN_VAULT_FILE_CACHE_BYTES,
} from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import { createTestVault } from "../helpers/factories.js";
import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/scale/multi-vault-footprint.scale.test.ts";

const VAULT_COUNT = 5;
const VAULT_DB_FILES = 1;

const HOST_TOTAL_MMAP_BYTES = DEFAULT_VAULT_FOOTPRINT.mmapBytes;
const HOST_TOTAL_CACHE_BYTES = DEFAULT_VAULT_FOOTPRINT.cacheBytes;

interface FilePragmas {
  label: string;
  mmapBytes: number;
  cacheBytes: number;
}

function pragmasOf(db: VaultDb, index: number): FilePragmas[] {
  return ([["vault.db", db.vault]] as const).map(([name, handle]) => ({
    label: `vault-${index}/${name}`,
    mmapBytes: (
      handle.prepare("PRAGMA mmap_size").get() as { mmap_size: number }
    ).mmap_size,
    cacheBytes:
      -(handle.prepare("PRAGMA cache_size").get() as { cache_size: number })
        .cache_size * 1024,
  }));
}

describe("multi-vault-footprint.scale", () => {
  test("five vaults under one budget stay flat in vault count, not linear", async () => {
    const rssBefore = process.memoryUsage().rss;

    const perVault = {
      mmapBytes: Math.floor(HOST_TOTAL_MMAP_BYTES / VAULT_COUNT),
      cacheBytes: Math.floor(HOST_TOTAL_CACHE_BYTES / VAULT_COUNT),
    };
    const vaults: VaultDb[] = [];
    const mountRange = async (index: number, end: number): Promise<void> => {
      if (index >= end) return;
      vaults.push(await createTestVault({ footprint: perVault }));
      return mountRange(index + 1, end);
    };
    await mountRange(0, 1);
    const rssAfterFirst = process.memoryUsage().rss;
    await mountRange(1, VAULT_COUNT);

    const rssAfter = process.memoryUsage().rss;
    const rssPerAdditionalVault = Math.round(
      (rssAfter - rssAfterFirst) / (VAULT_COUNT - 1)
    );
    const files = vaults.flatMap((db, index) => pragmasOf(db, index));

    const summedMmapBytes = files.reduce(
      (sum, file) => sum + file.mmapBytes,
      0
    );
    const summedCacheBytes = files.reduce(
      (sum, file) => sum + file.cacheBytes,
      0
    );
    const smallestCacheBytes = Math.min(
      ...files.map((file) => file.cacheBytes)
    );

    const unbudgetedMmapBytes = VAULT_COUNT * DEFAULT_VAULT_FOOTPRINT.mmapBytes;
    const unbudgetedCacheBytes =
      VAULT_COUNT * DEFAULT_VAULT_FOOTPRINT.cacheBytes;

    const withinTotals =
      summedMmapBytes <= HOST_TOTAL_MMAP_BYTES &&
      summedCacheBytes <= HOST_TOTAL_CACHE_BYTES;
    const everyFileUsable = smallestCacheBytes >= MIN_VAULT_FILE_CACHE_BYTES;

    const drift = await rigDriftBudgetMs("scale", OWNER);
    const withinDrift = drift === null || summedCacheBytes <= drift;
    const passed = withinTotals && everyFileUsable && withinDrift;

    console.log("\n======== FIVE-VAULT FOOTPRINT ========");
    console.log(`handles open:        ${files.length}`);
    console.log(
      `summed mmap:         ${summedMmapBytes} B  (host total ${HOST_TOTAL_MMAP_BYTES} B, unbudgeted would be ${unbudgetedMmapBytes} B)`
    );
    console.log(
      `summed page cache:   ${summedCacheBytes} B  (host total ${HOST_TOTAL_CACHE_BYTES} B, unbudgeted would be ${unbudgetedCacheBytes} B)`
    );
    console.log(
      `smallest file cache: ${smallestCacheBytes} B  (floor ${MIN_VAULT_FILE_CACHE_BYTES} B)`
    );
    console.log(
      `RSS delta (idle):    ${rssAfter - rssBefore} B total, ` +
        `${rssPerAdditionalVault} B per vault after the first`
    );
    console.log("======================================\n");

    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: `${VAULT_COUNT} mounted vaults (${VAULT_COUNT * VAULT_DB_FILES} SQLite handles) under one host footprint budget`,
      status: passed ? "passed" : "failed",
      measurements: [
        {
          name: "summed page cache",
          value: summedCacheBytes,
          unit: "bytes",
          budget: HOST_TOTAL_CACHE_BYTES,
        },
        {
          name: "summed mmap window",
          value: summedMmapBytes,
          unit: "bytes",
          budget: HOST_TOTAL_MMAP_BYTES,
        },
        {
          name: "smallest per-file cache",
          value: smallestCacheBytes,
          unit: "bytes",
          budget: MIN_VAULT_FILE_CACHE_BYTES,
        },
        {
          name: "page cache had this been per-file",
          value: unbudgetedCacheBytes,
          unit: "bytes",
        },
        {
          name: "RSS delta mounting all 5 (idle; includes one-time module load)",
          value: rssAfter - rssBefore,
          unit: "bytes",
        },
        {
          name: "RSS per additional vault after the first (idle)",
          value: rssPerAdditionalVault,
          unit: "bytes",
        },
        { name: "SQLite handles", value: files.length, unit: "handles" },
      ],
    });

    expect(files).toHaveLength(VAULT_COUNT * VAULT_DB_FILES);
    expect(summedMmapBytes, "summed mmap across 5 vaults").toBeLessThanOrEqual(
      HOST_TOTAL_MMAP_BYTES
    );
    expect(
      summedCacheBytes,
      "summed page cache across 5 vaults"
    ).toBeLessThanOrEqual(HOST_TOTAL_CACHE_BYTES);
    expect(
      summedCacheBytes,
      "page cache was actually reserved"
    ).toBeGreaterThan(0);

    expect(
      smallestCacheBytes,
      "smallest per-file page cache"
    ).toBeGreaterThanOrEqual(MIN_VAULT_FILE_CACHE_BYTES);

    expect(
      withinDrift,
      `sustained drift: ${summedCacheBytes} B vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
    ).toBe(true);
  });
});
