// Issue #731 goal 1: which intervening operations make a composed intent
// stale. Real on-disk seats (see `commons-intent.test-fixtures.ts`), so the
// conflicting ops are genuine `share_commons_op` rows produced by the
// ordinary command gateway rather than hand-seeded fixtures.

import { rmSync } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import {
  credential,
  opened,
  roots,
  setup,
} from "./commons-intent.test-fixtures.js";
import { signCommonsIntent } from "./commons-signature.js";
import {
  executeCommonsCommand,
  queueCommonsIntent,
  readCommonsIntentBasedOnSequence,
  STALE_CONTEXT_REASON_PREFIX,
} from "./commons.js";

describe("issue #731: stale-context conflict scoping", () => {
  afterEach(() => {
    while (opened.length > 0) {
      opened.pop()?.close();
    }
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  test("refuses a command that names a party removed by an intervening op", () => {
    const {
      priya,
      bob,
      cara,
      gateway,
      groupId,
      grant,
      seats,
      now,
      executeAsPriya,
    } = setup();

    // Priya adds an expense so the grant has a non-zero sequence to compare
    // against, and so its own compile step syncs `share_circle_grant` into
    // Bob's local vault the way a real pull would.
    expect(
      executeAsPriya("tally.add_expense", {
        group_id: groupId,
        description: "Train",
        amount_minor: 900,
        paid_by: priya.boot.ownerPartyId,
        category: "travel",
        splits: [{ party_id: priya.boot.ownerPartyId, share_minor: 900 }],
      }).decision.accepted
    ).toBe(true);

    // Bob composes an expense paid by Cara while offline — `queueCommonsIntent`
    // records the grant sequence Bob's own vault had projected at this moment.
    const bobInput = {
      group_id: groupId,
      description: "Groceries",
      amount_minor: 600,
      paid_by: cara.boot.ownerPartyId,
      category: "food",
      splits: [
        { party_id: cara.boot.ownerPartyId, share_minor: 300 },
        { party_id: bob.boot.ownerPartyId, share_minor: 300 },
      ],
    };
    const intentId = queueCommonsIntent({
      seat: bob.db.vault,
      grantId: grant.grantId,
      actorPartyId: bob.boot.ownerPartyId,
      command: "tally.add_expense",
      commandInput: bobInput,
      stewardLabel: "Priya's device",
      now,
    });
    const basedOnSequence = readCommonsIntentBasedOnSequence(
      bob.db.vault,
      intentId
    );
    expect(basedOnSequence).toBe(1);

    // Before Bob's command reaches the steward, Priya removes Cara from the
    // group — an intervening executed op that names exactly the party Bob's
    // composed command depends on.
    expect(
      executeAsPriya("tally.remove_group_member", {
        group_id: groupId,
        party_id: cara.boot.ownerPartyId,
      }).decision.accepted
    ).toBe(true);

    const result = executeCommonsCommand({
      steward: priya.db,
      gateway,
      credential: credential(priya),
      stewardVaultId: priya.vaultId,
      grantId: grant.grantId,
      actorPartyId: bob.boot.ownerPartyId,
      command: "tally.add_expense",
      commandInput: bobInput,
      seats,
      memberSignature: signCommonsIntent(bob.db.identitySeed, {
        grantId: grant.grantId,
        actorPartyId: bob.boot.ownerPartyId,
        command: "tally.add_expense",
        commandInput: bobInput,
        memberVaultId: bob.vaultId,
        nonce: intentId,
      }),
      basedOnSequence,
      intentId,
      invocationId: intentId,
      now,
    });
    expect(result.decision.accepted).toBe(false);
    expect(
      result.decision.reason?.startsWith(STALE_CONTEXT_REASON_PREFIX)
    ).toBe(true);
    // The refusal is a normal, recorded, attributable decision — not a thrown
    // error — and it is a genuinely NEW op (member removal was its own op).
    expect(
      priya.db.vault
        .prepare(
          "SELECT outcome, reason, actor_party_id FROM share_commons_op WHERE sequence = ?"
        )
        .get(result.decision.sequence)
    ).toMatchObject({
      outcome: "refused",
      actor_party_id: bob.boot.ownerPartyId,
    });
  });

  test("does not refuse for an unrelated intervening command in the same group", () => {
    const { priya, bob, gateway, groupId, grant, seats, now, executeAsPriya } =
      setup();

    expect(
      executeAsPriya("tally.add_expense", {
        group_id: groupId,
        description: "Train",
        amount_minor: 900,
        paid_by: priya.boot.ownerPartyId,
        category: "travel",
        splits: [{ party_id: priya.boot.ownerPartyId, share_minor: 900 }],
      }).decision.accepted
    ).toBe(true);

    // Bob composes a new expense that names only himself and Priya — never
    // Cara, and never an existing expense_id (it is a fresh add).
    const bobInput = {
      group_id: groupId,
      description: "Lunch",
      amount_minor: 400,
      paid_by: bob.boot.ownerPartyId,
      category: "food",
      splits: [
        { party_id: priya.boot.ownerPartyId, share_minor: 200 },
        { party_id: bob.boot.ownerPartyId, share_minor: 200 },
      ],
    };
    const intentId = queueCommonsIntent({
      seat: bob.db.vault,
      grantId: grant.grantId,
      actorPartyId: bob.boot.ownerPartyId,
      command: "tally.add_expense",
      commandInput: bobInput,
      stewardLabel: "Priya's device",
      now,
    });
    const basedOnSequence = readCommonsIntentBasedOnSequence(
      bob.db.vault,
      intentId
    );
    expect(basedOnSequence).toBe(1);

    // An unrelated add — a different, brand-new expense that happens to also
    // involve Priya — must never count as a conflict for Bob's command: an
    // active group moves constantly, and two independent adds sharing a
    // container (or even a friend) are not the kind of collision goal 1
    // exists to catch.
    expect(
      executeAsPriya("tally.add_expense", {
        group_id: groupId,
        description: "Dinner",
        amount_minor: 1200,
        paid_by: priya.boot.ownerPartyId,
        category: "food",
        splits: [{ party_id: priya.boot.ownerPartyId, share_minor: 1200 }],
      }).decision.accepted
    ).toBe(true);

    const result = executeCommonsCommand({
      steward: priya.db,
      gateway,
      credential: credential(priya),
      stewardVaultId: priya.vaultId,
      grantId: grant.grantId,
      actorPartyId: bob.boot.ownerPartyId,
      command: "tally.add_expense",
      commandInput: bobInput,
      seats,
      memberSignature: signCommonsIntent(bob.db.identitySeed, {
        grantId: grant.grantId,
        actorPartyId: bob.boot.ownerPartyId,
        command: "tally.add_expense",
        commandInput: bobInput,
        memberVaultId: bob.vaultId,
        nonce: intentId,
      }),
      basedOnSequence,
      intentId,
      invocationId: intentId,
      now,
    });
    expect(result.decision).toMatchObject({ accepted: true });
    expect(
      priya.db.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM tally_expense WHERE description = 'Lunch'"
        )
        .get()
    ).toMatchObject({ n: 1 });
  });

  test("refuses a command whose own expense was edited by an intervening op", () => {
    const { priya, bob, gateway, groupId, grant, seats, now, executeAsPriya } =
      setup();

    const added = executeAsPriya("tally.add_expense", {
      group_id: groupId,
      description: "Train",
      amount_minor: 900,
      paid_by: priya.boot.ownerPartyId,
      category: "travel",
      splits: [{ party_id: priya.boot.ownerPartyId, share_minor: 900 }],
    });
    expect(added.decision.accepted).toBe(true);
    const expenseId = (
      priya.db.vault
        .prepare(
          "SELECT expense_id FROM tally_expense WHERE description = 'Train'"
        )
        .get() as { expense_id: string }
    ).expense_id;

    // Bob composes a second edit to the same expense.
    const bobEdit = {
      expense_id: expenseId,
      description: "Train tickets",
      amount_minor: 900,
      paid_by: priya.boot.ownerPartyId,
      category: "travel",
      splits: [{ party_id: priya.boot.ownerPartyId, share_minor: 900 }],
    };
    const intentId = queueCommonsIntent({
      seat: bob.db.vault,
      grantId: grant.grantId,
      actorPartyId: bob.boot.ownerPartyId,
      command: "tally.edit_expense",
      commandInput: bobEdit,
      stewardLabel: "Priya's device",
      now,
    });
    const basedOnSequence = readCommonsIntentBasedOnSequence(
      bob.db.vault,
      intentId
    );

    // Priya edits the SAME expense first.
    expect(
      executeAsPriya("tally.edit_expense", {
        expense_id: expenseId,
        description: "Train (early booking)",
        amount_minor: 850,
        paid_by: priya.boot.ownerPartyId,
        category: "travel",
        splits: [{ party_id: priya.boot.ownerPartyId, share_minor: 850 }],
      }).decision.accepted
    ).toBe(true);

    const result = executeCommonsCommand({
      steward: priya.db,
      gateway,
      credential: credential(priya),
      stewardVaultId: priya.vaultId,
      grantId: grant.grantId,
      actorPartyId: bob.boot.ownerPartyId,
      command: "tally.edit_expense",
      commandInput: bobEdit,
      seats,
      memberSignature: signCommonsIntent(bob.db.identitySeed, {
        grantId: grant.grantId,
        actorPartyId: bob.boot.ownerPartyId,
        command: "tally.edit_expense",
        commandInput: bobEdit,
        memberVaultId: bob.vaultId,
        nonce: intentId,
      }),
      basedOnSequence,
      intentId,
      invocationId: intentId,
      now,
    });
    expect(result.decision.accepted).toBe(false);
    expect(
      result.decision.reason?.startsWith(STALE_CONTEXT_REASON_PREFIX)
    ).toBe(true);
  });
});
