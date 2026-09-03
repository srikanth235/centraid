import { describe, expect, test } from "vitest";

import {
  answerCommonsInvitation,
  commonsSeats,
  compileCommons,
  createCommonsClaimInvitation,
  createCommonsGrant,
  executeCommonsCommand,
  exportCommonsBootstrap,
  listCommonsInvitations,
  readCommonsGrant,
  registerDocumentCommands,
  retainCommonsItem,
  revokeCommonsGrant,
  scrubCommonsSeat,
  signCommonsIntent,
  uuidv7,
} from "@centraid/vault";

import { addKnownParty, documentRows } from "./commons-b6.test-fixtures.js";
import {
  claimPeerCommonsInvitation,
  invitePeerToCommons,
  pullPeerCommons,
  sendPeerCommonsCommand,
} from "./peer-commons-client.js";
import {
  dialFrom,
  link,
  makeCoHostedSides,
  makeSide,
  routeFrom,
} from "./peer-give.test-fixtures.js";
import type { Side } from "./peer-give.test-fixtures.js";

describe("B6 Docs folder Commons across a real peer", () => {
  test("a pre-install invite claims over an approved link, mixed writes converge, unshare scrubs, Save and re-invite survive", async () => {
    const [origin, reader] = makeCoHostedSides(
      "docs-b6-local-host",
      "docs-b6-origin",
      "docs-b6-reader"
    );
    const now = new Date().toISOString();
    addKnownParty(origin, reader, now);
    registerDocumentCommands(origin.gateway);
    registerDocumentCommands(reader.gateway);
    const invokeOrigin = (
      command: string,
      input: Record<string, unknown>
    ): Record<string, unknown> => {
      const outcome = origin.gateway.invoke(origin.ownerCredential, {
        command,
        input,
      });
      if (outcome.status !== "executed")
        throw new Error(`${command} failed: ${JSON.stringify(outcome)}`);
      return outcome.output as Record<string, unknown>;
    };
    const trip = (
      invokeOrigin("core.create_folder", { name: "Trip" }) as {
        folder_id: string;
      }
    ).folder_id;
    const bookings = (
      invokeOrigin("core.create_folder", {
        name: "Bookings",
        parent_folder_id: trip,
      }) as { folder_id: string }
    ).folder_id;
    const initial = invokeOrigin("core.add_document", {
      folder_id: bookings,
      title: "Train ticket",
      data_uri: "data:text/plain,train-ticket",
    }) as { document_id: string; content_id: string };

    const invitedPartyId = "party-docs-writer-before-install";
    const grant = createCommonsGrant({
      origin: origin.vault.vault,
      ownerPartyId: origin.ownerPartyId,
      ownerVaultId: origin.vaultId,
      ownerVault: origin.vault,
      containerType: "docs.folder",
      containerId: trip,
      members: [
        { partyId: invitedPartyId, capability: "read+write" },
        {
          partyId: reader.ownerPartyId,
          capability: "read",
          vaultId: reader.vaultId,
          vault: reader.vault,
        },
      ],
      now,
    });
    const originSeats = (grantId = grant.grantId) =>
      commonsSeats({
        steward: origin.vault.vault,
        grantId,
        stewardVaultId: origin.vaultId,
        vaultFor: (vaultId) =>
          vaultId === origin.vaultId
            ? origin.vault
            : vaultId === reader.vaultId
              ? reader.vault
              : undefined,
      });
    const compileOrigin = (grantId = grant.grantId) =>
      compileCommons({
        steward: origin.vault,
        stewardVaultId: origin.vaultId,
        grantId,
        seats: originSeats(grantId),
        now,
      });
    compileOrigin();
    const readerWire = exportCommonsBootstrap({
      steward: origin.vault.vault,
      identitySeed: origin.vault.identitySeed,
      stewardVaultId: origin.vaultId,
      grantId: grant.grantId,
      memberVaultId: reader.vaultId,
    });
    const claim = createCommonsClaimInvitation({
      seat: origin.vault.vault,
      invitation: {
        grantId: grant.grantId,
        stewardVaultId: origin.vaultId,
        memberPartyId: invitedPartyId,
        capability: "read+write",
        containerType: "docs.folder",
        containerId: trip,
        containerLabel: "Trip",
        currentSizeBytes: readerWire.closure.blobs.reduce(
          (sum, blob) => sum + blob.size,
          0
        ),
      },
      now,
    });
    expect(
      origin.vault.vault
        .prepare(
          "SELECT member_vault_id FROM share_commons_invitation WHERE invitation_id = ?"
        )
        .get(claim.invitation.invitationId)
    ).toMatchObject({ member_vault_id: null });

    const writer = makeSide("docs-b6-writer-after-install");
    registerDocumentCommands(writer.gateway);
    await link(origin, writer);
    await expect(
      claimPeerCommonsInvitation({
        dial: dialFrom(writer, origin),
        route: routeFrom(writer, origin),
        stewardVaultId: origin.vaultId,
        memberVaultId: writer.vaultId,
        claimToken: claim.claimToken,
        seat: writer.vault,
        now,
      })
    ).resolves.toBe(true);
    expect(documentRows(writer.vault, trip)).toStrictEqual([]);
    const pending = listCommonsInvitations({
      seat: writer.vault.vault,
      memberVaultId: writer.vaultId,
    })[0]!;
    expect(pending).toMatchObject({
      status: "pending",
      currentSizeBytes: claim.invitation.currentSizeBytes,
    });
    await pullFrom(writer, origin, grant.grantId, now, true);
    answerCommonsInvitation({
      seat: writer.vault,
      invitationId: pending.invitationId,
      memberVaultId: writer.vaultId,
      answer: "accept",
      now,
    });

    const later = invokeOrigin("core.add_document", {
      folder_id: bookings,
      title: "Hotel receipt",
      data_uri: `data:application/pdf;base64,${Buffer.from(
        "hotel-receipt-peer-bytes"
      ).toString("base64")}`,
    }) as { document_id: string; content_id: string };
    compileOrigin();
    await pullFrom(writer, origin, grant.grantId, now);
    const expectedAfterFollow = ["Hotel receipt", "Train ticket"];
    for (const seat of [origin, reader, writer])
      expect(
        documentRows(seat.vault, trip).map((row) => row.title)
      ).toStrictEqual(expectedAfterFollow);
    const laterSha = documentRows(writer.vault, trip).find(
      (row) => row.document_id === later.document_id
    )!.sha256;
    expect(writer.vault.blobs.local.hasSync(laterSha)).toBe(true);

    const writerInput = {
      folder_id: bookings,
      title: "Writer itinerary",
      data_uri: `data:application/pdf;base64,${Buffer.from(
        "writer-itinerary-peer-bytes"
      ).toString("base64")}`,
    };
    await expect(
      sendWriter(
        writer,
        origin,
        grant.grantId,
        invitedPartyId,
        "core.add_document",
        writerInput,
        "peer-docs-writer-add"
      )
    ).resolves.toMatchObject({ state: "executed" });
    compileOrigin();
    await pullFrom(writer, origin, grant.grantId, now);
    for (const seat of [origin, reader, writer])
      expect(
        documentRows(seat.vault, trip).some(
          (row) => row.title === "Writer itinerary"
        )
      ).toBe(true);

    const readerInput = {
      folder_id: bookings,
      title: "Reader must not add",
      data_uri: "data:text/plain,reader-refused-peer",
    };
    const readerNonce = "peer-docs-reader-refused";
    const readerRefusal = executeCommonsCommand({
      steward: origin.vault,
      gateway: origin.gateway,
      credential: origin.ownerCredential,
      stewardVaultId: origin.vaultId,
      grantId: grant.grantId,
      actorPartyId: reader.ownerPartyId,
      command: "core.add_document",
      commandInput: readerInput,
      memberSignature: signCommonsIntent(reader.vault.identitySeed, {
        grantId: grant.grantId,
        actorPartyId: reader.ownerPartyId,
        command: "core.add_document",
        commandInput: readerInput,
        memberVaultId: reader.vaultId,
        nonce: readerNonce,
      }),
      intentId: readerNonce,
      invocationId: readerNonce,
      seats: originSeats(),
      now,
    });
    expect(readerRefusal.decision).toMatchObject({
      accepted: false,
      reason: "this commons is read-only for this member",
    });

    reader.vault.vault
      .prepare(
        `INSERT INTO core_content_derivative
           (derivative_id, content_id, variant, sha256, media_type,
            byte_size, text_content, created_at)
         VALUES (?, ?, 'text', NULL, 'text/plain', 25,
                 'peeronlyunsharedneedle', ?)`
      )
      .run(uuidv7(), initial.content_id, now);
    expect(ftsCount(reader, "peeronlyunsharedneedle")).toBe(1);
    expect(
      retainCommonsItem({
        seat: writer.vault.vault,
        itemType: "docs.folder",
        itemId: trip,
        now,
      })
    ).toMatchObject({ retained: true, grantIds: [grant.grantId] });
    await pullFrom(writer, origin, grant.grantId, now);
    revokeCommonsGrant({
      steward: origin.vault.vault,
      grantId: grant.grantId,
      actorPartyId: origin.ownerPartyId,
      now,
    });
    await pullFrom(writer, origin, grant.grantId, now);
    scrubCommonsSeat({ seat: reader.vault, grantId: grant.grantId });
    expect(documentRows(reader.vault, trip)).toStrictEqual([]);
    expect(ftsCount(reader, "peeronlyunsharedneedle")).toBe(0);
    expect(
      reader.vault.vault
        .prepare("SELECT COUNT(*) AS n FROM core_content_derivative")
        .get()
    ).toMatchObject({ n: 0 });
    expect(documentRows(writer.vault, trip).length).toBeGreaterThan(0);
    expect(
      writer.vault.vault
        .prepare("SELECT COUNT(*) AS n FROM core_concept WHERE concept_id = ?")
        .get(trip)
    ).toMatchObject({ n: 1 });

    const reinvite = createCommonsGrant({
      origin: origin.vault.vault,
      ownerPartyId: origin.ownerPartyId,
      ownerVaultId: origin.vaultId,
      ownerVault: origin.vault,
      circleName: "Trip peer re-invite",
      containerType: "docs.folder",
      containerId: trip,
      members: [
        {
          partyId: reader.ownerPartyId,
          capability: "read",
          vaultId: reader.vaultId,
          vault: reader.vault,
        },
        {
          partyId: invitedPartyId,
          capability: "read+write",
          vaultId: writer.vaultId,
          vaultPublicKey: writer.publicKey,
        },
      ],
      now,
    });
    compileOrigin(reinvite.grantId);
    const reinviteWire = exportCommonsBootstrap({
      steward: origin.vault.vault,
      identitySeed: origin.vault.identitySeed,
      stewardVaultId: origin.vaultId,
      grantId: reinvite.grantId,
      memberVaultId: writer.vaultId,
    });
    origin.vault.vault
      .prepare(
        `UPDATE share_commons_member_state SET status = 'invited', accepted_at = NULL
          WHERE grant_id = ? AND party_id = ?`
      )
      .run(reinvite.grantId, invitedPartyId);
    await expect(
      invitePeerToCommons({
        dial: dialFrom(origin, writer),
        route: routeFrom(origin, writer),
        wire: reinviteWire,
      })
    ).resolves.toBe(true);
    const pendingReinvite = listCommonsInvitations({
      seat: writer.vault.vault,
      memberVaultId: writer.vaultId,
    }).find(
      (invitation) =>
        invitation.grantId === reinvite.grantId &&
        invitation.status === "pending"
    )!;
    await pullFrom(writer, origin, reinvite.grantId, now, true);
    answerCommonsInvitation({
      seat: writer.vault,
      invitationId: pendingReinvite.invitationId,
      memberVaultId: writer.vaultId,
      answer: "accept",
      now,
    });
    expect(documentRows(reader.vault, trip).length).toBeGreaterThan(0);
    expect(documentRows(writer.vault, trip).length).toBeGreaterThan(0);
  });
});

async function sendWriter(
  writer: Side,
  origin: Side,
  grantId: string,
  actorPartyId: string,
  command: string,
  commandInput: Record<string, unknown>,
  intentId: string
) {
  return sendPeerCommonsCommand({
    dial: dialFrom(writer, origin),
    route: routeFrom(writer, origin),
    stewardVaultId: origin.vaultId,
    memberVaultId: writer.vaultId,
    grantId,
    actorPartyId,
    command,
    commandInput,
    memberSignature: signCommonsIntent(writer.vault.identitySeed, {
      grantId,
      actorPartyId,
      command,
      commandInput,
      memberVaultId: writer.vaultId,
      nonce: intentId,
    }),
    basedOnSequence: readCommonsGrant(writer.vault.vault, grantId).lastSequence,
    intentId,
  });
}

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

function ftsCount(side: Side, query: string): number {
  return (
    side.vault.vault
      .prepare(
        "SELECT COUNT(*) AS n FROM fts_core_document WHERE fts_core_document MATCH ?"
      )
      .get(query) as { n: number }
  ).n;
}
