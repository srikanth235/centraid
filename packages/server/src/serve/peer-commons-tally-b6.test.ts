import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";
import {
  answerCommonsInvitation,
  backupVault,
  commonsSeats,
  compileCommons,
  createCommonsGrant,
  createGateway,
  executeCommonsCommand,
  exportCommonsBootstrap,
  listCommonsInvitations,
  openVaultDb,
  readCommonsGrant,
  registerTallyCommands,
  removeCommonsMember,
  signCommonsIntent,
  transferCommonsSteward,
  upsertCommonsMember,
} from "@centraid/vault";

import { addKnownParty, localTallyNet } from "./commons-b6.test-fixtures.js";
import {
  invitePeerToCommons,
  pullPeerCommons,
  sendPeerCommonsCommand,
} from "./peer-commons-client.js";
import { sweepPeerCommons } from "./peer-commons-sweep.js";
import {
  dialFrom,
  link,
  makeCoHostedSides,
  makeSide,
  routeFrom,
} from "./peer-give.test-fixtures.js";
import type { Side } from "./peer-give.test-fixtures.js";

describe("B6 Tally Commons across a real peer", () => {
  test("three seats converge through offline restore, ordered controls, re-invite, and steward transfer", async () => {
    const [origin, local] = makeCoHostedSides(
      "tally-b6-local-host",
      "tally-b6-origin",
      "tally-b6-local"
    );
    const remote = makeSide("tally-b6-remote");
    await link(origin, remote);
    await link(local, remote);
    const now = new Date().toISOString();
    for (const member of [local, remote]) addKnownParty(origin, member, now);
    for (const side of [origin, local, remote])
      registerTallyCommands(side.gateway);

    const created = origin.gateway.invoke(origin.ownerCredential, {
      command: "tally.create_group",
      input: {
        name: "Peer household",
        icon: "🛰️",
        member_ids: [local.ownerPartyId, remote.ownerPartyId],
      },
    });
    expect(created.status).toBe("executed");
    const groupId = (created as { output: { group_id: string } }).output
      .group_id;
    const grant = createCommonsGrant({
      origin: origin.vault.vault,
      ownerPartyId: origin.ownerPartyId,
      ownerVaultId: origin.vaultId,
      ownerVault: origin.vault,
      containerType: "tally.group",
      containerId: groupId,
      members: [
        {
          partyId: local.ownerPartyId,
          capability: "read+write",
          vaultId: local.vaultId,
          vault: local.vault,
        },
        {
          partyId: remote.ownerPartyId,
          capability: "read+write",
          vaultId: remote.vaultId,
          vaultPublicKey: remote.publicKey,
        },
      ],
      now,
    });
    const originSeats = () =>
      commonsSeats({
        steward: origin.vault.vault,
        grantId: grant.grantId,
        stewardVaultId: origin.vaultId,
        vaultFor: (vaultId) =>
          vaultId === origin.vaultId
            ? origin.vault
            : vaultId === local.vaultId
              ? local.vault
              : undefined,
      });
    const compileOrigin = () =>
      compileCommons({
        steward: origin.vault,
        stewardVaultId: origin.vaultId,
        grantId: grant.grantId,
        seats: originSeats(),
        now,
      });
    compileOrigin();

    const initialWire = exportCommonsBootstrap({
      steward: origin.vault.vault,
      identitySeed: origin.vault.identitySeed,
      stewardVaultId: origin.vaultId,
      grantId: grant.grantId,
      memberVaultId: remote.vaultId,
    });
    origin.vault.vault
      .prepare(
        `UPDATE share_commons_member_state SET status = 'invited', accepted_at = NULL
          WHERE grant_id = ? AND party_id = ?`
      )
      .run(grant.grantId, remote.ownerPartyId);
    await expect(
      invitePeerToCommons({
        dial: dialFrom(origin, remote),
        route: routeFrom(origin, remote),
        wire: initialWire,
      })
    ).resolves.toBe(true);
    expect(
      remote.vault.vault
        .prepare("SELECT COUNT(*) AS n FROM tally_group WHERE group_id = ?")
        .get(groupId)
    ).toMatchObject({ n: 0 });
    const invitation = listCommonsInvitations({
      seat: remote.vault.vault,
      memberVaultId: remote.vaultId,
    })[0]!;
    expect(invitation.currentSizeBytes).toBeGreaterThan(0);
    await expect(
      pullPeerCommons({
        dial: dialFrom(remote, origin),
        route: routeFrom(remote, origin),
        stewardVaultId: origin.vaultId,
        memberVaultId: remote.vaultId,
        grantId: grant.grantId,
        seat: remote.vault,
        acceptInvitation: true,
        now,
      })
    ).resolves.toMatchObject({ state: "current" });
    answerCommonsInvitation({
      seat: remote.vault,
      invitationId: invitation.invitationId,
      memberVaultId: remote.vaultId,
      answer: "accept",
      now,
    });

    const expenseInput = (payer: Side, description: string) => ({
      group_id: groupId,
      description,
      amount_minor: 900,
      paid_by: payer.ownerPartyId,
      category: "travel",
      splits: [origin, local, remote].map((seat) => ({
        party_id: seat.ownerPartyId,
        share_minor: 300,
      })),
    });
    const signed = (
      actor: Side,
      command: string,
      input: Record<string, unknown>,
      intentId: string
    ) =>
      signCommonsIntent(actor.vault.identitySeed, {
        grantId: grant.grantId,
        actorPartyId: actor.ownerPartyId,
        command,
        commandInput: input,
        memberVaultId: actor.vaultId,
        nonce: intentId,
      });
    const sendRemote = async (
      command: string,
      input: Record<string, unknown>,
      intentId: string
    ) =>
      sendPeerCommonsCommand({
        dial: dialFrom(remote, origin),
        route: routeFrom(remote, origin),
        stewardVaultId: origin.vaultId,
        memberVaultId: remote.vaultId,
        grantId: grant.grantId,
        actorPartyId: remote.ownerPartyId,
        command,
        commandInput: input,
        memberSignature: signed(remote, command, input, intentId),
        basedOnSequence: readCommonsGrant(remote.vault.vault, grant.grantId)
          .lastSequence,
        intentId,
      });
    const syncRemote = async () => {
      compileOrigin();
      await pullFrom(remote, origin, grant.grantId, now);
    };

    expect(
      executeCommonsCommand({
        steward: origin.vault,
        gateway: origin.gateway,
        credential: origin.ownerCredential,
        stewardVaultId: origin.vaultId,
        grantId: grant.grantId,
        actorPartyId: local.ownerPartyId,
        command: "tally.add_expense",
        commandInput: expenseInput(local, "Local train"),
        memberSignature: signed(
          local,
          "tally.add_expense",
          expenseInput(local, "Local train"),
          "local-train"
        ),
        intentId: "local-train",
        invocationId: "local-train",
        seats: originSeats(),
        now,
      }).decision.accepted
    ).toBe(true);

    const offlineInput = expenseInput(remote, "Offline lunch");
    expect(
      remote.gateway.invoke(remote.ownerCredential, {
        command: "tally.add_expense",
        input: offlineInput,
        intentId: "remote-offline-lunch",
        intentDeviceId: remote.ownerCredential.deviceId,
      })
    ).toMatchObject({
      status: "denied",
      reason: "waiting for tally-b6-origin's device",
    });
    const swept = await sweepPeerCommons({
      vaults: [
        {
          vaultId: remote.vaultId,
          db: remote.vault,
          gateway: remote.gateway,
          credential: remote.ownerCredential,
        },
      ],
      links: remote.links,
      dial: dialFrom(remote, origin),
      limit: 10,
      now,
    });
    expect(swept.progressed).toBeGreaterThan(0);
    expect(
      remote.vault.vault
        .prepare("SELECT status FROM share_commons_intent WHERE intent_id = ?")
        .get("remote-offline-lunch")
    ).toMatchObject({ status: "executed" });
    const lunch = origin.vault.vault
      .prepare(
        "SELECT expense_id FROM tally_expense WHERE description = 'Offline lunch'"
      )
      .get() as { expense_id: string };
    const edited = {
      expense_id: lunch.expense_id,
      description: "Peer brunch",
      amount_minor: 900,
      paid_by: remote.ownerPartyId,
      category: "food",
      splits: offlineInput.splits,
    };
    const editResult = await sendRemote(
      "tally.edit_expense",
      edited,
      "remote-edit-lunch"
    );
    if (editResult.state !== "executed")
      throw new Error(`edit refused: ${JSON.stringify(editResult)}`);
    await syncRemote();
    for (const seat of [origin, local, remote])
      expect(
        seat.vault.vault
          .prepare("SELECT description FROM tally_expense WHERE expense_id = ?")
          .get(lunch.expense_id)
      ).toMatchObject({ description: "Peer brunch" });
    await expect(
      sendRemote(
        "tally.delete_expense",
        { expense_id: lunch.expense_id },
        "remote-delete-lunch"
      )
    ).resolves.toMatchObject({ state: "executed" });
    await syncRemote();
    for (const seat of [origin, local, remote])
      expect(
        seat.vault.vault
          .prepare("SELECT deleted_at FROM tally_expense WHERE expense_id = ?")
          .get(lunch.expense_id)
      ).toMatchObject({ deleted_at: expect.any(String) });
    await expect(
      sendRemote(
        "tally.restore_expense",
        { expense_id: lunch.expense_id },
        "remote-restore-lunch"
      )
    ).resolves.toMatchObject({ state: "executed" });
    await syncRemote();
    expectLocalNets([origin, local, remote], groupId);

    const backupDir = tempDirSync("tally-b6-remote-own-backup-");
    mkdirSync(backupDir, { recursive: true });
    const sealKey = Buffer.from(remote.vault.sealKey);
    const identitySeed = Buffer.from(remote.vault.identitySeed);
    const backup = backupVault(remote.vault, backupDir);
    remote.vault.close();
    const hotelInput = expenseInput(local, "Hotel while remote is gone");
    expect(
      executeCommonsCommand({
        steward: origin.vault,
        gateway: origin.gateway,
        credential: origin.ownerCredential,
        stewardVaultId: origin.vaultId,
        grantId: grant.grantId,
        actorPartyId: local.ownerPartyId,
        command: "tally.add_expense",
        commandInput: hotelInput,
        memberSignature: signed(
          local,
          "tally.add_expense",
          hotelInput,
          "local-hotel"
        ),
        intentId: "local-hotel",
        invocationId: "local-hotel",
        seats: originSeats(),
        now,
      }).decision.accepted
    ).toBe(true);
    copyFileSync(backup.vaultPath, path.join(backupDir, "vault.db"));
    remote.vault = openVaultDb({ dir: backupDir, sealKey, identitySeed });
    remote.gateway = createGateway(remote.vault);
    registerTallyCommands(remote.gateway);
    await pullFrom(remote, origin, grant.grantId, now);
    expectLocalNets([origin, local, remote], groupId);

    const downgradeSequence = upsertCommonsMember({
      steward: origin.vault.vault,
      grantId: grant.grantId,
      actorPartyId: origin.ownerPartyId,
      member: {
        partyId: remote.ownerPartyId,
        capability: "read",
        vaultId: remote.vaultId,
        vaultPublicKey: remote.publicKey,
      },
      now,
    });
    const refusedInput = expenseInput(remote, "Must refuse after downgrade");
    await expect(
      sendRemote("tally.add_expense", refusedInput, "remote-after-downgrade")
    ).resolves.toStrictEqual({
      state: "refused",
      reason: "this commons is read-only for this member",
    });
    expect(
      origin.vault.vault
        .prepare(
          "SELECT sequence, outcome, reason FROM share_commons_op WHERE grant_id = ? ORDER BY sequence DESC LIMIT 1"
        )
        .get(grant.grantId)
    ).toMatchObject({
      sequence: downgradeSequence + 1,
      outcome: "refused",
      reason: "this commons is read-only for this member",
    });

    removeCommonsMember({
      steward: origin.vault.vault,
      grantId: grant.grantId,
      actorPartyId: origin.ownerPartyId,
      memberPartyId: remote.ownerPartyId,
      now,
    });
    await pullFrom(remote, origin, grant.grantId, now);
    expect(
      remote.vault.vault
        .prepare("SELECT COUNT(*) AS n FROM tally_group WHERE group_id = ?")
        .get(groupId)
    ).toMatchObject({ n: 0 });
    expectLocalNets([origin, local], groupId);

    upsertCommonsMember({
      steward: origin.vault.vault,
      grantId: grant.grantId,
      actorPartyId: origin.ownerPartyId,
      member: {
        partyId: remote.ownerPartyId,
        capability: "read+write",
      },
      now,
    });
    await expect(
      invitePeerToCommons({
        dial: dialFrom(origin, remote),
        route: routeFrom(origin, remote),
        invitation: {
          grantId: grant.grantId,
          stewardVaultId: origin.vaultId,
          memberVaultId: remote.vaultId,
          memberPartyId: remote.ownerPartyId,
          capability: "read+write",
          containerType: "tally.group",
          containerId: groupId,
          containerLabel: "Peer household",
          currentSizeBytes: 0,
        },
      })
    ).resolves.toBe(true);
    await pullFrom(remote, origin, grant.grantId, now, true);
    const reinvite = listCommonsInvitations({
      seat: remote.vault.vault,
      memberVaultId: remote.vaultId,
    }).find((candidate) => candidate.status === "pending")!;
    answerCommonsInvitation({
      seat: remote.vault,
      invitationId: reinvite.invitationId,
      memberVaultId: remote.vaultId,
      answer: "accept",
      now,
    });
    expectLocalNets([origin, local, remote], groupId);

    expect(
      transferCommonsSteward({
        steward: origin.vault.vault,
        grantId: grant.grantId,
        actorPartyId: origin.ownerPartyId,
        successorPartyId: remote.ownerPartyId,
        now,
      })
    ).toBe(remote.ownerPartyId);
    compileOrigin();
    await pullFrom(remote, origin, grant.grantId, now);
    const resumed = remote.gateway.invoke(remote.ownerCredential, {
      command: "tally.add_expense",
      input: expenseInput(remote, "Ferry after transfer"),
    });
    expect(resumed.status).toBe("executed");
    await pullFrom(origin, remote, grant.grantId, now);
    await pullFrom(local, remote, grant.grantId, now);
    expectLocalNets([origin, local, remote], groupId);
  });
});

async function pullFrom(
  member: Side,
  steward: Side,
  grantId: string,
  now: string,
  acceptInvitation = false
): Promise<void> {
  await expect(
    pullPeerCommons({
      dial: dialFrom(member, steward),
      route: routeFrom(member, steward),
      stewardVaultId: steward.vaultId,
      memberVaultId: member.vaultId,
      grantId,
      seat: member.vault,
      ...(acceptInvitation ? { acceptInvitation: true } : {}),
      now,
    })
  ).resolves.toMatchObject({ state: "current" });
}

function expectLocalNets(sides: Side[], groupId: string): void {
  const expected = localTallyNet(sides[0]!.vault, groupId);
  for (const side of sides)
    expect(localTallyNet(side.vault, groupId), side.label).toStrictEqual(
      expected
    );
}
