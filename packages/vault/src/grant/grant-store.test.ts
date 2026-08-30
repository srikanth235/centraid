import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { nowIso, uuidv7 } from "../ids.js";
import { closeOpenVaults, household } from "../share/placement-fixture.js";
import {
  createShareGrant,
  ensureFulfillment,
  listFulfillment,
  listLiveGrantsReachingParty,
  listShareGrantsForAudience,
  listShareGrantsForSubject,
  readLiveShareGrant,
  readShareGrant,
  resolveAudienceParties,
  revokeShareGrant,
  setFulfillmentState,
  UnofferableSubjectError,
} from "./grant-store.js";

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

function addCircle(db: DatabaseSync, owner: string, name: string): string {
  const circleId = uuidv7();
  db.prepare(
    `INSERT INTO social_circle (circle_id, owner_party_id, name, kind)
     VALUES (?, ?, ?, 'custom')`
  ).run(circleId, owner, name);
  return circleId;
}

function addMember(
  db: DatabaseSync,
  circleId: string,
  partyId: string,
  capability: "read" | "read+write" = "read"
): void {
  db.prepare(
    `INSERT INTO social_circle_member
       (member_id, circle_id, party_id, added_at, capability)
     VALUES (?, ?, ?, ?, ?)`
  ).run(uuidv7(), circleId, partyId, nowIso(), capability);
}

describe("grant/grant-store", () => {
  afterEach(closeOpenVaults);

  test("creates, reads and lists a standing grant", () => {
    const { origin, originBoot } = household();
    const db = origin.vault;
    const now = nowIso();
    const audienceParty = addParty(db, "Ravi", now);
    const subjectId = uuidv7();

    const created = createShareGrant(db, {
      audience: { kind: "party", id: audienceParty },
      subjectType: "tally.group",
      subjectId,
      capability: "edit",
      grantedAt: now,
      grantedBy: originBoot.ownerPartyId,
      maxSizeBytes: 1024,
    });
    expect(created.outcome).toBe("created");
    expect(created.grant).toMatchObject({
      audience: { kind: "party", id: audienceParty },
      subjectType: "tally.group",
      subjectId,
      capability: "edit",
      grantedAt: now,
      revokedAt: null,
      grantedBy: originBoot.ownerPartyId,
      maxSizeBytes: 1024,
    });

    expect(readShareGrant(db, created.grantId)).toStrictEqual(created.grant);
    expect(
      readLiveShareGrant(
        db,
        { kind: "party", id: audienceParty },
        "tally.group",
        subjectId
      )
    ).toStrictEqual(created.grant);
    expect(
      listShareGrantsForAudience(db, { kind: "party", id: audienceParty })
    ).toStrictEqual([created.grant]);
    expect(
      listShareGrantsForSubject(db, "tally.group", subjectId)
    ).toStrictEqual([created.grant]);
    expect(readShareGrant(db, "no-such-grant")).toBeUndefined();
  });

  test("a subject x capability pair without a fulfillment answer is refused (#750)", () => {
    const { origin, originBoot } = household();
    const db = origin.vault;
    const now = nowIso();
    const party = addParty(db, "Nila", now);

    // Shareable in the closure vocabulary, deliberately absent from the
    // subject registry: secrets are not offered as grants.
    expect(() =>
      createShareGrant(db, {
        audience: { kind: "party", id: party },
        subjectType: "locker.item",
        subjectId: uuidv7(),
        capability: "view",
        grantedAt: now,
        grantedBy: originBoot.ownerPartyId,
      })
    ).toThrow(UnofferableSubjectError);

    // media.asset answers view but has no edit strategy.
    expect(() =>
      createShareGrant(db, {
        audience: { kind: "party", id: party },
        subjectType: "media.asset",
        subjectId: uuidv7(),
        capability: "edit",
        grantedAt: now,
        grantedBy: originBoot.ownerPartyId,
      })
    ).toThrow(/no fulfillment strategy answers media.asset x edit/u);

    // Counted over the SHARE lens: the same table also holds the device row
    // bootstrap wrote for this seat (#883).
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM share_authority
            WHERE principal_kind IN ('person','circle')`
        )
        .get()
    ).toMatchObject({ n: 0 });
  });

  test("one live grant per audience x subject: a repeat reports the standing one", () => {
    const { origin, originBoot } = household();
    const db = origin.vault;
    const now = nowIso();
    const party = addParty(db, "Meera", now);
    const subjectId = uuidv7();
    // `tally.group` is the one subject type v1 offers `edit` for (#825).
    const first = createShareGrant(db, {
      audience: { kind: "party", id: party },
      subjectType: "tally.group",
      subjectId,
      capability: "view",
      grantedAt: now,
      grantedBy: originBoot.ownerPartyId,
    });

    const again = createShareGrant(db, {
      audience: { kind: "party", id: party },
      subjectType: "tally.group",
      subjectId,
      capability: "edit",
      grantedAt: "2030-01-01T00:00:00.000Z",
      grantedBy: originBoot.ownerPartyId,
    });
    // `conflict`, not `exists` (#883): a DIFFERENT verb is not the same
    // sentence twice, and answering with the standing grant would report
    // "already shared" for an ask that was refused.
    expect(again.outcome).toBe("conflict");
    expect(again.grantId).toBe(first.grantId);
    // The standing decision is untouched — no silent capability upgrade.
    expect(again.grant.capability).toBe("view");
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM share_authority
            WHERE principal_kind IN ('person','circle')`
        )
        .get()
    ).toMatchObject({ n: 1 });

    // The index is real, not merely respected by this store — and it keys on
    // the VERB, so the rival row below restates the standing answer rather
    // than raising the capability.
    expect(() =>
      db
        .prepare(
          `INSERT INTO share_authority
             (authority_id, principal_kind, principal_id, subject_type,
              subject_id, verb, duration, decision, granted_at, granted_by)
           VALUES (?, 'person', ?, 'tally.group', ?, 'view', 'standing',
                   'granted', ?, ?)`
        )
        .run(uuidv7(), party, subjectId, now, originBoot.ownerPartyId)
    ).toThrow(/UNIQUE/u);
  });

  test("revoking dates the row, keeps it, and hands back the fulfillment rows", () => {
    const { origin, originBoot } = household();
    const db = origin.vault;
    const now = nowIso();
    const party = addParty(db, "Ilan", now);
    const subjectId = uuidv7();
    const grant = createShareGrant(db, {
      audience: { kind: "party", id: party },
      subjectType: "core.document",
      subjectId,
      capability: "view",
      grantedAt: now,
      grantedBy: originBoot.ownerPartyId,
    });
    ensureFulfillment(db, {
      grantId: grant.grantId,
      peerVaultId: "vault-ilan",
      state: "delivered",
      updatedAt: now,
    });

    const revoked = revokeShareGrant(db, {
      grantId: grant.grantId,
      revokedAt: "2031-02-03T00:00:00.000Z",
    });
    expect(revoked.outcome).toBe("revoked");
    expect(revoked.fulfillment).toStrictEqual([
      {
        grantId: grant.grantId,
        peerVaultId: "vault-ilan",
        state: "delivered",
        updatedAt: now,
        detail: null,
        deliveredAt: now,
      },
    ]);
    // Removal is not propagated — the delivery state is left alone.
    expect(listFulfillment(db, grant.grantId)[0]?.state).toBe("delivered");
    expect(readShareGrant(db, grant.grantId)?.revokedAt).toBe(
      "2031-02-03T00:00:00.000Z"
    );
    expect(
      listShareGrantsForAudience(db, { kind: "party", id: party })
    ).toStrictEqual([]);
    expect(
      listShareGrantsForAudience(
        db,
        { kind: "party", id: party },
        { includeRevoked: true }
      )
    ).toHaveLength(1);

    expect(
      revokeShareGrant(db, { grantId: grant.grantId, revokedAt: now }).outcome
    ).toBe("already-revoked");
    expect(
      revokeShareGrant(db, { grantId: "absent", revokedAt: now }).outcome
    ).toBe("absent");

    // Revoked rows are outside the live-uniqueness index.
    const again = createShareGrant(db, {
      audience: { kind: "party", id: party },
      subjectType: "core.document",
      subjectId,
      capability: "view",
      grantedAt: "2031-03-01T00:00:00.000Z",
      grantedBy: originBoot.ownerPartyId,
    });
    expect(again.outcome).toBe("created");
    expect(again.grantId).not.toBe(grant.grantId);
  });

  test("audience queries stay literal; only the reaching query unions circles", () => {
    const { origin, originBoot } = household();
    const db = origin.vault;
    const now = nowIso();
    const member = addParty(db, "Nadia", now);
    const stranger = addParty(db, "Otto", now);
    const circle = addCircle(db, originBoot.ownerPartyId, "Studio");
    addMember(db, circle, member);
    const circleSubject = uuidv7();
    const partySubject = uuidv7();

    const circleGrant = createShareGrant(db, {
      audience: { kind: "circle", id: circle },
      subjectType: "media.asset",
      subjectId: circleSubject,
      capability: "view",
      grantedAt: now,
      grantedBy: originBoot.ownerPartyId,
    });
    const partyGrant = createShareGrant(db, {
      audience: { kind: "party", id: member },
      subjectType: "core.collection",
      subjectId: partySubject,
      capability: "view",
      grantedAt: now,
      grantedBy: originBoot.ownerPartyId,
    });

    expect(
      listShareGrantsForAudience(db, { kind: "party", id: member }).map(
        (g) => g.grantId
      )
    ).toStrictEqual([partyGrant.grantId]);
    expect(
      listLiveGrantsReachingParty(db, member)
        .map((g) => g.grantId)
        .sort()
    ).toStrictEqual([circleGrant.grantId, partyGrant.grantId].sort());
    expect(listLiveGrantsReachingParty(db, stranger)).toStrictEqual([]);

    expect(
      resolveAudienceParties(db, { kind: "party", id: member })
    ).toStrictEqual([member]);
    expect(
      resolveAudienceParties(db, { kind: "circle", id: circle })
    ).toStrictEqual([member]);
    expect(
      resolveAudienceParties(db, { kind: "circle", id: "empty-circle" })
    ).toStrictEqual([]);

    // A revoked circle grant stops reaching the member.
    revokeShareGrant(db, { grantId: circleGrant.grantId, revokedAt: now });
    expect(
      listLiveGrantsReachingParty(db, member).map((g) => g.grantId)
    ).toStrictEqual([partyGrant.grantId]);
  });

  test("fulfillment opens once and then moves state with a detail note", () => {
    const { origin, originBoot } = household();
    const db = origin.vault;
    const now = nowIso();
    const party = addParty(db, "Pia", now);
    const grant = createShareGrant(db, {
      audience: { kind: "party", id: party },
      subjectType: "docs.folder",
      subjectId: uuidv7(),
      capability: "view",
      grantedAt: now,
      grantedBy: originBoot.ownerPartyId,
    });

    const opened = ensureFulfillment(db, {
      grantId: grant.grantId,
      peerVaultId: "vault-pia",
      state: "awaiting_channel",
      updatedAt: now,
    });
    expect(opened.state).toBe("awaiting_channel");
    // ensureFulfillment never rewrites a row that already stands.
    expect(
      ensureFulfillment(db, {
        grantId: grant.grantId,
        peerVaultId: "vault-pia",
        state: "delivered",
        updatedAt: "2032-01-01T00:00:00.000Z",
      }).state
    ).toBe("awaiting_channel");

    const moved = setFulfillmentState(db, {
      grantId: grant.grantId,
      peerVaultId: "vault-pia",
      state: "syncing",
      updatedAt: "2032-02-02T00:00:00.000Z",
      detail: "channel opened",
    });
    expect(moved).toStrictEqual({
      grantId: grant.grantId,
      peerVaultId: "vault-pia",
      state: "syncing",
      updatedAt: "2032-02-02T00:00:00.000Z",
      detail: "channel opened",
      // Nothing has reached the peer, so there is nothing to remember.
      deliveredAt: null,
    });
    const delivered = setFulfillmentState(db, {
      grantId: grant.grantId,
      peerVaultId: "vault-pia",
      state: "delivered",
      updatedAt: "2032-03-03T00:00:00.000Z",
    });
    expect(delivered.detail).toBeNull();
    expect(delivered.deliveredAt).toBe("2032-03-03T00:00:00.000Z");

    // #846: the delivery memory outlives the freshness reading. An unreachable
    // pass drops to `syncing`, but the peer still HOLDS the subject.
    expect(
      setFulfillmentState(db, {
        grantId: grant.grantId,
        peerVaultId: "vault-pia",
        state: "syncing",
        updatedAt: "2032-04-04T00:00:00.000Z",
        detail: "peer vault is not reachable from this host",
      }).deliveredAt
    ).toBe("2032-03-03T00:00:00.000Z");
    // Re-delivery keeps the FIRST instant: "has this peer ever held it".
    expect(
      setFulfillmentState(db, {
        grantId: grant.grantId,
        peerVaultId: "vault-pia",
        state: "delivered",
        updatedAt: "2032-05-05T00:00:00.000Z",
      }).deliveredAt
    ).toBe("2032-03-03T00:00:00.000Z");
    // A settled removal is the one thing that clears it.
    expect(
      setFulfillmentState(db, {
        grantId: grant.grantId,
        peerVaultId: "vault-pia",
        state: "removed",
        updatedAt: "2032-06-06T00:00:00.000Z",
      }).deliveredAt
    ).toBeNull();

    ensureFulfillment(db, {
      grantId: grant.grantId,
      peerVaultId: "vault-other",
      state: "awaiting_channel",
      updatedAt: now,
    });
    expect(
      listFulfillment(db, grant.grantId).map((f) => f.peerVaultId)
    ).toStrictEqual(["vault-other", "vault-pia"]);

    // The vocabulary is enforced by the table, not only by the type.
    expect(() =>
      db
        .prepare(
          `INSERT INTO share_fulfillment
             (grant_id, peer_vault_id, state, updated_at, detail)
           VALUES (?, 'vault-bad', 'in-flight', ?, NULL)`
        )
        .run(grant.grantId, now)
    ).toThrow(/CHECK/u);
    // And a fulfillment row cannot name a grant that does not exist.
    expect(() =>
      db
        .prepare(
          `INSERT INTO share_fulfillment
             (grant_id, peer_vault_id, state, updated_at, detail)
           VALUES ('ghost-grant', 'vault-bad', 'syncing', ?, NULL)`
        )
        .run(now)
    ).toThrow(/FOREIGN KEY/u);
  });
});
