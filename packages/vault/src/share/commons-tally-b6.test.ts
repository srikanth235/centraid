import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { bootstrapVault } from "../bootstrap.js";
import { registerTallyCommands } from "../commands/tally.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { backupVault } from "../gateway/custody.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { nowIso } from "../ids.js";
import {
  applyCommonsBootstrap,
  exportCommonsBootstrap,
} from "./commons-bootstrap.js";
import {
  commonsSeats,
  removeCommonsMember,
  recompileCommonsGrants,
  scrubCommonsSeat,
  upsertCommonsMember,
} from "./commons-lifecycle.js";
import { signCommonsIntent } from "./commons-signature.js";
import {
  compileCommons,
  createCommonsGrant,
  executeCommonsCommand,
  transferCommonsSteward,
} from "./commons.js";

interface Seat {
  vaultId: string;
  db: VaultDb;
  boot: ReturnType<typeof bootstrapVault>;
}

const opened: VaultDb[] = [];
const roots: string[] = [];

function openSeat(root: string, vaultId: string, ownerName: string): Seat {
  const dir = path.join(root, vaultId);
  mkdirSync(dir, { recursive: true });
  const db = openVaultDb({ dir });
  opened.push(db);
  return {
    vaultId,
    db,
    boot: bootstrapVault(db, { vaultId, ownerName }),
  };
}

function addParty(steward: VaultDb, seat: Seat, now: string): void {
  steward.vault
    .prepare(
      `INSERT INTO core_party
       (party_id, kind, display_name, sort_name, birth_date,
        avatar_content_id, created_at, updated_at, ontology_version)
       VALUES (?, 'person', ?, ?, NULL, NULL, ?, ?, '1.4')`
    )
    .run(
      seat.boot.ownerPartyId,
      seat.boot.displayName,
      seat.boot.displayName,
      now,
      now
    );
}

function credential(seat: Seat): Credential {
  return {
    kind: "device",
    deviceId: seat.boot.deviceId,
    deviceKey: seat.boot.deviceKey,
  };
}

function balances(db: VaultDb, groupId: string): Record<string, number> {
  const net = new Map<string, number>();
  const expenses = db.vault
    .prepare(
      "SELECT expense_id, paid_by, amount_minor FROM tally_expense WHERE group_id = ?"
    )
    .all(groupId) as unknown as {
    expense_id: string;
    paid_by: string;
    amount_minor: number;
  }[];
  const splits = db.vault.prepare(
    "SELECT party_id, share_minor FROM tally_expense_split WHERE expense_id = ?"
  );
  for (const expense of expenses) {
    net.set(
      expense.paid_by,
      (net.get(expense.paid_by) ?? 0) + expense.amount_minor
    );
    for (const split of splits.all(expense.expense_id) as unknown as {
      party_id: string;
      share_minor: number;
    }[]) {
      net.set(
        split.party_id,
        (net.get(split.party_id) ?? 0) - split.share_minor
      );
    }
  }
  return Object.fromEntries(
    [...net].toSorted(([a], [b]) => a.localeCompare(b))
  );
}

describe("B6 Tally Commons flagship", () => {
  afterEach(() => {
    while (opened.length > 0) {
      try {
        opened.pop()?.close();
      } catch {
        // The lost-device leg deliberately closes one handle early.
      }
    }
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  test("three local seats survive offline intent, restore, downgrade, removal, and steward transfer", () => {
    const root = tempDirSync("commons-b6-local-");
    roots.push(root);
    const priya = openSeat(root, "vault-priya", "Priya");
    let bob = openSeat(root, "vault-bob", "Bob");
    const cara = openSeat(root, "vault-cara", "Cara");
    const now = nowIso();
    addParty(priya.db, bob, now);
    addParty(priya.db, cara, now);
    const priyaGateway = createGateway(priya.db);
    registerTallyCommands(priyaGateway);
    const created = priyaGateway.invoke(credential(priya), {
      command: "tally.create_group",
      input: {
        name: "Goa",
        icon: "🏖️",
        member_ids: [bob.boot.ownerPartyId, cara.boot.ownerPartyId],
      },
    });
    expect(created.status).toBe("executed");
    const groupId = (created as { output: { group_id: string } }).output
      .group_id;
    const grant = createCommonsGrant({
      origin: priya.db.vault,
      ownerPartyId: priya.boot.ownerPartyId,
      ownerVaultId: priya.vaultId,
      ownerVault: priya.db,
      containerType: "tally.group",
      containerId: groupId,
      members: [
        {
          partyId: bob.boot.ownerPartyId,
          capability: "read+write",
          vaultId: bob.vaultId,
          vault: bob.db,
        },
        {
          partyId: cara.boot.ownerPartyId,
          capability: "read+write",
          vaultId: cara.vaultId,
          vault: cara.db,
        },
      ],
      now,
    });
    const localVaultFor = (vaultId: string): VaultDb | undefined =>
      vaultId === priya.vaultId
        ? priya.db
        : vaultId === bob.vaultId
          ? bob.db
          : vaultId === cara.vaultId
            ? cara.db
            : undefined;
    const allSeats = () =>
      commonsSeats({
        steward: priya.db.vault,
        grantId: grant.grantId,
        stewardVaultId: priya.vaultId,
        vaultFor: localVaultFor,
      });
    compileCommons({
      steward: priya.db,
      stewardVaultId: priya.vaultId,
      grantId: grant.grantId,
      seats: allSeats(),
      now,
    });

    const inputFor = (actor: Seat, description: string) => ({
      group_id: groupId,
      description,
      amount_minor: 900,
      paid_by: actor.boot.ownerPartyId,
      category: "travel",
      splits: [priya, bob, cara].map((seat) => ({
        party_id: seat.boot.ownerPartyId,
        share_minor: 300,
      })),
    });
    const executeAtPriya = (
      actor: Seat,
      description: string,
      seats = allSeats(),
      intentId = `intent-${description}`
    ) => {
      const commandInput = inputFor(actor, description);
      return executeSignedAtPriya(
        actor,
        "tally.add_expense",
        commandInput,
        seats,
        intentId
      );
    };
    const executeSignedAtPriya = (
      actor: Seat,
      command: string,
      commandInput: Record<string, unknown>,
      seats = allSeats(),
      intentId = `intent-${command}`
    ) => {
      return executeCommonsCommand({
        steward: priya.db,
        gateway: priyaGateway,
        credential: credential(priya),
        stewardVaultId: priya.vaultId,
        grantId: grant.grantId,
        actorPartyId: actor.boot.ownerPartyId,
        command,
        commandInput,
        seats,
        ...(actor === priya
          ? {}
          : {
              memberSignature: signCommonsIntent(actor.db.identitySeed, {
                grantId: grant.grantId,
                actorPartyId: actor.boot.ownerPartyId,
                command,
                commandInput,
                memberVaultId: actor.vaultId,
                nonce: intentId,
              }),
            }),
        intentId,
        invocationId: intentId,
        now,
      });
    };

    expect(executeAtPriya(priya, "Train").decision.accepted).toBe(true);
    const bobGateway = createGateway(bob.db);
    registerTallyCommands(bobGateway);
    const bobInput = inputFor(bob, "Lunch");
    const offline = bobGateway.invoke(credential(bob), {
      command: "tally.add_expense",
      input: bobInput,
      intentId: "intent-Lunch",
      intentDeviceId: bob.boot.deviceId,
    });
    expect(offline).toMatchObject({
      status: "denied",
      reason: "waiting for Priya's device",
    });
    expect(
      bob.db.vault
        .prepare("SELECT status FROM share_commons_intent WHERE intent_id = ?")
        .get("intent-Lunch")
    ).toMatchObject({ status: "queued" });
    expect(
      executeAtPriya(bob, "Lunch", allSeats(), "intent-Lunch").decision
    ).toMatchObject({ accepted: true });
    const lunch = priya.db.vault
      .prepare(
        "SELECT expense_id FROM tally_expense WHERE description = 'Lunch'"
      )
      .get() as { expense_id: string };
    const editedInput = {
      expense_id: lunch.expense_id,
      description: "Brunch",
      amount_minor: 900,
      paid_by: bob.boot.ownerPartyId,
      category: "food",
      splits: [priya, bob, cara].map((seat) => ({
        party_id: seat.boot.ownerPartyId,
        share_minor: 300,
      })),
    };
    expect(
      executeSignedAtPriya(
        bob,
        "tally.edit_expense",
        editedInput,
        allSeats(),
        "intent-edit-Lunch"
      ).decision.accepted
    ).toBe(true);
    expect(
      executeSignedAtPriya(
        bob,
        "tally.delete_expense",
        { expense_id: lunch.expense_id },
        allSeats(),
        "intent-delete-Lunch"
      ).decision.accepted
    ).toBe(true);
    expect(
      bob.db.vault
        .prepare("SELECT deleted_at FROM tally_expense WHERE expense_id = ?")
        .get(lunch.expense_id)
    ).toMatchObject({ deleted_at: expect.any(String) });
    expect(
      executeSignedAtPriya(
        bob,
        "tally.restore_expense",
        { expense_id: lunch.expense_id },
        allSeats(),
        "intent-restore-Lunch"
      ).decision.accepted
    ).toBe(true);
    for (const seat of [priya, bob, cara])
      expect(balances(seat.db, groupId)).toStrictEqual(
        balances(priya.db, groupId)
      );

    // Bob's own backup is taken while current. Cara then writes while Bob's
    // device is gone, so the restored copy must catch up from steward truth.
    const backupDir = path.join(root, "bob-own-backup");
    mkdirSync(backupDir, { recursive: true });
    const bobSealKey = Buffer.from(bob.db.sealKey);
    const bobIdentitySeed = Buffer.from(bob.db.identitySeed);
    const backup = backupVault(bob.db, backupDir);
    bob.db.close();
    const offlineSeats = allSeats().filter(
      (seat) => seat.vaultId !== bob.vaultId
    );
    expect(executeAtPriya(cara, "Hotel", offlineSeats).decision.accepted).toBe(
      true
    );
    copyFileSync(backup.vaultPath, path.join(backupDir, "vault.db"));
    copyFileSync(backup.journalPath, path.join(backupDir, "journal.db"));
    const restoredDb = openVaultDb({
      dir: backupDir,
      sealKey: bobSealKey,
      identitySeed: bobIdentitySeed,
    });
    opened.push(restoredDb);
    bob = { ...bob, db: restoredDb };
    const catchup = exportCommonsBootstrap({
      steward: priya.db.vault,
      identitySeed: priya.db.identitySeed,
      stewardVaultId: priya.vaultId,
      grantId: grant.grantId,
      memberVaultId: bob.vaultId,
    });
    applyCommonsBootstrap({ seat: bob.db, wire: catchup, now });
    expect(
      bob.db.vault
        .prepare(
          "SELECT description FROM tally_expense WHERE group_id = ? ORDER BY description"
        )
        .all(groupId)
    ).toMatchObject([
      { description: "Brunch" },
      { description: "Hotel" },
      { description: "Train" },
    ]);
    expect(balances(bob.db, groupId)).toStrictEqual(
      balances(priya.db, groupId)
    );

    const downgradeSequence = upsertCommonsMember({
      steward: priya.db.vault,
      grantId: grant.grantId,
      actorPartyId: priya.boot.ownerPartyId,
      member: {
        partyId: cara.boot.ownerPartyId,
        capability: "read",
        vaultId: cara.vaultId,
        vault: cara.db,
      },
      now,
    });
    const refused = executeAtPriya(cara, "Taxi");
    expect(refused.decision).toMatchObject({
      accepted: false,
      reason: "this commons is read-only for this member",
      sequence: downgradeSequence + 1,
    });
    expect(
      priya.db.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM tally_expense WHERE description = 'Taxi'"
        )
        .get()
    ).toMatchObject({ n: 0 });

    removeCommonsMember({
      steward: priya.db.vault,
      grantId: grant.grantId,
      actorPartyId: priya.boot.ownerPartyId,
      memberPartyId: cara.boot.ownerPartyId,
      now,
    });
    expect(
      scrubCommonsSeat({ seat: cara.db, grantId: grant.grantId })
    ).toBeGreaterThan(0);
    expect(
      cara.db.vault
        .prepare("SELECT COUNT(*) AS n FROM tally_expense WHERE group_id = ?")
        .get(groupId)
    ).toMatchObject({ n: 0 });
    compileCommons({
      steward: priya.db,
      stewardVaultId: priya.vaultId,
      grantId: grant.grantId,
      seats: allSeats(),
      now,
    });
    expect(balances(bob.db, groupId)).toStrictEqual(
      balances(priya.db, groupId)
    );

    expect(
      transferCommonsSteward({
        steward: priya.db.vault,
        grantId: grant.grantId,
        actorPartyId: priya.boot.ownerPartyId,
        successorPartyId: bob.boot.ownerPartyId,
        now,
      })
    ).toBe(bob.boot.ownerPartyId);
    compileCommons({
      steward: priya.db,
      stewardVaultId: priya.vaultId,
      grantId: grant.grantId,
      seats: allSeats(),
      now,
    });
    expect(
      bob.db.vault
        .prepare(
          "SELECT steward_party_id FROM share_circle_grant WHERE grant_id = ?"
        )
        .get(grant.grantId)
    ).toMatchObject({ steward_party_id: bob.boot.ownerPartyId });
    const restoredBobGateway = createGateway(bob.db);
    registerTallyCommands(restoredBobGateway);
    const ferryInput = {
      ...inputFor(bob, "Ferry"),
      splits: [priya, bob].map((seat) => ({
        party_id: seat.boot.ownerPartyId,
        share_minor: 450,
      })),
    };
    const afterTransfer = restoredBobGateway.invoke(credential(bob), {
      command: "tally.add_expense",
      input: ferryInput,
    });
    expect(afterTransfer.status).toBe("executed");
    expect(
      bob.db.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM tally_expense WHERE description = 'Ferry'"
        )
        .get()
    ).toMatchObject({ n: 1 });
    const reconciled = recompileCommonsGrants({
      steward: bob.db,
      stewardVaultId: bob.vaultId,
      stewardPartyId: bob.boot.ownerPartyId,
      grantId: grant.grantId,
      vaultFor: localVaultFor,
      now,
    });
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.seats).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ vaultId: priya.vaultId, status: "current" }),
      ])
    );
    expect(
      priya.db.vault
        .prepare(
          "SELECT description FROM tally_expense WHERE group_id = ? ORDER BY description"
        )
        .all(groupId)
    ).toMatchObject([
      { description: "Brunch" },
      { description: "Ferry" },
      { description: "Hotel" },
      { description: "Train" },
    ]);
    expect(balances(bob.db, groupId)).toStrictEqual(
      balances(priya.db, groupId)
    );
  });
});
