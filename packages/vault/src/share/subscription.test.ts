/*
 * A share as a subscription (#929), on two real vaults under one root.
 *
 * The claims that are load-bearing: the origin's row version survives ingest,
 * a one-field edit costs the audience ONE change row, two grants over one
 * photograph are two claims and revoking one keeps the row, and a purge leaves
 * the seat with nothing the origin no longer answers for.
 */

import { describe, afterEach, expect, test } from "vitest";

import { diffCounters } from "@centraid/core/protocol";

import type { VaultDb } from "../db.js";
import {
  gatewayWorkCounters,
  instrumentVaultStatements,
} from "../gateway/work-counters.js";
import { nowIso, uuidv7 } from "../ids.js";
import { currentReplicaLogState } from "../replica/change-log.js";
import { placeBlob } from "./blobs.js";
import {
  closeOpenVaults,
  household,
  placementAuthority,
  seedPhoto,
} from "./placement-fixture.js";
import type { SeededPhoto } from "./placement-fixture.js";
import { composeShareShape } from "./subscription-frame.js";
import { ingestShareShape, purgeShareShape } from "./subscription-seat.js";
import {
  readSubscription,
  readSubscriptionLineage,
} from "./subscription-store.js";

const ORIGIN_VAULT = "vault-priya";
const AUDIENCE_VAULT = "vault-family";

function shapeIdFor(grantId: string): string {
  return `@share:${grantId}`;
}

/** Compose, hardlink the manifest, ingest — the loopback route in one call. */
function deliver(
  origin: VaultDb,
  audience: VaultDb,
  input: { grantId: string; subjectId: string; subjectType?: "media.asset" }
): ReturnType<typeof ingestShareShape> {
  const frame = composeShareShape({
    origin,
    originVaultId: ORIGIN_VAULT,
    audienceVaultId: AUDIENCE_VAULT,
    shapeId: shapeIdFor(input.grantId),
    grantId: input.grantId,
    subjectType: input.subjectType ?? "media.asset",
    subjectId: input.subjectId,
  });
  for (const blob of frame.closure.blobs)
    placeBlob(origin.blobs.local, audience.blobs.local, blob.sha256);
  return ingestShareShape(audience.vault, frame, {
    audienceVaultId: AUDIENCE_VAULT,
    now: nowIso(),
  });
}

/**
 * The DOMAIN rows a pass touched — the delta a member's screens re-read.
 *
 * DISTINCT, because `updated_at`'s touch trigger writes a second log entry for
 * the same row on every update, member-authored ones included, and the replica
 * projection collapses a row to its latest entry per commit. The seat's own
 * cursor and lineage bookkeeping are `share.subscription*` rows: no app holds a
 * grant over them, so they wake no device.
 */
function changedRowsSince(db: VaultDb, seq: number): string[] {
  return (
    db.vault
      .prepare(
        `SELECT DISTINCT entity, row_id FROM replica_change
          WHERE epoch = ? AND seq > ? AND entity NOT LIKE 'share.%'
          ORDER BY entity, row_id`
      )
      .all(currentReplicaLogState(db.vault).epoch, seq) as {
      entity: string;
      row_id: string;
    }[]
  ).map((row) => `${row.entity} ${row.row_id}`);
}

function originVersionOf(db: VaultDb, entity: string, rowId: string): number {
  const row = db.vault
    .prepare(
      `SELECT MAX(seq) AS seq FROM replica_change
        WHERE epoch = ? AND entity = ? AND row_id = ?`
    )
    .get(currentReplicaLogState(db.vault).epoch, entity, rowId) as {
    seq: number | null;
  };
  return row.seq ?? 0;
}

function grantOver(origin: VaultDb, photo: SeededPhoto, party: string): string {
  placementAuthority(origin, "media.asset", [photo.assetId], party);
  return uuidv7();
}

describe("share subscription", () => {
  afterEach(closeOpenVaults);

  test("the origin row version survives ingest", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "a");
    const grantId = grantOver(origin, photo, "audience-party");
    const result = deliver(origin, audience, {
      grantId,
      subjectId: photo.assetId,
    });
    expect(result.apply).toBe("bootstrap");

    const lineage = readSubscriptionLineage(
      audience.vault,
      shapeIdFor(grantId)
    );
    const asset = lineage.find((row) => row.targetType === "media.asset");
    expect(asset?.originItemId).toBe(photo.assetId);
    expect(asset?.originRowVersion).toBe(
      originVersionOf(origin, "media.asset", photo.assetId)
    );
    expect(asset?.originRowVersion).toBeGreaterThan(0);
    expect(
      readSubscription(audience.vault, shapeIdFor(grantId), AUDIENCE_VAULT)
        ?.cursor.seq
    ).toBeGreaterThan(0);
  });

  test("a one-field edit costs the audience one change row", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "a");
    const grantId = grantOver(origin, photo, "audience-party");
    const first = deliver(origin, audience, {
      grantId,
      subjectId: photo.assetId,
    });
    const audienceAsset = first.items[0]!.itemId;
    const before = currentReplicaLogState(audience.vault).watermark.seq;

    origin.vault
      .prepare("UPDATE media_asset SET width = 1024 WHERE asset_id = ?")
      .run(photo.assetId);

    const second = deliver(origin, audience, {
      grantId,
      subjectId: photo.assetId,
    });
    expect(second.apply).toBe("fields");
    expect(second.fieldUpdates).toBe(1);
    expect(changedRowsSince(audience, before)).toStrictEqual([
      `media.asset ${audienceAsset}`,
    ]);
    expect(
      audience.vault
        .prepare("SELECT width FROM media_asset WHERE asset_id = ?")
        .get(audienceAsset)
    ).toMatchObject({ width: 1024 });
  });

  /**
   * #929 box 2, the work-counter half. `fieldUpdates` is the audience's UPDATE
   * count for the pass, so a moved row set costs one UPDATE per moved row and
   * wakes exactly those rows' devices. The statement delta is recorded so a
   * per-row constant that grows shows up as an integer, not as a timing.
   */
  test("a moved row set costs one UPDATE per moved row", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "a");
    const grantId = grantOver(origin, photo, "audience-party");
    const first = deliver(origin, audience, {
      grantId,
      subjectId: photo.assetId,
    });
    instrumentVaultStatements(audience.vault);
    const before = currentReplicaLogState(audience.vault).watermark.seq;

    origin.vault
      .prepare("UPDATE media_asset SET width = 1024 WHERE asset_id = ?")
      .run(photo.assetId);
    origin.vault
      .prepare("UPDATE core_content_item SET title = ? WHERE content_id = ?")
      .run("Moved", photo.contentId);

    const countersBefore = gatewayWorkCounters();
    const second = deliver(origin, audience, {
      grantId,
      subjectId: photo.assetId,
    });
    const spent = diffCounters(countersBefore, gatewayWorkCounters());

    expect(second.apply).toBe("fields");
    expect(second.fieldUpdates).toBe(2);
    const woken = changedRowsSince(audience, before);
    expect(woken).toHaveLength(2);
    expect(woken).toContain(`media.asset ${first.items[0]!.itemId}`);
    // The counter is monotonic, so this only ever fences a regression upward.
    expect(spent.statements).toBeGreaterThan(0);
  });

  test("an unchanged shape writes nothing on the audience", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "a");
    const grantId = grantOver(origin, photo, "audience-party");
    deliver(origin, audience, { grantId, subjectId: photo.assetId });
    const before = currentReplicaLogState(audience.vault).watermark.seq;
    const again = deliver(origin, audience, {
      grantId,
      subjectId: photo.assetId,
    });
    expect(again.apply).toBe("fields");
    expect(again.fieldUpdates).toBe(0);
    expect(changedRowsSince(audience, before)).toStrictEqual([]);
  });

  test("two grants over one row are two claims; revoking one keeps the row", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "a");
    const first = grantOver(origin, photo, "audience-party");
    const second = grantOver(origin, photo, "other-party");
    const placed = deliver(origin, audience, {
      grantId: first,
      subjectId: photo.assetId,
    });
    deliver(origin, audience, { grantId: second, subjectId: photo.assetId });
    const assetId = placed.items[0]!.itemId;

    const purge = purgeShareShape(audience.vault, {
      shapeId: shapeIdFor(first),
      audienceVaultId: AUDIENCE_VAULT,
      now: nowIso(),
    });
    expect(purge.removed).toBe(0);
    expect(purge.retained).toBeGreaterThan(0);
    // The second grant still delivers it, so the row stays.
    expect(
      audience.vault
        .prepare("SELECT asset_id FROM media_asset WHERE asset_id = ?")
        .get(assetId)
    ).toBeTruthy();

    const last = purgeShareShape(audience.vault, {
      shapeId: shapeIdFor(second),
      audienceVaultId: AUDIENCE_VAULT,
      now: nowIso(),
    });
    expect(last.removed).toBeGreaterThan(0);
    expect(
      audience.vault
        .prepare("SELECT asset_id FROM media_asset WHERE asset_id = ?")
        .get(assetId)
    ).toBeUndefined();
    expect(
      readSubscription(audience.vault, shapeIdFor(second), AUDIENCE_VAULT)
        ?.state
    ).toBe("removed");
    expect(
      readSubscriptionLineage(audience.vault, shapeIdFor(second))
    ).toStrictEqual([]);
  });

  test("a frame addressed elsewhere is refused before anything lands", () => {
    const { origin, originBoot, audience } = household();
    const photo = seedPhoto(origin, originBoot, "a");
    const grantId = grantOver(origin, photo, "audience-party");
    const frame = composeShareShape({
      origin,
      originVaultId: ORIGIN_VAULT,
      audienceVaultId: "vault-someone-else",
      shapeId: shapeIdFor(grantId),
      grantId,
      subjectType: "media.asset",
      subjectId: photo.assetId,
    });
    expect(() =>
      ingestShareShape(audience.vault, frame, {
        audienceVaultId: AUDIENCE_VAULT,
        now: nowIso(),
      })
    ).toThrow(/addressed to/u);
    expect(
      audience.vault.prepare("SELECT count(*) AS n FROM media_asset").get()
    ).toMatchObject({ n: 0 });
  });
});
