// Pure search-surface logic for the mobile Search overlay (issue #708, mobile
// close-out). Kept apart from SearchOverlay.tsx / useSearchRecents.ts (no
// React, no react-native, no replica imports) for the same reason
// ./tile-model and ./catalog are: the rule for what shows up and in what
// order is the part that can be wrong, so it is the part that is unit-tested.
//
// Two responsibilities live here:
//
//  1. Grouping typed query results (`BlueprintSearchHit[]`) by their owning
//     app, in the app's catalog order — the "objects, not apps" contract:
//     the group header names the app, the rows underneath are the objects.
//  2. Deriving the empty-state RECENTS list and SUGGESTION CHIPS from
//     already-fetched replica rows, so the empty state is real vault content
//     rather than a blank void or an invented placeholder.

import type { IconName } from "@centraid/design";

import { BLUEPRINT_SEARCH_TARGETS } from "./blueprint-search";
import type { BlueprintSearchHit } from "./blueprint-search";

export interface SearchGroup {
  appId: string;
  appLabel: string;
  /** Absent when the id is not in the design registry — the renderer supplies
   *  a neutral token rather than this layer inventing a colour. */
  appColor: string | undefined;
  appIconKey: IconName;
  hits: BlueprintSearchHit[];
}

// The catalog order search targets are declared in — the same order the
// overlay's "All / Agenda / Tasks / …" filter chips already use, so a
// grouped result list and the filter row read as one consistent app order.
const APP_ORDER: readonly string[] = BLUEPRINT_SEARCH_TARGETS.map(
  (target) => target.appId
);

/** Query hits, grouped by owning app in catalog order. An app with zero hits
 *  gets no group — this is a list of groups that exist, not a fixed grid. */
export function groupSearchHits(
  hits: readonly BlueprintSearchHit[]
): SearchGroup[] {
  const byApp = new Map<string, BlueprintSearchHit[]>();
  for (const hit of hits) {
    const list = byApp.get(hit.appId);
    if (list) list.push(hit);
    else byApp.set(hit.appId, [hit]);
  }
  return APP_ORDER.flatMap((appId): SearchGroup[] => {
    const appHits = byApp.get(appId);
    if (!appHits || appHits.length === 0) return [];
    const first = appHits[0];
    if (!first) return [];
    return [
      {
        appId,
        appLabel: first.appLabel,
        appColor: first.appColor,
        appIconKey: first.appIconKey,
        hits: appHits,
      },
    ];
  });
}

/**
 * One RECENTS row, or one SUGGESTION CHIP candidate — the same shape
 * `useSearchRecents.ts` builds from its per-app bounded reads. `meta` is the
 * raw ISO instant (edited/captured/spent) the row sorts on; unlike
 * `BlueprintSearchHit`, every row here has already cleared its label check,
 * so `label` is never empty.
 */
export interface RecentSourceRow {
  appId: string;
  appLabel: string;
  /** Absent when the id is not in the design registry — the renderer supplies
   *  a neutral token rather than this layer inventing a colour. */
  appColor: string | undefined;
  appIconKey: IconName;
  kind: string;
  id: string;
  label: string;
  meta?: string;
}

/** Newest-first by `meta`; rows without one sort last, not first — an
 *  unknown timestamp is not evidence of recency. */
export function selectSearchRecents(
  rows: readonly RecentSourceRow[],
  limit = 8
): RecentSourceRow[] {
  return [...rows]
    .sort((left, right) => {
      if (!left.meta && !right.meta) return 0;
      if (!left.meta) return 1;
      if (!right.meta) return -1;
      return right.meta.localeCompare(left.meta);
    })
    .slice(0, limit);
}

/**
 * The numeric-register meta column, formatted for display: a short month +
 * day, the same shape `AgendaHome.tsx`'s range header and
 * `TallyRecurringTemplates.tsx`'s upcoming-dates line already use.
 * `undefined` in, `undefined` out — a row with no meta column renders none,
 * never a fabricated date.
 */
export function formatSearchMeta(iso?: string): string | undefined {
  if (!iso) return undefined;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return undefined;
  return when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Suggestion chips: real labels from the vault, deduplicated case-
 * insensitively, capped in count and length. Tapping a chip fills the query
 * with exactly this string (SearchOverlay owns that wiring) — so a chip is
 * never a category name or an invented example, only something that exists.
 */
export function selectSuggestionChips(
  candidates: readonly string[],
  limit = 6,
  maxChars = 28
): string[] {
  const seen = new Set<string>();
  const chips: string[] = [];
  for (const raw of candidates) {
    const label = raw.trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    chips.push(
      label.length > maxChars ? `${label.slice(0, maxChars - 1)}…` : label
    );
    if (chips.length >= limit) break;
  }
  return chips;
}
