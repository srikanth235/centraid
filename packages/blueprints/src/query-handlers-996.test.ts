/*! Browser-JS fixtures intentionally lack TypeScript declarations. (#408) */
// oxlint-disable-next-line typescript/ban-ts-comment -- (#408) these browser-JS fixture imports have no TypeScript declarations
// @ts-nocheck -- the imported browser fixtures intentionally lack declarations
//
// #996 wave 0c and 0d, read through the REAL query handlers.
//
// Two storage rulings enforced by a reader test (R22's last clause): a
// recurrence exception the handler must actually match, and a balance the
// handler must not fold across currencies. Both are written the way the vault
// stores the rows, and both were silently wrong before — a skip that matched
// nothing, and a sum that was true in no money.
//
// Its own file rather than another block in `query-handlers.test.ts`, which is
// at the repo's file-size limit.
import { describe, expect, it } from "vitest";

import { queryHandlerCtx } from "./query-handler-ctx.test-fixtures.js";

const importQuery = (relativePath: string) => import(relativePath);
const ctxOf = queryHandlerCtx;

// THE SKIP HAS TO REACH THE SCREEN (#996, ruling R21; drift ONT-25).
//
// A recurrence exception is stored keyed on `original_start_local` — the
// series-local wall clock — and this handler read `original_start`, which is
// not a column of anything. Every lookup missed, so a skipped occurrence came
// back onto the agenda, silently, under every reading of the clock. The
// scenario is written through the stored rows the vault actually writes and
// read through the real query handler.
describe("agenda upcoming — a skipped occurrence stays skipped (#996)", () => {
  const READINGS = [
    {
      name: "UTC",
      semantics: "zoned",
      tz: "Etc/UTC",
      dtstart: "2026-03-02T09:00:00.000Z",
      dtend: "2026-03-02T10:00:00.000Z",
      skipKey: "2026-03-03T09:00:00",
    },
    {
      name: "a non-UTC zone",
      semantics: "zoned",
      tz: "Asia/Kolkata",
      dtstart: "2026-03-02T03:30:00.000Z",
      dtend: "2026-03-02T04:30:00.000Z",
      skipKey: "2026-03-03T09:00:00",
    },
    {
      name: "a DST boundary",
      semantics: "zoned",
      tz: "Europe/London",
      dtstart: "2026-03-28T09:00:00.000Z",
      dtend: "2026-03-28T10:00:00.000Z",
      skipKey: "2026-03-29T09:00:00",
    },
    {
      name: "floating",
      semantics: "floating",
      tz: undefined,
      dtstart: "2026-03-02T09:00",
      dtend: "2026-03-02T10:00",
      // The canonical wall format the writer stores, seconds included — the
      // key is a value, not a rendering.
      skipKey: "2026-03-03T09:00:00",
    },
    {
      name: "all-day",
      semantics: "all-day",
      tz: undefined,
      dtstart: "2026-03-02",
      dtend: "2026-03-03",
      skipKey: "2026-03-03",
    },
  ] as const;

  it.each(READINGS)(
    "drops the skipped occurrence — $name",
    async (reading: (typeof READINGS)[number]) => {
      const { default: upcoming } = await importQuery(
        "../apps/agenda/queries/upcoming.ts"
      );
      const event = {
        event_id: "series-1",
        summary: "Standup",
        dtstart: reading.dtstart,
        dtend: reading.dtend,
        rrule: "FREQ=DAILY;COUNT=4",
        status: "confirmed",
        recurrence_semantics: reading.semantics,
        ...(reading.tz === undefined
          ? {}
          : { start_tz: reading.tz, end_tz: reading.tz }),
        sequence: 0,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "u1",
      };
      // Exactly the row `schedule.edit_event_occurrence` writes.
      const exception = {
        exception_id: "x1",
        target_type: "core.event",
        target_id: "series-1",
        original_start_local: reading.skipKey,
        recurrence_semantics: reading.semantics,
        scope: "occurrence",
        action: "skip",
        override_json: null,
      };
      const range = {
        from: "2026-03-01T00:00:00.000Z",
        to: "2026-04-10T00:00:00.000Z",
      };
      const ctx = ctxOf({
        "core.event": [event],
        "schedule.recurrence_exception": [exception],
      });
      const result = await upcoming({ query: range, input: range, ctx });
      const keys = result.events.map(
        (row: { original_start_local: string }) => row.original_start_local
      );
      expect(keys, reading.name).toHaveLength(3);
      expect(keys, reading.name).not.toContain(reading.skipKey);
    }
  );
});

// USD 100 + EUR 100 IS NOT USD 200 (#996, ruling R22; drift ONT-23).
//
// The scenario is written the way the vault stores it — two groups, two
// currencies, one friend in both — and read through the real dashboard
// handler. Before this the two folded into one `owed_total_minor` of 20_000
// labelled with the vault's base currency: a figure that is not true in either
// money, on the app's most-read screen.
describe("Tally balances keep their currency (#996)", () => {
  const ME = "owner";
  const ANA = "ana";

  function tallyCtx() {
    return ctxOf({
      "core.vault": [{ self_party_id: ME, base_currency: "USD" }],
      "core.party": [
        { party_id: ME, display_name: "You" },
        { party_id: ANA, display_name: "Ana" },
      ],
      "tally.friend": [{ party_id: ANA }],
      "social.circle": [
        { circle_id: "c-usd", name: "Road trip" },
        { circle_id: "c-eur", name: "Berlin flat" },
      ],
      "tally.group": [
        {
          group_id: "g-usd",
          circle_id: "c-usd",
          icon: "🚗",
          color: "",
          currency: "USD",
        },
        {
          group_id: "g-eur",
          circle_id: "c-eur",
          icon: "🏠",
          color: "",
          currency: "EUR",
        },
      ],
      "social.circle_member": [
        { circle_id: "c-usd", party_id: ME },
        { circle_id: "c-usd", party_id: ANA },
        { circle_id: "c-eur", party_id: ME },
        { circle_id: "c-eur", party_id: ANA },
      ],
      "tally.expense": [
        {
          expense_id: "e-usd",
          group_id: "g-usd",
          paid_by: ME,
          amount_minor: 20_000,
          description: "Petrol",
          category: "travel",
          spent_on: "2026-03-01",
          settlement_currency: "USD",
        },
        {
          expense_id: "e-eur",
          group_id: "g-eur",
          paid_by: ME,
          amount_minor: 20_000,
          description: "Strom",
          category: "utilities",
          spent_on: "2026-03-02",
          settlement_currency: "EUR",
        },
      ],
      "tally.expense_split": [
        { expense_id: "e-usd", party_id: ME, share_minor: 10_000 },
        { expense_id: "e-usd", party_id: ANA, share_minor: 10_000 },
        { expense_id: "e-eur", party_id: ME, share_minor: 10_000 },
        { expense_id: "e-eur", party_id: ANA, share_minor: 10_000 },
      ],
      "tally.expense_payer": [
        { expense_id: "e-usd", party_id: ME, paid_minor: 20_000 },
        { expense_id: "e-eur", party_id: ME, paid_minor: 20_000 },
      ],
    });
  }

  it("returns two balances for a friend owed in two currencies, never one sum", async () => {
    const { default: dashboard } = await importQuery(
      "../apps/tally/queries/dashboard.ts"
    );
    const result = await dashboard({ input: {}, query: {}, ctx: tallyCtx() });
    expect(result.vaultDenied).toBeUndefined();
    const ana = result.friends.find(
      (friend: { party_id: string }) => friend.party_id === ANA
    );
    expect(ana.balances).toStrictEqual([
      { amount_minor: 10_000, currency: "EUR" },
      { amount_minor: 10_000, currency: "USD" },
    ]);
    // And nothing anywhere in the answer is 20_000.
    expect(
      ana.balances.some(
        (amount: { amount_minor: number }) => amount.amount_minor === 20_000
      )
    ).toBe(false);
  });

  it("says the hero figure is unavailable rather than adding EUR to USD", async () => {
    const { default: dashboard } = await importQuery(
      "../apps/tally/queries/dashboard.ts"
    );
    const result = await dashboard({ input: {}, query: {}, ctx: tallyCtx() });
    expect(result.owed).toStrictEqual({
      state: "unavailable",
      reason: "no-rate-source",
      currencies: ["EUR", "USD"],
      components: [
        { amount_minor: 10_000, currency: "EUR" },
        { amount_minor: 10_000, currency: "USD" },
      ],
    });
    // The other side is empty, so it needs no rate and is a real figure.
    expect(result.owe).toStrictEqual({
      state: "valued",
      total: { amount_minor: 0, currency: "USD" },
      rates: [],
      components: [],
    });
  });

  it("gives each group its own money", async () => {
    const { default: dashboard } = await importQuery(
      "../apps/tally/queries/dashboard.ts"
    );
    const result = await dashboard({ input: {}, query: {}, ctx: tallyCtx() });
    const byId = new Map(
      result.groups.map((group: { group_id: string }) => [
        group.group_id,
        group,
      ])
    );
    expect(byId.get("g-usd").owner_net).toStrictEqual({
      amount_minor: 10_000,
      currency: "USD",
    });
    expect(byId.get("g-eur").owner_net).toStrictEqual({
      amount_minor: 10_000,
      currency: "EUR",
    });
  });
});
