import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { nowIso, uuidv7 } from "../ids.js";
import type { Household, SeededPhoto } from "../share/placement-fixture.js";
import {
  closeOpenVaults,
  household,
  seedPhoto,
} from "../share/placement-fixture.js";
import { channelForParty } from "./channel.js";
import {
  fulfillShareGrant,
  propagateShareGrantRevocation,
  ShareGrantMaxSizeError,
} from "./fulfillment.js";
import {
  createShareGrant,
  listShareGrantsForSubject,
  readFulfillment,
  revokeShareGrant,
} from "./grant-store.js";

const AUDIENCE_VAULT = "vault-family";
const ORIGIN_VAULT = "vault-priya";

function addParty(db: DatabaseSync, name: string, now: string): string {
  const partyId = uuidv7();
  db.prepare(
    `INSERT INTO core_party
       (party_id, kind, display_name, sort_name, created_at, updated_at,
        ontology_version)
     VALUES (?, 'person', ?, ?, ?, ?, '1.4')`
  ).run(partyId, name, name, now, now);
  return partyId;
}

function linkVault(
  db: DatabaseSync,
  partyId: string,
  vaultId: string,
  now: string
): void {
  db.prepare(
    `INSERT INTO share_party_vault_binding
       (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
     VALUES (?, ?, ?, NULL, ?, NULL)`
  ).run(uuidv7(), partyId, vaultId, now);
}

/** An album holding one photograph — the container-grant subject. */
function seedAlbum(
  home: Household,
  now: string
): { albumId: string; first: SeededPhoto } {
  const first = seedPhoto(home.origin, home.originBoot, "a");
  const albumId = uuidv7();
  home.origin.vault
    .prepare(
      `INSERT INTO core_collection
         (collection_id, owner_party_id, name, cover_content_id,
          parent_collection_id, sort_order, created_at)
       VALUES (?, ?, 'Trip', ?, NULL, 0, ?)`
    )
    .run(albumId, home.originBoot.ownerPartyId, first.contentId, now);
  addToAlbum(home, albumId, first.assetId, 0, now);
  return { albumId, first };
}

function addToAlbum(
  home: Household,
  albumId: string,
  assetId: string,
  position: number,
  now: string
): void {
  home.origin.vault
    .prepare(
      `INSERT INTO core_collection_entry
         (entry_id, collection_id, target_type, target_id, position, added_at)
       VALUES (?, ?, 'media.asset', ?, ?, ?)`
    )
    .run(uuidv7(), albumId, assetId, position, now);
}

/** Titles of every content item the audience vault holds, in album order. */
function audienceTitles(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        `SELECT c.title AS title
           FROM core_collection_entry e
           JOIN media_asset a ON a.asset_id = e.target_id
           JOIN core_content_item c ON c.content_id = a.content_id
          ORDER BY e.position`
      )
      .all() as { title: string }[]
  ).map((row) => row.title);
}

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
    ).toMatchObject({ state: "delivered", updatedAt: now, detail: null });
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
    ).toMatchObject({ state: "removed", updatedAt: revokedAt });
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

  test("a grant to an unlinked person mints the invitation and parks", () => {
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
    });
    expect(parked.steps[0]?.claimToken).toBeTypeOf("string");
    expect(parked.steps[0]?.peerVaultId).toBeUndefined();
    // The ask is now the channel: the person is invited, not unreachable.
    expect(channelForParty(home.origin.vault, nila)).toMatchObject({
      partyId: nila,
      state: "invited",
    });
    const invitation = home.origin.vault
      .prepare(
        `SELECT capability, container_type, container_id, status
           FROM share_commons_invitation WHERE grant_id = ?`
      )
      .get(grant.grantId);
    expect(invitation).toMatchObject({
      capability: "read",
      container_type: "core.collection",
      container_id: albumId,
      status: "pending",
    });

    // Running the pass again reports the standing ask; it never rotates a
    // claim token an invite link may already be carrying.
    const again = fulfillShareGrant({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor: () => undefined,
      now,
    });
    expect(again.steps[0]?.invitationId).toBe(parked.steps[0]?.invitationId);
    expect(again.steps[0]?.claimToken).toBeUndefined();

    // The channel opens, and the same grant delivers with no re-granting.
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

  test("a subject above the grant's ceiling is refused before anything lands", () => {
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
      maxSizeBytes: 16,
    });

    expect(() =>
      fulfillShareGrant({
        origin: home.origin,
        originVaultId: ORIGIN_VAULT,
        grantId: grant.grantId,
        seatFor: (vaultId) =>
          vaultId === AUDIENCE_VAULT ? home.audience : undefined,
        now,
      })
    ).toThrow(ShareGrantMaxSizeError);
    expect(audienceTitles(home.audience.vault)).toStrictEqual([]);
    expect(
      readFulfillment(home.origin.vault, grant.grantId, AUDIENCE_VAULT)
    ).toBeUndefined();
  });
});
