const BUCKET_BOUNDS_MS = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000,
] as const;

const BUCKET_COUNT = BUCKET_BOUNDS_MS.length + 1;

const MAX_ROUTES = 64;

const OTHER = "other";

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
  return segment.length > 24;
}

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

export class RouteLatencyMetrics {
  private readonly routes = new Map<string, RouteHistogram>();

  record(pathname: string, durationMs: number): void {
    const requested = routeLabel(pathname);
    let histogram = this.routes.get(requested);
    if (!histogram) {
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

  reset(): void {
    this.routes.clear();
  }
}
