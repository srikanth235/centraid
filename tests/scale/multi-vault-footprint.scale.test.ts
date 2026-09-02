import { describe, expect, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";
import {
  DEFAULT_VAULT_FOOTPRINT,
  MIN_VAULT_FILE_CACHE_BYTES,
} from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import { createTestVault } from "../helpers/factories.js";
import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

/**
 * FIVE-VAULT MEMORY FOOTPRINT (issue #659 S5).
 *
 * The claim under test is a single sentence: **a host's vault memory footprint
 * is flat in the number of mounted vaults, not linear.** Before `openVaultDb`
 * took a `footprint` budget (#659 L8, packages/vault/src/db.ts), the read-path
 * pragmas were per-FILE constants — 64 MiB mmap and 16,000 KiB cache each —
 * and every mounted plane opens TWO files. A gateway with five vaults
 * therefore reserved 10x those numbers with no way for the host to say
 * otherwise, and nothing anywhere measured it. The repo's only footprint
 * evidence was a two-vault disk measurement in
 * receipts/issue-608-v0-fresh-install-web-sweep.md; the N-plane MEMORY claim
 * had never been executed at all.
 *
 * `packages/vault/src/db.test.ts` already owns the SINGLE-vault half of this:
 * "a footprint budget is a per-vault TOTAL split across its databases" and
 * "a budget divided too far still leaves each database a usable cache". This
 * rig deliberately does not restate either. It owns only what a unit test on
 * one vault cannot see — that five planes opened under one ceiling stay under
 * that ceiling in aggregate.
 *
 * Asserted against the `openVaultDb` contract, NOT against the gateway plane
 * layer: `packages/server/src/serve/vault-plane.ts` is concurrently gaining a
 * host-level total, and a rig pinned to a moving seam measures the seam rather
 * than the property.
 *
 * ── Year-3 declared volume (docs/coding-standards.md D6) ────────────────────
 *
 * | Dimension            | Year-3 | Seeded here |
 * | -------------------- | ------ | ----------- |
 * | Mounted vaults       | 5      | 5 (`VAULT_COUNT`) |
 * | SQLite handles open  | 5      | 5 — one `vault.db` per vault (ONE FILE, #916) |
 * | Rows per vault       | n/a    | bootstrap only — see below |
 *
 * Five is the declared year-3 vault count for one household: the gateway
 * auto-founds one marked `Personal` vault on a fresh data dir (#603,
 * ARCHITECTURE.md) and a household adds four more vaults explicitly. The full
 * volume table lives in tests/experience-budgets/README.md.
 *
 * **The row volume is deliberately bootstrap-only, and that is a real limit of
 * this rig.** The pragmas under test are reservations made at open time, so
 * they are exact regardless of how much data the vault holds. The RESIDENT
 * memory reported below is therefore a floor, not a year-3 number: a vault
 * being read hard will occupy its page cache, and this rig never reads. Do not
 * quote the RSS figure as "five vaults cost X" — quote it as "five idle,
 * freshly bootstrapped vaults cost at least X".
 */
const OWNER = "tests/scale/multi-vault-footprint.scale.test.ts";

const VAULT_COUNT = 5;
const VAULT_DB_FILES = 1;

// The host ceiling: one default vault's worth of memory for the WHOLE gateway,
// however many planes it mounts. Choosing DEFAULT_VAULT_FOOTPRINT as the total
// makes the assertion legible — five vaults under this budget must cost no more
// than ONE vault costs today.
const HOST_TOTAL_MMAP_BYTES = DEFAULT_VAULT_FOOTPRINT.mmapBytes;
const HOST_TOTAL_CACHE_BYTES = DEFAULT_VAULT_FOOTPRINT.cacheBytes;

interface FilePragmas {
  label: string;
  mmapBytes: number;
  cacheBytes: number;
}

/**
 * Read the two reservation pragmas off the vault's handle. ONE FILE (#916):
 * `db.audit` is an alias of `db.vault`, so there is exactly one handle per
 * vault and measuring both names would double-count the same reservation.
 */
function pragmasOf(db: VaultDb, index: number): FilePragmas[] {
  return ([["vault.db", db.vault]] as const).map(([name, handle]) => ({
    label: `vault-${index}/${name}`,
    mmapBytes: (
      handle.prepare("PRAGMA mmap_size").get() as { mmap_size: number }
    ).mmap_size,
    // SQLite reports a negative `cache_size` back in KiB, exactly as it was set.
    cacheBytes:
      -(handle.prepare("PRAGMA cache_size").get() as { cache_size: number })
        .cache_size * 1024,
  }));
}

describe("multi-vault-footprint.scale", () => {
  test("five vaults under one budget stay flat in vault count, not linear", async () => {
    const rssBefore = process.memoryUsage().rss;

    // Each plane gets total/N and does no other arithmetic — this IS the host
    // contract from packages/vault/src/db.ts, exercised as a host would use it.
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
    // Mount the FIRST vault alone, then the rest. The first mount also pays for
    // the vault package's module graph and the bootstrap DDL, which is a
    // one-time cost that has nothing to do with vault count — folding it into a
    // per-vault figure would overstate the marginal cost by an order of
    // magnitude. The incremental number below is the one that answers "does a
    // sixth vault cost anything".
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

    // What the SAME five vaults would have reserved before #659 L8, i.e. with
    // the per-file constants. Reported so the win is a number in the artifact
    // rather than a claim in a comment.
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

    // (a) Flat, not linear: the whole point.
    expect(files).toHaveLength(VAULT_COUNT * VAULT_DB_FILES);
    expect(summedMmapBytes, "summed mmap across 5 vaults").toBeLessThanOrEqual(
      HOST_TOTAL_MMAP_BYTES
    );
    expect(
      summedCacheBytes,
      "summed page cache across 5 vaults"
    ).toBeLessThanOrEqual(HOST_TOTAL_CACHE_BYTES);
    // Guard the assertion itself: if a future change made the pragmas report 0
    // the two ceilings above would pass while nothing was reserved at all.
    expect(
      summedCacheBytes,
      "page cache was actually reserved"
    ).toBeGreaterThan(0);

    // (b) Divided five ways, every handle still has a usable cache.
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
