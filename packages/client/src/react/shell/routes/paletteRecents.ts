/*
 * The ⌘K palette's empty-state source (issue #708 §A, last item): before any
 * query, the palette shows RECENTS (recently opened/edited vault objects)
 * rather than a blank void. Reuses the same replica session as
 * `paletteEntitySearch.ts` — `session.read` instead of `session.search`,
 * ordered by each entity's edit-time column instead of matched against a
 * query term — and the same `EntityTarget` catalog, so the two sources can
 * never disagree about which app owns which entity/kind/icon.
 *
 * `schedule.task` carries no `recentField` (see `paletteEntitySearch.ts`) and
 * is excluded here rather than approximated — a member's tasks simply don't
 * appear in Recents until the schema grows an edit-time column.
 *
 * Suggestion chips (also part of the empty state) are derived from the same
 * fetch — one label per app, in recency order — rather than a second
 * round-trip: "recently touched" objects are exactly the vocabulary a member
 * is likeliest to search for next.
 */

import {
  first,
  formatMetaValue,
  PALETTE_ENTITY_TARGETS,
} from "./paletteEntitySearch.js";
import type { EntityTarget, PaletteEntityHit } from "./paletteEntitySearch.js";

export type PaletteRecentHit = PaletteEntityHit;

export interface PaletteRecents {
  /** Cached recents, most-recently-touched first (`[]` until a fetch settles). */
  items: () => PaletteRecentHit[];
  /** One example query per app, drawn from the same cache. */
  suggestions: () => string[];
  /** Fetch once (idempotent past the first call, like the search sources' cache). */
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

/** One label per app (in the order recents already carries — most recent
 *  first), capped — the vault's own vocabulary as example queries. */
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
