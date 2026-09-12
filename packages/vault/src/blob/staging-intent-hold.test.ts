// The staging band's INTENT hold (#1014, B5). An offline device stages bytes
// first and sends the claiming intent when it can; the 24-hour TTL used to
// reclaim those bytes out from under a write that was still coming. These
// tests pin the three bounds the hold has: an unsettled intent holds, a
// settled one releases at the ordinary TTL, and an intent that never returns
// releases at the hold's own, longer, bound.

import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import { nowIso } from "../ids.js";
import {
  holdStagingForIntent,
  releaseIntentHold,
  stageBlobBytes,
  sweepBlobStaging,
} from "./staging.js";

/** Two days back: past the 24-hour TTL, inside the week-long intent hold. */
function stagedLongAgo(db: ReturnType<typeof openVaultDb>, sha: string): void {
  db.vault
    .prepare("UPDATE blob_staging SET staged_at = ? WHERE sha256 = ?")
    .run(new Date(Date.now() - 48 * 3_600_000).toISOString(), sha);
}

function recordOutcome(
  db: ReturnType<typeof openVaultDb>,
  intentId: string,
  status: string
): void {
  db.vault
    .prepare(
      `INSERT INTO replica_intent_outcome
         (intent_id, device_id, app_id, action, payload_hash, status, created_at, updated_at)
       VALUES (?, 'device-1', 'photos', 'photos.upload', 'hash', ?, ?, ?)`
    )
    .run(intentId, status, nowIso(), nowIso());
}

describe("staging intent hold", () => {
  test("bytes an unsettled intent still needs survive the TTL sweep", () => {
    const db = openVaultDb();
    const staged = stageBlobBytes(db, {
      bytes: Buffer.from("queued behind a dead radio"),
      heldByIntent: "intent-1",
    });
    stagedLongAgo(db, staged.sha256);
    recordOutcome(db, "intent-1", "queued");

    expect(sweepBlobStaging(db, {}).expired).toStrictEqual([]);
    expect(db.blobs.hasSync(staged.sha256)).toBe(true);
  });

  test("a parked intent holds; the hold's own bound still releases it", () => {
    const db = openVaultDb();
    const staged = stageBlobBytes(db, {
      bytes: Buffer.from("parked for the owner"),
      heldByIntent: "intent-2",
    });
    stagedLongAgo(db, staged.sha256);
    recordOutcome(db, "intent-2", "parked");

    expect(sweepBlobStaging(db, {}).expired).toStrictEqual([]);
    // An intent that never comes back costs one hold window, not for ever.
    expect(sweepBlobStaging(db, { intentHoldHours: -1 }).expired).toStrictEqual(
      [staged.sha256]
    );
  });

  test("a settled intent releases the hold at the ordinary TTL", () => {
    const db = openVaultDb();
    const staged = stageBlobBytes(db, {
      bytes: Buffer.from("the write landed"),
      heldByIntent: "intent-3",
    });
    stagedLongAgo(db, staged.sha256);
    recordOutcome(db, "intent-3", "executed");

    expect(sweepBlobStaging(db, {}).expired).toStrictEqual([staged.sha256]);
  });

  test("the ingress door's hold reaches a row staged by any path", () => {
    const db = openVaultDb();
    const staged = stageBlobBytes(db, { bytes: Buffer.from("streamed in") });
    holdStagingForIntent(db.vault, staged.sha256, "intent-4");
    stagedLongAgo(db, staged.sha256);
    recordOutcome(db, "intent-4", "sending");

    expect(sweepBlobStaging(db, {}).expired).toStrictEqual([]);
    // A second intent does not steal a hold the first one still needs.
    holdStagingForIntent(db.vault, staged.sha256, "intent-5");
    const held = db.vault
      .prepare("SELECT held_by_intent FROM blob_staging WHERE sha256 = ?")
      .get(staged.sha256) as { held_by_intent: string };
    expect(held.held_by_intent).toBe("intent-4");

    releaseIntentHold(db.vault, "intent-4");
    expect(sweepBlobStaging(db, {}).expired).toStrictEqual([staged.sha256]);
  });
});
