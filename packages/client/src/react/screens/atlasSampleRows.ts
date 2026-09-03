import { useEffect, useRef, useState } from "react";

import { SEALED_SENTINEL, isSealedValue } from "./atlasBrowseData.js";

export type SampleRowsFetcher = (
  logical: string
) => Promise<Record<string, unknown>[]>;

export type SampleResult =
  | { status: "ready"; rows: Record<string, unknown>[] }
  | { status: "error" };

const SAMPLE_LIMIT = 3;

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

const PREFERRED_NAME_PARTS = [
  "title",
  "name",
  "label",
  "summary",
  "subject",
  "pref_label",
  "display_name",
] as const;

const looksLikeId = (key: string): boolean => /(?:^|_)id$/iu.test(key);

const stringish = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

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

  if (entries.some(([, value]) => isSealedValue(value))) return SEALED_SENTINEL;
  return "—";
}
