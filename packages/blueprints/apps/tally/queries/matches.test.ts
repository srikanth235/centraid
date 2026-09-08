/*
 * CROSS-SOURCE MATCH PROPOSALS (#996, R20(c) / OQ-12).
 *
 * What these cases pin is the whole of the ruling: a pair is PROPOSED on
 * evidence a member can check, an answered pair never comes back, and nothing
 * — no amount, no row, no account — is changed by the read that proposes it.
 */
import { describe, expect, it } from "vitest";

import { pagedFixture } from "../../_shared/paged-ctx.test-fixtures.ts";
import matchesHandler from "./matches.ts";
import type { MatchProposal } from "./matches.ts";

function txn(
  id: string,
  account: string,
  postedAt: string,
  amount: number,
  description: string
): Record<string, unknown> {
  return {
    txn_id: id,
    account_id: account,
    posted_at: postedAt,
    amount_minor: amount,
    currency: "GBP",
    direction: "debit",
    status: "posted",
    description,
  };
}

const ROWS: Record<string, Array<Record<string, unknown>>> = {
  "core.transaction": [
    txn(
      "txn-a",
      "acct-current",
      "2026-03-11T00:00:00.000Z",
      4250,
      "SAINSBURYS"
    ),
    // The same money, two days later, on the OTHER source's account.
    txn(
      "txn-b",
      "acct-shared",
      "2026-03-13T00:00:00.000Z",
      4250,
      "Sainsbury's"
    ),
    // Same amount, other account, but three weeks away.
    txn(
      "txn-d",
      "acct-shared",
      "2026-04-02T00:00:00.000Z",
      4250,
      "Sainsbury's"
    ),
    // A different amount is a different movement, never a near miss.
    txn("txn-e", "acct-shared", "2026-03-11T00:00:00.000Z", 4251, "SAINSBURY"),
    // A member who buys the same round twice on ONE account is not a
    // duplicate: same money, one day apart, same account.
    txn("txn-f", "acct-current", "2026-02-01T00:00:00.000Z", 9900, "Boiler"),
    txn("txn-g", "acct-current", "2026-02-02T00:00:00.000Z", 9900, "Boiler"),
  ],
  "core.account": [
    { account_id: "acct-current", name: "Current", external_ref: "file:a.csv" },
    { account_id: "acct-shared", name: "Joint", external_ref: "file:b.csv" },
  ],
  "core.link": [],
};

async function run(
  rows: Record<string, Array<Record<string, unknown>>> = ROWS
): Promise<{
  answer: { proposals: MatchProposal[]; accounts: Record<string, string> };
  statements: { name: string; from: string }[];
}> {
  const fixture = pagedFixture(rows);
  const answer = (await matchesHandler({
    input: {},
    ctx: { vault: { page: fixture.page } },
  } as never)) as {
    proposals: MatchProposal[];
    accounts: Record<string, string>;
  };
  return { answer, statements: fixture.statements };
}

describe("cross-source match proposals", () => {
  it("proposes the pair that is the same money on two accounts, days apart", async () => {
    const { answer } = await run();
    expect(
      answer.proposals.map((row) => [row.left_txn_id, row.right_txn_id])
      // Newest first, because the scan is newest first: the pair is unordered
      // and the row states both dates, so neither side is "the" transaction.
    ).toStrictEqual([["txn-b", "txn-a"]]);
    const [proposal] = answer.proposals;
    expect(proposal).toMatchObject({
      amount_minor: 4250,
      currency: "GBP",
      days_apart: 2,
      left_account: "acct-shared",
      right_account: "acct-current",
    });
    // The member cannot judge a pair they cannot attribute.
    expect(answer.accounts).toStrictEqual({
      "acct-current": "Current",
      "acct-shared": "Joint",
    });
  });

  it("never proposes two rows on the SAME account, whatever they cost", async () => {
    const { answer } = await run();
    expect(
      answer.proposals.filter((row) => row.left_account === row.right_account)
    ).toStrictEqual([]);
    const seen = new Set(
      answer.proposals.flatMap((row) => [row.left_txn_id, row.right_txn_id])
    );
    expect([seen.has("txn-f"), seen.has("txn-g")]).toStrictEqual([
      false,
      false,
    ]);
  });

  it("does not reach past the window, and does not pair unequal amounts", async () => {
    const { answer } = await run();
    const seen = new Set(
      answer.proposals.flatMap((row) => [row.left_txn_id, row.right_txn_id])
    );
    expect(seen.has("txn-d")).toBe(false);
    expect(seen.has("txn-e")).toBe(false);
  });

  it("drops a pair the owner has already answered, in either direction", async () => {
    const decision = (from: string, to: string): Record<string, unknown> => ({
      link_id: "link-1",
      from_type: "core.transaction",
      from_id: from,
      to_type: "core.transaction",
      to_id: to,
      valid_to: null,
    });
    const answered = await Promise.all(
      [decision("txn-a", "txn-b"), decision("txn-b", "txn-a")].map((link) =>
        run({ ...ROWS, "core.link": [link] })
      )
    );
    expect(answered.map((each) => each.answer.proposals)).toStrictEqual([
      [],
      [],
    ]);
  });

  it("reads and never writes: three statements, all of them SELECTs", async () => {
    const { statements } = await run();
    expect(statements.map((s) => s.from)).toStrictEqual([
      "core_transaction",
      "core_link",
      "core_account",
    ]);
    expect(statements.map((s) => s.name)).toStrictEqual([
      "tally.matches.transactions",
      "tally.matches.decisions",
      "tally.matches.accounts",
    ]);
  });

  it("answers an empty ledger with an empty list, not with a denial", async () => {
    const { answer } = await run({
      "core.transaction": [],
      "core.account": [],
      "core.link": [],
    });
    expect(answer).toStrictEqual({ proposals: [], accounts: {} });
  });
});
