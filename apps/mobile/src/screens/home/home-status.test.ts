/**
 * Home's ambient status line — the sentence, not the frame.
 *
 * These are honesty assertions rather than copy assertions: the point of each
 * case is that the line never publishes a number it does not have, never
 * renders a capped count as an exact one, and never invents a fact this device
 * cannot read.
 */
import { describe, expect, it } from "vitest";

import { statusSentence } from "./home-status";
import type { HomeStatusFacts } from "./home-status";

const facts = (over: Partial<HomeStatusFacts> = {}): HomeStatusFacts => ({
  capped: false,
  gatewayName: "home-gateway.local",
  offline: false,
  settled: true,
  total: 8432,
  ...over,
});

describe(statusSentence, () => {
  it("groups the count and names the gateway backups run on", () => {
    expect(statusSentence(facts())).toBe(
      "8,432 things in this vault. Backups run on home-gateway.local."
    );
  });

  it("refuses to publish a number while a read is still in flight", () => {
    const line = statusSentence(facts({ settled: false }));
    expect(line).toContain("Counting what is in this vault…");
    expect(line).not.toContain("8,432");
  });

  it("says a capped total is a floor rather than an exact figure", () => {
    expect(statusSentence(facts({ capped: true, total: 200 }))).toContain(
      "At least 200 things"
    );
  });

  it("agrees in number for a vault holding exactly one thing", () => {
    expect(statusSentence(facts({ total: 1 }))).toContain("1 thing in");
  });

  it("still counts a vault holding nothing, rather than going quiet", () => {
    expect(statusSentence(facts({ total: 0 }))).toContain("0 things");
  });

  it("states offline as a schedule for writes, not as a failed read", () => {
    const line = statusSentence(facts({ offline: true }));
    expect(line).toContain("changes sync when home-gateway.local is back");
    expect(line).not.toContain("not answering");
    // Never claims a backup while it cannot reach the thing that runs them.
    expect(line).not.toContain("Backups run");
  });

  it("states an unpaired phone as absent rather than inventing a gateway", () => {
    const line = statusSentence(facts({ gatewayName: undefined }));
    expect(line).toBe(
      "8,432 things in this vault. No gateway is paired with this phone."
    );
  });

  it("never invents a last-backup date the phone has no read for", () => {
    for (const over of [{}, { offline: true }, { gatewayName: undefined }])
      expect(statusSentence(facts(over))).not.toMatch(
        /last backup|Sunday|ago/iu
      );
  });
});
