/*
 * A share as a subscription (#929) under the closure predicate (#996, R10), on
 * two real vaults under one root.
 *
 * The claims that are load-bearing, and which survived the transport swap
 * unchanged because they were never about the frame: the origin's row version
 * survives ingest, a one-field edit costs the audience ONE change row, a moved
 * row set costs one write per moved row, an unchanged subscription writes
 * nothing at all, and a purge leaves the seat with nothing the origin no longer
 * answers for.
 *
 * What DID change is the word for the third of those. `apply: "fields"` and
 * `fieldUpdates` were the frame path's vocabulary — which of three ingest paths
 * a digest chose. The outputs say it directly: `entered`, `updated`, `left`.
 */

import { afterEach, describe, expect, test } from "vitest";

import { diffCounters } from "@centraid/core/protocol";

import type { VaultDb } from "../db.js";
import {
  gatewayWorkCounters,
  instrumentVaultStatements,
} from "../gateway/work-counters.js";
import { nowIso, uuidv7 } from "../ids.js";
import {
  currentReplicaLogState,
  replicaRowIdFromKeyJson,
} from "../replica/change-log.js";
import { placeBlob } from "./blobs.js";
import {
  closeOpenVaults,
  household,
  inCommit,
  placementAuthority,
  seedPhoto,
} from "./placement-fixture.js";
import type { SeededPhoto } from "./placement-fixture.js";
import { ingestShareTail, purgeShareShape } from "./subscription-seat.js";
import {
  readSubscription,
  readSubscriptionLineage,
} from "./subscription-store.js";
import { composeShareTail } from "./subscription-tail.js";

const ORIGIN_VAULT = "vault-priya";
const AUDIENCE_VAULT = "vault-family";

/** Compose the tail, hardlink its manifest, ingest, settle — one loopback pass. */
function deliver(
  origin: VaultDb,
  audience: VaultDb,
  input: { grantId: string; subjectId: string; subjectType?: "media.asset" }
): ReturnType<typeof ingestShareTail> {
  const standing = readSubscription(
    audience.vault,
    input.grantId,
    AUDIENCE_VAULT
  );
  const pass = composeShareTail({
    origin: origin.vault,
    originVaultId: ORIGIN_VAULT,
    audienceVaultId: AUDIENCE_VAULT,
    authorityId: input.grantId,
    subjectType: input.subjectType ?? "media.asset",
    subjectId: input.subjectId,
    ...(standing?.cursor.epoch == null
      ? {}
      : { since: { epoch: standing.cursor.epoch, seq: standing.cursor.seq } }),
  })!;
  for (const blob of pass.frame.blobs)
    placeBlob(origin.blobs.local, audience.blobs.local, blob.sha256);
  const result = ingestShareTail(audience.vault, pass.frame, {
    audienceVaultId: AUDIENCE_VAULT,
    now: nowIso(),
  });
  pass.settle();
  return result;
}

/**
 * The DOMAIN rows a pass touched — the delta a member's screens re-read.
 *
 * DISTINCT, because `updated_at`'s touch trigger writes a second log entry for
 * the same row on every update, member-authored ones included, and the replica
 * projection collapses a row to its latest entry per commit. The seat's own
 * cursor and lineage bookkeeping are `share_subscription*` rows: no app holds a
 * grant over them, so they wake no device. The log speaks PHYSICAL tables
 * since #1014 (R-1014-1), so the prefix does too.
 */
function changedRowsSince(db: VaultDb, seq: number): string[] {
  return (
    db.vault
      .prepare(
        `SELECT DISTINCT "table" AS entity, pk_json FROM replica_log
          WHERE epoch = ? AND seq > ? AND "table" NOT LIKE 'share\\_%' ESCAPE '\\'
          ORDER BY "table", pk_json`
      )
      .all(currentReplicaLogState(db.vault).epoch, seq) as {
      entity: string;
      pk_json: string;
    }[]
  ).map((row) => `${row.entity} ${replicaRowIdFromKeyJson(row.pk_json)}`);
}

function grantOver(origin: VaultDb, photo: SeededPhoto, party: string): string {
  placementAuthority(origin, "media.asset", [photo.assetId], party);
  return uuidv7();
}

function audienceAssetOf(audience: VaultDb): string {
  return (
    audience.vault.prepare("SELECT asset_id FROM media_asset").get() as {
      asset_id: string;
    }
  ).asset_id;
}

describe("share subscription", () => {
  afterEach(closeOpenVaults);

  test("the origin row version survives ingest", () => {
    const { origin, originBoot, audience } = household();
    const photo = inCommit(origin, () => seedPhoto(origin, originBoot, "a"));
    const grantId = grantOver(origin, photo, "audience-party");
    const result = deliver(origin, audience, {
      grantId,
      subjectId: photo.assetId,
    });
    expect(result.entered).toBeGreaterThan(0);

    const lineage = readSubscriptionLineage(audience.vault, grantId);
    const asset = lineage.find((row) => row.targetType === "media.asset");
    expect(asset?.originItemId).toBe(photo.assetId);
    expect(asset?.originRowVersion).toBeGreaterThan(0);
    expect(
      readSubscription(audience.vault, grantId, AUDIENCE_VAULT)?.cursor.seq
    ).toBeGreaterThan(0);
  });

  test("a one-field edit costs the audience one change row", () => {
    const { origin, originBoot, audience } = household();
    const photo = inCommit(origin, () => seedPhoto(origin, originBoot, "a"));
    const grantId = grantOver(origin, photo, "audience-party");
    deliver(origin, audience, { grantId, subjectId: photo.assetId });
    const audienceAsset = audienceAssetOf(audience);
    const before = currentReplicaLogState(audience.vault).watermark.seq;

    inCommit(origin, () =>
      origin.vault
        .prepare("UPDATE media_asset SET width = 1024 WHERE asset_id = ?")
        .run(photo.assetId)
    );

    const second = deliver(origin, audience, {
      grantId,
      subjectId: photo.assetId,
    });
    expect([second.entered, second.updated, second.left]).toStrictEqual([
      0, 1, 0,
    ]);
    expect(changedRowsSince(audience, before)).toStrictEqual([
      `media_asset ${audienceAsset}`,
    ]);
    expect(
      audience.vault
        .prepare("SELECT width FROM media_asset WHERE asset_id = ?")
        .get(audienceAsset)
    ).toMatchObject({ width: 1024 });
  });

  /**
   * #929 box 2, the work-counter half. `updated` is the audience's write count
   * for the pass, so a moved row set costs one write per moved row and wakes
   * exactly those rows' devices. The statement delta is recorded so a per-row
   * constant that grows shows up as an integer, not as a timing.
   */
  test("a moved row set costs one write per moved row", () => {
    const { origin, originBoot, audience } = household();
    const photo = inCommit(origin, () => seedPhoto(origin, originBoot, "a"));
    const grantId = grantOver(origin, photo, "audience-party");
    deliver(origin, audience, { grantId, subjectId: photo.assetId });
    const audienceAsset = audienceAssetOf(audience);
    instrumentVaultStatements(audience.vault);
    const before = currentReplicaLogState(audience.vault).watermark.seq;

    inCommit(origin, () => {
      origin.vault
        .prepare("UPDATE media_asset SET width = 1024 WHERE asset_id = ?")
        .run(photo.assetId);
      // A SECOND ROW, deliberately: since #996 (R20(b)) a photo's title lives
      // on the asset, so retitling would move the same row width just moved
      // and the claim under test — one write per moved row — would have one
      // row to count. The byte row's own language is the second thing moved.
      origin.vault
        .prepare(
          "UPDATE core_content_item SET language = 'en' WHERE content_id = ?"
        )
        .run(photo.contentId);
    });

    const countersBefore = gatewayWorkCounters();
    const second = deliver(origin, audience, {
      grantId,
      subjectId: photo.assetId,
    });
    const spent = diffCounters(countersBefore, gatewayWorkCounters());

    expect([second.entered, second.updated, second.left]).toStrictEqual([
      0, 2, 0,
    ]);
    const woken = changedRowsSince(audience, before);
    expect(woken).toHaveLength(2);
    expect(woken).toContain(`media_asset ${audienceAsset}`);
    // The counter is monotonic, so this only ever fences a regression upward.
    expect(spent.statements).toBeGreaterThan(0);
  });

  test("an unchanged subscription writes nothing on the audience", () => {
    const { origin, originBoot, audience } = household();
    const photo = inCommit(origin, () => seedPhoto(origin, originBoot, "a"));
    const grantId = grantOver(origin, photo, "audience-party");
    deliver(origin, audience, { grantId, subjectId: photo.assetId });
    const before = currentReplicaLogState(audience.vault).watermark.seq;
    const again = deliver(origin, audience, {
      grantId,
      subjectId: photo.assetId,
    });
    expect([again.entered, again.updated, again.left]).toStrictEqual([0, 0, 0]);
    expect(changedRowsSince(audience, before)).toStrictEqual([]);
  });

  test("a purge leaves the seat with nothing the origin answers for", () => {
    const { origin, originBoot, audience } = household();
    const photo = inCommit(origin, () => seedPhoto(origin, originBoot, "a"));
    const grantId = grantOver(origin, photo, "audience-party");
    deliver(origin, audience, { grantId, subjectId: photo.assetId });

    const purged = purgeShareShape(audience.vault, {
      authorityId: grantId,
      audienceVaultId: AUDIENCE_VAULT,
      now: nowIso(),
    });
    expect(purged.removed).toBeGreaterThan(0);
    expect(
      readSubscription(audience.vault, grantId, AUDIENCE_VAULT)?.state
    ).toBe("removed");
    expect(readSubscriptionLineage(audience.vault, grantId)).toStrictEqual([]);
    expect(
      audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
    ).toMatchObject({ n: 0 });
  });

  test("a tail addressed elsewhere is refused before anything lands", () => {
    const { origin, originBoot, audience } = household();
    const photo = inCommit(origin, () => seedPhoto(origin, originBoot, "a"));
    const grantId = grantOver(origin, photo, "audience-party");
    const pass = composeShareTail({
      origin: origin.vault,
      originVaultId: ORIGIN_VAULT,
      audienceVaultId: "vault-someone-else",
      authorityId: grantId,
      subjectType: "media.asset",
      subjectId: photo.assetId,
    })!;
    expect(() =>
      ingestShareTail(audience.vault, pass.frame, {
        audienceVaultId: AUDIENCE_VAULT,
        now: nowIso(),
      })
    ).toThrow(/addressed to/u);
    expect(
      audience.vault.prepare("SELECT COUNT(*) AS n FROM media_asset").get()
    ).toMatchObject({ n: 0 });
  });
});
