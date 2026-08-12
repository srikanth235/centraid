/* B6 peer-plane flagship: two real gateway/vault fixtures joined over the
 * repository's in-process peer dial. Consent, snapshot+CAS, signed writes,
 * catch-up and authenticated unshare all cross the actual peer routes. */

import { describe, expect, test } from "vitest";

import {
  answerCommonsInvitation,
  commonsSeats,
  compileCommons,
  createCommonsClaimInvitation,
  createCommonsGrant,
  listCommonsInvitations,
  readCommonsGrant,
  registerTallyCommands,
  revokeCommonsGrant,
  signCommonsIntent,
} from "@centraid/vault";

import { COMMONS_BOOTSTRAP_PAGE_BYTES } from "../routes/peer-commons-pages.js";
import { PEER_COMMONS_BOOTSTRAP_PATH_PREFIX } from "../routes/peer-commons-route.js";
import {
  claimPeerCommonsInvitation,
  invitePeerToCommons,
  pullPeerCommons,
  sendPeerCommonsCommand,
} from "./peer-commons-client.js";
import {
  dialFrom,
  exportCommonsBootstrapForTest,
  link,
  makeSide,
  routeFrom,
  seedPhoto,
} from "./peer-give.test-fixtures.js";

describe("B6 Commons peer plane", () => {
  test("explicit consent gates snapshot+CAS, then signed Tally writes catch up and revoke scrubs", async () => {
    const origin = makeSide("commons-origin");
    const member = makeSide("commons-member");
    await link(origin, member);
    const now = new Date().toISOString();

    const photo = seedPhoto(origin, "commons-cas");
    const invitedPartyId = "party-invited-before-vault";
    const photoGrant = createCommonsGrant({
      origin: origin.vault.vault,
      ownerPartyId: origin.ownerPartyId,
      ownerVaultId: origin.vaultId,
      ownerVault: origin.vault,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [
        {
          partyId: invitedPartyId,
          capability: "read",
        },
      ],
      now,
    });
    compileCommons({
      steward: origin.vault,
      stewardVaultId: origin.vaultId,
      grantId: photoGrant.grantId,
      seats: commonsSeats({
        steward: origin.vault.vault,
        grantId: photoGrant.grantId,
        stewardVaultId: origin.vaultId,
        vaultFor: () => undefined,
      }),
      now,
    });
    const claim = createCommonsClaimInvitation({
      seat: origin.vault.vault,
      invitation: {
        grantId: photoGrant.grantId,
        stewardVaultId: origin.vaultId,
        memberPartyId: invitedPartyId,
        capability: "read",
        containerType: "media.asset",
        containerId: photo.assetId,
        containerLabel: "Photo before install",
        currentSizeBytes: photo.bytes.length,
      },
      now,
    });
    await expect(
      claimPeerCommonsInvitation({
        dial: dialFrom(member, origin),
        route: routeFrom(member, origin),
        stewardVaultId: origin.vaultId,
        memberVaultId: member.vaultId,
        claimToken: claim.claimToken,
        seat: member.vault,
        now,
      })
    ).resolves.toBe(true);
    const invitations = listCommonsInvitations({
      seat: member.vault.vault,
      memberVaultId: member.vaultId,
    });
    expect(invitations[0]).toMatchObject({
      grantId: photoGrant.grantId,
      status: "pending",
      currentSizeBytes: photo.bytes.length,
      memberPartyId: invitedPartyId,
    });
    expect(
      member.vault.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
    ).toMatchObject({ n: 0 });
    expect(
      origin.vault.vault
        .prepare(
          `SELECT b.party_id, s.status FROM share_party_vault_binding b
           JOIN share_commons_member_state s ON s.party_id = b.party_id
          WHERE s.grant_id = ? AND b.vault_id = ?`
        )
        .get(photoGrant.grantId, member.vaultId)
    ).toMatchObject({ party_id: invitedPartyId, status: "invited" });
    await expect(
      pullPeerCommons({
        dial: dialFrom(member, origin),
        route: routeFrom(member, origin),
        stewardVaultId: origin.vaultId,
        memberVaultId: member.vaultId,
        grantId: photoGrant.grantId,
        seat: member.vault,
        acceptInvitation: true,
        now,
      })
    ).resolves.toMatchObject({ state: "current" });
    answerCommonsInvitation({
      seat: member.vault,
      invitationId: invitations[0]!.invitationId,
      memberVaultId: member.vaultId,
      answer: "accept",
      now,
    });
    expect(member.vault.blobs.local.getSync(photo.sha256)).toStrictEqual(
      photo.bytes
    );
    expect(
      origin.gatewayDb.db
        .prepare(
          `SELECT size FROM commons_blob_access
            WHERE grant_id = ? AND member_vault_id = ? AND sha256 = ?`
        )
        .get(photoGrant.grantId, member.vaultId, photo.sha256)
    ).toMatchObject({ size: photo.bytes.length });

    registerTallyCommands(origin.gateway);
    // A Tally group names people, not vault addresses. The link/share
    // ceremony normally materializes this remote party before the group UI
    // submits member_ids; the low-level peer fixture does that explicitly.
    origin.vault.vault
      .prepare(
        `INSERT INTO core_party
           (party_id, kind, display_name, sort_name, birth_date,
            avatar_content_id, created_at, updated_at, ontology_version)
         VALUES (?, 'person', 'Peer member', 'Peer member', NULL, NULL, ?, ?, '1.4')
         ON CONFLICT(party_id) DO NOTHING`
      )
      .run(member.ownerPartyId, now, now);
    const groupOutcome = origin.gateway.invoke(origin.ownerCredential, {
      command: "tally.create_group",
      input: {
        name: "Peer trip",
        icon: "🛰️",
        member_ids: [member.ownerPartyId],
      },
    });
    if (groupOutcome.status !== "executed")
      throw new Error(
        `failed to create group: ${JSON.stringify(groupOutcome)}`
      );
    const groupId = (groupOutcome.output as { group_id: string }).group_id;
    // Force a multi-page metadata frame without adding binary CAS payload.
    // The peer client must resume it by byte cursor before atomically applying.
    origin.vault.vault
      .prepare(
        `UPDATE social_circle SET name = ?
          WHERE circle_id = (SELECT circle_id FROM tally_group WHERE group_id = ?)`
      )
      .run("Peer trip ".padEnd(COMMONS_BOOTSTRAP_PAGE_BYTES * 2, "x"), groupId);
    const tallyGrant = createCommonsGrant({
      origin: origin.vault.vault,
      ownerPartyId: origin.ownerPartyId,
      ownerVaultId: origin.vaultId,
      ownerVault: origin.vault,
      containerType: "tally.group",
      containerId: groupId,
      members: [
        {
          partyId: member.ownerPartyId,
          capability: "read+write",
          vaultId: member.vaultId,
          vaultPublicKey: member.publicKey,
        },
      ],
      now,
    });
    compileCommons({
      steward: origin.vault,
      stewardVaultId: origin.vaultId,
      grantId: tallyGrant.grantId,
      seats: commonsSeats({
        steward: origin.vault.vault,
        grantId: tallyGrant.grantId,
        stewardVaultId: origin.vaultId,
        vaultFor: () => undefined,
      }),
      now,
    });
    const tallyWire = exportCommonsBootstrapForTest({
      steward: origin.vault.vault,
      identitySeed: origin.vault.identitySeed,
      stewardVaultId: origin.vaultId,
      grantId: tallyGrant.grantId,
      memberVaultId: member.vaultId,
    });
    origin.vault.vault
      .prepare(
        `UPDATE share_commons_member_state SET status = 'invited', accepted_at = NULL
          WHERE grant_id = ? AND party_id = ?`
      )
      .run(tallyGrant.grantId, member.ownerPartyId);
    await invitePeerToCommons({
      dial: dialFrom(origin, member),
      route: routeFrom(origin, member),
      wire: tallyWire,
    });
    const tallyInvitation = listCommonsInvitations({
      seat: member.vault.vault,
      memberVaultId: member.vaultId,
    }).find((entry) => entry.grantId === tallyGrant.grantId)!;
    const memberDial = dialFrom(member, origin);
    const memberRoute = routeFrom(member, origin);
    const acceptedFrame = await memberDial.request({
      endpointTicket: memberDial.endpointTicketFor(
        memberRoute.endpointId,
        memberRoute.relayHints
      ),
      method: "GET",
      target: `${PEER_COMMONS_BOOTSTRAP_PATH_PREFIX}${encodeURIComponent(
        tallyGrant.grantId
      )}?${new URLSearchParams({
        stewardVaultId: origin.vaultId,
        memberVaultId: member.vaultId,
        accept: "1",
      })}`,
    });
    expect(acceptedFrame).toMatchObject({ status: 200 });
    const acceptedPage = acceptedFrame.json as {
      state?: string;
      cursor?: number;
      nextCursor?: number | null;
      totalBytes?: number;
      bytes?: string;
    };
    expect(acceptedPage).toMatchObject({
      state: "bootstrap-page",
      cursor: 0,
      nextCursor: COMMONS_BOOTSTRAP_PAGE_BYTES,
    });
    expect(acceptedPage.totalBytes).toBeGreaterThan(
      COMMONS_BOOTSTRAP_PAGE_BYTES
    );
    expect(
      Buffer.from(acceptedPage.bytes ?? "", "base64").length
    ).toBeLessThanOrEqual(COMMONS_BOOTSTRAP_PAGE_BYTES);
    await expect(
      pullPeerCommons({
        dial: memberDial,
        route: memberRoute,
        stewardVaultId: origin.vaultId,
        memberVaultId: member.vaultId,
        grantId: tallyGrant.grantId,
        seat: member.vault,
        now,
      })
    ).resolves.toMatchObject({ state: "current" });
    answerCommonsInvitation({
      seat: member.vault,
      invitationId: tallyInvitation.invitationId,
      memberVaultId: member.vaultId,
      answer: "accept",
      now,
    });
    const commandInput = {
      group_id: groupId,
      description: "Ferry",
      amount_minor: 900,
      paid_by: member.ownerPartyId,
      category: "travel",
      splits: [
        { party_id: origin.ownerPartyId, share_minor: 450 },
        { party_id: member.ownerPartyId, share_minor: 450 },
      ],
    };
    const intentId = "peer-tally-ferry";
    const result = await sendPeerCommonsCommand({
      dial: dialFrom(member, origin),
      route: routeFrom(member, origin),
      stewardVaultId: origin.vaultId,
      memberVaultId: member.vaultId,
      grantId: tallyGrant.grantId,
      actorPartyId: member.ownerPartyId,
      command: "tally.add_expense",
      commandInput,
      memberSignature: signCommonsIntent(member.vault.identitySeed, {
        grantId: tallyGrant.grantId,
        actorPartyId: member.ownerPartyId,
        command: "tally.add_expense",
        commandInput,
        memberVaultId: member.vaultId,
        nonce: intentId,
      }),
      basedOnSequence: readCommonsGrant(member.vault.vault, tallyGrant.grantId)
        .lastSequence,
      intentId,
    });
    expect(result).toMatchObject({ state: "executed" });
    const commandCatchup = await pullPeerCommons({
      dial: dialFrom(member, origin),
      route: routeFrom(member, origin),
      stewardVaultId: origin.vaultId,
      memberVaultId: member.vaultId,
      grantId: tallyGrant.grantId,
      seat: member.vault,
      now,
    });
    expect(commandCatchup).toMatchObject({ state: "current" });
    expect(
      member.vault.vault
        .prepare("SELECT description FROM tally_expense WHERE group_id = ?")
        .get(groupId)
    ).toMatchObject({ description: "Ferry" });

    revokeCommonsGrant({
      steward: origin.vault.vault,
      grantId: tallyGrant.grantId,
      actorPartyId: origin.ownerPartyId,
      now,
    });
    expect(commandCatchup).toMatchObject({ state: "current" });
    await expect(
      pullPeerCommons({
        dial: dialFrom(member, origin),
        route: routeFrom(member, origin),
        stewardVaultId: origin.vaultId,
        memberVaultId: member.vaultId,
        grantId: tallyGrant.grantId,
        seat: member.vault,
        now,
      })
    ).resolves.toMatchObject({ state: "current" });
    expect(
      member.vault.vault
        .prepare("SELECT COUNT(*) AS n FROM tally_group WHERE group_id = ?")
        .get(groupId)
    ).toMatchObject({ n: 0 });
  });

  test("a large blob uses one steward export and bounded member chunks", async () => {
    const origin = makeSide("commons-large-origin");
    const member = makeSide("commons-large-member");
    await link(origin, member);
    const now = new Date().toISOString();
    origin.vault.vault
      .prepare(
        `INSERT INTO core_party
           (party_id, kind, display_name, sort_name, birth_date,
            avatar_content_id, created_at, updated_at, ontology_version)
         VALUES (?, 'person', 'Large member', 'Large member', NULL, NULL, ?, ?, '1.4')`
      )
      .run(member.ownerPartyId, now, now);
    const bytes = Buffer.alloc(6 * 1024 * 1024, 0x61);
    const photo = seedPhoto(origin, "large-stream", bytes);
    const grant = createCommonsGrant({
      origin: origin.vault.vault,
      ownerPartyId: origin.ownerPartyId,
      ownerVaultId: origin.vaultId,
      ownerVault: origin.vault,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [
        {
          partyId: member.ownerPartyId,
          capability: "read",
          vaultId: member.vaultId,
          vaultPublicKey: member.publicKey,
        },
      ],
      now,
    });
    compileCommons({
      steward: origin.vault,
      stewardVaultId: origin.vaultId,
      grantId: grant.grantId,
      seats: commonsSeats({
        steward: origin.vault.vault,
        grantId: grant.grantId,
        stewardVaultId: origin.vaultId,
        vaultFor: () => undefined,
      }),
      now,
    });
    let exportCount = 0;
    let maxChunkBytes = 0;
    let chunkCount = 0;
    const dial = dialFrom(member, origin, {
      onCommonsBootstrapExport: () => {
        exportCount += 1;
      },
    });
    const pulled = await pullPeerCommons({
      dial,
      route: routeFrom(member, origin),
      stewardVaultId: origin.vaultId,
      memberVaultId: member.vaultId,
      grantId: grant.grantId,
      seat: member.vault,
      onBlobChunk: (length) => {
        chunkCount += 1;
        maxChunkBytes = Math.max(maxChunkBytes, length);
      },
      now,
    });

    expect(pulled).toMatchObject({ state: "current" });
    expect(exportCount).toBe(1);
    expect(chunkCount).toBeGreaterThanOrEqual(6);
    expect(maxChunkBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(member.vault.blobs.local.getSync(photo.sha256)).toStrictEqual(bytes);
  });
});
