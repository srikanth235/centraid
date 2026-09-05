import { afterEach, describe, expect, test } from "vitest";

import { registerPartyCommands } from "../commands/parties.js";
import { createGateway } from "../gateway/gateway.js";
import { nowIso, uuidv7 } from "../ids.js";
import {
  closeOpenVaults,
  household,
  seedPhoto,
} from "../share/placement-fixture.js";
import { channelForParty } from "./channel.js";
import {
  fulfillShareGrant,
  propagateShareGrantRevocation,
} from "./fulfillment.js";
import {
  addParty,
  addToAlbum,
  audienceTitles,
  AUDIENCE_VAULT,
  linkVault,
  ORIGIN_VAULT,
  seedAlbum,
} from "./fulfillment.test-fixtures.js";
import {
  createShareGrant,
  listFulfillment,
  listShareGrantsForSubject,
  readFulfillment,
  revokeShareGrant,
} from "./grant-store.js";

describe("grant/fulfillment", () => {
  afterEach(closeOpenVaults);

  test("share, deliver, follow an origin edit, revoke, and remove", () => {
    const home = household();
    const now = nowIso();
    const ravi = addParty(home.origin.vault, "Ravi", now);
    linkVault(home.origin.vault, ravi, AUDIENCE_VAULT, now);
    const { albumId, first } = seedAlbum(home, now);
    const seatFor = (vaultId: string) =>
      vaultId === AUDIENCE_VAULT ? home.audience : undefined;

    const grant = createShareGrant(home.origin.vault, {
      audience: { kind: "party", id: ravi },
      subjectType: "core.collection",
      subjectId: albumId,
      capability: "view",
      grantedAt: now,
      grantedBy: home.originBoot.ownerPartyId,
    });

    const delivered = fulfillShareGrant({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor,
      now,
    });
    expect(delivered.steps).toHaveLength(1);
    expect(delivered.steps[0]).toMatchObject({
      partyId: ravi,
      state: "delivered",
      peerVaultId: AUDIENCE_VAULT,
    });
    expect(delivered.steps[0]?.projected).toHaveLength(1);
    expect(
      readFulfillment(home.origin.vault, grant.grantId, AUDIENCE_VAULT)
      // `updated_at` is the touch trigger's since #916.
    ).toMatchObject({ state: "delivered", detail: null });
    expect(audienceTitles(home.audience.vault)).toStrictEqual(["Photo a"]);

    // The origin edits the caption. Divergence is a bug, not the resting
    // state: the next pass re-projects and the audience replica follows.
    const later = "2026-08-19T10:00:00.000Z";
    home.origin.vault
      .prepare("UPDATE core_content_item SET title = ? WHERE content_id = ?")
      .run("Sunset at last", first.contentId);
    fulfillShareGrant({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor,
      now: later,
    });
    expect(audienceTitles(home.audience.vault)).toStrictEqual([
      "Sunset at last",
    ]);

    // Revoke: the grant row is dated, then the removal is carried out.
    const revokedAt = "2026-08-19T11:00:00.000Z";
    expect(
      revokeShareGrant(home.origin.vault, {
        grantId: grant.grantId,
        revokedAt,
      }).outcome
    ).toBe("revoked");
    const removal = propagateShareGrantRevocation({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor,
      now: revokedAt,
    });
    expect(removal.steps).toStrictEqual([
      { peerVaultId: AUDIENCE_VAULT, state: "removed", removed: true },
    ]);
    expect(
      readFulfillment(home.origin.vault, grant.grantId, AUDIENCE_VAULT)
    ).toMatchObject({ state: "removed" });
    // Hard delete: no projection, no lineage row, no tombstone of any kind.
    expect(audienceTitles(home.audience.vault)).toStrictEqual([]);
    expect(
      home.audience.vault
        .prepare("SELECT COUNT(*) AS n FROM core_collection")
        .get()
    ).toMatchObject({ n: 0 });
    expect(
      home.audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
    ).toMatchObject({ n: 0 });
    expect(
      home.audience.vault
        .prepare("SELECT COUNT(*) AS n FROM core_share_origin")
        .get()
    ).toMatchObject({ n: 0 });

    // A revoked grant is never fulfilled again.
    expect(() =>
      fulfillShareGrant({
        origin: home.origin,
        originVaultId: ORIGIN_VAULT,
        grantId: grant.grantId,
        seatFor,
        now: revokedAt,
      })
    ).toThrow("is revoked");
  });

  test("a container grant is membership, not a snapshot", () => {
    const home = household();
    const now = nowIso();
    const ravi = addParty(home.origin.vault, "Ravi", now);
    linkVault(home.origin.vault, ravi, AUDIENCE_VAULT, now);
    const { albumId } = seedAlbum(home, now);
    const seatFor = (vaultId: string) =>
      vaultId === AUDIENCE_VAULT ? home.audience : undefined;

    const grant = createShareGrant(home.origin.vault, {
      audience: { kind: "party", id: ravi },
      subjectType: "core.collection",
      subjectId: albumId,
      capability: "view",
      grantedAt: now,
      grantedBy: home.originBoot.ownerPartyId,
    });
    fulfillShareGrant({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor,
      now,
    });
    expect(audienceTitles(home.audience.vault)).toStrictEqual(["Photo a"]);

    // A photograph added to the album AFTER the grant. No second grant, no
    // second act — the next pass carries it because it is now in the closure.
    const later = "2026-08-19T12:00:00.000Z";
    const second = seedPhoto(home.origin, home.originBoot, "b");
    addToAlbum(home, albumId, second.assetId, 1, later);
    fulfillShareGrant({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor,
      now: later,
    });
    expect(audienceTitles(home.audience.vault)).toStrictEqual([
      "Photo a",
      "Photo b",
    ]);
    expect(
      listShareGrantsForSubject(home.origin.vault, "core.collection", albumId)
    ).toHaveLength(1);
  });

  test("a grant to an unlinked person parks with nothing minted, and delivers once the link is made", () => {
    const home = household();
    const now = nowIso();
    const nila = addParty(home.origin.vault, "Nila", now);
    const { albumId } = seedAlbum(home, now);

    const grant = createShareGrant(home.origin.vault, {
      audience: { kind: "party", id: nila },
      subjectType: "core.collection",
      subjectId: albumId,
      capability: "view",
      grantedAt: now,
      grantedBy: home.originBoot.ownerPartyId,
    });
    expect(channelForParty(home.origin.vault, nila)).toBeNull();

    const parked = fulfillShareGrant({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor: () => undefined,
      now,
    });
    expect(parked.steps[0]).toMatchObject({
      partyId: nila,
      state: "awaiting_channel",
      detail:
        "they have no linked account, so there is no vault to deliver into",
    });
    // No vault to key a row by, so there is none — absence means never linked.
    expect(parked.steps[0]?.peerVaultId).toBeUndefined();
    expect(listFulfillment(home.origin.vault, grant.grantId)).toStrictEqual([]);
    // Sharing no longer opens a channel of its own (#903): an unlinked party
    // stays unlinked, and NOTHING is minted in the member's name.
    expect(channelForParty(home.origin.vault, nila)).toBeNull();
    expect(
      home.origin.vault
        .prepare(
          `SELECT COUNT(*) AS n FROM share_commons_invitation WHERE grant_id = ?`
        )
        .get(grant.grantId)
    ).toMatchObject({ n: 0 });

    // The pass is idempotent: it parks again and still mints nothing.
    const again = fulfillShareGrant({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor: () => undefined,
      now,
    });
    expect(again.steps[0]).toMatchObject({ state: "awaiting_channel" });

    // The link ceremony opens the channel, and the SAME grant delivers with
    // no re-granting — which is what keeps a circle's unlinked member a
    // delivery question rather than a reason to refuse the grant.
    const later = "2026-08-19T13:00:00.000Z";
    linkVault(home.origin.vault, nila, AUDIENCE_VAULT, later);
    const delivered = fulfillShareGrant({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor: (vaultId) =>
        vaultId === AUDIENCE_VAULT ? home.audience : undefined,
      now: later,
    });
    expect(delivered.steps[0]).toMatchObject({
      state: "delivered",
      peerVaultId: AUDIENCE_VAULT,
    });
    expect(audienceTitles(home.audience.vault)).toStrictEqual(["Photo a"]);
  });

  test("an unreachable peer stops at remove_sent and says so", () => {
    const home = household();
    const now = nowIso();
    const ravi = addParty(home.origin.vault, "Ravi", now);
    linkVault(home.origin.vault, ravi, AUDIENCE_VAULT, now);
    const { albumId } = seedAlbum(home, now);
    const grant = createShareGrant(home.origin.vault, {
      audience: { kind: "party", id: ravi },
      subjectType: "core.collection",
      subjectId: albumId,
      capability: "view",
      grantedAt: now,
      grantedBy: home.originBoot.ownerPartyId,
    });
    fulfillShareGrant({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor: (vaultId) =>
        vaultId === AUDIENCE_VAULT ? home.audience : undefined,
      now,
    });

    const revokedAt = "2026-08-19T14:00:00.000Z";
    revokeShareGrant(home.origin.vault, { grantId: grant.grantId, revokedAt });
    const removal = propagateShareGrantRevocation({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor: () => undefined,
      now: revokedAt,
    });
    expect(removal.steps[0]).toMatchObject({
      peerVaultId: AUDIENCE_VAULT,
      state: "remove_sent",
      detail: `removal sent to ${AUDIENCE_VAULT}; the peer has not acknowledged it`,
    });
    // Honest, not optimistic: the peer still holds the copy, and the state
    // never advances to `removed` without a real deletion.
    expect(audienceTitles(home.audience.vault)).toStrictEqual(["Photo a"]);
    expect(
      readFulfillment(home.origin.vault, grant.grantId, AUDIENCE_VAULT)
    ).toMatchObject({ state: "remove_sent" });
  });

  test("revoking a never-delivered grant removes nothing and says so", () => {
    const home = household();
    const now = nowIso();
    const dev = addParty(home.origin.vault, "Dev", now);
    // A severed channel: the peer vault is known and the binding is revoked,
    // which is the one way `awaiting_channel` is still reached (#903).
    home.origin.vault
      .prepare(
        `INSERT INTO share_party_vault_binding
           (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
         VALUES (?, ?, ?, NULL, ?, ?)`
      )
      .run(uuidv7(), dev, AUDIENCE_VAULT, now, now);
    const { albumId } = seedAlbum(home, now);
    const grant = createShareGrant(home.origin.vault, {
      audience: { kind: "party", id: dev },
      subjectType: "core.collection",
      subjectId: albumId,
      capability: "view",
      grantedAt: now,
      grantedBy: home.originBoot.ownerPartyId,
    });
    const parked = fulfillShareGrant({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor: () => undefined,
      now,
    });
    expect(parked.steps[0]).toMatchObject({
      partyId: dev,
      state: "awaiting_channel",
      peerVaultId: AUDIENCE_VAULT,
      detail: `the link to peer vault ${AUDIENCE_VAULT} has ended`,
    });

    const revokedAt = "2026-08-19T15:00:00.000Z";
    revokeShareGrant(home.origin.vault, { grantId: grant.grantId, revokedAt });
    // The peer vault is mounted at revoke time — and it still must NOT be
    // told `removed` as if something had been taken back: nothing was ever
    // delivered, and the state says exactly that.
    const removal = propagateShareGrantRevocation({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor: (vaultId) =>
        vaultId === AUDIENCE_VAULT ? home.audience : undefined,
      now: revokedAt,
    });
    expect(removal.steps).toStrictEqual([
      {
        peerVaultId: AUDIENCE_VAULT,
        state: "removed",
        detail: "nothing had been delivered; there was nothing to remove",
        removed: false,
      },
    ]);
    expect(audienceTitles(home.audience.vault)).toStrictEqual([]);
    expect(channelForParty(home.origin.vault, dev)).toMatchObject({
      state: "severed",
    });
  });
  // The incident this guards: a member had a contact card for Bob AND the party
  // his vault link created. The share went to the card, the merge folded the
  // card into the linked party — and the grant kept naming a row that no longer
  // existed, so fulfillment could not resolve a peer vault and the document
  // never arrived. Nothing reported a failure; the grant simply sat there.
  test("a grant to a duplicate party follows the merge and then delivers", () => {
    const home = household();
    const now = nowIso();
    // Two rows for one person: the hand-added card, and the party the link
    // wrote. Only the linked one has somewhere to deliver.
    const card = addParty(home.origin.vault, "Bob", now);
    const linked = addParty(home.origin.vault, "Bob Ferreira", now);
    linkVault(home.origin.vault, linked, AUDIENCE_VAULT, now);
    const { albumId } = seedAlbum(home, now);
    const seatFor = (vaultId: string) =>
      vaultId === AUDIENCE_VAULT ? home.audience : undefined;

    const grant = createShareGrant(home.origin.vault, {
      audience: { kind: "party", id: card },
      subjectType: "core.collection",
      subjectId: albumId,
      capability: "view",
      grantedAt: now,
      grantedBy: home.originBoot.ownerPartyId,
    });
    // Granted to the card, so there is no channel and nothing to deliver over.
    expect(
      fulfillShareGrant({
        origin: home.origin,
        originVaultId: ORIGIN_VAULT,
        grantId: grant.grantId,
        seatFor,
        now,
      }).steps[0]
    ).toMatchObject({ partyId: card, state: "awaiting_channel" });
    expect(audienceTitles(home.audience.vault)).toStrictEqual([]);

    const gateway = createGateway(home.origin);
    registerPartyCommands(gateway);
    const merged = gateway.invoke(
      {
        kind: "device",
        deviceId: home.originBoot.deviceId,
        deviceKey: home.originBoot.deviceKey,
      },
      {
        command: "core.merge_party",
        input: { survivor_party_id: linked, merged_party_id: card },
      }
    );
    expect(merged.status).toBe("executed");

    // The same grant, re-fulfilled: it now names the party the link bound, so
    // the album lands in the peer vault without the owner granting anything a
    // second time.
    const delivered = fulfillShareGrant({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor,
      now,
    });
    expect(delivered.steps[0]).toMatchObject({
      partyId: linked,
      state: "delivered",
      peerVaultId: AUDIENCE_VAULT,
    });
    expect(audienceTitles(home.audience.vault)).toStrictEqual(["Photo a"]);
  });
});
