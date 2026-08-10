/* PR #735 peer-plane commons hardening: the signed-command route must bind the
 * acted-as party to the PROVEN peer (never trust body.actorPartyId), and a
 * fully caught-up member's pull must be a no-op that neither scrubs nor counts
 * as sweep progress. Both cross the real peer routes on two in-process vaults. */

import { describe, expect, test } from "vitest";

import {
  commonsSeats,
  compileCommons,
  createCommonsGrant,
  signCommonsIntent,
} from "@centraid/vault";

import {
  pullPeerCommons,
  sendPeerCommonsCommand,
} from "./peer-commons-client.js";
import {
  dialFrom,
  link,
  makeSide,
  routeFrom,
  seedPhoto,
} from "./peer-give.test-fixtures.js";

describe("commons peer-plane hardening", () => {
  test("a read-only member cannot forge a steward-attributed command by supplying actorPartyId", async () => {
    const origin = makeSide("forge-steward");
    const member = makeSide("forge-member");
    await link(origin, member);
    const now = new Date().toISOString();
    const photo = seedPhoto(origin, "forge");
    const grant = createCommonsGrant({
      origin: origin.vault.vault,
      ownerPartyId: origin.ownerPartyId,
      ownerVaultId: origin.vaultId,
      ownerVault: origin.vault,
      containerType: "media.media_asset",
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
    const commandInput = { asset_id: photo.assetId, title: "forged" };
    // The member signs as the STEWARD's party — a forged attribution that, if
    // honored, would skip capability/signature/replay (those short-circuit when
    // actorPartyId === stewardPartyId).
    const forgery = await sendPeerCommonsCommand({
      dial: dialFrom(member, origin),
      route: routeFrom(member, origin),
      stewardVaultId: origin.vaultId,
      memberVaultId: member.vaultId,
      grantId: grant.grantId,
      actorPartyId: origin.ownerPartyId,
      command: "media.update_asset",
      commandInput,
      memberSignature: signCommonsIntent(member.vault.identitySeed, {
        grantId: grant.grantId,
        actorPartyId: origin.ownerPartyId,
        command: "media.update_asset",
        commandInput,
        memberVaultId: member.vaultId,
        nonce: "forge-nonce",
      }),
      intentId: "forge-nonce",
    });
    // The route refuses to resolve the caller as the steward: nothing executes,
    // and no steward-attributed op is written to the log.
    expect(forgery.state).toBe("unavailable");
    expect(
      origin.vault.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM share_commons_op WHERE grant_id = ? AND actor_party_id = ?"
        )
        .get(grant.grantId, origin.ownerPartyId)
    ).toMatchObject({ n: 0 });

    // The same member acting honestly as ITSELF reaches the steward and is
    // refused on capability — proving the block above was the forgery, not the
    // transport.
    const honest = await sendPeerCommonsCommand({
      dial: dialFrom(member, origin),
      route: routeFrom(member, origin),
      stewardVaultId: origin.vaultId,
      memberVaultId: member.vaultId,
      grantId: grant.grantId,
      actorPartyId: member.ownerPartyId,
      command: "media.update_asset",
      commandInput,
      memberSignature: signCommonsIntent(member.vault.identitySeed, {
        grantId: grant.grantId,
        actorPartyId: member.ownerPartyId,
        command: "media.update_asset",
        commandInput,
        memberVaultId: member.vaultId,
        nonce: "honest-nonce",
      }),
      intentId: "honest-nonce",
    });
    expect(honest).toMatchObject({
      state: "refused",
      reason: "this commons is read-only for this member",
    });
    expect(
      origin.vault.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM share_commons_op WHERE grant_id = ? AND actor_party_id = ?"
        )
        .get(grant.grantId, member.ownerPartyId)
    ).toMatchObject({ n: 1 });
  });

  test("a fully caught-up member's repeated pull is a no-op, not a scrub-and-reproject", async () => {
    const origin = makeSide("noop-steward");
    const member = makeSide("noop-member");
    await link(origin, member);
    const now = new Date().toISOString();
    const photo = seedPhoto(origin, "noop");
    const grant = createCommonsGrant({
      origin: origin.vault.vault,
      ownerPartyId: origin.ownerPartyId,
      ownerVaultId: origin.vaultId,
      ownerVault: origin.vault,
      containerType: "media.media_asset",
      containerId: photo.assetId,
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
      grantId: grant.grantId,
      seats: commonsSeats({
        steward: origin.vault.vault,
        grantId: grant.grantId,
        stewardVaultId: origin.vaultId,
        vaultFor: () => undefined,
      }),
      now,
    });
    // First pull is a real bootstrap that lands the closure.
    const first = await pullPeerCommons({
      dial: dialFrom(member, origin),
      route: routeFrom(member, origin),
      stewardVaultId: origin.vaultId,
      memberVaultId: member.vaultId,
      grantId: grant.grantId,
      seat: member.vault,
      now,
    });
    expect(first.state).toBe("current");
    expect(
      member.vault.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM media_media_asset WHERE asset_id = ?"
        )
        .get(photo.assetId)
    ).toMatchObject({ n: 1 });

    // A second pull, now fully caught up, must be a no-op: it neither ships nor
    // re-applies the closure, and it must NOT count as sweep progress.
    const second = await pullPeerCommons({
      dial: dialFrom(member, origin),
      route: routeFrom(member, origin),
      stewardVaultId: origin.vaultId,
      memberVaultId: member.vaultId,
      grantId: grant.grantId,
      seat: member.vault,
      now,
    });
    expect(second.state).toBe("noop");
    expect(
      member.vault.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM media_media_asset WHERE asset_id = ?"
        )
        .get(photo.assetId)
    ).toMatchObject({ n: 1 });
  });
});
