// governance: allow-repo-hygiene file-size-limit (#731) one lifecycle acceptance suite covers grants, invites, compaction/replay, restore, revoke, retain, and transfer over a shared real-vault fixture.
import { afterEach, describe, expect, test, vi } from "vitest";

import { nowIso, uuidv7 } from "../ids.js";
import {
  answerCommonsInvitation,
  applyCommonsBootstrap,
  applyCommonsTombstone,
  exportCommonsBootstrap,
  exportCommonsSyncFrame,
  listCommonsInvitations,
  placeCommonsBootstrapBlobs,
  queueCommonsInvitation,
} from "./commons-bootstrap.js";
import { advanceCommonsCursor, readCommonsCursor } from "./commons-cursor.js";
import {
  listCommonsGrants,
  recompileCommonsGrants,
  removeCommonsMember,
  revokeCommonsGrant,
  scrubCommonsSeat,
  upsertCommonsMember,
} from "./commons-lifecycle.js";
import {
  appendCommonsOperation,
  authorizeCommonsCommand,
  compileCommons,
  compactCommonsOperations,
  createCommonsGrant,
  retainCommonsItem,
  removeCommonsFromSeat,
  transferCommonsSteward,
} from "./commons.js";
import { closeOpenVaults, household, seedPhoto } from "./placement-fixture.js";

// This fixture repeatedly creates full encrypted vaults. The pre-push gate
// deliberately runs package suites concurrently, where cold SQLite setup can
// exceed Vitest's small unit default without changing the deterministic work.
vi.setConfig({ testTimeout: 30_000 });

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

describe("commons lifecycle and logical cursors", () => {
  afterEach(closeOpenVaults);

  test("per-grant member offsets advance monotonically above one vault replica", () => {
    const { audience } = household();
    const now = nowIso();
    expect(
      advanceCommonsCursor({
        db: audience.vault,
        grantId: "grant-a",
        memberVaultId: "vault-family",
        sequence: 7,
        now,
      })
    ).toMatchObject({ sequence: 7 });
    advanceCommonsCursor({
      db: audience.vault,
      grantId: "grant-a",
      memberVaultId: "vault-family",
      sequence: 3,
      now: "2000-01-01T00:00:00.000Z",
    });
    advanceCommonsCursor({
      db: audience.vault,
      grantId: "grant-b",
      memberVaultId: "vault-family",
      sequence: 2,
      now,
    });
    expect(
      readCommonsCursor(audience.vault, "grant-a", "vault-family")
    ).toMatchObject({ sequence: 7, updatedAt: now });
    expect(
      readCommonsCursor(audience.vault, "grant-b", "vault-family")
    ).toMatchObject({ sequence: 2 });
  });

  test("checkpoint compaction waits for the minimum member cursor and retains signed replay decisions", () => {
    const { origin, originBoot, audience, audienceBoot } = household();
    const now = nowIso();
    const photo = seedPhoto(origin, originBoot, "compaction");
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      ownerVaultId: "vault-priya",
      ownerVault: origin,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [
        {
          partyId: audienceBoot.ownerPartyId,
          capability: "read+write",
          vaultId: "vault-family",
          vault: audience,
        },
      ],
      now,
    });
    appendCommonsOperation({
      steward: origin.vault,
      grantId: grant.grantId,
      actorPartyId: originBoot.ownerPartyId,
      kind: "command",
      command: "media.update_asset",
      input: { asset_id: photo.assetId },
      outcome: "refused",
      reason: "proof",
      now,
    });
    appendCommonsOperation({
      steward: origin.vault,
      grantId: grant.grantId,
      actorPartyId: audienceBoot.ownerPartyId,
      kind: "command",
      command: "media.update_asset",
      input: { asset_id: photo.assetId },
      memberSignature: {
        memberVaultId: "vault-family",
        nonce: "compacted-signed-nonce",
        signature: "test-signature",
      },
      outcome: "refused",
      reason: "signed proof",
      now,
    });
    const ownerSeat = {
      partyId: originBoot.ownerPartyId,
      capability: "read+write" as const,
      vaultId: "vault-priya",
      vault: origin,
    };
    const memberSeat = {
      partyId: audienceBoot.ownerPartyId,
      capability: "read+write" as const,
      vaultId: "vault-family",
      vault: audience,
    };
    compileCommons({
      steward: origin,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      seats: [ownerSeat, memberSeat],
      now,
    });
    compactCommonsOperations(origin.vault, grant.grantId, true);
    expect(
      origin.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM share_commons_op WHERE grant_id = ?"
        )
        .get(grant.grantId)
    ).toMatchObject({ n: 0 });
    expect(
      origin.vault
        .prepare(
          `SELECT sequence, outcome FROM share_commons_replay
            WHERE grant_id = ? AND signature_nonce = 'compacted-signed-nonce'`
        )
        .get(grant.grantId)
    ).toMatchObject({ sequence: 2, outcome: "refused" });
    expect(
      origin.vault
        .prepare(
          "SELECT kind, actor_party_id FROM share_commons_receipt WHERE grant_id = ? ORDER BY sequence"
        )
        .all(grant.grantId)
    ).toMatchObject([
      { kind: "command", actor_party_id: originBoot.ownerPartyId },
      { kind: "command", actor_party_id: audienceBoot.ownerPartyId },
    ]);

    appendCommonsOperation({
      steward: origin.vault,
      grantId: grant.grantId,
      actorPartyId: originBoot.ownerPartyId,
      kind: "command",
      command: "media.update_asset",
      input: { asset_id: photo.assetId },
      outcome: "refused",
      reason: "laggard proof",
      now,
    });
    compileCommons({
      steward: origin,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      seats: [ownerSeat],
      now,
    });
    compactCommonsOperations(origin.vault, grant.grantId, true);
    expect(
      origin.vault
        .prepare("SELECT sequence FROM share_commons_op WHERE grant_id = ?")
        .all(grant.grantId)
    ).toMatchObject([{ sequence: 3 }]);
    compileCommons({
      steward: origin,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      seats: [ownerSeat, memberSeat],
      now,
    });
    compactCommonsOperations(origin.vault, grant.grantId, true);
    expect(
      origin.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM share_commons_op WHERE grant_id = ?"
        )
        .get(grant.grantId)
    ).toMatchObject({ n: 0 });
    expect(
      audience.vault
        .prepare(
          `SELECT sequence FROM share_commons_replay
            WHERE grant_id = ? AND signature_nonce = 'compacted-signed-nonce'`
        )
        .get(grant.grantId)
    ).toMatchObject({ sequence: 2 });
    expect(
      transferCommonsSteward({
        steward: audience.vault,
        grantId: grant.grantId,
        actorPartyId: audienceBoot.ownerPartyId,
        now,
      })
    ).toBe(audienceBoot.ownerPartyId);
    expect(
      authorizeCommonsCommand({
        steward: audience.vault,
        grantId: grant.grantId,
        actorPartyId: audienceBoot.ownerPartyId,
        command: "media.update_asset",
        commandInput: { asset_id: photo.assetId },
        memberSignature: {
          memberVaultId: "vault-family",
          nonce: "compacted-signed-nonce",
          signature: "same-replayed-signature",
        },
        now,
      })
    ).toMatchObject({ accepted: false, sequence: 2, reason: "signed proof" });
    advanceCommonsCursor({
      db: audience.vault,
      grantId: grant.grantId,
      memberVaultId: "vault-priya",
      sequence: 1,
      now,
    });
    removeCommonsMember({
      steward: audience.vault,
      grantId: grant.grantId,
      actorPartyId: audienceBoot.ownerPartyId,
      memberPartyId: originBoot.ownerPartyId,
      now,
    });
    compileCommons({
      steward: audience,
      stewardVaultId: "vault-family",
      grantId: grant.grantId,
      seats: [memberSeat],
      now,
    });
    compactCommonsOperations(audience.vault, grant.grantId, true);
    expect(
      audience.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM share_commons_cursor WHERE grant_id = ? AND member_vault_id = 'vault-priya'"
        )
        .get(grant.grantId)
    ).toMatchObject({ n: 1 });
    expect(
      audience.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM share_commons_op WHERE grant_id = ?"
        )
        .get(grant.grantId)
    ).toMatchObject({ n: 0 });
  });

  test("membership changes share the command log and restore recompiles from vault truth", () => {
    const { origin, originBoot, audience, audienceBoot } = household();
    const now = nowIso();
    const bob = addParty(origin.vault, "Bob", now, audienceBoot.ownerPartyId);
    const photo = seedPhoto(origin, originBoot, "restore");
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      containerType: "media.asset",
      containerId: photo.assetId,
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
    expect(
      removeCommonsFromSeat({ seat: audience, grantId: grant.grantId })
    ).toBe(1);
    expect(
      audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
    ).toMatchObject({ n: 0 });
    recompileCommonsGrants({
      steward: origin,
      stewardVaultId: "vault-priya",
      stewardPartyId: originBoot.ownerPartyId,
      vaultFor: (vaultId) =>
        vaultId === "vault-priya"
          ? origin
          : vaultId === "vault-family"
            ? audience
            : undefined,
      now,
    });
    expect(
      audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
    ).toMatchObject({ n: 1 });

    const downgraded = upsertCommonsMember({
      steward: origin.vault,
      grantId: grant.grantId,
      actorPartyId: originBoot.ownerPartyId,
      member: {
        partyId: bob,
        capability: "read",
        vaultId: "vault-family",
        vault: audience,
      },
      now,
    });
    expect(downgraded).toBe(1);
    removeCommonsMember({
      steward: origin.vault,
      grantId: grant.grantId,
      actorPartyId: originBoot.ownerPartyId,
      memberPartyId: bob,
      now,
    });
    expect(
      origin.vault
        .prepare(
          "SELECT kind, sequence FROM share_commons_op WHERE grant_id = ? ORDER BY sequence"
        )
        .all(grant.grantId)
    ).toMatchObject([
      { kind: "capability_changed", sequence: 1 },
      { kind: "member_removed", sequence: 2 },
    ]);
    expect(scrubCommonsSeat({ seat: audience, grantId: grant.grantId })).toBe(
      1
    );
    expect(
      audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
    ).toMatchObject({ n: 0 });
    expect(listCommonsGrants(audience.vault)).toStrictEqual([]);
  });

  test("a peer member bootstraps from checkpoint N plus an ordered tail", () => {
    const { origin, originBoot, audience, audienceBoot } = household();
    const now = nowIso();
    const bob = addParty(origin.vault, "Bob", now, audienceBoot.ownerPartyId);
    const photo = seedPhoto(origin, originBoot, "peer-bootstrap");
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      // The steward's own vault binding is what a member verifies the signed
      // checkpoint against (#731).
      ownerVaultId: "vault-priya",
      ownerVault: origin,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [
        {
          partyId: bob,
          capability: "read",
          vaultId: "vault-family",
          vault: audience,
        },
      ],
      now,
    });
    compileCommons({
      steward: origin,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      seats: [
        {
          partyId: originBoot.ownerPartyId,
          capability: "read+write",
          vaultId: "vault-priya",
          vault: origin,
        },
        { partyId: bob, capability: "read", vaultId: "vault-family" },
      ],
      now,
    });
    appendCommonsOperation({
      steward: origin.vault,
      grantId: grant.grantId,
      actorPartyId: bob,
      kind: "command",
      command: "media.update_asset",
      input: { asset_id: photo.assetId },
      outcome: "refused",
      reason: "this commons is read-only for this member",
      now,
    });
    const wire = exportCommonsBootstrap({
      steward: origin.vault,
      identitySeed: origin.identitySeed,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      memberVaultId: "vault-family",
    });
    expect(wire.snapshotSequence).toBe(0);
    expect(wire.tail.map((row) => row["sequence"])).toStrictEqual([1]);
    placeCommonsBootstrapBlobs({ source: origin, seat: audience, wire });
    applyCommonsBootstrap({ seat: audience, wire, now });
    expect(
      audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
    ).toMatchObject({ n: 1 });
    expect(
      audience.vault
        .prepare(
          "SELECT sequence, reason FROM share_commons_op WHERE grant_id = ?"
        )
        .all(grant.grantId)
    ).toMatchObject([
      {
        sequence: 1,
        reason: "this commons is read-only for this member",
      },
    ]);
    expect(
      readCommonsCursor(audience.vault, grant.grantId, "vault-family")
    ).toMatchObject({ sequence: 1 });
    removeCommonsMember({
      steward: origin.vault,
      grantId: grant.grantId,
      actorPartyId: originBoot.ownerPartyId,
      memberPartyId: bob,
      now,
    });
    const frame = exportCommonsSyncFrame({
      steward: origin.vault,
      identitySeed: origin.identitySeed,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      memberVaultId: "vault-family",
    });
    expect(frame).toMatchObject({
      state: "tombstone",
      tombstone: { reason: "member_removed" },
    });
    if (frame.state === "tombstone")
      applyCommonsTombstone({ seat: audience, tombstone: frame.tombstone });
    expect(
      audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
    ).toMatchObject({ n: 0 });
    expect(listCommonsGrants(audience.vault)).toStrictEqual([]);
  });

  test("a peer invitation preserves size and projects only after explicit acceptance", () => {
    const { origin, originBoot, audience, audienceBoot } = household();
    const now = nowIso();
    const photo = seedPhoto(origin, originBoot, "pending-peer-consent");
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      ownerVaultId: "vault-priya",
      ownerVault: origin,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [
        {
          partyId: audienceBoot.ownerPartyId,
          capability: "read",
          vaultId: "vault-family",
          vault: audience,
        },
      ],
      now,
    });
    const wire = exportCommonsBootstrap({
      steward: origin.vault,
      identitySeed: origin.identitySeed,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      memberVaultId: "vault-family",
    });
    const pending = queueCommonsInvitation({
      seat: audience.vault,
      invitation: {
        grantId: wire.grantId,
        stewardVaultId: wire.stewardVaultId,
        memberVaultId: wire.memberVaultId,
        memberPartyId: audienceBoot.ownerPartyId,
        capability: "read",
        containerType: "media.asset",
        containerId: photo.assetId,
        containerLabel: "Pending photo",
        currentSizeBytes: photo.bytes.length,
      },
      now,
    });
    expect(pending).toMatchObject({
      status: "pending",
      currentSizeBytes: photo.bytes.length,
    });
    expect(
      listCommonsInvitations({
        seat: audience.vault,
        memberVaultId: "vault-family",
      })
    ).toMatchObject([pending]);
    expect(
      audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
    ).toMatchObject({ n: 0 });
    expect(
      (
        audience.vault
          .prepare("PRAGMA table_info(share_commons_invitation)")
          .all() as { name: string }[]
      ).map((column) => column.name)
    ).not.toContain("wire_json");

    expect(
      answerCommonsInvitation({
        seat: audience,
        invitationId: pending.invitationId,
        memberVaultId: "vault-family",
        answer: "refuse",
        now,
      }).status
    ).toBe("refused");
    const reopened = queueCommonsInvitation({
      seat: audience.vault,
      invitation: {
        grantId: wire.grantId,
        stewardVaultId: wire.stewardVaultId,
        memberVaultId: wire.memberVaultId,
        memberPartyId: audienceBoot.ownerPartyId,
        capability: "read",
        containerType: "media.asset",
        containerId: photo.assetId,
        containerLabel: "Pending photo",
        currentSizeBytes: photo.bytes.length,
      },
      now,
    });
    expect(reopened).toMatchObject({ status: "pending" });
    expect(reopened.invitationId).not.toBe(pending.invitationId);
    const accepted = answerCommonsInvitation({
      seat: audience,
      invitationId: reopened.invitationId,
      memberVaultId: "vault-family",
      answer: "accept",
      now,
    });
    expect(accepted.status).toBe("accepted");
    expect(
      audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
    ).toMatchObject({ n: 0 });
    applyCommonsBootstrap({ seat: audience, wire, now });
    expect(
      audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
    ).toMatchObject({ n: 1 });
  });

  test("an invited party joins later without changing capability", () => {
    const { origin, originBoot, audience, audienceBoot } = household();
    const now = nowIso();
    const bob = addParty(origin.vault, "Bob", now, audienceBoot.ownerPartyId);
    const photo = seedPhoto(origin, originBoot, "late-join");
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      ownerVaultId: "vault-priya",
      ownerVault: origin,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [{ partyId: bob, capability: "read" }],
      now,
    });
    expect(listCommonsGrants(origin.vault)[0]?.members).toContainEqual({
      partyId: bob,
      capability: "read",
      status: "invited",
    });
    expect(
      upsertCommonsMember({
        steward: origin.vault,
        grantId: grant.grantId,
        actorPartyId: originBoot.ownerPartyId,
        member: {
          partyId: bob,
          capability: "read",
          vaultId: "vault-family",
          vault: audience,
        },
        now,
      })
    ).toBe(1);
    const seats = recompileCommonsGrants({
      steward: origin,
      stewardVaultId: "vault-priya",
      stewardPartyId: originBoot.ownerPartyId,
      vaultFor: (vaultId) =>
        vaultId === "vault-priya"
          ? origin
          : vaultId === "vault-family"
            ? audience
            : undefined,
      now,
    });
    expect(seats[0]?.seats.find((seat) => seat.partyId === bob)).toMatchObject({
      status: "current",
      vaultId: "vault-family",
    });
    expect(
      origin.vault
        .prepare(
          `SELECT checkpoint_sequence, last_sequence FROM share_circle_grant
            WHERE grant_id = ?`
        )
        .get(grant.grantId)
    ).toMatchObject({ checkpoint_sequence: 1, last_sequence: 1 });
    expect(
      origin.vault
        .prepare("SELECT kind FROM share_commons_op WHERE grant_id = ?")
        .get(grant.grantId)
    ).toMatchObject({ kind: "member_joined" });
    expect(
      audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
    ).toMatchObject({ n: 1 });
  });

  test("an offline member receives a grant-revoked tombstone and scrubs its copy", () => {
    const { origin, originBoot, audience, audienceBoot } = household();
    const now = nowIso();
    const bob = addParty(origin.vault, "Bob", now, audienceBoot.ownerPartyId);
    const photo = seedPhoto(origin, originBoot, "revoked-peer");
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [
        {
          partyId: bob,
          capability: "read",
          vaultId: "vault-family",
          vault: audience,
        },
      ],
      now,
    });
    compileCommons({
      steward: origin,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      seats: [
        {
          partyId: originBoot.ownerPartyId,
          capability: "read+write",
          vaultId: "vault-priya",
          vault: origin,
        },
        {
          partyId: bob,
          capability: "read",
          vaultId: "vault-family",
          vault: audience,
        },
      ],
      now,
    });
    revokeCommonsGrant({
      steward: origin.vault,
      grantId: grant.grantId,
      actorPartyId: originBoot.ownerPartyId,
      now,
    });

    const frame = exportCommonsSyncFrame({
      steward: origin.vault,
      identitySeed: origin.identitySeed,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      memberVaultId: "vault-family",
    });
    expect(frame).toMatchObject({
      state: "tombstone",
      tombstone: { reason: "grant_revoked" },
    });
    if (frame.state === "tombstone")
      applyCommonsTombstone({ seat: audience, tombstone: frame.tombstone });
    expect(
      audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
    ).toMatchObject({ n: 0 });
    expect(listCommonsGrants(audience.vault)).toStrictEqual([]);
  });

  test("a receiver-retained Commons item survives revoke and retain retries", () => {
    const { origin, originBoot, audience, audienceBoot } = household();
    const now = nowIso();
    const photo = seedPhoto(origin, originBoot, "retained-copy");
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      ownerVaultId: "vault-priya",
      ownerVault: origin,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [
        {
          partyId: audienceBoot.ownerPartyId,
          capability: "read",
          vaultId: "vault-family",
          vault: audience,
        },
      ],
      now,
    });
    compileCommons({
      steward: origin,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      seats: [
        {
          partyId: audienceBoot.ownerPartyId,
          capability: "read",
          vaultId: "vault-family",
          vault: audience,
        },
      ],
      now,
    });
    expect(
      retainCommonsItem({
        seat: audience.vault,
        itemType: "media.asset",
        itemId: photo.assetId,
        now,
      })
    ).toMatchObject({ retained: true, grantIds: [grant.grantId] });
    expect(
      retainCommonsItem({
        seat: audience.vault,
        itemType: "media.asset",
        itemId: photo.assetId,
        now,
      })
    ).toMatchObject({ retained: false, grantIds: [grant.grantId] });
    origin.vault
      .prepare("UPDATE media_asset SET favorite = 0 WHERE asset_id = ?")
      .run(photo.assetId);
    compileCommons({
      steward: origin,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      seats: [
        {
          partyId: audienceBoot.ownerPartyId,
          capability: "read",
          vaultId: "vault-family",
          vault: audience,
        },
      ],
      now,
    });
    expect(
      audience.vault
        .prepare("SELECT favorite FROM media_asset WHERE asset_id = ?")
        .get(photo.assetId)
    ).toMatchObject({ favorite: 1 });
    expect(
      audience.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM core_share_origin WHERE item_type = 'media.asset' AND item_id = ?"
        )
        .get(photo.assetId)
    ).toMatchObject({ n: 0 });
    applyCommonsBootstrap({
      seat: audience,
      wire: exportCommonsBootstrap({
        steward: origin.vault,
        identitySeed: origin.identitySeed,
        stewardVaultId: "vault-priya",
        grantId: grant.grantId,
        memberVaultId: "vault-family",
      }),
      now,
    });
    expect(
      audience.vault
        .prepare("SELECT favorite FROM media_asset WHERE asset_id = ?")
        .get(photo.assetId)
    ).toMatchObject({ favorite: 1 });
    expect(
      audience.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM share_commons_lineage WHERE grant_id = ?"
        )
        .get(grant.grantId)
    ).toMatchObject({ n: 0 });
    revokeCommonsGrant({
      steward: origin.vault,
      grantId: grant.grantId,
      actorPartyId: originBoot.ownerPartyId,
      now,
    });
    const frame = exportCommonsSyncFrame({
      steward: origin.vault,
      identitySeed: origin.identitySeed,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      memberVaultId: "vault-family",
    });
    if (frame.state === "tombstone")
      applyCommonsTombstone({ seat: audience, tombstone: frame.tombstone });
    expect(
      audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
    ).toMatchObject({ n: 1 });
    expect(audience.blobs.local.hasSync(photo.sha256)).toBe(true);
  });
});
