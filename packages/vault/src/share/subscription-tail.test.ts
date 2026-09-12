/*
 * THE TRANSITION TESTS the wave-7 contract names (#996, R10), end to end on two
 * real vaults through the predicate transport: a folder move, a photograph
 * added to and removed from a shared album, overlapping grants with one
 * revoked, deletion and purge of a shared item, revocation, and a reconnect
 * after retention expiry.
 *
 * Written red-first against the applier: each one is a claim about what the
 * AUDIENCE holds after a pass, and the pass is the same three outputs in every
 * case. What makes them worth writing separately is that each is a different
 * way for a row to enter or leave scope WITHOUT changing — which is the whole
 * thing a log-only transport cannot see.
 */

import { afterEach, describe, expect, test } from "vitest";

import type { VaultDb } from "../db.js";
import { nowIso, uuidv7 } from "../ids.js";
import {
  bumpReplicaEpoch,
  currentReplicaLogState,
} from "../replica/change-log.js";
import { forwardProjectedEdit } from "./apply-outputs.js";
import { placeBlob } from "./blobs.js";
import type { ShareableItemType } from "./closure.js";
import {
  addToAlbum,
  closeOpenVaults,
  household,
  inCommit,
  seedAlbum,
  seedPhoto,
} from "./placement-fixture.js";
import { ingestShareTail, purgeShareShape } from "./subscription-seat.js";
import {
  readSubscription,
  readSubscriptionLineage,
} from "./subscription-store.js";
import { composeShareTail } from "./subscription-tail.js";

const ORIGIN_VAULT = "vault-priya";
const AUDIENCE_VAULT = "vault-family";

interface Grant {
  authorityId: string;
  subjectType: ShareableItemType;
  subjectId: string;
}

/** One delivery: compose the tail, place its bytes, ingest it, settle. */
function deliver(
  origin: VaultDb,
  audience: VaultDb,
  grant: Grant
): ReturnType<typeof ingestShareTail> {
  const standing = readSubscription(
    audience.vault,
    grant.authorityId,
    AUDIENCE_VAULT
  );
  const since =
    standing?.cursor.epoch === null || standing === undefined
      ? undefined
      : { epoch: standing.cursor.epoch, seq: standing.cursor.seq };
  const pass = composeShareTail({
    origin: origin.vault,
    originVaultId: ORIGIN_VAULT,
    audienceVaultId: AUDIENCE_VAULT,
    authorityId: grant.authorityId,
    subjectType: grant.subjectType,
    subjectId: grant.subjectId,
    ...(since === undefined ? {} : { since }),
  });
  expect(pass, "the row applier could not place this closure").toBeDefined();
  for (const blob of pass!.frame.blobs)
    placeBlob(origin.blobs.local, audience.blobs.local, blob.sha256);
  const result = ingestShareTail(audience.vault, pass!.frame, {
    audienceVaultId: AUDIENCE_VAULT,
    now: nowIso(),
  });
  pass!.settle();
  return result;
}

function count(db: VaultDb, sql: string, ...args: string[]): number {
  return (db.vault.prepare(sql).get(...args) as { n: number }).n;
}

function albumOver(
  origin: VaultDb,
  originBoot: { ownerPartyId: string },
  photos: readonly string[],
  name = "Beach"
): string {
  return inCommit(origin, () => {
    const id = seedAlbum(origin, originBoot as never, name);
    photos.forEach((assetId, index) =>
      addToAlbum(origin, id, { type: "media.asset", id: assetId }, index + 1)
    );
    return id;
  });
}

describe("the predicate transport, transition by transition", () => {
  afterEach(closeOpenVaults);

  test("a photograph added to a shared album ENTERS the audience; removing it makes it LEAVE", () => {
    const { origin, originBoot, audience } = household();
    const first = inCommit(origin, () => seedPhoto(origin, originBoot, "one"));
    const second = inCommit(origin, () => seedPhoto(origin, originBoot, "two"));
    const album = albumOver(origin, originBoot, [first.assetId]);
    const grant: Grant = {
      authorityId: "authority-album",
      subjectType: "core.collection",
      subjectId: album,
    };

    const bootstrap = deliver(origin, audience, grant);
    expect(bootstrap.entered).toBeGreaterThan(0);
    expect(count(audience, "SELECT COUNT(*) AS n FROM media_asset")).toBe(1);

    inCommit(origin, () =>
      addToAlbum(origin, album, { type: "media.asset", id: second.assetId }, 2)
    );
    const added = deliver(origin, audience, grant);
    // FOUR rows entered on a commit whose log says only "an entry row moved".
    expect(added.entered).toBe(4);
    expect(added.left).toBe(0);
    expect(count(audience, "SELECT COUNT(*) AS n FROM media_asset")).toBe(2);
    expect(
      count(audience, "SELECT COUNT(*) AS n FROM core_collection_entry")
    ).toBe(2);

    inCommit(origin, () =>
      origin.vault
        .prepare(
          "DELETE FROM core_collection_entry WHERE collection_id = ? AND target_id = ?"
        )
        .run(album, second.assetId)
    );
    const removed = deliver(origin, audience, grant);
    expect(removed.entered).toBe(0);
    // The asset, its bytes row, its representation and the entry all leave,
    // and not one of them changed.
    expect(removed.left).toBe(4);
    expect(count(audience, "SELECT COUNT(*) AS n FROM media_asset")).toBe(1);
    // The one that stayed is untouched.
    expect(
      count(
        audience,
        "SELECT COUNT(*) AS n FROM core_content_item WHERE sha256 = ?",
        first.sha256
      )
    ).toBe(1);
  });

  test("a document moved between folders follows the folder it is filed under", () => {
    const { origin, originBoot, audience } = household();
    const photo = inCommit(origin, () => seedPhoto(origin, originBoot, "doc"));
    const documentId = uuidv7();
    const schemeId = uuidv7();
    const rootId = uuidv7();
    const sharedId = uuidv7();
    const otherId = uuidv7();
    inCommit(origin, () => {
      origin.vault
        .prepare(
          `INSERT INTO core_document
             (document_id, title, current_content_id, created_at, updated_at)
           VALUES (?, 'Ferry timetable', ?, ?, ?)`
        )
        .run(documentId, photo.contentId, nowIso(), nowIso());
      origin.vault
        .prepare(
          `INSERT INTO core_concept_scheme (scheme_id, uri, title, version, created_at)
           VALUES (?, 'https://centraid.dev/schemes/folders', 'Folders', '1', ?)`
        )
        .run(schemeId, nowIso());
      const concept = origin.vault.prepare(
        `INSERT INTO core_concept
           (concept_id, scheme_id, notation, pref_label, broader_concept_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      concept.run(rootId, schemeId, "root", "Root", null, nowIso());
      concept.run(sharedId, schemeId, "shared", "Shared", rootId, nowIso());
      concept.run(otherId, schemeId, "other", "Other", rootId, nowIso());
      origin.vault
        .prepare(
          `INSERT INTO core_tag (tag_id, concept_id, target_type, target_id, tagged_at)
           VALUES (?, ?, 'core.document', ?, ?)`
        )
        .run(uuidv7(), sharedId, documentId, nowIso());
    });
    const grant: Grant = {
      authorityId: "authority-folder",
      subjectType: "docs.folder",
      subjectId: sharedId,
    };

    expect(deliver(origin, audience, grant).entered).toBeGreaterThan(0);
    expect(count(audience, "SELECT COUNT(*) AS n FROM core_document")).toBe(1);

    // Filed out of the shared folder: the document leaves with its tag.
    inCommit(origin, () =>
      origin.vault
        .prepare("UPDATE core_tag SET concept_id = ? WHERE target_id = ?")
        .run(otherId, documentId)
    );
    const moved = deliver(origin, audience, grant);
    expect(moved.left).toBeGreaterThan(0);
    expect(count(audience, "SELECT COUNT(*) AS n FROM core_document")).toBe(0);
  });

  test("two grants over one photograph are two claims; revoking one keeps the row", () => {
    const { origin, originBoot, audience } = household();
    const photo = inCommit(origin, () => seedPhoto(origin, originBoot, "two"));
    const first: Grant = {
      authorityId: "authority-first",
      subjectType: "media.asset",
      subjectId: photo.assetId,
    };
    const second: Grant = { ...first, authorityId: "authority-second" };
    deliver(origin, audience, first);
    deliver(origin, audience, second);
    expect(count(audience, "SELECT COUNT(*) AS n FROM media_asset")).toBe(1);

    const purged = purgeShareShape(audience.vault, {
      authorityId: first.authorityId,
      audienceVaultId: AUDIENCE_VAULT,
      now: nowIso(),
    });
    expect(purged.removed).toBe(0);
    expect(purged.retained).toBeGreaterThan(0);
    expect(count(audience, "SELECT COUNT(*) AS n FROM media_asset")).toBe(1);

    const last = purgeShareShape(audience.vault, {
      authorityId: second.authorityId,
      audienceVaultId: AUDIENCE_VAULT,
      now: nowIso(),
    });
    expect(last.removed).toBeGreaterThan(0);
    expect(count(audience, "SELECT COUNT(*) AS n FROM media_asset")).toBe(0);
  });

  test("purging a shared member scrubs the audience's copy, and no revocation is involved", () => {
    const { origin, originBoot, audience } = household();
    const kept = inCommit(origin, () => seedPhoto(origin, originBoot, "kept"));
    const doomed = inCommit(origin, () =>
      seedPhoto(origin, originBoot, "doomed")
    );
    const album = albumOver(origin, originBoot, [kept.assetId, doomed.assetId]);
    const grant: Grant = {
      authorityId: "authority-purge",
      subjectType: "core.collection",
      subjectId: album,
    };
    deliver(origin, audience, grant);
    expect(count(audience, "SELECT COUNT(*) AS n FROM media_asset")).toBe(2);

    // The owner purges one member out of their own library. The grant's
    // SUBJECT is the album, so `core_entity_revoke_on_purge` revokes nothing —
    // the leave output is the only thing that reaches the audience's copy.
    inCommit(origin, () =>
      origin.vault
        .prepare("DELETE FROM core_entity WHERE entity_id = ?")
        .run(doomed.assetId)
    );
    const after = deliver(origin, audience, grant);
    expect(after.left).toBeGreaterThan(0);
    expect(count(audience, "SELECT COUNT(*) AS n FROM media_asset")).toBe(1);
  });

  test("a reconnect after retention expiry RESENDS every member and scrubs nothing", () => {
    const { origin, originBoot, audience } = household();
    const photo = inCommit(origin, () => seedPhoto(origin, originBoot, "back"));
    const album = albumOver(origin, originBoot, [photo.assetId]);
    const grant: Grant = {
      authorityId: "authority-reconnect",
      subjectType: "core.collection",
      subjectId: album,
    };
    deliver(origin, audience, grant);
    const before = count(audience, "SELECT COUNT(*) AS n FROM media_asset");

    // The audience comes back with a cursor the origin's log no longer covers.
    const pass = composeShareTail({
      origin: origin.vault,
      originVaultId: ORIGIN_VAULT,
      audienceVaultId: AUDIENCE_VAULT,
      authorityId: grant.authorityId,
      subjectType: grant.subjectType,
      subjectId: grant.subjectId,
      since: { epoch: "an-older-epoch", seq: 1 },
    })!;
    expect(pass.frame.outputs.reason).toBe("resend");
    expect(pass.frame.outputs.leave).toStrictEqual([]);
    const applied = ingestShareTail(audience.vault, pass.frame, {
      audienceVaultId: AUDIENCE_VAULT,
      now: nowIso(),
    });
    pass.settle();
    // Every member came again, and every one of them landed on the row the
    // audience already held: an upsert, never a scrub-and-reinsert.
    expect(applied.entered).toBe(pass.frame.outputs.enter.length);
    expect(applied.left).toBe(0);
    expect(count(audience, "SELECT COUNT(*) AS n FROM media_asset")).toBe(
      before
    );
  });

  test("an epoch roll RESENDS, and the audience scrubs what left it (#1014 V10)", () => {
    const { origin, originBoot, audience } = household();
    const kept = inCommit(origin, () => seedPhoto(origin, originBoot, "kept"));
    const gone = inCommit(origin, () => seedPhoto(origin, originBoot, "gone"));
    const album = albumOver(origin, originBoot, [kept.assetId, gone.assetId]);
    const grant: Grant = {
      authorityId: "authority-epoch-roll",
      subjectType: "core.collection",
      subjectId: album,
    };
    deliver(origin, audience, grant);
    expect(count(audience, "SELECT COUNT(*) AS n FROM media_asset")).toBe(2);

    // The subject changes while the subscriber is not looking, and the ORIGIN
    // rolls its epoch: the audience's cursor is in a dead sequence space, so
    // the only answer the origin can compose is a resend.
    inCommit(origin, () =>
      origin.vault
        .prepare(
          "DELETE FROM core_collection_entry WHERE collection_id = ? AND target_id = ?"
        )
        .run(album, gone.assetId)
    );
    bumpReplicaEpoch(origin.vault, { reason: "test-epoch-roll" });
    // A resend is the origin saying its memory of what this audience holds is
    // NOT to be trusted — so that memory cannot also be the only thing that
    // scrubs. Forgetting it is what a real roll does to a restored or
    // re-created origin, and it is the case only the audience can close.
    origin.vault
      .prepare("DELETE FROM share_subscription_member WHERE authority_id = ?")
      .run(grant.authorityId);

    const standing = readSubscription(
      audience.vault,
      grant.authorityId,
      AUDIENCE_VAULT
    );
    const applied = deliver(origin, audience, grant);
    expect(applied.scrubbed).toBeGreaterThan(0);
    // The row that left is gone from the audience's copy AND from the grant's
    // lineage; the one that stayed is untouched.
    expect(count(audience, "SELECT COUNT(*) AS n FROM media_asset")).toBe(1);
    expect(
      readSubscriptionLineage(audience.vault, grant.authorityId).some(
        (row) => row.originItemId === gone.assetId
      )
    ).toBe(false);
    expect(
      readSubscriptionLineage(audience.vault, grant.authorityId).some(
        (row) => row.originItemId === kept.assetId
      )
    ).toBe(true);
    // And the cursor moved into the NEW epoch rather than staying in the dead
    // one, so the next pass is an ordinary tail.
    const after = readSubscription(
      audience.vault,
      grant.authorityId,
      AUDIENCE_VAULT
    );
    expect(after?.cursor.epoch).not.toBe(standing?.cursor.epoch);
    expect(after?.cursor.epoch).toBe(
      currentReplicaLogState(origin.vault).epoch
    );
  });

  test("a projected row is read-only: an edit is routed to the origin, not written here", () => {
    const { origin, originBoot, audience } = household();
    const photo = inCommit(origin, () => seedPhoto(origin, originBoot, "ro"));
    const grant: Grant = {
      authorityId: "authority-readonly",
      subjectType: "media.asset",
      subjectId: photo.assetId,
    };
    deliver(origin, audience, grant);
    const assetId = (
      audience.vault.prepare("SELECT asset_id FROM media_asset").get() as {
        asset_id: string;
      }
    ).asset_id;

    const route = forwardProjectedEdit(audience.vault, {
      entity: "media.asset",
      rowId: assetId,
    });
    expect(route).toMatchObject({
      authorityId: grant.authorityId,
      originVaultId: ORIGIN_VAULT,
      // The intent names the ORIGIN's row id, never the audience's.
      originItemId: photo.assetId,
    });
    expect(route!.originRowVersion).toBeGreaterThan(0);

    // A row the audience authored itself is its own: nothing to forward.
    const ownId = uuidv7();
    audience.vault
      .prepare(
        "INSERT INTO core_entity (entity_id, entity_type, created_at) VALUES (?, 'core.collection', ?)"
      )
      .run(ownId, nowIso());
    expect(
      forwardProjectedEdit(audience.vault, {
        entity: "core.collection",
        rowId: ownId,
      })
    ).toBeUndefined();
  });
});
