import { afterEach, describe, expect, test } from "vitest";

import { nowIso, uuidv7 } from "../ids.js";
import { closeOpenVaults, household } from "../share/placement-fixture.js";
import {
  createGrantProjectionMemory,
  fulfillShareGrant,
  ShareGrantMaxSizeError,
} from "./fulfillment.js";
import {
  addParty,
  audienceTitles,
  AUDIENCE_VAULT,
  linkVault,
  ORIGIN_VAULT,
  seedAlbum,
} from "./fulfillment.test-fixtures.js";
import {
  createShareGrant,
  declineShare,
  listShareGrantsForSubject,
  readFulfillment,
} from "./grant-store.js";

describe("grant/fulfillment — roster and ceiling", () => {
  afterEach(closeOpenVaults);

  test("a circle audience skips the granter and recompiles its roster per pass", () => {
    const home = household();
    const now = nowIso();
    const owner = home.originBoot.ownerPartyId;
    const ravi = addParty(home.origin.vault, "Ravi", now);
    linkVault(home.origin.vault, ravi, AUDIENCE_VAULT, now);
    const circleId = uuidv7();
    home.origin.vault
      .prepare(
        `INSERT INTO social_circle (circle_id, owner_party_id, name, kind)
         VALUES (?, ?, 'Home', 'custom')`
      )
      .run(circleId, owner);
    const addMember = (partyId: string): void => {
      home.origin.vault
        .prepare(
          `INSERT INTO social_circle_member
             (member_id, circle_id, party_id, added_at, capability)
           VALUES (?, ?, ?, ?, 'read')`
        )
        .run(uuidv7(), circleId, partyId, now);
    };
    addMember(owner);
    addMember(ravi);
    const { albumId } = seedAlbum(home, now);
    const grant = createShareGrant(home.origin.vault, {
      audience: { kind: "circle", id: circleId },
      subjectType: "core.collection",
      subjectId: albumId,
      capability: "view",
      grantedAt: now,
      grantedBy: owner,
    });

    const first = fulfillShareGrant({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor: (vaultId) =>
        vaultId === AUDIENCE_VAULT ? home.audience : undefined,
      now,
    });
    expect(first.steps).toHaveLength(1);
    expect(first.steps[0]).toMatchObject({
      partyId: ravi,
      state: "delivered",
      peerVaultId: AUDIENCE_VAULT,
    });
    expect(audienceTitles(home.audience.vault)).toStrictEqual(["Photo a"]);

    const later = "2026-08-19T16:00:00.000Z";
    const nila = addParty(home.origin.vault, "Nila", later);
    linkVault(home.origin.vault, nila, AUDIENCE_VAULT, later);
    addMember(nila);
    const second = fulfillShareGrant({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor: (vaultId) =>
        vaultId === AUDIENCE_VAULT ? home.audience : undefined,
      now: later,
    });
    expect(second.steps.map((step) => step.partyId).sort()).toStrictEqual(
      [ravi, nila].sort()
    );
    expect(
      listShareGrantsForSubject(home.origin.vault, "core.collection", albumId)
    ).toHaveLength(1);
  });

  test("an over-ceiling grant leaves no row even when every peer is unreachable", () => {
    const home = household();
    const now = nowIso();
    const ravi = addParty(home.origin.vault, "Ravi", now);
    linkVault(home.origin.vault, ravi, "vault-elsewhere", now);
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
        seatFor: () => undefined,
        now,
      })
    ).toThrow(ShareGrantMaxSizeError);
    expect(
      readFulfillment(home.origin.vault, grant.grantId, "vault-elsewhere")
    ).toBeUndefined();
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

  test("a refusal inside a granted circle costs the member the person, not the circle", () => {
    const home = household();
    const now = nowIso();
    const db = home.origin.vault;
    const ravi = addParty(db, "Ravi", now);
    const meera = addParty(db, "Meera", now);
    const circleId = uuidv7();
    db.prepare(
      `INSERT INTO social_circle (circle_id, owner_party_id, name, kind)
       VALUES (?, ?, 'Family', 'custom')`
    ).run(circleId, home.originBoot.ownerPartyId);
    for (const partyId of [ravi, meera])
      db.prepare(
        `INSERT INTO social_circle_member
           (member_id, circle_id, party_id, added_at, capability)
         VALUES (?, ?, ?, ?, 'read')`
      ).run(uuidv7(), circleId, partyId, now);
    const { albumId } = seedAlbum(home, now);
    const grant = createShareGrant(db, {
      audience: { kind: "circle", id: circleId },
      subjectType: "core.collection",
      subjectId: albumId,
      capability: "view",
      grantedAt: now,
      grantedBy: home.originBoot.ownerPartyId,
    });

    const both = fulfillShareGrant({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor: () => undefined,
      now,
    });
    expect(both.steps.map((step) => step.partyId).sort()).toStrictEqual(
      [ravi, meera].sort()
    );
    expect(both.drift.masked).toStrictEqual([]);

    declineShare(db, {
      audience: { kind: "party", id: meera },
      subjectType: "core.collection",
      subjectId: albumId,
      capability: "view",
      decidedAt: now,
      decidedBy: home.originBoot.ownerPartyId,
    });
    const masked = fulfillShareGrant({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor: () => undefined,
      now,
    });
    expect(masked.steps.map((step) => step.partyId)).toStrictEqual([ravi]);
    expect(masked.drift.masked).toStrictEqual([meera]);
    expect(
      listShareGrantsForSubject(db, "core.collection", albumId)
    ).toHaveLength(1);
  });

  test("an unchanged projection writes nothing and wakes no device", () => {
    const home = household();
    const now = nowIso();
    const ravi = addParty(home.origin.vault, "Ravi", now);
    linkVault(home.origin.vault, ravi, AUDIENCE_VAULT, now);
    const { albumId } = seedAlbum(home, now);
    const seatFor = (vaultId: string) =>
      vaultId === AUDIENCE_VAULT ? home.audience : undefined;
    const memory = createGrantProjectionMemory();
    const grant = createShareGrant(home.origin.vault, {
      audience: { kind: "party", id: ravi },
      subjectType: "core.collection",
      subjectId: albumId,
      capability: "view",
      grantedAt: now,
      grantedBy: home.originBoot.ownerPartyId,
    });
    const pass = (at: string) =>
      fulfillShareGrant({
        origin: home.origin,
        originVaultId: ORIGIN_VAULT,
        grantId: grant.grantId,
        seatFor,
        now: at,
        memory,
      });

    const first = pass(now);
    expect(first.steps[0]).toMatchObject({
      state: "delivered",
      firstDelivery: true,
    });
    const projectedId = (
      home.audience.vault
        .prepare("SELECT target_id FROM core_share_origin LIMIT 1")
        .get() as { target_id: string }
    ).target_id;
    const changesAfterFirst = (
      home.audience.vault
        .prepare("SELECT count(*) AS n FROM replica_change")
        .get() as { n: number }
    ).n;

    const second = pass("2031-01-01T00:00:00.000Z");
    expect(second.steps[0]).toMatchObject({
      state: "delivered",
      unchanged: true,
    });
    expect(
      home.audience.vault
        .prepare("SELECT target_id FROM core_share_origin LIMIT 1")
        .get()
    ).toMatchObject({ target_id: projectedId });
    expect(
      home.audience.vault
        .prepare("SELECT count(*) AS n FROM replica_change")
        .get()
    ).toMatchObject({ n: changesAfterFirst });
    expect(
      readFulfillment(home.origin.vault, grant.grantId, AUDIENCE_VAULT)
    ).toMatchObject({ deliveredAt: now });
    home.origin.vault
      .prepare("UPDATE core_collection SET name = ? WHERE collection_id = ?")
      .run("Trip (final)", albumId);
    const third = pass("2032-01-01T00:00:00.000Z");
    expect(third.steps[0]?.unchanged).toBeUndefined();
    expect(third.steps[0]?.firstDelivery).toBeUndefined();
  });
});
