/*
 * Gateway-owned host-capability catalog store.
 *
 * Persists, per runner, the two things a host runtime can self-report — its
 * model list (the chat picker) and its tool surface (builtins + MCP, the
 * builder's grounding and the Settings → Agents tools view) — at a
 * host-supplied `<dir>/model-catalog.json`. Models and tools refresh on
 * INDEPENDENT triggers, so each is read-modify-write merged into the shared
 * per-runner entry; one never clobbers the other.
 *
 * This module is pure storage: read + merge-write. It NEVER enumerates, so
 * reads are instant (no CLI spawn, no SDK call) — the `readRunner*` helpers
 * just return the cached field or `[]`. Enumeration (and the write-back) is
 * owned by the `CatalogWarmer` (./catalog-warmer.ts), which boot and Refresh
 * both drive; there is no hardcoded seed (a cold catalog yields `[]`, and the
 * UI shows a loading/empty state until the warmer fills it in).
 *
 * Everything is best-effort: read/write failures degrade silently so callers
 * never throw.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { RunnerKind, RunnerModel } from '@centraid/app-engine';
import type { HostTool } from '../host-tools.js';

const CATALOG_VERSION = 2 as const;

interface CatalogEntry {
  /** Hash of the enumerated model ids — lets a reader spot a stale entry. */
  hash?: string;
  models?: RunnerModel[];
  /** ISO timestamp the model list was enumerated. */
  enumeratedAt?: string;
  /** Host tools (builtins + MCP) — absent until the first tool enumeration. */
  tools?: HostTool[];
  /** ISO timestamp the tool list was enumerated. */
  toolsEnumeratedAt?: string;
}

interface ModelCatalogFile {
  version: typeof CATALOG_VERSION;
  runners: Partial<Record<RunnerKind, CatalogEntry>>;
}

/** Stable hash of a model set, by id. */
export function hashModelIds(models: readonly RunnerModel[]): string {
  return createHash('sha256')
    .update(models.map((m) => m.id).join('\n'))
    .digest('hex')
    .slice(0, 16);
}

/** Read + validate the catalog file. `undefined` on any failure. */
export async function readCatalog(catalogPath: string): Promise<ModelCatalogFile | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(catalogPath, 'utf8')) as ModelCatalogFile;
    if (parsed && parsed.version === CATALOG_VERSION && parsed.runners) return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merge a partial patch into a single runner's entry (read-modify-write).
 * Models and tools refresh independently, so each writes only its own fields;
 * the merge preserves the other's. Best-effort.
 */
export async function writeCatalogEntry(
  catalogPath: string,
  kind: RunnerKind,
  patch: Partial<CatalogEntry>,
): Promise<void> {
  try {
    const existing = (await readCatalog(catalogPath)) ?? {
      version: CATALOG_VERSION,
      runners: {},
    };
    existing.version = CATALOG_VERSION;
    existing.runners[kind] = { ...existing.runners[kind], ...patch };
    await fs.mkdir(path.dirname(catalogPath), { recursive: true });
    await fs.writeFile(catalogPath, JSON.stringify(existing, null, 2), 'utf8');
  } catch {
    /* catalog is best-effort */
  }
}

/**
 * Read a runner's cached models straight from the catalog — no enumeration, no
 * seed. `[]` until the `CatalogWarmer` has populated the entry (boot or
 * Refresh). The chat picker reads this and pairs it with `deriveStatus` to show
 * a loading vs empty state.
 */
export async function readRunnerModels(
  catalogPath: string,
  kind: RunnerKind,
): Promise<RunnerModel[]> {
  return (await readCatalog(catalogPath))?.runners[kind]?.models ?? [];
}

/**
 * Read a runner's cached host tools straight from the catalog — no enumeration,
 * no fallback. The builder's grounding reads this on every turn (instant), so it
 * never spawns a CLI; the boot probe / explicit refresh is what populates it.
 */
export async function readRunnerTools(catalogPath: string, kind: RunnerKind): Promise<HostTool[]> {
  return (await readCatalog(catalogPath))?.runners[kind]?.tools ?? [];
}
