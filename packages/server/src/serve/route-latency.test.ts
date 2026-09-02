// The gateway reports event-loop lag; without per-route histograms it cannot
// say WHICH route is slow, so every performance claim needs a bench rig to
// reproduce (#659).

import { describe, expect, it } from "vitest";

import { RouteLatencyMetrics, routeLabel } from "./route-latency.js";

describe(routeLabel, () => {
  it("keeps the route and replaces the data in it", () => {
    expect(routeLabel("/centraid/_apps")).toBe("/centraid/_apps");
    expect(
      routeLabel(
        "/centraid/_apps/1f0b6c2e-2a6f-4f1e-9f3a-0b1c2d3e4f50/sessions"
      )
    ).toBe("/centraid/_apps/:id");
    expect(routeLabel("/centraid/_vault/notifications")).toBe(
      "/centraid/_vault/notifications"
    );
    expect(routeLabel("/")).toBe("/");
  });

  it("collapses ids so one label cannot exist per conversation", () => {
    const labels = new Set(
      Array.from({ length: 500 }, (_, index) =>
        routeLabel(`/centraid/_conversations/${index}/turns`)
      )
    );
    expect(labels.size).toBe(1);
  });
});

describe(RouteLatencyMetrics, () => {
  it("reports percentiles as the bucket ceiling that covers them", () => {
    const metrics = new RouteLatencyMetrics();
    for (let index = 0; index < 95; index += 1)
      metrics.record("/centraid/_apps", 3);
    for (let index = 0; index < 5; index += 1)
      metrics.record("/centraid/_apps", 4_000);

    const [summary] = metrics.snapshot();
    expect(summary?.route).toBe("/centraid/_apps");
    expect(summary?.count).toBe(100);
    expect(summary?.p50Ms).toBe(5);
    expect(summary?.p95Ms).toBe(5);
    expect(summary?.p99Ms).toBe(5_000);
    expect(summary?.maxMs).toBe(4_000);
  });

  it("keeps one histogram per route, busiest first", () => {
    const metrics = new RouteLatencyMetrics();
    metrics.record("/centraid/_vault/parked", 10);
    for (let index = 0; index < 5; index += 1)
      metrics.record("/centraid/_apps", 10);
    const routes = metrics.snapshot().map((s) => s.route);
    expect(routes).toStrictEqual([
      "/centraid/_apps",
      "/centraid/_vault/parked",
    ]);
  });

  it("never grows past its label ceiling, whatever paths arrive", () => {
    const metrics = new RouteLatencyMetrics();
    for (let index = 0; index < 5_000; index += 1)
      metrics.record(`/route-${index}/leaf`, 1);
    expect(metrics.snapshot().length).toBeLessThanOrEqual(64);
    // The overflow is folded, not dropped: every sample is still counted.
    const total = metrics
      .snapshot()
      .reduce((sum, summary) => sum + summary.count, 0);
    expect(total).toBe(5_000);
  });

  it("resets to empty for a fresh measurement epoch", () => {
    const metrics = new RouteLatencyMetrics();
    metrics.record("/centraid/_apps", 1);
    metrics.reset();
    expect(metrics.snapshot()).toStrictEqual([]);
  });
});
