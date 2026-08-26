/*
 * The ⌘K palette's empty-state source (#708 §A): RECENTS before any query.
 * Reuses `paletteEntitySearch.ts`'s session + EntityTarget catalog so the two
 * sources never disagree; `schedule.task` (no recentField) is excluded.
 */

import {
  first,
  formatMetaValue,
  PALETTE_ENTITY_TARGETS,
} from "./paletteEntitySearch.js";
import type { EntityTarget, PaletteEntityHit } from "./paletteEntitySearch.js";

export type PaletteRecentHit = PaletteEntityHit;

export interface PaletteRecents {
  /** Cached recents, most-recent first (`[]` until a fetch settles). */
  items: () => PaletteRecentHit[];
  /** One example query per app, drawn from the same cache. */
  suggestions: () => string[];
  /** Fetch once; idempotent past the first call. */
  ensure: () => void;
  reset: () => void;
  setOnResults: (fn: (() => void) | null) => void;
}

const PER_ENTITY_LIMIT = 5;
const RECENTS_TOTAL = 8;
const SUGGESTIONS_TOTAL = 4;

function recentableTargets(): (EntityTarget & { recentField: string })[] {
  return PALETTE_ENTITY_TARGETS.filter(
    (target): target is EntityTarget & { recentField: string } =>
      typeof target.recentField === "string"
  );
}

export async function fetchPaletteRecents(): Promise<PaletteRecentHit[]> {
  const { getReplicaShellSession } =
    await import("../../../replica/shell-session.js");
  const session = await getReplicaShellSession();
  const settled = await Promise.allSettled(
    recentableTargets().map(async (target) => {
      const result = await session.read(target.appId, {
        entity: target.entity,
        orderBy: { column: target.recentField, dir: "desc" },
        limit: PER_ENTITY_LIMIT,
        ...(target.deletedColumn
          ? {
              where: [{ column: target.deletedColumn, op: "is-null" as const }],
            }
          : {}),
      });
      return result.rows.flatMap(
        (
          row
        ): (PaletteRecentHit & {
          recentAt: string;
        })[] => {
          const values = row.values as Record<string, unknown>;
          const id = values[target.id];
          const label = first(values, target.labels);
          const recentAt = first(values, [target.recentField]);
          if (typeof id !== "string" || !label || !recentAt) return [];
          return [
            {
              appId: target.appId,
              appLabel: target.appLabel,
              entity: target.entity,
              kind: target.kind,
              id,
              label,
              snippet: first(values, target.snippetFields),
              meta: formatMetaValue(recentAt),
              recentAt,
            },
          ];
        }
      );
    })
  );
  return settled
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .sort((a, b) =>
      a.recentAt < b.recentAt ? 1 : a.recentAt > b.recentAt ? -1 : 0
    )
    .slice(0, RECENTS_TOTAL)
    .map(({ recentAt: _recentAt, ...hit }) => hit);
}

/** One label per app (recency order), capped — examples from vault vocabulary. */
export function suggestionsFromRecents(
  hits: readonly PaletteRecentHit[]
): string[] {
  const seenApps = new Set<string>();
  const out: string[] = [];
  for (const hit of hits) {
    if (seenApps.has(hit.appId)) continue;
    seenApps.add(hit.appId);
    out.push(hit.label);
    if (out.length >= SUGGESTIONS_TOTAL) break;
  }
  return out;
}

export function createPaletteRecents(options?: {
  fetch?: () => Promise<PaletteRecentHit[]>;
}): PaletteRecents {
  let cache: PaletteRecentHit[] | null = null;
  let inFlight = false;
  let onResults: (() => void) | null = null;
  const fetchRecents = options?.fetch ?? fetchPaletteRecents;
  return {
    items() {
      return cache ?? [];
    },
    suggestions() {
      return suggestionsFromRecents(cache ?? []);
    },
    ensure() {
      if (cache !== null || inFlight) return;
      inFlight = true;
      void fetchRecents()
        .then((hits) => {
          cache = hits;
        })
        .catch(() => {
          cache = [];
        })
        .finally(() => {
          inFlight = false;
          onResults?.();
        });
    },
    reset() {
      cache = null;
      inFlight = false;
    },
    setOnResults(fn) {
      onResults = fn;
    },
  };
}
