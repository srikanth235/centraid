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
    ).toMatchObject({ state: "delivered", detail: null });
    expect(audienceTitles(home.audience.vault)).toStrictEqual(["Photo a"]);

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
    expect(parked.steps[0]?.peerVaultId).toBeUndefined();
    expect(listFulfillment(home.origin.vault, grant.grantId)).toStrictEqual([]);
    expect(channelForParty(home.origin.vault, nila)).toBeNull();
    expect(
      home.origin.vault
        .prepare(
          `SELECT COUNT(*) AS n FROM share_commons_invitation WHERE grant_id = ?`
        )
        .get(grant.grantId)
    ).toMatchObject({ n: 0 });

    const again = fulfillShareGrant({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor: () => undefined,
      now,
    });
    expect(again.steps[0]).toMatchObject({ state: "awaiting_channel" });

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
    expect(audienceTitles(home.audience.vault)).toStrictEqual(["Photo a"]);
    expect(
      readFulfillment(home.origin.vault, grant.grantId, AUDIENCE_VAULT)
    ).toMatchObject({ state: "remove_sent" });
  });

  test("revoking a never-delivered grant removes nothing and says so", () => {
    const home = household();
    const now = nowIso();
    const dev = addParty(home.origin.vault, "Dev", now);
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
  test("a grant to a duplicate party follows the merge and then delivers", () => {
    const home = household();
    const now = nowIso();
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
        purpose: "dpv:ServiceProvision",
      }
    );
    expect(merged.status).toBe("executed");

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
