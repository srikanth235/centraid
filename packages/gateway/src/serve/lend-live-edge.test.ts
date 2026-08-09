/*
 * Exit evidence for P4 lend/read (#726). Two in-process gateways over the
 * same peer transport `peer-link-ceremony.test.ts` uses — every frame below
 * goes through the real `/centraid/_peer/lend/*` handlers.
 *
 * The claim under test throughout: an edge is no longer a snapshot. The
 * audience holds a WINDOW onto rows that still live at the origin, the origin
 * can close it, and the audience forgets on its own schedule if nobody tells
 * it anything at all.
 */

import { describe, expect, it } from "vitest";

import { closeLiveEdge } from "../routes/edges-live.js";
import { readEdgeRow } from "../routes/edges-reconcile.js";
import { custodyForRung } from "./borrowed-cas.js";
import {
  dropBorrowedEdge,
  sweepExpiredBorrowedEdges,
  syncBorrowedEdge,
} from "./lend-audience.js";
import { closeLendOverPeer } from "./lend-client.js";
import { readLentEdge } from "./lend-origin.js";
import {
  addListEntry,
  borrowedSlotsFor,
  lend,
  seedList,
} from "./lend.test-fixtures.js";
import {
  dialFrom,
  link,
  makeSide,
  routeFrom,
} from "./peer-give.test-fixtures.js";

const LIST_SCOPES = [
  { schema: "core", table: "collection" },
  { schema: "core", table: "collection_entry" },
];

function receiptsFor(
  side: ReturnType<typeof makeSide>,
  edgeId: string
): Array<{ action: string }> {
  return side.gatewayDb.db
    .prepare("SELECT action FROM share_access_receipts WHERE edge_id = ?")
    .all(edgeId) as Array<{ action: string }>;
}

async function lentList(edgeId = "edge-live-1") {
  const origin = makeSide(`ada-${crypto.randomUUID().slice(0, 8)}`);
  const audience = makeSide(`priya-${crypto.randomUUID().slice(0, 8)}`);
  await link(origin, audience);
  const borrowed = borrowedSlotsFor(audience);
  const list = seedList(origin, "Groceries", 2);
  const opened = await lend(origin, audience, borrowed, {
    edgeId,
    itemType: "core.collection",
    scopes: LIST_SCOPES,
  });
  return { origin, audience, borrowed, list, ...opened };
}

describe("a live edge lends a scope rather than copying items", () => {
  it("lends a list and keeps it growing without a second ceremony", async () => {
    const { origin, audience, borrowed, list, edge, identity, pull } =
      await lentList();
    // The origin's edge is ESTABLISHED, not completed: nothing finished.
    expect(edge.status).toBe("established");

    const first = await syncBorrowedEdge(borrowed, identity, pull);
    expect(first.state).toBe("established");
    const store = borrowed.storeFor(origin.vaultId);
    const shape = store.shapeForEdge(identity.edgeId)!;
    expect(store.rows(shape.shapeId, "core.collection_entry")).toHaveLength(2);

    // A row appears at the origin AFTER the window opened. No new edge, no new
    // link ceremony, no re-open frame — just the next tail.
    addListEntry(origin, list.collectionId, 2);
    const second = await syncBorrowedEdge(borrowed, identity, pull);
    expect(second.state).toBe("established");
    expect(
      borrowed
        .storeFor(origin.vaultId)
        .rows(shape.shapeId, "core.collection_entry")
    ).toHaveLength(3);
    expect(readEdgeRow(origin.gatewayDb, identity.edgeId)?.status).toBe(
      "established"
    );
    // The rows landed in the AUDIENCE's borrowed slot, never in its vault.
    expect(
      audience.vault.vault
        .prepare("SELECT count(*) AS n FROM core_collection_entry")
        .get()
    ).toMatchObject({ n: 0 });
  });

  it("honours a field mask and a row filter on the wire", async () => {
    const origin = makeSide(`ada-mask`);
    const audience = makeSide(`priya-mask`);
    await link(origin, audience);
    const borrowed = borrowedSlotsFor(audience);
    const lent = seedList(origin, "Lent", 2);
    const secret = seedList(origin, "Private", 3);

    const opened = await lend(origin, audience, borrowed, {
      edgeId: "edge-masked",
      itemType: "core.collection",
      scopes: [
        {
          schema: "core",
          table: "collection",
          rowFilter: [
            { column: "collection_id", op: "eq", value: lent.collectionId },
          ],
          fieldMask: ["collection_id", "name"],
        },
        {
          schema: "core",
          table: "collection_entry",
          rowFilter: [
            { column: "collection_id", op: "eq", value: lent.collectionId },
          ],
        },
      ],
    });
    await expect(
      syncBorrowedEdge(borrowed, opened.identity, opened.pull)
    ).resolves.toMatchObject({ state: "established" });
    const store = borrowed.storeFor(origin.vaultId);
    const shape = store.shapeForEdge("edge-masked")!;

    const collections = store.rows(shape.shapeId, "core.collection");
    expect(collections).toHaveLength(1);
    expect(collections[0]!.values.name).toBe("Lent");
    // The mask is not a display rule — the excluded columns never crossed.
    expect(Object.keys(collections[0]!.values).sort()).toStrictEqual([
      "collection_id",
      "name",
    ]);
    // And the filtered-out list is absent entirely, entries and all.
    const entries = store.rows(shape.shapeId, "core.collection_entry");
    expect(entries).toHaveLength(2);
    expect(entries.some((row) => secret.entryIds.includes(row.rowId))).toBe(
      false
    );
  });

  it("a row filter cannot leak an unentitled row through search pagination (#726 P4 D10)", async () => {
    const origin = makeSide(`ada-rowfilter-search`);
    const audience = makeSide(`priya-rowfilter-search`);
    await link(origin, audience);
    const borrowed = borrowedSlotsFor(audience);
    const lent = seedList(origin, "Lent", 2);
    // No fieldMask on this scope — only a row filter — so a leak here would
    // be the row filter's fault, not a mask refusal's.
    seedList(origin, "TopSecretPrivateName", 3);

    const opened = await lend(origin, audience, borrowed, {
      edgeId: "edge-rowfilter-search",
      itemType: "core.collection",
      scopes: [
        {
          schema: "core",
          table: "collection",
          rowFilter: [
            { column: "collection_id", op: "eq", value: lent.collectionId },
          ],
        },
      ],
    });
    await expect(
      syncBorrowedEdge(borrowed, opened.identity, opened.pull)
    ).resolves.toMatchObject({ state: "established" });
    const store = borrowed.storeFor(origin.vaultId);
    const shape = store.shapeForEdge("edge-rowfilter-search")!;

    // Fully searchable — no field mask means no refusal, so a miss here is
    // an honest miss, not a REFUSED entity in disguise.
    expect(store.searchableEntities(shape.shapeId).refused).toStrictEqual([]);

    // A LIMIT of 1000 finds nothing: the filtered-out collection's name
    // never crossed, so there is no row for the FTS index to hold, let
    // alone page past.
    const leaked = store.search(shape.shapeId, "TopSecretPrivateName", 1000);
    expect(leaked.rows).toStrictEqual([]);
    expect(leaked.refusedEntities).toStrictEqual([]);

    const found = store.search(shape.shapeId, "Lent", 1000);
    expect(found.rows).toHaveLength(1);
    expect(found.rows[0]!.values.name).toBe("Lent");
  });

  it("revokes: the shape is gone at the audience and the deletion is receipted", async () => {
    const { origin, audience, borrowed, identity, pull } =
      await lentList("edge-revoke");
    await syncBorrowedEdge(borrowed, identity, pull);
    expect(
      borrowed.storeFor(origin.vaultId).shapeForEdge("edge-revoke")
    ).toBeDefined();

    const closed = await closeLiveEdge({
      db: origin.gatewayDb,
      row: readEdgeRow(origin.gatewayDb, "edge-revoke")!,
      origin: origin.vault,
      route: routeFrom(origin, audience),
      peerDial: dialFrom(origin, audience, borrowed),
    });
    expect(closed.status).toBe("revoked");
    expect(
      borrowed.storeFor(origin.vaultId).shapeForEdge("edge-revoke")
    ).toBeUndefined();
    // `receiptsFor` returns rows straight off the SQLite driver, on its own
    // prototype — `toStrictEqual` would fail on that provenance, not on the
    // data, so this stays `toEqual`.
    // oxlint-disable-next-line vitest/prefer-strict-equal -- see comment above
    expect(receiptsFor(audience, "edge-revoke")).toEqual([
      { action: "unshare" },
    ]);
    // Refusal at the origin, said twice: the per-stream authorize AND the
    // grant. A later pull learns nothing it could act on.
    expect(
      readLentEdge(origin.gatewayDb, "edge-revoke")?.revoked_at
    ).not.toBeNull();
    await expect(
      pull({
        frame: "changes",
        edgeId: "edge-revoke",
        since: { epoch: "x", seq: 0 },
      })
    ).resolves.toMatchObject({ state: "not_found" });
  });

  it("drops the store unprompted once the lease has run out", async () => {
    const { origin, borrowed, identity, pull } = await lentList("edge-expiry");
    await syncBorrowedEdge(borrowed, identity, pull);
    const store = borrowed.storeFor(origin.vaultId);
    const shape = store.shapeForEdge("edge-expiry")!;
    expect(Date.parse(shape.leaseExpiresAt)).toBeGreaterThan(Date.now());

    // Pretend the audience went offline right after the lease was minted and
    // stayed offline past its term. Nothing below touches the network.
    store.renewLease(shape.shapeId, "2020-01-01T00:00:00.000Z");
    const dropped = sweepExpiredBorrowedEdges(borrowed);

    expect(dropped).toStrictEqual([
      { edgeId: "edge-expiry", originVaultId: origin.vaultId },
    ]);
    expect(store.shapeForEdge("edge-expiry")).toBeUndefined();
    expect(store.rowCount(shape.shapeId)).toBe(0);
  });

  it("clears the same shape when the AUDIENCE drops the edge", async () => {
    const { origin, audience, borrowed, identity, pull } =
      await lentList("edge-audience-drop");
    await syncBorrowedEdge(borrowed, identity, pull);

    // The borrower's own decision, down the SAME deletion path a revocation
    // takes — then a courtesy close so the lender stops holding the window.
    dropBorrowedEdge(borrowed, identity, "I no longer want this");
    await closeLendOverPeer({
      dial: dialFrom(audience, origin),
      route: routeFrom(audience, origin),
      edgeId: "edge-audience-drop",
    });

    expect(
      borrowed.storeFor(origin.vaultId).shapeForEdge("edge-audience-drop")
    ).toBeUndefined();
    // See the comment on the other `receiptsFor` assertion above: SQLite
    // driver rows, own prototype, `toEqual` not `toStrictEqual`.
    // oxlint-disable-next-line vitest/prefer-strict-equal -- see comment above
    expect(receiptsFor(audience, "edge-audience-drop")).toEqual([
      { action: "unshare" },
    ]);
    expect(
      readLentEdge(origin.gatewayDb, "edge-audience-drop")?.revoked_at
    ).not.toBeNull();
  });

  it("renders an unreachable original as at the lender's vault", async () => {
    const { origin, borrowed, identity, pull } = await lentList("edge-custody");
    await syncBorrowedEdge(borrowed, identity, pull);
    const store = borrowed.storeFor(origin.vaultId);
    const cas = borrowed.casFor(origin.vaultId);
    const shape = store.shapeForEdge("edge-custody")!;

    const thumb = Buffer.from("thumb-bytes");
    const original = Buffer.from("original-bytes-much-larger");
    cas.put(store, shape.shapeId, {
      sha256: "a".repeat(64),
      rung: "thumb",
      bytes: thumb,
    });
    cas.put(store, shape.shapeId, {
      sha256: "b".repeat(64),
      rung: "original",
      bytes: original,
    });
    expect(custodyForRung("thumb")).toBe("pinned");
    expect(custodyForRung("original")).toBe("at-origin");

    // Reclaim under pressure: the viewer seat gives back the lender's bytes.
    const freed = cas.reclaim(store, shape.shapeId, original.length);
    expect(freed).toStrictEqual(["b".repeat(64)]);

    // The tile still paints…
    expect(cas.read("a".repeat(64), identity.holderLabel)).toMatchObject({
      state: "resident",
    });
    // …and the original is an honest STATE naming a person, not an error.
    expect(cas.read("b".repeat(64), identity.holderLabel)).toStrictEqual({
      state: "at-origin",
      holder: identity.holderLabel,
    });
  });
});
