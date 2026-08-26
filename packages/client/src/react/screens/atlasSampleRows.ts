import { useEffect, useRef, useState } from "react";

import { SEALED_SENTINEL, isSealedValue } from "./atlasBrowseData.js";

// Sample rows for the Relations orrery (#441). Reuse the Browse endpoint
// verbatim and invent no values.

/** Optional, so a host that omits it renders the "no samples" path. */
export type SampleRowsFetcher = (
  logical: string
) => Promise<Record<string, unknown>[]>;

/** `ready` may carry zero rows — an empty table is a truth, not an error.
 *  No entry means still in flight. */
export type SampleResult =
  | { status: "ready"; rows: Record<string, unknown>[] }
  | { status: "error" };

const SAMPLE_LIMIT = 3;

/** Hover must never trigger a fetch — it is transient and would storm the
 *  endpoint. A cache hit never refetches; an unsettled fetch shows nothing. */
export function useSampleRows(
  logical: string | undefined,
  fetcher: SampleRowsFetcher | undefined
): SampleResult | undefined {
  const [cache, setCache] = useState<Map<string, SampleResult>>(
    () => new Map()
  );
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!fetcher || logical === undefined) return;
    if (cache.has(logical)) return; // cache hit — never refetch
    let cancelled = false;
    void fetcher(logical)
      .then((rows) => {
        if (cancelled || !mountedRef.current) return;
        setCache((current) =>
          new Map(current).set(logical, {
            status: "ready",
            rows: rows.slice(0, SAMPLE_LIMIT),
          })
        );
      })
      .catch(() => {
        if (cancelled || !mountedRef.current) return;
        // Pretending the table is empty would read as "Nothing here yet".
        setCache((current) =>
          new Map(current).set(logical, { status: "error" })
        );
      });
    return () => {
      cancelled = true;
    };
  }, [logical, fetcher, cache]);

  return logical === undefined ? undefined : cache.get(logical);
}

/** Pass 1 of the row→string heuristic reads only these. */
const PREFERRED_NAME_PARTS = [
  "title",
  "name",
  "label",
  "summary",
  "subject",
  "pref_label",
  "display_name",
] as const;

/** Skipped by both content passes, so no FK reads as a display string. */
const looksLikeId = (key: string): boolean => /(?:^|_)id$/iu.test(key);

/** Numbers pass only as the primary-key fallback. */
const stringish = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Sealed columns are skipped, an entirely sealed row shows the sentinel, and
 *  nothing usable is an em dash — never a fabricated label. */
export function pickSampleDisplay(row: Record<string, unknown>): string {
  const entries = Object.entries(row);

  for (const [key, value] of entries) {
    if (looksLikeId(key)) continue;
    if (isSealedValue(value)) continue;
    if (!PREFERRED_NAME_PARTS.some((p) => key.toLowerCase().includes(p)))
      continue;
    if (stringish(value)) return value;
  }

  for (const [key, value] of entries) {
    if (looksLikeId(key)) continue;
    if (isSealedValue(value)) continue;
    if (stringish(value)) return value;
  }

  for (const [key, value] of entries) {
    if (!looksLikeId(key)) continue;
    if (isSealedValue(value)) continue;
    if (value !== null && value !== undefined) return String(value);
  }

  // Everything usable was sealed.
  if (entries.some(([, value]) => isSealedValue(value))) return SEALED_SENTINEL;
  return "—";
}
