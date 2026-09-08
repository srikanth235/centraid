import { describe, expect, it, vi } from "vitest";

import { pagedFixture } from "../../_shared/paged-ctx.test-fixtures.ts";
import groupHandler from "./group.ts";

const ROWS: Record<string, Array<Record<string, unknown>>> = {
  "core.vault": [{ self_party_id: "party-owner", base_currency: "USD" }],
  "tally.friend": [{ party_id: "party-current" }],
  "tally.group": [
    { group_id: "group-trip", circle_id: "circle-trip", icon: "✈️" },
  ],
  "social.circle": [{ circle_id: "circle-trip", name: "Trip" }],
  "social.circle_member": [
    { circle_id: "circle-trip", party_id: "party-owner" },
    { circle_id: "circle-trip", party_id: "party-current" },
  ],
  "tally.expense": [
    {
      expense_id: "expense-before-departure",
      group_id: "group-trip",
      paid_by: "party-departed",
      amount_minor: 900,
      description: "Train",
      category: "travel",
      spent_on: "2026-08-01",
    },
  ],
  "tally.expense_payer": [
    {
      expense_id: "expense-before-departure",
      party_id: "party-departed",
      paid_minor: 900,
    },
  ],
  "tally.expense_split": [
    {
      expense_id: "expense-before-departure",
      party_id: "party-owner",
      share_minor: 450,
    },
    {
      expense_id: "expense-before-departure",
      party_id: "party-departed",
      share_minor: 450,
    },
  ],
  "core.party": [
    { party_id: "party-owner", display_name: "Owner" },
    { party_id: "party-current", display_name: "Current member" },
    { party_id: "party-departed", display_name: "Priya" },
  ],
};

describe("Tally group departed participants", () => {
  it("keeps a removed ledger participant named and marks them departed", async () => {
    const read = vi.fn<
      (request: { entity: string }) => Promise<{
        rows: Array<Record<string, unknown>>;
      }>
    >(async ({ entity }) => ({ rows: ROWS[entity] ?? [] }));
    const { page, statements } = pagedFixture(ROWS);

    const result = await groupHandler({
      input: { group_id: "group-trip" },
      ctx: { vault: { page, read } },
    } as unknown as HandlerArgs);

    expect(result.members.map((member) => member.party_id)).toStrictEqual([
      "party-owner",
      "party-current",
      "party-departed",
    ]);
    expect(result.members[0]).not.toHaveProperty("departed");
    expect(result.members[1]).not.toHaveProperty("departed");
    expect(result.members[2]).toStrictEqual(
      expect.objectContaining({
        party_id: "party-departed",
        name: "Priya",
        net: { amount_minor: 450, currency: "USD" },
        departed: true,
      })
    );
    // The party read is a paged statement since #996 wave 4: the departed
    // participant's id is in its binds, which is the claim that matters —
    // a member who left is still nameable wherever the ledger refers to them.
    expect(
      statements.some(
        (statement) =>
          statement.from === "core_party" &&
          (statement.bind ?? []).includes("party-departed")
      )
    ).toBe(true);
  });
});
