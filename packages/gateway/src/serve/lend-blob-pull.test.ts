/*
 * Pins the coupling `peer-blob-route.ts` names but does not enforce (#726
 * re-audit): `fillBorrowedBlobsOverPeer` hands the origin an `edgeId` for a
 * LENT (live) edge; the origin resolves it with `readEdgeRow`, which reads
 * `share_edges` — a table the LEND path never inserts into directly. It only
 * works because opening a live edge for a remote audience ALSO inserts a
 * `share_edges` row at the origin (`edges-routes.ts`'s `insertOrRead`, mirrored
 * here by `lend.test-fixtures.ts`'s `insertLiveEdgeRow`, and driven for real by
 * `openLiveEdge`). Nothing else pins that row's existence, so a refactor that
 * ever skips it would make every borrowed thumbnail 404 into "pending"
 * forever — a silent, permanent stall, not a fault. See the invariant comment
 * on `handlePeerBlobChunk`'s `readEdgeRow` call in `../routes/peer-blob-route.ts`.
 */

import { describe, expect, it } from "vitest";

import { syncBorrowedEdge } from "./lend-audience.js";
import {
  fillBorrowedBlobsOverPeer,
  pendingPinnedBlobs,
} from "./lend-blob-pull.js";
import { borrowedSlotsFor, lend } from "./lend.test-fixtures.js";
import {
  dialFrom,
  link,
  makeSide,
  routeFrom,
  seedPhoto,
} from "./peer-give.test-fixtures.js";

const PHOTO_SCOPES = [
  { schema: "core", table: "content_item" },
  { schema: "core", table: "content_derivative" },
  { schema: "media", table: "media_asset" },
];

describe("fillBorrowedBlobsOverPeer depends on the origin's share_edges row (#726 re-audit)", () => {
  it("pulls a pinned thumbnail for a live edge's id, resolved through share_edges at the origin", async () => {
    const origin = makeSide(`ada-blobpull-${crypto.randomUUID().slice(0, 8)}`);
    const audience = makeSide(
      `priya-blobpull-${crypto.randomUUID().slice(0, 8)}`
    );
    await link(origin, audience);
    const borrowed = borrowedSlotsFor(audience);
    const photo = seedPhoto(origin, "blobpull");
    const { edge, identity, pull } = await lend(origin, audience, borrowed, {
      edgeId: "edge-blobpull",
      itemType: "media.media_asset",
      scopes: PHOTO_SCOPES,
    });
    expect(edge.status).toBe("established");

    await syncBorrowedEdge(borrowed, identity, pull);
    const store = borrowed.storeFor(origin.vaultId);
    const cas = borrowed.casFor(origin.vaultId);
    const shape = store.shapeForEdge("edge-blobpull")!;
    expect(
      pendingPinnedBlobs(store, shape.shapeId, cas).map((b) => b.sha256)
    ).toStrictEqual([photo.thumbSha]);
    store.renewLease(shape.shapeId, "2000-01-01T00:00:00.000Z");

    const result = await fillBorrowedBlobsOverPeer({
      store,
      cas,
      shapeId: shape.shapeId,
      dial: dialFrom(audience, origin),
      route: routeFrom(audience, origin),
      identity,
      edgeId: "edge-blobpull",
      limit: 10,
    });

    expect(result.done).toStrictEqual([photo.thumbSha]);
    expect(
      Date.parse(store.shapeForEdge("edge-blobpull")!.leaseExpiresAt)
    ).toBeGreaterThan(Date.now());
    expect(cas.read(photo.thumbSha, origin.label)).toMatchObject({
      state: "resident",
      bytes: photo.thumbBytes,
    });
  });

  it("stalls the SAME pull as a permanent 'pending', never a fault, if the origin's share_edges row for that edge is ever absent", async () => {
    // Simulates the exact regression the coupling above is silent about: a
    // live edge established without (or after losing) its `share_edges` row.
    // This is the failure the invariant test above exists to catch before it
    // reaches here — this test documents WHAT that failure looks like: not
    // an exception, not a 500, an unending 'pending'.
    const origin = makeSide(
      `ada-blobpull-gap-${crypto.randomUUID().slice(0, 8)}`
    );
    const audience = makeSide(
      `priya-blobpull-gap-${crypto.randomUUID().slice(0, 8)}`
    );
    await link(origin, audience);
    const borrowed = borrowedSlotsFor(audience);
    const photo = seedPhoto(origin, "blobpull-gap");
    const { identity, pull } = await lend(origin, audience, borrowed, {
      edgeId: "edge-blobpull-gap",
      itemType: "media.media_asset",
      scopes: PHOTO_SCOPES,
    });
    await syncBorrowedEdge(borrowed, identity, pull);
    const store = borrowed.storeFor(origin.vaultId);
    const cas = borrowed.casFor(origin.vaultId);
    const shape = store.shapeForEdge("edge-blobpull-gap")!;

    // The row the give/lend flow is supposed to have written — removed here
    // to stand in for a future write path that forgets to write it.
    origin.gatewayDb.run(
      "DELETE FROM share_edges WHERE edge_id = ?",
      "edge-blobpull-gap"
    );

    const result = await fillBorrowedBlobsOverPeer({
      store,
      cas,
      shapeId: shape.shapeId,
      dial: dialFrom(audience, origin),
      route: routeFrom(audience, origin),
      identity,
      edgeId: "edge-blobpull-gap",
      limit: 10,
    });

    expect(result.pending).toStrictEqual([photo.thumbSha]);
    expect(result.done).toStrictEqual([]);
    expect(result.failed).toStrictEqual([]);
    expect(cas.has(photo.thumbSha)).toBe(false);
  });
});
