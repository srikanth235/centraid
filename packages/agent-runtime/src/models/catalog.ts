/*
 * Gateway-owned host-capability catalog store.
 *
 * Persists, per harness, the host runtime's self-reported model list (the chat
 * picker) at a host-supplied `<dir>/model-catalog.json`. (The tool surface it
 * once also tracked went away with the `ctx.tool` rail — issue #484.)
 *
 * This module is pure storage: read + merge-write. It NEVER enumerates, so
 * reads are instant (no CLI spawn, no SDK call) — `readHarnessModels` just
 * returns the cached field or `[]`. Enumeration (and the write-back) is owned
 * by the `CatalogWarmer` (./catalog-warmer.ts), which boot and Refresh both
 * drive; there is no hardcoded seed (a cold catalog yields `[]`, and the UI
 * shows a loading/empty state until the warmer fills it in).
 *
 * Everything is best-effort: read/write failures degrade silently so callers
 * never throw.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { HarnessKind, HarnessModel } from "@centraid/app-engine";

const CATALOG_VERSION = 2 as const;

interface CatalogEntry {
  /** Hash of the enumerated model ids — lets a reader spot a stale entry. */
  hash?: string;
  models?: HarnessModel[];
  /** ISO timestamp the model list was enumerated. */
  enumeratedAt?: string;
}

interface ModelCatalogFile {
  version: typeof CATALOG_VERSION;
  harnesses: Partial<Record<HarnessKind, CatalogEntry>>;
}

/** Stable hash of a model set, by id. */
export function hashModelIds(models: readonly HarnessModel[]): string {
  return createHash("sha256")
    .update(models.map((m) => m.id).join("\n"))
    .digest("hex")
    .slice(0, 16);
}

/** Read + validate the catalog file. `undefined` on any failure. */
export async function readCatalog(
  catalogPath: string
): Promise<ModelCatalogFile | undefined> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(catalogPath, "utf8")
    ) as ModelCatalogFile;
    if (parsed && parsed.version === CATALOG_VERSION && parsed.harnesses)
      return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merge a partial patch into a single harness's entry (read-modify-write): the
 * patch writes only its own fields and the merge preserves the rest of the
 * entry. Best-effort.
 */
export async function writeCatalogEntry(
  catalogPath: string,
  kind: HarnessKind,
  patch: Partial<CatalogEntry>
): Promise<void> {
  try {
    const existing = (await readCatalog(catalogPath)) ?? {
      version: CATALOG_VERSION,
      harnesses: {},
    };
    existing.version = CATALOG_VERSION;
    existing.harnesses[kind] = { ...existing.harnesses[kind], ...patch };
    await fs.mkdir(path.dirname(catalogPath), { recursive: true });
    await fs.writeFile(catalogPath, JSON.stringify(existing, null, 2), "utf8");
  } catch {
    /* catalog is best-effort */
  }
}

/**
 * Read a harness's cached models straight from the catalog — no enumeration, no
 * seed. `[]` until the `CatalogWarmer` has populated the entry (boot or
 * Refresh). The chat picker reads this and pairs it with `deriveStatus` to show
 * a loading vs empty state.
 */
export async function readHarnessModels(
  catalogPath: string,
  kind: HarnessKind
): Promise<HarnessModel[]> {
  return (await readCatalog(catalogPath))?.harnesses[kind]?.models ?? [];
}
