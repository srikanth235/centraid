import http from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, test } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";
import {
  commonsCurrentSize,
  createCommonsClaimInvitation,
  createCommonsGrant,
  listCommonsInvitations,
  queueCommonsInvitation,
  upsertCommonsMember,
} from "@centraid/vault";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import {
  makeCoHostedSides,
  seedPhoto,
} from "../serve/peer-give.test-fixtures.js";
import {
  COMMONS_PATH,
  isCommonsContainerType,
  makeCommonsRouteHandler,
} from "./commons-routes.js";

describe("Commons container registry", () => {
  test("matches shipped placement containers and refuses Locker structurally", () => {
    expect(isCommonsContainerType("docs.folder")).toBe(true);
    expect(isCommonsContainerType("tally.group")).toBe(true);
    expect(isCommonsContainerType("locker.item")).toBe(false);
    expect(isCommonsContainerType("unknown.container")).toBe(false);
  });

  test("same-machine claim requires an approved link without burning the token", async () => {
    const [steward, member] = makeCoHostedSides(
      "commons-local-claim",
      "steward",
      "member"
    );
    const now = new Date().toISOString();
    const photo = seedPhoto(steward, "claim-gate");
    const invitedPartyId = "party-invited-before-local-vault";
    const grant = createCommonsGrant({
      origin: steward.vault.vault,
      ownerPartyId: steward.ownerPartyId,
      ownerVaultId: steward.vaultId,
      ownerVault: steward.vault,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [{ partyId: invitedPartyId, capability: "read" }],
      now,
    });
    const initialSize = commonsCurrentSize(
      steward.vault.vault,
      steward.vaultId,
      grant.grantId
    );
    const claim = createCommonsClaimInvitation({
      seat: steward.vault.vault,
      invitation: {
        grantId: grant.grantId,
        stewardVaultId: steward.vaultId,
        memberPartyId: invitedPartyId,
        capability: "read",
        containerType: "media.asset",
        containerId: photo.assetId,
        currentSizeBytes: initialSize,
      },
      now,
    });
    const sides = new Map([
      [steward.vaultId, steward],
      [member.vaultId, member],
    ]);
    const handler = makeCommonsRouteHandler({
      enrollments: EnrollmentStore.open(steward.gatewayDb),
      vaultFor: (vaultId) => sides.get(vaultId)?.vault,
      ownerPartyFor: (vaultId) => sides.get(vaultId)?.ownerPartyId,
      gatewayFor: (vaultId) => sides.get(vaultId)?.gateway,
      credentialFor: (vaultId) => sides.get(vaultId)?.ownerCredential,
      vaultPublicKeyFor: (vaultId) => sides.get(vaultId)?.publicKey,
      linkedVaultPublicKey: (localVaultId, peerVaultId) => {
        const link = steward.links.findPair(localVaultId, peerVaultId);
        if (!link || !link.approvedByA || !link.approvedByB) return undefined;
        return steward.links.directoryEntry(peerVaultId)?.publicKey;
      },
    });
    const server = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const claimRequest = () =>
      fetch(`http://127.0.0.1:${port}${COMMONS_PATH}/invitations/claim`, {
        method: "POST",
        headers: {
          [AUTHED_DEVICE_HEADER]: member.deviceId,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          actorVaultId: member.vaultId,
          stewardVaultId: steward.vaultId,
          claimToken: claim.claimToken,
        }),
      });
    try {
      const refused = await claimRequest();
      expect(refused.status).toBe(400);
      await expect(refused.json()).resolves.toMatchObject({
        message: "commons invitation claim requires an approved vault link",
      });
      expect(
        steward.vault.vault
          .prepare(
            "SELECT COUNT(*) AS n FROM share_commons_invitation WHERE invitation_id = ? AND claim_token_hash IS NOT NULL"
          )
          .get(claim.invitation.invitationId)
      ).toMatchObject({ n: 1 });

      const link = steward.links.propose({
        fromVaultId: steward.vaultId,
        fromPublicKey: steward.publicKey,
        fromPartyId: steward.ownerPartyId,
        toVaultId: member.vaultId,
        toPublicKey: member.publicKey,
        toPartyId: member.ownerPartyId,
      });
      steward.links.approve(link.linkId, member.vaultId);
      const accepted = await claimRequest();
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toStrictEqual({ claimed: true });
      expect(
        steward.vault.vault
          .prepare(
            "SELECT party_id FROM share_party_vault_binding WHERE vault_id = ? AND revoked_at IS NULL"
          )
          .get(member.vaultId)
      ).toMatchObject({ party_id: invitedPartyId });
      const [pending] = listCommonsInvitations({
        seat: member.vault.vault,
        memberVaultId: member.vaultId,
      });
      expect(pending).toStrictEqual(
        expect.objectContaining({
          grantId: grant.grantId,
          memberPartyId: invitedPartyId,
          status: "pending",
          currentSizeBytes: initialSize,
        })
      );
      expect(
        member.vault.vault
          .prepare("SELECT COUNT(*) AS n FROM media_asset")
          .get()
      ).toMatchObject({ n: 0 });

      steward.vault.vault
        .prepare(
          `UPDATE core_content_item
              SET title = 'A much longer title after invitation'
            WHERE content_id = (
              SELECT content_id FROM media_asset WHERE asset_id = ?
            )`
        )
        .run(photo.assetId);
      const answer = () =>
        fetch(
          `http://127.0.0.1:${port}${COMMONS_PATH}/invitations/${encodeURIComponent(
            pending!.invitationId
          )}/answer`,
          {
            method: "POST",
            headers: {
              [AUTHED_DEVICE_HEADER]: member.deviceId,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              actorVaultId: member.vaultId,
              answer: "accept",
            }),
          }
        );
      const stale = await answer();
      expect(stale.status).toBe(400);
      await expect(stale.json()).resolves.toMatchObject({
        message: expect.stringContaining("review the invitation again"),
      });
      const [refreshed] = listCommonsInvitations({
        seat: member.vault.vault,
        memberVaultId: member.vaultId,
      });
      expect(refreshed).toMatchObject({ status: "pending" });
      expect(refreshed!.currentSizeBytes).toBeGreaterThan(initialSize);
      const acceptedAnswer = await answer();
      expect(acceptedAnswer.status).toBe(200);
      await expect(acceptedAnswer.json()).resolves.toMatchObject({
        invitation: { status: "accepted" },
      });
      expect(
        member.vault.vault
          .prepare("SELECT COUNT(*) AS n FROM media_asset")
          .get()
      ).toMatchObject({ n: 1 });
      const resident = async (vaultId: string, deviceId: string) => {
        const response = await fetch(
          `http://127.0.0.1:${port}${COMMONS_PATH}/resident?actorVaultId=${encodeURIComponent(
            vaultId
          )}`,
          { headers: { [AUTHED_DEVICE_HEADER]: deviceId } }
        );
        expect(response.status).toBe(200);
        return (await response.json()) as { items: unknown[] };
      };
      await expect(
        resident(member.vaultId, member.deviceId)
      ).resolves.toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({
            grantId: grant.grantId,
            itemType: "media.asset",
            itemId: photo.assetId,
          }),
        ]),
      });
      await expect(
        resident(steward.vaultId, steward.deviceId)
      ).resolves.toStrictEqual({ items: [] });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  test("local refusal settles steward truth and a deliberate reinvite reopens consent", async () => {
    const [steward, member] = makeCoHostedSides(
      "commons-local-refusal",
      "steward",
      "member"
    );
    const now = new Date().toISOString();
    const photo = seedPhoto(steward, "refusal");
    const grant = createCommonsGrant({
      origin: steward.vault.vault,
      ownerPartyId: steward.ownerPartyId,
      ownerVaultId: steward.vaultId,
      ownerVault: steward.vault,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [{ partyId: member.ownerPartyId, capability: "read" }],
      now,
    });
    const invitationBase = {
      grantId: grant.grantId,
      stewardVaultId: steward.vaultId,
      memberVaultId: member.vaultId,
      memberPartyId: member.ownerPartyId,
      capability: "read" as const,
      containerType: "media.asset",
      containerId: photo.assetId,
      currentSizeBytes: commonsCurrentSize(
        steward.vault.vault,
        steward.vaultId,
        grant.grantId
      ),
    };
    const first = queueCommonsInvitation({
      seat: member.vault.vault,
      invitation: invitationBase,
      now,
    });
    const sides = new Map([
      [steward.vaultId, steward],
      [member.vaultId, member],
    ]);
    const handler = makeCommonsRouteHandler({
      enrollments: EnrollmentStore.open(steward.gatewayDb),
      vaultFor: (vaultId) => sides.get(vaultId)?.vault,
      ownerPartyFor: (vaultId) => sides.get(vaultId)?.ownerPartyId,
      gatewayFor: (vaultId) => sides.get(vaultId)?.gateway,
      credentialFor: (vaultId) => sides.get(vaultId)?.ownerCredential,
    });
    const server = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const answer = (invitationId: string, value: "accept" | "refuse") =>
      fetch(
        `http://127.0.0.1:${port}${COMMONS_PATH}/invitations/${encodeURIComponent(
          invitationId
        )}/answer`,
        {
          method: "POST",
          headers: {
            [AUTHED_DEVICE_HEADER]: member.deviceId,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            actorVaultId: member.vaultId,
            answer: value,
          }),
        }
      );
    try {
      const refused = await answer(first.invitationId, "refuse");
      expect(refused.status).toBe(200);
      expect(
        steward.vault.vault
          .prepare(
            "SELECT status FROM share_commons_member_state WHERE grant_id = ? AND party_id = ?"
          )
          .get(grant.grantId, member.ownerPartyId)
      ).toMatchObject({ status: "refused" });
      expect(
        steward.vault.vault
          .prepare(
            "SELECT kind, actor_party_id FROM share_commons_op WHERE grant_id = ? ORDER BY sequence DESC LIMIT 1"
          )
          .get(grant.grantId)
      ).toMatchObject({
        kind: "member_refused",
        actor_party_id: member.ownerPartyId,
      });
      expect(
        member.vault.vault
          .prepare("SELECT COUNT(*) AS n FROM media_asset")
          .get()
      ).toMatchObject({ n: 0 });

      upsertCommonsMember({
        steward: steward.vault.vault,
        grantId: grant.grantId,
        actorPartyId: steward.ownerPartyId,
        member: { partyId: member.ownerPartyId, capability: "read" },
        now: new Date().toISOString(),
      });
      const second = queueCommonsInvitation({
        seat: member.vault.vault,
        invitation: invitationBase,
        now: new Date().toISOString(),
      });
      expect(second.status).toBe("pending");
      expect(second.invitationId).not.toBe(first.invitationId);
      const accepted = await answer(second.invitationId, "accept");
      expect(accepted.status).toBe(200);
      expect(
        member.vault.vault
          .prepare("SELECT COUNT(*) AS n FROM media_asset")
          .get()
      ).toMatchObject({ n: 1 });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});
