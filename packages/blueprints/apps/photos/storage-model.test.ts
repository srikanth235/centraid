// The Storage screen's custody arithmetic (#711) — DOM-free, exactly as
// the model is. Two things are being pinned here: that the totals are sums of
// the buckets the gateway wrote and nothing else, and that a free-up offer is
// gated on PROVEN custody, never on a plausible-looking number.

import { describe, expect, it } from "vitest";

import type { StorageBucket, StorageRollup } from "./queries/storage.ts";
import {
  custodyFacts,
  custodyHealth,
  freeUpIsOfferable,
} from "./storage-model.ts";

const EMPTY_BUCKETS: Record<StorageBucket, { count: number; bytes: number }> = {
  "pending-offsite": { count: 0, bytes: 0 },
  "local-only": { count: 0, bytes: 0 },
  replicated: { count: 0, bytes: 0 },
  "remote-only": { count: 0, bytes: 0 },
  missing: { count: 0, bytes: 0 },
  freeable: { count: 0, bytes: 0 },
  "local-unproven": { count: 0, bytes: 0 },
};

function rollup(
  computedAt: string | null,
  buckets: Partial<Record<StorageBucket, { count: number; bytes: number }>>
): StorageRollup {
  return { computedAt, buckets: { ...EMPTY_BUCKETS, ...buckets } };
}

describe("folding every scope's rollup into one set of facts", () => {
  it("sums the five custody states into the library total", () => {
    const facts = custodyFacts([
      {
        label: "Library",
        rollup: rollup("2026-08-01T00:00:00.000Z", {
          replicated: { count: 10, bytes: 1000 },
          "remote-only": { count: 4, bytes: 400 },
          "local-only": { count: 2, bytes: 200 },
          "pending-offsite": { count: 1, bytes: 100 },
          missing: { count: 1, bytes: 50 },
        }),
      },
    ]);
    expect(facts.library).toStrictEqual({ count: 18, bytes: 1750 });
  });

  it("keeps the local-tier buckets OUT of the library total", () => {
    // freeable/local-unproven describe the same originals from the disk's side.
    // Folding them in would count every photograph twice.
    const facts = custodyFacts([
      {
        label: "Library",
        rollup: rollup("2026-08-01T00:00:00.000Z", {
          replicated: { count: 10, bytes: 1000 },
          freeable: { count: 8, bytes: 800 },
          "local-unproven": { count: 2, bytes: 200 },
        }),
      },
    ]);
    expect(facts.library).toStrictEqual({ count: 10, bytes: 1000 });
    expect(facts.freeable).toStrictEqual({ count: 8, bytes: 800 });
    expect(facts.unproven).toStrictEqual({ count: 2, bytes: 200 });
  });

  it("adds scopes together and reports the OLDEST sweep as the as-of instant", () => {
    const facts = custodyFacts([
      {
        label: "Library",
        rollup: rollup("2026-08-04T09:00:00.000Z", {
          replicated: { count: 3, bytes: 300 },
        }),
      },
      {
        label: "Family",
        rollup: rollup("2026-08-01T09:00:00.000Z", {
          replicated: { count: 7, bytes: 700 },
        }),
      },
    ]);
    expect(facts.backedUp).toStrictEqual({ count: 10, bytes: 1000 });
    expect(facts.checkedAt).toBe("2026-08-01T09:00:00.000Z");
  });

  it("names a scope that could not be read, and does not count it as empty", () => {
    const facts = custodyFacts([
      {
        label: "Library",
        rollup: rollup("2026-08-04T09:00:00.000Z", {
          replicated: { count: 3, bytes: 300 },
        }),
      },
      { label: "Family", rollup: null },
    ]);
    expect(facts.unread).toStrictEqual(["Family"]);
    expect(facts.known).toBe(true);
    expect(facts.library).toStrictEqual({ count: 3, bytes: 300 });
  });

  it("an unswept scope contributes nothing and is named as uncounted", () => {
    const facts = custodyFacts([{ label: "Family", rollup: rollup(null, {}) }]);
    expect(facts.known).toBe(false);
    expect(facts.uncounted).toStrictEqual(["Family"]);
    expect(facts.checkedAt).toBeNull();
    expect(facts.library).toStrictEqual({ count: 0, bytes: 0 });
  });
});

describe("the health verdict, worst first", () => {
  const at = "2026-08-04T09:00:00.000Z";

  it("says unknown when nothing has been counted", () => {
    expect(custodyHealth(custodyFacts([{ label: "L", rollup: null }]))).toBe(
      "unknown"
    );
  });

  it("ranks a missing byte above everything else", () => {
    const facts = custodyFacts([
      {
        label: "L",
        rollup: rollup(at, {
          missing: { count: 1, bytes: 1 },
          "local-only": { count: 90, bytes: 900 },
          "pending-offsite": { count: 90, bytes: 900 },
        }),
      },
    ]);
    expect(custodyHealth(facts)).toBe("missing");
  });

  it("ranks on-this-machine-only above merely waiting", () => {
    const facts = custodyFacts([
      {
        label: "L",
        rollup: rollup(at, {
          "local-only": { count: 1, bytes: 1 },
          "pending-offsite": { count: 500, bytes: 5000 },
        }),
      },
    ]);
    expect(custodyHealth(facts)).toBe("only-here");
  });

  it("says held when every original is off this machine", () => {
    const facts = custodyFacts([
      {
        label: "L",
        rollup: rollup(at, {
          replicated: { count: 12, bytes: 1200 },
          "remote-only": { count: 3, bytes: 300 },
        }),
      },
    ]);
    expect(custodyHealth(facts)).toBe("held");
  });
});

describe("free-up safety: only PROVEN bytes may be offered", () => {
  const at = "2026-08-04T09:00:00.000Z";

  it("offers nothing when no byte has a proven copy elsewhere", () => {
    // The disk is full of originals; not one of them is provably held
    // elsewhere, so there is no offer at any size.
    const facts = custodyFacts([
      {
        label: "L",
        rollup: rollup(at, {
          "local-only": { count: 4000, bytes: 96_000_000_000 },
          "local-unproven": { count: 4000, bytes: 96_000_000_000 },
        }),
      },
    ]);
    expect(facts.freeable).toStrictEqual({ count: 0, bytes: 0 });
    expect(freeUpIsOfferable(facts)).toBe(false);
  });

  it("offers only the proven bytes, never the unproven ones beside them", () => {
    const facts = custodyFacts([
      {
        label: "L",
        rollup: rollup(at, {
          replicated: { count: 1412, bytes: 96_400_000_000 },
          "local-only": { count: 41, bytes: 4_000_000_000 },
          freeable: { count: 1412, bytes: 96_400_000_000 },
          "local-unproven": { count: 41, bytes: 4_000_000_000 },
        }),
      },
    ]);
    expect(freeUpIsOfferable(facts)).toBe(true);
    expect(facts.freeable).toStrictEqual({
      count: 1412,
      bytes: 96_400_000_000,
    });
    // The 41 unproven originals are reported, but they are NOT in the offer.
    expect(facts.unproven.count).toBe(41);
  });

  it("makes no offer before anything has been counted", () => {
    const facts = custodyFacts([{ label: "L", rollup: rollup(null, {}) }]);
    expect(freeUpIsOfferable(facts)).toBe(false);
  });

  it("makes no offer for a zero-byte proven set — a control with no effect", () => {
    const facts = custodyFacts([
      { label: "L", rollup: rollup(at, { freeable: { count: 3, bytes: 0 } }) },
    ]);
    expect(freeUpIsOfferable(facts)).toBe(false);
  });
});
