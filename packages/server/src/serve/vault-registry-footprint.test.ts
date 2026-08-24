/*
 * The mounted-plane memory budget (issue #659 L8).
 *
 * `mmap_size` and `cache_size` are a HOST budget, not per-FILE constants: at
 * per-file numbers every mounted vault opens two databases at the full figure
 * and a household's memory bill grows linearly with its vault count — on
 * exactly the small always-on box that cannot absorb it. The claim under test
 * is that the summed footprint across N planes stays inside ONE host ceiling:
 * flat in vault count, not linear in it.
 */

import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  DEFAULT_VAULT_FOOTPRINT,
  MIN_VAULT_FILE_CACHE_BYTES,
} from "@centraid/vault";

import { openVaultRegistry } from "./vault-registry.js";
import type { VaultRegistry } from "./vault-registry.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const cleanups: Array<() => Promise<void> | void> = [];

function mmapBytesOf(db: DatabaseSync): number {
  return Number(
    (db.prepare("PRAGMA mmap_size").get() as { mmap_size: number }).mmap_size
  );
}

/** `cache_size` is NEGATIVE kibibytes when expressed as memory, not pages. */
function cacheBytesOf(db: DatabaseSync): number {
  const raw = Number(
    (db.prepare("PRAGMA cache_size").get() as { cache_size: number }).cache_size
  );
  expect(raw).toBeLessThan(0);
  return Math.abs(raw) * 1024;
}

/** Every open database handle across every mounted plane (two per vault). */
function handlesOf(registry: VaultRegistry): DatabaseSync[] {
  return registry
    .planesList()
    .flatMap((plane) => [plane.db.vault, plane.db.journal]);
}

describe("vault-registry footprint budget (#659 L8)", () => {
  afterEach(async () =>
    forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) => cleanup())
  );

  async function registryWith(
    vaults: number,
    footprintBudget?: typeof DEFAULT_VAULT_FOOTPRINT
  ): Promise<VaultRegistry> {
    const root = await tempDir(`footprint-${vaults}-`);
    const registry = openVaultRegistry({
      rootDir: root,
      logger: silentLogger,
      ownerName: "Priya",
      ...(footprintBudget ? { footprintBudget } : {}),
    });
    cleanups.push(() => registry.stop());
    for (let index = 0; index < vaults; index += 1) {
      registry.create(`Vault ${index}`);
    }
    expect(registry.planesList()).toHaveLength(vaults);
    return registry;
  }

  test("five mounted vaults fit inside one host ceiling instead of costing five", async () => {
    const planes = 5;
    const registry = await registryWith(planes, DEFAULT_VAULT_FOOTPRINT);
    const handles = handlesOf(registry);
    expect(handles).toHaveLength(planes * 2);

    const totalMmap = handles.reduce((sum, db) => sum + mmapBytesOf(db), 0);
    const totalCache = handles.reduce((sum, db) => sum + cacheBytesOf(db), 0);

    // The whole point: the SUM across ten handles is within one vault's budget.
    expect(totalMmap).toBeLessThanOrEqual(DEFAULT_VAULT_FOOTPRINT.mmapBytes);
    expect(totalCache).toBeLessThanOrEqual(DEFAULT_VAULT_FOOTPRINT.cacheBytes);

    // …and it lands JUST under it, not merely somewhere below. Both divisions
    // (budget → per vault → per file) floor, so the shortfall is rounding dust
    // — a few bytes per division — never a whole plane's share. Asserting the
    // gap's SIZE is what distinguishes "the budget was divided" from "the
    // budget was quietly under-spent", which a `> half` bound would not.
    const slack = 4 * planes;
    expect(
      DEFAULT_VAULT_FOOTPRINT.mmapBytes - totalMmap
    ).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_VAULT_FOOTPRINT.mmapBytes - totalMmap).toBeLessThanOrEqual(
      slack
    );
    expect(
      DEFAULT_VAULT_FOOTPRINT.cacheBytes - totalCache
    ).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_VAULT_FOOTPRINT.cacheBytes - totalCache).toBeLessThanOrEqual(
      slack
    );
  }, 60_000);

  test("every database keeps a usable page cache however far the budget divides", async () => {
    const registry = await registryWith(5, DEFAULT_VAULT_FOOTPRINT);
    for (const db of handlesOf(registry)) {
      expect(cacheBytesOf(db)).toBeGreaterThanOrEqual(
        MIN_VAULT_FILE_CACHE_BYTES
      );
    }
  }, 60_000);

  test("a single vault under the same ceiling is unchanged from before the budget", async () => {
    const budgeted = handlesOf(await registryWith(1, DEFAULT_VAULT_FOOTPRINT));
    const unbudgeted = handlesOf(await registryWith(1));
    expect(budgeted.map(mmapBytesOf)).toStrictEqual(
      unbudgeted.map(mmapBytesOf)
    );
    expect(budgeted.map(cacheBytesOf)).toStrictEqual(
      unbudgeted.map(cacheBytesOf)
    );
  }, 60_000);

  test("without a budget the cost is still linear — the regression this prevents", async () => {
    const one = handlesOf(await registryWith(1));
    const five = handlesOf(await registryWith(5));
    const sum = (handles: DatabaseSync[]): number =>
      handles.reduce((total, db) => total + cacheBytesOf(db), 0);
    // Five unbudgeted vaults cost five times one. This is the shape the
    // budgeted case above must NOT have.
    expect(sum(five)).toBe(sum(one) * 5);
  }, 60_000);
});
