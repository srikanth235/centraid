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
 * The lifecycle mirrors for both:
 *
 *  - **Default load** (no refresh) → return the cached field if present, else
 *    the caller's fallback (the model seed for models; `[]` for tools — tools
 *    are MCP-config-specific, so they have no hardcoded seed). NEVER enumerate
 *    on a normal load, so reads are instant (no CLI spawn, no SDK call).
 *  - **Refresh** → run `enumerate()`; on a non-empty result overwrite that
 *    field and return it; on failure keep the prior field if present, else fall
 *    back (never clobber a good entry on a transient failure).
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

/**
 * Read a runner's cached host tools straight from the catalog — no enumeration,
 * no fallback. The builder's grounding reads this on every turn (instant), so it
 * never spawns a CLI; the boot probe / explicit refresh is what populates it.
 */
export async function readRunnerTools(catalogPath: string, kind: RunnerKind): Promise<HostTool[]> {
  return (await readCatalog(catalogPath))?.runners[kind]?.tools ?? [];
}

/**
 * Resolve the host tools to surface for a runner (builtins + MCP).
 *
 * Mirrors `resolveRunnerModels` but tools have NO hardcoded seed — they depend
 * on the host's MCP configuration, so a seed would lie. Until the first
 * successful enumeration the result is `[]` (the builder simply omits the
 * grounding block and the UI shows an empty state).
 *
 * @param enumerate  Live tool probe; only invoked on `refresh`.
 */
export async function resolveRunnerTools(opts: {
  kind: RunnerKind;
  catalogPath: string;
  enumerate: () => Promise<HostTool[]>;
  refresh?: boolean;
}): Promise<HostTool[]> {
  const { kind, catalogPath, enumerate, refresh } = opts;
  const cached = (await readCatalog(catalogPath))?.runners[kind];

  if (refresh) {
    let enumerated: HostTool[] = [];
    try {
      enumerated = await enumerate();
    } catch {
      enumerated = [];
    }
    if (enumerated.length) {
      await writeCatalogEntry(catalogPath, kind, {
        tools: enumerated,
        toolsEnumeratedAt: new Date().toISOString(),
      });
      return enumerated;
    }
    // Probe failed — never clobber a good tool list.
    return cached?.tools ?? [];
  }

  return cached?.tools ?? [];
}
