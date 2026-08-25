// Pure (#708): no React, no react-native, no replica imports.

import type { IconName } from "@centraid/design";

import { BLUEPRINT_SEARCH_TARGETS } from "./blueprint-search";
import type { BlueprintSearchHit } from "./blueprint-search";

export interface SearchGroup {
  appId: string;
  appLabel: string;
  appColor: string | undefined;
  appIconKey: IconName;
  hits: BlueprintSearchHit[];
}

// Catalog order — the same order the overlay's filter chips use.
const APP_ORDER: readonly string[] = BLUEPRINT_SEARCH_TARGETS.map(
  (target) => target.appId
);

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

export interface RecentSourceRow {
  appId: string;
  appLabel: string;
  appColor: string | undefined;
  appIconKey: IconName;
  kind: string;
  id: string;
  label: string;
  meta?: string;
}

/** Rows without `meta` sort last: unknown is not evidence of recency. */
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

export function formatSearchMeta(iso?: string): string | undefined {
  if (!iso) return undefined;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return undefined;
  return when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A long label yields its longest word — never an ellipsised fragment. */
function deriveSuggestionTerm(
  label: string,
  maxTermChars: number
): string | undefined {
  const trimmed = label.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxTermChars) return trimmed;
  let best: string | undefined;
  for (const raw of trimmed.split(/\s+/u)) {
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (word.length < 3 || word.length > maxTermChars) continue;
    if (!best || word.length > best.length) best = word;
  }
  return best;
}

/** Caps count AND row characters: the chip row is one line, never wrapped. */
export function selectSuggestionChips(
  candidates: readonly string[],
  limit = 3,
  maxTermChars = 16,
  rowCharBudget = 30
): string[] {
  const seen = new Set<string>();
  const chips: string[] = [];
  let used = 0;
  for (const raw of candidates) {
    const term = deriveSuggestionTerm(raw, maxTermChars);
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Keep scanning: a shorter later term may still fit.
    if (used + term.length > rowCharBudget) continue;
    chips.push(term);
    used += term.length;
    if (chips.length >= limit) break;
  }
  return chips;
}
