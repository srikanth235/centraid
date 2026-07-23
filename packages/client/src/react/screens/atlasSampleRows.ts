import { useEffect, useRef, useState } from 'react';
import { SEALED_SENTINEL, isSealedValue } from './atlasBrowseData.js';

// Sample-row plumbing for the Relations orrery's "A few of yours" panel section
// (issue #441 human-language layer). The chart speaks human — People, not
// core_party — so the readout rail earns its keep by showing a few REAL rows of
// whatever kind you stand on. This reuses the Browse endpoint verbatim
// (`browseRows({ table, limit: 3 })`), adds zero new gateway plumbing, and never
// invents a value: a fetch that fails is a fetch that shows nothing.

/** The fetcher the Relations tab is handed — a thin wrapper over `browseRows`
 *  wired in AtlasScreen. Optional at the component seam so a test (or any host)
 *  that omits it renders the section-less "no samples" path cleanly. */
export type SampleRowsFetcher = (logical: string) => Promise<Record<string, unknown>[]>;

/**
 * The settled outcome for one kind's sample fetch, cached per-mount. `ready`
 * carries the rows (possibly empty — an empty table is a truth, not an error);
 * `error` carries nothing, so the panel simply omits the section rather than
 * inventing a placeholder. The absence of an entry means "still in flight".
 */
export type SampleResult =
  | { status: 'ready'; rows: Record<string, unknown>[] }
  | { status: 'error' };

/** How many sample rows we ever show — a glance, not a grid. */
const SAMPLE_LIMIT = 3;

/**
 * Fetch up to three sample rows for the CURRENT CENTRE only, cached per-mount by
 * logical name. Hover is deliberately NOT a fetch trigger — it is transient and
 * would storm the endpoint — so this keys purely off the centre's logical name.
 * A cache hit never refetches; an in-flight or errored fetch resolves to
 * `undefined`/`{status:'error'}` so the caller shows nothing, never a spinner.
 */
export function useSampleRows(
  logical: string | undefined,
  fetcher: SampleRowsFetcher | undefined,
): SampleResult | undefined {
  // Per-mount cache. A ref (not state) because the cache identity must be stable
  // across renders — only the resolved entry drives a re-render, via `tick`.
  const cacheRef = useRef<Map<string, SampleResult>>(new Map());
  const [, setTick] = useState(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const cache = cacheRef.current;

  useEffect(() => {
    if (!fetcher || logical === undefined) return;
    if (cache.has(logical)) return; // cache hit — never refetch
    let cancelled = false;
    void fetcher(logical)
      .then((rows) => {
        if (cancelled || !mountedRef.current) return;
        cache.set(logical, { status: 'ready', rows: rows.slice(0, SAMPLE_LIMIT) });
        setTick((n) => n + 1);
      })
      .catch(() => {
        if (cancelled || !mountedRef.current) return;
        // Honest failure: record the error so we neither refetch nor pretend the
        // table is empty (which would misread as "Nothing here yet").
        cache.set(logical, { status: 'error' });
        setTick((n) => n + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [logical, fetcher, cache]);

  return logical === undefined ? undefined : cache.get(logical);
}

/** Column-name fragments that tend to name a human-readable display value — the
 *  first pass of the row→string heuristic looks only at these. */
const PREFERRED_NAME_PARTS = [
  'title',
  'name',
  'label',
  'summary',
  'subject',
  'pref_label',
  'display_name',
] as const;

/** A column whose name reads as an identifier, not content — skipped by the two
 *  content passes so an FK/pk value never masquerades as a display string. */
const looksLikeId = (key: string): boolean => /(^|_)id$/i.test(key);

/** A usable display string is a non-blank string (numbers are only accepted as
 *  the primary-key fallback, so a numeric measure never reads as a title). */
const stringish = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * Reduce one row to a single human display string for the "A few of yours"
 * list, honestly and never inventing:
 *   1. the first non-null string among preferred-named, non-id columns,
 *   2. else the first non-null string among any non-id column,
 *   3. else the first non-null identifier value (the primary key).
 * Sealed columns read back as the `«sealed»` sentinel — they are skipped while
 * picking, but a row that is ENTIRELY sealed shows the sentinel verbatim (the
 * honest statement "this row is sealed"). A row with nothing usable is an em
 * dash, never a fabricated label.
 */
export function pickSampleDisplay(row: Record<string, unknown>): string {
  const entries = Object.entries(row);

  // Pass 1 — preferred-named content columns.
  for (const [key, value] of entries) {
    if (looksLikeId(key)) continue;
    if (isSealedValue(value)) continue;
    if (!PREFERRED_NAME_PARTS.some((p) => key.toLowerCase().includes(p))) continue;
    if (stringish(value)) return value;
  }

  // Pass 2 — any non-id content column.
  for (const [key, value] of entries) {
    if (looksLikeId(key)) continue;
    if (isSealedValue(value)) continue;
    if (stringish(value)) return value;
  }

  // Pass 3 — the primary key (an identifier is honest when there's no content).
  for (const [key, value] of entries) {
    if (!looksLikeId(key)) continue;
    if (isSealedValue(value)) continue;
    if (value !== null && value !== undefined) return String(value);
  }

  // Everything usable was sealed → say so plainly; otherwise nothing to show.
  if (entries.some(([, value]) => isSealedValue(value))) return SEALED_SENTINEL;
  return '—';
}
