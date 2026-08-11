import { afterEach, describe, expect, test } from "vitest";

import { registerTallyCommands } from "../commands/tally.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { nowIso, uuidv7 } from "../ids.js";
import { signCommonsIntent } from "./commons-signature.js";
import {
  authorizeCommonsCommand,
  commonsCurrentSize,
  compileCommons,
  createCommonsGrant,
  executeCommonsCommand,
  queueCommonsIntent,
  removeCommonsFromSeat,
  settleCommonsIntent,
  transferCommonsSteward,
} from "./commons.js";
import { closeOpenVaults, household, seedPhoto } from "./placement-fixture.js";

function addParty(
  db: ReturnType<typeof household>["origin"]["vault"],
  name: string,
  now: string,
  partyId = uuidv7()
): string {
  db.prepare(
    `INSERT INTO core_party
       (party_id, kind, display_name, sort_name, birth_date,
        avatar_content_id, created_at, updated_at, ontology_version)
     VALUES (?, 'person', ?, ?, NULL, NULL, ?, ?, '1.4')`
  ).run(partyId, name, name, now, now);
  return partyId;
}

describe("circle-backed commons", () => {
  afterEach(closeOpenVaults);

  test("implicit circles are isolated, project domain rows without derivatives, and follow container additions", () => {
    const { origin, originBoot, audience } = household();
    const now = nowIso();
    const bob = addParty(origin.vault, "Bob", now);
    const first = seedPhoto(origin, originBoot, "commons-first");
    const collectionId = uuidv7();
    origin.vault
      .prepare(
        `INSERT INTO core_collection
           (collection_id, owner_party_id, name, cover_content_id,
            parent_collection_id, sort_order, created_at)
         VALUES (?, ?, 'Trip', ?, NULL, 0, ?)`
      )
      .run(collectionId, originBoot.ownerPartyId, first.contentId, now);
    const add = origin.vault.prepare(
      `INSERT INTO core_collection_entry
         (entry_id, collection_id, target_type, target_id, position, added_at)
       VALUES (?, ?, 'media.media_asset', ?, ?, ?)`
    );
    add.run(uuidv7(), collectionId, first.assetId, 0, now);

    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      containerType: "core.collection",
      containerId: collectionId,
      members: [
        { partyId: bob, capability: "read+write", vaultId: "vault-family" },
      ],
      now,
    });
    const seats = [
      {
        partyId: originBoot.ownerPartyId,
        capability: "read+write" as const,
        vaultId: "vault-priya",
        vault: origin,
      },
      {
        partyId: bob,
        capability: "read+write" as const,
        vaultId: "vault-family",
        vault: audience,
      },
      { partyId: uuidv7(), capability: "read" as const },
    ];
    const firstCompile = compileCommons({
      steward: origin,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      seats,
      now,
    });
    expect(firstCompile.map((seat) => seat.status)).toStrictEqual([
      "current",
      "current",
      "invited",
    ]);
    expect(
      audience.vault
        .prepare("SELECT COUNT(*) AS n FROM media_media_asset")
        .get()
    ).toMatchObject({ n: 1 });
    expect(
      audience.vault
        .prepare("SELECT COUNT(*) AS n FROM core_content_derivative")
        .get()
    ).toMatchObject({ n: 0 });
    expect(audience.blobs.hasSync(first.sha256)).toBe(true);
    expect(audience.blobs.hasSync(first.thumbSha)).toBe(false);

    const second = seedPhoto(origin, originBoot, "commons-later");
    add.run(uuidv7(), collectionId, second.assetId, 1, now);
    compileCommons({
      steward: origin,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      seats,
      now,
    });
    expect(
      audience.vault
        .prepare("SELECT COUNT(*) AS n FROM media_media_asset")
        .get()
    ).toMatchObject({ n: 2 });
    expect(audience.blobs.hasSync(second.sha256)).toBe(true);
  });

  test("steward serializes capability decisions, pending intent truth, transfer, and scrub", () => {
    const { origin, originBoot, audience } = household();
    const now = nowIso();
    const bob = addParty(origin.vault, "Bob", now);
    const photo = seedPhoto(origin, originBoot, "commons-control");
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      containerType: "media.media_asset",
      containerId: photo.assetId,
      members: [{ partyId: bob, capability: "read", vaultId: "vault-family" }],
      now,
    });
    const seats = [
      {
        partyId: originBoot.ownerPartyId,
        capability: "read+write" as const,
        vaultId: "vault-priya",
        vault: origin,
      },
      {
        partyId: bob,
        capability: "read" as const,
        vaultId: "vault-family",
        vault: audience,
      },
    ];
    compileCommons({
      steward: origin,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      seats,
      now,
    });
    const intentId = queueCommonsIntent({
      seat: audience.vault,
      grantId: grant.grantId,
      actorPartyId: bob,
      command: "media.update_asset",
      commandInput: { asset_id: photo.assetId },
      stewardLabel: "Priya's device",
      now,
    });
    const denied = authorizeCommonsCommand({
      steward: origin.vault,
      grantId: grant.grantId,
      actorPartyId: bob,
      command: "media.update_asset",
      commandInput: { asset_id: photo.assetId },
      now,
    });
    expect(denied).toMatchObject({
      accepted: false,
      sequence: 1,
      reason: "this commons is read-only for this member",
    });
    settleCommonsIntent({
      seat: audience.vault,
      intentId,
      status: "denied",
      reason: denied.reason,
      now,
    });
    expect(
      audience.vault
        .prepare(
          "SELECT status, reason, steward_label FROM share_commons_intent"
        )
        .get()
    ).toMatchObject({
      status: "denied",
      reason: denied.reason,
      steward_label: "Priya's device",
    });

    origin.vault
      .prepare(
        "UPDATE social_circle_member SET capability = 'read+write' WHERE circle_id = ? AND party_id = ?"
      )
      .run(grant.circleId, bob);
    expect(
      authorizeCommonsCommand({
        steward: origin.vault,
        grantId: grant.grantId,
        actorPartyId: bob,
        command: "media.update_asset",
        commandInput: {},
        now,
      })
    ).toMatchObject({ accepted: false, sequence: 2 });
    const successor = transferCommonsSteward({
      steward: origin.vault,
      grantId: grant.grantId,
      actorPartyId: originBoot.ownerPartyId,
      now,
    });
    expect(successor).toBe(bob);
    expect(
      origin.vault
        .prepare("SELECT sequence FROM share_commons_op ORDER BY sequence")
        .all()
    ).toMatchObject([{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }]);
    expect(() =>
      transferCommonsSteward({
        steward: origin.vault,
        grantId: grant.grantId,
        actorPartyId: bob,
        successorPartyId: originBoot.ownerPartyId,
        now,
      })
    ).toThrow("founder");
    expect(
      removeCommonsFromSeat({ seat: audience, grantId: grant.grantId })
    ).toBe(1);
    expect(
      audience.vault
        .prepare("SELECT COUNT(*) AS n FROM media_media_asset")
        .get()
    ).toMatchObject({ n: 0 });
  });

  test("two writable Tally members add records that converge in both vaults", () => {
    const { origin, originBoot, audience, audienceBoot } = household();
    const now = nowIso();
    const bob = addParty(origin.vault, "Bob", now, audienceBoot.ownerPartyId);
    const gateway = createGateway(origin);
    registerTallyCommands(gateway);
    const credential: Credential = {
      kind: "device",
      deviceId: originBoot.deviceId,
      deviceKey: originBoot.deviceKey,
    };
    const created = gateway.invoke(credential, {
      command: "tally.create_group",
      input: { name: "Trip", icon: "🧳", member_ids: [bob] },
      purpose: "dpv:ServiceProvision",
    });
    expect(created.status).toBe("executed");
    const groupId = (created as { output: { group_id: string } }).output
      .group_id;
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      containerType: "tally.group",
      containerId: groupId,
      members: [
        {
          partyId: bob,
          capability: "read+write",
          vaultId: "vault-family",
          vault: audience,
        },
      ],
      now,
    });
    const seats = [
      {
        partyId: originBoot.ownerPartyId,
        capability: "read+write" as const,
        vaultId: "vault-priya",
        vault: origin,
      },
      {
        partyId: bob,
        capability: "read+write" as const,
        vaultId: "vault-family",
        vault: audience,
      },
    ];
    compileCommons({
      steward: origin,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      seats,
      now,
    });

    const write = (
      actorPartyId: string,
      description: string,
      amount: number,
      intentId?: string
    ) => {
      const commandInput = {
        group_id: groupId,
        description,
        amount_minor: amount,
        paid_by: actorPartyId,
        category: "food",
        splits: [
          { party_id: originBoot.ownerPartyId, share_minor: amount / 2 },
          { party_id: bob, share_minor: amount / 2 },
        ],
      };
      return executeCommonsCommand({
        steward: origin,
        gateway,
        credential,
        stewardVaultId: "vault-priya",
        grantId: grant.grantId,
        actorPartyId,
        command: "tally.add_expense",
        commandInput,
        seats,
        ...(actorPartyId === bob
          ? {
              memberSignature: signCommonsIntent(audience.identitySeed, {
                grantId: grant.grantId,
                actorPartyId,
                command: "tally.add_expense",
                commandInput,
                memberVaultId: "vault-family",
                nonce: intentId ?? description,
              }),
            }
          : {}),
        ...(intentId ? { intentId } : {}),
        now,
      });
    };

    const aliceWrite = write(originBoot.ownerPartyId, "Train", 1_000);
    expect(aliceWrite.decision.accepted).toBe(true);
    expect(aliceWrite.outcome?.status).toBe("executed");
    expect(
      origin.vault
        .prepare("SELECT description FROM tally_expense WHERE group_id = ?")
        .all(groupId)
    ).toMatchObject([{ description: "Train" }]);
    const bobIntent = queueCommonsIntent({
      seat: audience.vault,
      grantId: grant.grantId,
      actorPartyId: bob,
      command: "tally.add_expense",
      commandInput: { group_id: groupId, description: "Lunch" },
      stewardLabel: "Priya's device",
      now,
    });
    const bobWrite = write(bob, "Lunch", 600, bobIntent);
    expect(bobWrite.decision.reason).toBeUndefined();
    expect(bobWrite.decision).toMatchObject({ accepted: true });
    expect(bobWrite.outcome?.status).toBe("executed");

    for (const db of [origin.vault, audience.vault]) {
      expect(
        db
          .prepare(
            "SELECT description FROM tally_expense WHERE group_id = ? ORDER BY description"
          )
          .all(groupId)
      ).toMatchObject([{ description: "Lunch" }, { description: "Train" }]);
    }
    expect(
      audience.vault
        .prepare("SELECT status FROM share_commons_intent WHERE intent_id = ?")
        .get(bobIntent)
    ).toMatchObject({ status: "executed" });
    expect(
      origin.vault
        .prepare(
          `SELECT actor_party_id, sequence FROM share_commons_op
            WHERE grant_id = ?
           UNION ALL
           SELECT actor_party_id, sequence FROM share_commons_receipt
            WHERE grant_id = ?
           ORDER BY sequence`
        )
        .all(grant.grantId, grant.grantId)
    ).toMatchObject([
      { actor_party_id: originBoot.ownerPartyId, sequence: 1 },
      { actor_party_id: bob, sequence: 2 },
    ]);
    const currentSize = commonsCurrentSize(
      origin.vault,
      "vault-priya",
      grant.grantId
    );
    origin.vault
      .prepare(
        "UPDATE share_circle_grant SET max_size_bytes = ? WHERE grant_id = ?"
      )
      .run(currentSize, grant.grantId);
    expect(
      write(originBoot.ownerPartyId, "Crosses maximum", 200).decision
    ).toMatchObject({
      accepted: false,
      reason: expect.stringMatching(/above its .* byte maximum/u),
      sequence: 2,
    });
    expect(
      origin.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM tally_expense WHERE description = 'Crosses maximum'"
        )
        .get()
    ).toMatchObject({ n: 0 });
    expect(
      origin.vault
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM share_commons_op WHERE grant_id = ?)
             + (SELECT COUNT(*) FROM share_commons_receipt WHERE grant_id = ?)
             AS n`
        )
        .get(grant.grantId, grant.grantId)
    ).toMatchObject({ n: 2 });
  });
});
