// The Relations tab's fixed lenses — question chips and detail-dial positions —
// extracted so AtlasRelationsTab stays under the repo's component-file cap.

import type { AtlasDetailLevel } from './atlasOrreryGeometry.js';

export const fmt = (n: number): string => n.toLocaleString('en-US');

/** The three question chips above the stage — each a saved "lens" over the
 *  chart. `q` is the stable key (also the `data-q` attribute); one is active at
 *  a time, and clicking the active one clears it. */
export const QUESTIONS: readonly { q: 'connected' | 'heaviest' | 'unused'; label: string }[] = [
  { q: 'connected', label: "What's connected here?" },
  { q: 'heaviest', label: "Where's my data heaviest?" },
  { q: 'unused', label: "What's unused?" },
];
export type QuestionKey = (typeof QUESTIONS)[number]['q'];

/** The three detail-dial positions, tightest lens first. Each is an honest
 *  FILTER over the real schema (never an aggregation — see `visibleAtLevel` for
 *  the filter-not-aggregate rationale and the bearings-stay-fixed invariant):
 *  Simple shows only kinds that provably carry data; Standard is today's lens;
 *  Everything reveals the unreachable machinery and the raw SQL names too. */
export const LEVELS: readonly { level: AtlasDetailLevel; label: string }[] = [
  { level: 'simple', label: 'Simple' },
  { level: 'standard', label: 'Standard' },
  { level: 'everything', label: 'Everything' },
];
