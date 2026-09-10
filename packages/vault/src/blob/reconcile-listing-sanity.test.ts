/*
 * SANITY BEFORE A DESTRUCTIVE DIFF (#1014, B23).
 *
 * Reconcile deletes every listed key the live model does not claim, and took
 * the listing entirely on trust: a misconfigured endpoint answering for
 * ANOTHER prefix, or a provider mid-outage returning a short page, produced a
 * listing that looked authoritative and the sweep deleted against it.
 */

import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { BLOB_CACHE_DDL } from "../schema/blob.js";
import type { BlobCache } from "./cache.js";
import { reconcileCustody } from "./custody-reconcile.js";
import type { ReconcileContext } from "./custody-reconcile.js";
import { MemoryBlobStore } from "./local.js";
import { ReplicaIndex } from "./replica-index.js";
import { sha256OfBytes } from "./store.js";

const SHA = (s: string): string => sha256OfBytes(Buffer.from(s));

function memDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(BLOB_CACHE_DDL);
  return db;
}

interface Harness {
  ctx: { -readonly [K in keyof ReconcileContext]: ReconcileContext[K] };
  remote: MemoryBlobStore;
  replica: ReplicaIndex;
}

function harness(): Harness {
  const remote = new MemoryBlobStore();
  const local = new MemoryBlobStore();
  const replica = new ReplicaIndex(memDb());
  const ctx: ReconcileContext = {
    remote: { store: remote },
    local,
    // Only `replica` is read by the gate; a partial cache keeps this suite off
    // the whole eviction machine.
    cache: { replica } as unknown as BlobCache,
    desiredStore: () => "cas",
    open: () => Promise.resolve(),
    replicate: (shas) => Promise.resolve(shas),
  };
  return { ctx, remote, replica };
}

describe("reconcile listing sanity", () => {
  test("never deletes a listed key that is not a content address", async () => {
    // `MemoryBlobStore` refuses a non-sha key at PUT, which is the point: only
    // the LISTING can carry one, so the store has to be a stub here.
    const { ctx, replica } = harness();
    const mine = SHA("mine");
    const deleted: string[] = [];
    const foreign = "someone-elses/object.txt";
    replica.mark(mine, 4, "cas");
    ctx.remote = {
      store: {
        list: () => Promise.resolve([foreign, mine]),
        delete: (key: string) => {
          deleted.push(key);
          return Promise.resolve();
        },
      } as unknown as NonNullable<ReconcileContext["remote"]>["store"],
    };

    const result = await reconcileCustody(ctx, new Set([mine]), {});

    expect(deleted).toStrictEqual([]);
    expect(result.orphansDeleted).toStrictEqual([]);
    expect(result.listingsRefused[0]?.reason).toContain(
      "not content addresses"
    );
  });

  test("skips the orphan delete when the listing is far below this host's evidence", async () => {
    const { ctx, remote, replica } = harness();
    // Ten objects pushed and proven; the listing answers with one.
    for (let i = 0; i < 10; i++) replica.mark(SHA(`pushed-${i}`), 4, "cas");
    const stray = SHA("pushed-0");
    remote.putSync(stray, Buffer.from("x"));

    const result = await reconcileCustody(ctx, new Set(), {});

    // Spared, and reported as spared — the same shape `skipOrphanDelete` gives.
    expect(result.orphansDeleted).toStrictEqual([]);
    expect(result.orphansSkipped).toStrictEqual([stray]);
    expect(remote.hasSync(stray)).toBe(true);
    expect(result.listingsRefused[0]).toMatchObject({ store: "cas" });
    expect(result.listingsRefused[0]?.reason).toContain("evidence of 10");
  });

  test("a listing that clears the bound still deletes its orphans", async () => {
    const { ctx, remote, replica } = harness();
    for (let i = 0; i < 4; i++) {
      const sha = SHA(`pushed-${i}`);
      replica.mark(sha, 4, "cas");
      remote.putSync(sha, Buffer.from("x"));
    }
    const live = SHA("pushed-0");

    const result = await reconcileCustody(ctx, new Set([live]), {});

    expect(result.listingsRefused).toStrictEqual([]);
    expect(result.orphansDeleted).toHaveLength(3);
    expect(remote.hasSync(live)).toBe(true);
  });
});
