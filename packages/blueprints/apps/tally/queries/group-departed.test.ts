import { describe, expect, it, vi } from "vitest";

import groupHandler from "./group.ts";

const ROWS: Record<string, Array<Record<string, unknown>>> = {
  "core.vault": [{ owner_party_id: "party-owner", base_currency: "USD" }],
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

    const result = await groupHandler({
      input: { group_id: "group-trip" },
      ctx: { vault: { read } },
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
        net_minor: 450,
        departed: true,
      })
    );
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "core.party",
        where: [
          expect.objectContaining({
            value: expect.arrayContaining(["party-departed"]),
          }),
        ],
      })
    );
  });
});
