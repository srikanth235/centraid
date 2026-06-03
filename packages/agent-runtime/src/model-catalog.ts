/*
 * Gateway-owned model catalog store.
 *
 * Persists the per-runner model list the chat picker shows, at a
 * host-supplied `<dir>/model-catalog.json`. The lifecycle is deliberately
 * simple:
 *
 *  - **Default load** (no refresh) → return the cached entry if present,
 *    else the hardcoded `defaults` seed. NEVER enumerate on a normal load,
 *    so the picker is instant (no `claude -p` turn, no `codex app-server`
 *    spawn).
 *  - **Refresh** → run `enumerate()` synchronously; on a non-empty result
 *    overwrite the entry and return it; on failure keep the prior entry if
 *    present, else fall back to `defaults` (never clobber a good catalog on
 *    a transient failure).
 *
 * Everything is best-effort: read/write failures degrade silently so the
 * caller (`runner-status`) never throws.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { RunnerKind, RunnerModel } from '@centraid/app-engine';

const CATALOG_VERSION = 1 as const;

interface CatalogEntry {
  /** Hash of the enumerated ids — lets a reader spot a stale entry. */
  hash: string;
  models: RunnerModel[];
  /** ISO timestamp the entry was enumerated. */
  enumeratedAt: string;
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

/** Read-modify-write a single runner's entry. Best-effort. */
export async function writeCatalogEntry(
  catalogPath: string,
  kind: RunnerKind,
  entry: CatalogEntry,
): Promise<void> {
  try {
    const existing = (await readCatalog(catalogPath)) ?? {
      version: CATALOG_VERSION,
      runners: {},
    };
    existing.runners[kind] = entry;
    await fs.mkdir(path.dirname(catalogPath), { recursive: true });
    await fs.writeFile(catalogPath, JSON.stringify(existing, null, 2), 'utf8');
  } catch {
    /* catalog is best-effort */
  }
}

/**
 * Resolve the models to surface for a runner.
 *
 * @param enumerate  Live self-report; only invoked on `refresh`.
 * @param defaults   Hardcoded seed shown until the catalog is populated.
 */
export async function resolveRunnerModels(opts: {
  kind: RunnerKind;
  catalogPath: string;
  enumerate: () => Promise<RunnerModel[]>;
  defaults: RunnerModel[];
  refresh?: boolean;
}): Promise<RunnerModel[]> {
  const { kind, catalogPath, enumerate, defaults, refresh } = opts;
  const cached = (await readCatalog(catalogPath))?.runners[kind];

  if (refresh) {
    let enumerated: RunnerModel[] = [];
    try {
      enumerated = await enumerate();
    } catch {
      enumerated = [];
    }
    if (enumerated.length) {
      await writeCatalogEntry(catalogPath, kind, {
        hash: hashModelIds(enumerated),
        models: enumerated,
        enumeratedAt: new Date().toISOString(),
      });
      return enumerated;
    }
    // Enumeration failed — never clobber a good catalog.
    return cached?.models ?? defaults;
  }

  return cached?.models ?? defaults;
}
