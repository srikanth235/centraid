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
