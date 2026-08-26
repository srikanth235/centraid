/*
 * Catalog warmer — the single owner of host-capability enumeration.
 *
 * Empty enumerator result never clobbers a prior good entry. A finished warm
 * is RECORDED (`hasWarmed`) even when empty; without that, "empty cache → kick
 * a warm" re-kicks every poll and `deriveStatus` never leaves `loading`.
 * Reads stay in `./catalog.ts`; this module only writes.
 */

import type {
  HarnessKind,
  HarnessModel,
  SurfaceStatus,
} from "@centraid/server/engine";

import { writeCatalogEntry, hashModelIds } from "./catalog.js";

export type { SurfaceStatus } from "@centraid/server/engine";

export type CatalogSurface = "models";

export interface CatalogWarmerOptions {
  catalogPath: string;
  /** Live model self-report for a kind. Best-effort; should resolve `[]` on failure. */
  enumerateModels: (kind: HarnessKind) => Promise<HarnessModel[]>;
}

export class CatalogWarmer {
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly warmed = new Set<string>();

  constructor(private readonly opts: CatalogWarmerOptions) {}

  private key(kind: HarnessKind, surface: CatalogSurface): string {
    return `${kind}:${surface}`;
  }

  isWarming(kind: HarnessKind, surface: CatalogSurface): boolean {
    return this.inflight.has(this.key(kind, surface));
  }

  /** True even when it enumerated nothing — empty is an answer, not a retry. */
  hasWarmed(kind: HarnessKind, surface: CatalogSurface): boolean {
    return this.warmed.has(this.key(kind, surface));
  }

  warm(kind: HarnessKind, surface: CatalogSurface): Promise<void> {
    const k = this.key(kind, surface);
    const existing = this.inflight.get(k);
    if (existing) return existing;
    const run = this.run(kind, surface).finally(() => {
      this.inflight.delete(k);
      this.warmed.add(k);
    });
    this.inflight.set(k, run);
    return run;
  }

  private async run(
    kind: HarnessKind,
    _surface: CatalogSurface
  ): Promise<void> {
    let models: HarnessModel[] = [];
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
  }
}

/**
 * `loading` wins over a non-empty cache so an in-flight warm reports `loading`
 * and the client polls. Blank-avoidance is the renderer's job: it keeps showing
 * the cached list while `loading` rather than clearing it.
 */
export function deriveStatus(
  cachedLen: number,
  warming: boolean
): SurfaceStatus {
  if (warming) return "loading";
  if (cachedLen > 0) return "ready";
  return "empty";
}
