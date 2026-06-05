/*
 * Catalog warmer — the single owner of host-capability enumeration.
 *
 * Both surfaces (models, tools) for both runners are enumerated through one
 * shared `CatalogWarmer` instance, on two triggers:
 *
 *  - **Boot**: the gateway warms every detected runner × surface in the
 *    background so the catalog is fresh before anyone opens the picker.
 *  - **Refresh / cold read**: the status routes kick a warm fire-and-forget;
 *    the client polls the surface's `SurfaceStatus` until it leaves `loading`.
 *
 * `warm(kind, surface)` dedupes concurrent calls (boot + an immediate Refresh
 * join one enumeration), runs the injected enumerator best-effort, and on a
 * NON-EMPTY result merge-writes the catalog via `writeCatalogEntry` (an empty
 * result never clobbers a prior good entry). The enumerators are injected so
 * this stays free of gateway-only concerns (`enumerateHostTools` needs a cwd +
 * mock-LLM; model/tool prefs come from the gateway's prefs loader).
 *
 * Reads stay in `./catalog.ts` (`readRunnerModels` / `readRunnerTools`); this
 * module only writes. `deriveStatus` turns (cached length, isWarming) into the
 * tri-state the UI renders.
 */

import type { RunnerKind, RunnerModel, SurfaceStatus } from '@centraid/app-engine';
import type { HostTool } from '../host-tools.js';
import { writeCatalogEntry, hashModelIds } from './catalog.js';

export type { SurfaceStatus } from '@centraid/app-engine';

/** The two host-capability surfaces the catalog tracks per runner. */
export type CatalogSurface = 'models' | 'tools';

export interface CatalogWarmerOptions {
  catalogPath: string;
  /** Live model self-report for a kind. Best-effort; should resolve `[]` on failure. */
  enumerateModels: (kind: RunnerKind) => Promise<RunnerModel[]>;
  /** Live tool probe for a kind. Best-effort; should resolve `[]` on failure. */
  enumerateTools: (kind: RunnerKind) => Promise<HostTool[]>;
}

export class CatalogWarmer {
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(private readonly opts: CatalogWarmerOptions) {}

  private key(kind: RunnerKind, surface: CatalogSurface): string {
    return `${kind}:${surface}`;
  }

  /** Is a warm for this (kind, surface) currently running? */
  isWarming(kind: RunnerKind, surface: CatalogSurface): boolean {
    return this.inflight.has(this.key(kind, surface));
  }

  /**
   * Start (or join) a warm for (kind, surface). Resolves when it finishes.
   * Concurrent calls for the same key share one enumeration.
   */
  warm(kind: RunnerKind, surface: CatalogSurface): Promise<void> {
    const k = this.key(kind, surface);
    const existing = this.inflight.get(k);
    if (existing) return existing;
    const run = this.run(kind, surface).finally(() => this.inflight.delete(k));
    this.inflight.set(k, run);
    return run;
  }

  private async run(kind: RunnerKind, surface: CatalogSurface): Promise<void> {
    if (surface === 'models') {
      let models: RunnerModel[] = [];
      try {
        models = await this.opts.enumerateModels(kind);
      } catch {
        models = [];
      }
      // Empty result → never clobber a prior good entry (no write).
      if (models.length) {
        await writeCatalogEntry(this.opts.catalogPath, kind, {
          hash: hashModelIds(models),
          models,
          enumeratedAt: new Date().toISOString(),
        });
      }
      return;
    }

    let tools: HostTool[] = [];
    try {
      tools = await this.opts.enumerateTools(kind);
    } catch {
      tools = [];
    }
    if (tools.length) {
      await writeCatalogEntry(this.opts.catalogPath, kind, {
        tools,
        toolsEnumeratedAt: new Date().toISOString(),
      });
    }
  }
}

/**
 * Tri-state a surface from its cached size and whether a warm is in flight.
 * `loading` wins over a non-empty cache so an in-flight warm (boot OR an
 * explicit Refresh over an existing list) reports `loading` and the client
 * polls to pick up the fresh list. Blank-avoidance is the renderer's job: it
 * keeps showing the cached list while `loading` rather than clearing it.
 */
export function deriveStatus(cachedLen: number, warming: boolean): SurfaceStatus {
  if (warming) return 'loading';
  if (cachedLen > 0) return 'ready';
  return 'empty';
}
