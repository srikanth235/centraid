// Activity's folds and the two guards that ride with them.
//
// The day bucket and the window both have a silent failure mode: a row filed
// under the wrong heading reads perfectly, and a truncated feed that draws no
// end row reads as the whole ledger. The removal guard has a third — a member
// who appears on a ledger must never be removable, and "appears" has to mean
// paid it OR holds a share of it, not just the first of those.
import { describe, expect, it } from "vitest";

import {
  ACTIVITY_WINDOW,
  appearsOnLedger,
  bucketOf,
  dayBuckets,
  windowOf,
} from "./activity-model.ts";
import type { ActivityRow, LedgerEntry, Split } from "./types.ts";

const NOW = "2026-07-18T09:00:00.000Z";

function row(date: string | undefined): ActivityRow {
  return { kind: "expense", date, amount_minor: 100 };
}

describe("which day a row belongs to", () => {
  it.each([
    ["2026-07-18", "today"],
    ["2026-07-17", "yesterday"],
    ["2026-07-16", "earlier"],
    ["2026-01-02", "earlier"],
  ])("files %s under %s", (date, expected) => {
    expect(bucketOf(date, NOW)).toBe(expected);
  });

  it("crosses a month boundary without losing yesterday", () => {
    expect(bucketOf("2026-06-30", "2026-07-01T09:00:00.000Z")).toBe(
      "yesterday"
    );
  });

  it("files an undated row under Earlier rather than claiming it is today", () => {
    expect(bucketOf(undefined, NOW)).toBe("earlier");
  });

  it("draws no heading for a day with nothing under it", () => {
    const buckets = dayBuckets([row("2026-07-18"), row("2026-07-02")], NOW);
    expect(buckets.map((bucket) => bucket.label)).toStrictEqual([
      "Today",
      "Earlier",
    ]);
  });

  it("keeps the feed's own order inside a heading", () => {
    const buckets = dayBuckets(
      [row("2026-07-18"), row("2026-07-18"), row("2026-07-17")],
      NOW
    );
    expect(buckets[0]?.rows).toHaveLength(2);
    expect(buckets[1]?.label).toBe("Yesterday");
  });
});

describe("the window's honest end", () => {
  const feed = Array.from({ length: 194 }, () => row("2026-07-18"));

  it("states both counts and admits there is more", () => {
    const state = windowOf(feed, ACTIVITY_WINDOW);
    expect(state.shown).toBe(60);
    expect(state.total).toBe(194);
    expect(state.more).toBe(true);
    expect(state.rows).toHaveLength(60);
  });

  it("still states the count when the window holds everything", () => {
    const state = windowOf(feed.slice(0, 12), ACTIVITY_WINDOW);
    expect(state).toMatchObject({ shown: 12, total: 12, more: false });
  });

  it("cannot show more rows than it was given", () => {
    expect(windowOf([], 60)).toMatchObject({ shown: 0, total: 0, more: false });
  });
});

describe("the removal guard", () => {
  const split = (partyId: string): Split => ({
    party_id: partyId,
    name: partyId,
    color: "",
    initials: "",
    share_minor: 100,
  });
  const entry: LedgerEntry = {
    expense_id: "x1",
    group_id: "g1",
    amount_minor: 300,
    original_amount_minor: 300,
    original_currency: "GBP",
    settlement_currency: "GBP",
    rate_scaled: 1_000_000,
    rate_scale: 6,
    rate_source: "identity",
    recurring_template_id: null,
    paid_by: "ana",
    paid_by_name: "Ana",
    your_role: "borrowed",
    your_amount_minor: 100,
    splits: [split("me"), split("ana")],
  };

  it("catches the payer", () => {
    expect(appearsOnLedger([entry], "ana")).toBe(true);
  });

  it("catches someone who only holds a share", () => {
    // The bug this closes: guarding on `paid_by` alone lets a member who
    // never fronted anything be removed out from under their own shares.
    expect(appearsOnLedger([entry], "me")).toBe(true);
  });

  it("lets a member who never touched the ledger go", () => {
    expect(appearsOnLedger([entry], "tom")).toBe(false);
    expect(appearsOnLedger([], "ana")).toBe(false);
  });
});
