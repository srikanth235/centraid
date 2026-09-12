/*
 * EVERY WRITE CARRIES A BASE VERSION (#1014, R18).
 *
 * The guard against a silent overwrite is `base_versions_json`: the version
 * the seat observed on the row it is editing. The seat used to drop it for
 * every row a still-queued intent had upserted — so the second edit of a
 * photograph, and the trash that followed it, went out with `[]` and the
 * gateway had nothing to refuse them against. Paired with an outbox that
 * never settled, that meant a row lost its precondition on the first write
 * and never got it back (R23, R24).
 *
 * The rule the chain actually needs is narrower: only a row a queued
 * predecessor will MINT has nothing to observe. Everything else has a real
 * version, and the gateway rebases it onto the parent's produced version
 * before checking it.
 */
import { describe, expect, test } from "vitest";

import { projectPendingWrite } from "@centraid/blueprints/apps/_shared/pending-overlay";
import { pendingProjectionFor } from "@centraid/blueprints/apps/_shared/pending-projections";

import { IntentQueue } from "./intents.js";
import { MemoryIntentStore } from "./memory-intent-store.js";
import { chainBaseVersions, mintedRowIndex } from "./offline-chain.js";
import type { OptimisticMutation, ReplicaBaseVersion } from "./types.js";

const ASSET = "asset-9";

/** What `seatBaseVersions` would answer for a row the seat already holds. */
const observed = (rowId = ASSET, version = 47): ReplicaBaseVersion[] => [
  { entity: "media.asset", rowId, version },
];

function projected(action: string, intentId: string) {
  return projectPendingWrite(pendingProjectionFor("photos"), {
    appId: "photos",
    action,
    input: { asset_id: ASSET },
    intentId,
  }).optimistic as OptimisticMutation[];
}

describe("a chained write's base versions", () => {
  test("an edit behind an unsettled edit of the same row still states a base", async () => {
    const store = new MemoryIntentStore();
    const queue = new IntentQueue(store);
    const first = await queue.enqueue({
      appId: "photos",
      action: "update-asset",
      input: { asset_id: ASSET, captured_at: "2024-01-01T00:00:00Z" },
      optimistic: projected("update-asset", "intent-1"),
      baseVersions: observed(),
    });
    expect(first.baseVersions).toStrictEqual(observed());

    const second = await queue.enqueue({
      appId: "photos",
      action: "update-asset",
      input: { asset_id: ASSET, captured_at: "2024-02-02T00:00:00Z" },
      optimistic: projected("update-asset", "intent-2"),
      baseVersions: observed(),
    });
    // The whole finding: this used to be `undefined` — no precondition at all.
    expect(second.baseVersions).toStrictEqual(observed());
  });

  test("a trash behind an unsettled edit of the same row still states a base", async () => {
    const store = new MemoryIntentStore();
    const queue = new IntentQueue(store);
    await queue.enqueue({
      appId: "photos",
      action: "update-asset",
      input: { asset_id: ASSET, captured_at: "2024-01-01T00:00:00Z" },
      optimistic: projected("update-asset", "intent-1"),
      baseVersions: observed(),
    });
    const trashed = await queue.enqueue({
      appId: "photos",
      action: "delete-asset",
      input: { asset_id: ASSET },
      optimistic: projected("delete-asset", "intent-2"),
      baseVersions: observed(),
    });
    expect(trashed.baseVersions).toStrictEqual(observed());
  });

  test("a hard delete states a base too", async () => {
    const store = new MemoryIntentStore();
    const queue = new IntentQueue(store);
    await queue.enqueue({
      appId: "photos",
      action: "update-asset",
      input: { asset_id: ASSET, captured_at: "2024-01-01T00:00:00Z" },
      optimistic: projected("update-asset", "intent-1"),
      baseVersions: observed(),
    });
    const purged = await queue.enqueue({
      appId: "photos",
      action: "purge-asset",
      input: { asset_id: ASSET },
      optimistic: projected("purge-asset", "intent-2"),
      baseVersions: observed(),
    });
    expect(purged.baseVersions).toStrictEqual(observed());
  });

  test("a row only a queued predecessor will mint still states nothing", () => {
    const minted = mintedRowIndex([
      {
        intentId: "intent-1",
        appId: "photos",
        action: "create-album",
        input: {},
        state: "queued",
        attempts: 0,
        createdOrder: 1,
        optimistic: [
          {
            op: "upsert",
            entity: "core.collection",
            rowId: "pending-album",
            values: {},
          },
        ],
        dependencies: [],
        payloadHash: "x",
      },
    ]);
    expect(minted.get("pending-album")?.synthetic).toBe(true);
    expect(
      chainBaseVersions(
        [{ entity: "core.collection", rowId: "pending-album", version: 1 }],
        minted
      )
    ).toStrictEqual([]);
  });
});
