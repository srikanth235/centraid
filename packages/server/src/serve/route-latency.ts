/*
 * Per-route request-duration histograms (issue #659 R5).
 *
 * The gateway could report event-loop lag and RSS but not "which route is
 * slow" — so every performance claim about a shipped gateway had to be
 * reproduced on a bench rig first. This closes that: the same health snapshot
 * that already carries `eventLoopLagP99Ms` now carries a p50/p95/p99 per route.
 *
 * Cheap by construction, because it runs on every request:
 *   - fixed logarithmic buckets, so recording is a bounded scan and an integer
 *     increment — no allocation, no sorting, no retained samples;
 *   - a bounded route-label set, because a histogram per URL is a memory leak
 *     with a metrics name (see {@link routeLabel}); and
 *   - percentiles computed only when someone reads the snapshot.
 *
 * The percentiles are bucket-resolution estimates, reported as the bucket's
 * upper bound. That is the honest reading: a p99 of 250 means "at least 99% of
 * requests finished within 250ms", never "the 99th request took exactly 250ms".
 */

/**
 * Bucket upper bounds in ms. Dense where the budget lives (the low-end
 * `requestP99Ms` ceiling is 250ms) and coarse out in the tail, where the only
 * question is "how bad".
 */
const BUCKET_BOUNDS_MS = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000,
] as const;

/** Anything slower than the last bound lands in the overflow bucket. */
const BUCKET_COUNT = BUCKET_BOUNDS_MS.length + 1;

/**
 * Ceiling on distinct route labels. Reaching it means {@link routeLabel} let
 * something unbounded through; the extra labels are folded into `other` rather
 * than growing the map, so a bug here costs fidelity and never memory.
 */
const MAX_ROUTES = 64;

const OTHER = "other";

/** A path segment that is data, not a route: uuids, hashes, ids, numbers. */
function isVariableSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  if (/^\d+$/u.test(segment)) return true;
  if (/^[0-9a-f]{8,}$/iu.test(segment)) return true;
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      segment
    )
  ) {
    return true;
  }
  // Long opaque tokens (base64url ids, vault ids) are data too.
  return segment.length > 24;
}

/**
 * A low-cardinality label for a request path. Keeps the first three segments,
 * replaces anything that looks like an identifier with `:id`, and drops the
 * rest — `/centraid/_apps/e0f1.../sessions/abc` becomes `/centraid/_apps/:id`.
 * Cardinality is what makes a metric affordable; a label per conversation id is
 * how observability turns into the thing it was measuring.
 */
export function routeLabel(pathname: string): string {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return "/";
  return `/${segments
    .slice(0, 3)
    .map((segment) => (isVariableSegment(segment) ? ":id" : segment))
    .join("/")}`;
}

export interface RouteLatencySummary {
  route: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

function percentileFrom(
  buckets: readonly number[],
  count: number,
  quantile: number
): number {
  const target = Math.ceil(count * quantile);
  let seen = 0;
  for (let index = 0; index < buckets.length; index += 1) {
    seen += buckets[index] ?? 0;
    if (seen >= target) {
      return BUCKET_BOUNDS_MS[index] ?? Number.POSITIVE_INFINITY;
    }
  }
  return Number.POSITIVE_INFINITY;
}

interface RouteHistogram {
  buckets: number[];
  count: number;
  maxMs: number;
}

/** Fixed-bucket duration histograms keyed by {@link routeLabel}. */
export class RouteLatencyMetrics {
  private readonly routes = new Map<string, RouteHistogram>();

  /** Record one completed request. Constant time, zero allocation on repeat routes. */
  record(pathname: string, durationMs: number): void {
    const requested = routeLabel(pathname);
    let histogram = this.routes.get(requested);
    if (!histogram) {
      // -1 reserves the slot the `other` bucket itself occupies.
      const label = this.routes.size >= MAX_ROUTES - 1 ? OTHER : requested;
      histogram = this.routes.get(label);
      if (!histogram) {
        histogram = {
          buckets: Array.from({ length: BUCKET_COUNT }, () => 0),
          count: 0,
          maxMs: 0,
        };
        this.routes.set(label, histogram);
      }
    }
    let index = 0;
    while (
      index < BUCKET_BOUNDS_MS.length &&
      durationMs > BUCKET_BOUNDS_MS[index]!
    ) {
      index += 1;
    }
    histogram.buckets[index] = (histogram.buckets[index] ?? 0) + 1;
    histogram.count += 1;
    if (durationMs > histogram.maxMs) histogram.maxMs = durationMs;
  }

  /**
   * Per-route percentiles, busiest route first. Computed on read — nothing here
   * runs on the request path.
   */
  snapshot(): RouteLatencySummary[] {
    return [...this.routes.entries()]
      .map(([route, histogram]) => ({
        route,
        count: histogram.count,
        p50Ms: percentileFrom(histogram.buckets, histogram.count, 0.5),
        p95Ms: percentileFrom(histogram.buckets, histogram.count, 0.95),
        p99Ms: percentileFrom(histogram.buckets, histogram.count, 0.99),
        maxMs: histogram.maxMs,
      }))
      .sort((left, right) => right.count - left.count);
  }

  /** Drop every recorded sample — used by the in-process benchmark's epoch reset. */
  reset(): void {
    this.routes.clear();
  }
}
