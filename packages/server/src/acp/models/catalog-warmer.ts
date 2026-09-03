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
    if (models.length) {
      await writeCatalogEntry(this.opts.catalogPath, kind, {
        hash: hashModelIds(models),
        models,
        enumeratedAt: new Date().toISOString(),
      });
    }
  }
}

export function deriveStatus(
  cachedLen: number,
  warming: boolean
): SurfaceStatus {
  if (warming) return "loading";
  if (cachedLen > 0) return "ready";
  return "empty";
}
