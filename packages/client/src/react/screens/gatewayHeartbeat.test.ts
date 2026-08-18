import { describe, expect, it } from "vitest";

import { buildHeartbeatStrip, HEARTBEAT_COLUMNS } from "./gatewayHeartbeat.js";
import type { HeartbeatSample } from "./gatewayHeartbeat.js";

const START = Date.parse("2026-08-17T09:00:00Z");
const CADENCE = 15_000;

function ring(
  count: number,
  failAt: readonly number[] = []
): HeartbeatSample[] {
  return Array.from({ length: count }, (_, index) => ({
    at: START + index * CADENCE,
    latencyMs: 12,
    ok: !failAt.includes(index),
  }));
}

const NOW = START + 400 * CADENCE;

describe(buildHeartbeatStrip, () => {
  it("draws nothing until three probes have landed — two rectangles are not a shape", () => {
    expect(buildHeartbeatStrip([], NOW)).toBeNull();
    expect(buildHeartbeatStrip(ring(1), NOW)).toBeNull();
    expect(buildHeartbeatStrip(ring(2), NOW)).toBeNull();
    expect(buildHeartbeatStrip(ring(3), NOW)).not.toBeNull();
  });

  it("gives a short ring one column per probe", () => {
    const strip = buildHeartbeatStrip(ring(7), NOW);
    expect(strip?.bars).toHaveLength(7);
  });

  it("caps a long ring at the column count and covers every probe", () => {
    const strip = buildHeartbeatStrip(ring(240), NOW);
    expect(strip?.bars).toHaveLength(HEARTBEAT_COLUMNS);
    // 240 probes over 30 columns — every column carries the same weight of
    // evidence, and none of them is empty.
    expect(strip?.bars.every((bar) => bar.ok + (bar.fail ?? 0) === 100)).toBe(
      true
    );
  });

  it("colours a column by the SHARE of the bucket that went unanswered", () => {
    // 60 probes over 30 columns = 2 probes each; probe 0 failed, so the first
    // column is half red and the rest are clean.
    const strip = buildHeartbeatStrip(ring(60, [0]), NOW);
    expect(strip?.bars[0]?.fail).toBe(50);
    expect(strip?.bars[0]?.ok).toBe(50);
    expect(strip?.bars.slice(1).every((bar) => bar.fail === 0)).toBe(true);
  });

  it("names the session rather than a window it never measured", () => {
    const strip = buildHeartbeatStrip(ring(10), NOW);
    expect(strip?.note).toContain("This session only");
    expect(strip?.ariaLabel).toContain("this session");
    expect(strip?.note).not.toContain("30 days");
    expect(strip?.axis.at(-1)).toBe("now");
  });

  it("states how many heartbeats went unanswered, and when the last one was", () => {
    const clean = buildHeartbeatStrip(ring(10), NOW);
    expect(clean?.note).toContain("Every one of 10 heartbeats was answered");

    const broken = buildHeartbeatStrip(ring(10, [3, 4]), NOW);
    expect(broken?.note).toContain("2 of 10 heartbeats went unanswered");
    // The LAST failure, not the first — "when did it stop" is the question.
    expect(broken?.note).toContain("the last at");
  });

  it("labels each column with its own clock and outcome", () => {
    const strip = buildHeartbeatStrip(ring(4, [1]), NOW);
    expect(strip?.bars[0]?.label).toContain("answering");
    expect(strip?.bars[1]?.label).toContain("1 of 1 did not answer");
  });
});
