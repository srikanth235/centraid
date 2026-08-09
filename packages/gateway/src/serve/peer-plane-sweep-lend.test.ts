/*
 * Exit evidence for #726 P4 reach: closing the two gaps the core lend agent
 * flagged rather than leaving them as a live edge that LOOKS established
 * while doing nothing.
 *
 *  - The sweep must actually DRIVE `syncBorrowedEdge` per live edge, not just
 *    sweep lease expiry — proved here by never calling `syncBorrowedEdge`
 *    directly, only `sweep.runOnce()`, and watching rows land anyway.
 *  - The borrowed CAS must actually be FILLED by the puller — proved by
 *    asserting the pinned thumb's bytes are resident after a tick, pulled
 *    ranged over the SAME `/centraid/_peer/blob/chunk` frame a give uses.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";
import { bootstrappedVault } from "@centraid/test-kit/vault";
import {
  bootstrapVault,
  openVaultDb,
  signWithVaultIdentity,
  vaultIdentityPublicKey,
} from "@centraid/vault";
import type { ShareVaultRef } from "@centraid/vault";

import { BorrowedSlots } from "./borrowed-slots.js";
import { GatewayDatabase } from "./gateway-db.js";
import { recordBorrowedEdge } from "./lend-audience.js";
import { setBudget } from "./lend-budget-settings.js";
import { openLentEdge } from "./lend-origin.js";
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
  seedPhoto,
} from "./peer-give.test-fixtures.js";
import { createPeerPlaneSweep } from "./peer-plane-sweep.js";
import { VaultLinksStore } from "./vault-links-store.js";

const LIST_SCOPES = [
  { schema: "core", table: "collection" },
  { schema: "core", table: "collection_entry" },
];

const PHOTO_SCOPES = [
  { schema: "core", table: "content_item" },
  { schema: "core", table: "content_derivative" },
  { schema: "media", table: "media_asset" },
];

/** Reaches past the public API on purpose — `state`/`reason` are the ledger
 *  facts item 8's exit evidence is actually about. */
function borrowedEdgeState(
  db: GatewayDatabase,
  edgeId: string
): { state: string; reason: string | null } {
  return db.db
    .prepare("SELECT state, reason FROM borrowed_edges WHERE edge_id = ?")
    .get(edgeId) as { state: string; reason: string | null };
}

describe("the peer-plane sweep drives a live borrowed edge (#726 P4 reach)", () => {
  it("bootstraps and tails a REMOTE edge on ticks alone, no syncBorrowedEdge call", async () => {
    const origin = makeSide(`ada-${crypto.randomUUID().slice(0, 8)}`);
    const audience = makeSide(`priya-${crypto.randomUUID().slice(0, 8)}`);
    await link(origin, audience);
    const borrowed = borrowedSlotsFor(audience);
    const list = seedList(origin, "Groceries", 2);
    const { edge } = await lend(origin, audience, borrowed, {
      edgeId: "edge-sweep-tail",
      itemType: "core.collection",
      scopes: LIST_SCOPES,
    });
    expect(edge.status).toBe("established");

    const sweep = createPeerPlaneSweep({
      db: audience.gatewayDb,
      links: audience.links,
      vaultFor: () => undefined, // force the REMOTE path — nothing is co-hosted here
      dial: () => dialFrom(audience, origin),
      borrowed,
    });

    // First tick: the edge never bootstrapped (only `lend/open` landed the
    // `borrowed_edges` row) — the sweep alone must bring the rows over.
    await sweep.runOnce();
    const store = borrowed.storeFor(origin.vaultId);
    const shape = store.shapeForEdge("edge-sweep-tail");
    expect(shape).toBeDefined();
    expect(store.rows(shape!.shapeId, "core.collection_entry")).toHaveLength(2);

    // A row lands at the origin AFTER the sweep already ran once. No new
    // ceremony, no direct call — the NEXT tick alone must pick it up.
    addListEntry(origin, list.collectionId, 2);
    await sweep.runOnce();
    expect(store.rows(shape!.shapeId, "core.collection_entry")).toHaveLength(3);
    // The sweep's own bookkeeping says so too — not just the store's rows.
    // `borrowedEdgeState` returns a row straight off the SQLite driver, on
    // its own prototype — `toStrictEqual` would fail on that provenance, not
    // on the data, so this stays `toEqual`.
    // oxlint-disable-next-line vitest/prefer-strict-equal -- see comment above
    expect(borrowedEdgeState(audience.gatewayDb, "edge-sweep-tail")).toEqual({
      state: "established",
      reason: null,
    });
  });

  it("fills the borrowed CAS with a pinned thumbnail over the ranged peer pull", async () => {
    const origin = makeSide(`ada-photo-${crypto.randomUUID().slice(0, 8)}`);
    const audience = makeSide(`priya-photo-${crypto.randomUUID().slice(0, 8)}`);
    await link(origin, audience);
    const borrowed = borrowedSlotsFor(audience);
    const photo = seedPhoto(origin, "cover");
    await lend(origin, audience, borrowed, {
      edgeId: "edge-sweep-blobs",
      itemType: "media.media_asset",
      scopes: PHOTO_SCOPES,
    });

    const sweep = createPeerPlaneSweep({
      db: audience.gatewayDb,
      links: audience.links,
      vaultFor: () => undefined,
      dial: () => dialFrom(audience, origin),
      borrowed,
    });
    await sweep.runOnce();

    const cas = borrowed.casFor(origin.vaultId);
    // The pinned rung actually arrived — the tile can paint offline.
    expect(cas.has(photo.thumbSha)).toBe(true);
    expect(cas.read(photo.thumbSha, origin.label)).toMatchObject({
      state: "resident",
      bytes: photo.thumbBytes,
    });
    // The original is never a background duty — it stays an honest "at
    // <person>'s vault" until something actually asks for it.
    expect(cas.has(photo.sha256)).toBe(false);
    expect(cas.read(photo.sha256, origin.label)).toStrictEqual({
      state: "at-origin",
      holder: origin.label,
    });
  });

  it("tails a CO-HOSTED edge with NO dial at all — locality is routing, not semantics", async () => {
    const root = tempDirSync("centraid-sweep-cohosted-");
    const db = GatewayDatabase.open(root);
    const originVaultId = "vault-origin";
    const audienceVaultId = "vault-audience";
    const originBoot = bootstrappedVault(
      { openVaultDb, bootstrapVault },
      {
        dir: path.join(root, "vaults", "origin"),
        ownerName: "Ada",
        vaultId: originVaultId,
      }
    );
    const originRef: ShareVaultRef = originBoot.db;
    const links = new VaultLinksStore(db);
    const borrowed = new BorrowedSlots(db, path.join(root, "data"));

    const collectionId = crypto.randomUUID();
    originBoot.db.vault
      .prepare(
        `INSERT INTO core_collection
           (collection_id, owner_party_id, name, cover_content_id,
            parent_collection_id, sort_order, created_at)
         VALUES (?, ?, 'Groceries', NULL, NULL, 0, ?)`
      )
      .run(
        collectionId,
        originBoot.boot.ownerPartyId,
        new Date().toISOString()
      );

    const signAsVault = (vaultId: string, bytes: Buffer) =>
      vaultId === originVaultId
        ? signWithVaultIdentity(originBoot.db.identitySeed, bytes)
        : undefined;

    // The origin's own bookkeeping (mints the grant + `lent_edges` row) and
    // the audience's own bookkeeping (`borrowed_edges`) both live in the
    // SAME gateway.db here, which is what "co-hosted" means.
    openLentEdge(db, originRef, {
      edgeId: "edge-cohosted",
      originVaultId,
      audienceVaultId,
      audienceLabel: "Priya",
      itemType: "core.collection",
      scopes: [{ schema: "core", table: "collection" }],
      verbs: "read",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    recordBorrowedEdge(db, {
      edgeId: "edge-cohosted",
      originVaultId,
      audienceVaultId,
      originPublicKey: vaultIdentityPublicKey(
        originBoot.db.identitySeed
      ).toString("base64"),
      holderLabel: "Ada",
      itemType: "core.collection",
      linkId: "local:edge-cohosted",
    });

    const sweep = createPeerPlaneSweep({
      db,
      links,
      vaultFor: (vaultId) =>
        vaultId === originVaultId ? originRef : undefined,
      dial: () => undefined, // no peer transport wired at all
      borrowed,
      signAsVault,
    });
    await sweep.runOnce();

    const store = borrowed.storeFor(originVaultId);
    const shape = store.shapeForEdge("edge-cohosted");
    expect(shape).toBeDefined();
    expect(store.rows(shape!.shapeId, "core.collection")).toHaveLength(1);
  });

  it("parks for byte budget — distinguishably from unreachable — and resumes when it frees", async () => {
    const origin = makeSide(`ada-budget-${crypto.randomUUID().slice(0, 8)}`);
    const audience = makeSide(
      `priya-budget-${crypto.randomUUID().slice(0, 8)}`
    );
    await link(origin, audience);
    const borrowed = borrowedSlotsFor(audience);
    const photo = seedPhoto(origin, "cover");
    await lend(origin, audience, borrowed, {
      edgeId: "edge-sweep-budget",
      itemType: "media.media_asset",
      scopes: PHOTO_SCOPES,
    });

    // A budget too small for even one thumbnail — the pull must park, not
    // error, and the ROWS still land (budget governs bytes, not rows).
    const parkedSweep = createPeerPlaneSweep({
      db: audience.gatewayDb,
      links: audience.links,
      vaultFor: () => undefined,
      dial: () => dialFrom(audience, origin),
      borrowed,
      borrowedByteBudgetBytes: 0,
    });
    await parkedSweep.runOnce();

    const cas = borrowed.casFor(origin.vaultId);
    expect(cas.has(photo.thumbSha)).toBe(false);
    const parked = borrowedEdgeState(audience.gatewayDb, "edge-sweep-budget");
    expect(parked.state).toBe("parked");
    expect(parked.reason).toMatch(/budget/u);
    // Distinguishable from the unreachable-flavoured park this same function
    // writes — never the same reason text.
    expect(parked.reason).not.toMatch(/unreachable/u);

    // The budget frees (an owner would free it by revoking something else,
    // or raising the knob) — the VERY NEXT tick alone resumes, with no
    // separate "unpark" ceremony: the check is live, not sticky.
    const resumedSweep = createPeerPlaneSweep({
      db: audience.gatewayDb,
      links: audience.links,
      vaultFor: () => undefined,
      dial: () => dialFrom(audience, origin),
      borrowed,
      borrowedByteBudgetBytes: 10_000,
    });
    await resumedSweep.runOnce();
    expect(cas.has(photo.thumbSha)).toBe(true);
    // See the comment on the earlier `borrowedEdgeState` assertion: SQLite
    // driver rows, own prototype, `toEqual` not `toStrictEqual`.
    // oxlint-disable-next-line vitest/prefer-strict-equal -- see comment above
    expect(borrowedEdgeState(audience.gatewayDb, "edge-sweep-budget")).toEqual({
      state: "established",
      reason: null,
    });
  });

  it("a per-link budget (#726 P6 gap 2) parks and resumes independently of the build-wide default", async () => {
    const origin = makeSide(
      `ada-linkbudget-${crypto.randomUUID().slice(0, 8)}`
    );
    const audience = makeSide(
      `priya-linkbudget-${crypto.randomUUID().slice(0, 8)}`
    );
    await link(origin, audience);
    const borrowed = borrowedSlotsFor(audience);
    const photo = seedPhoto(origin, "cover");
    await lend(origin, audience, borrowed, {
      edgeId: "edge-link-budget",
      itemType: "media.media_asset",
      scopes: PHOTO_SCOPES,
    });
    const linkId = audience.links.findPair(
      origin.vaultId,
      audience.vaultId
    )!.linkId;

    // No `borrowedByteBudgetBytes` at all on the sweep — the DEFAULT would be
    // the generous 20GiB constant and this pull would sail through. The
    // per-link row alone must be what parks it.
    setBudget(audience.gatewayDb, linkId, audience.vaultId, 0);
    const parkedSweep = createPeerPlaneSweep({
      db: audience.gatewayDb,
      links: audience.links,
      vaultFor: () => undefined,
      dial: () => dialFrom(audience, origin),
      borrowed,
    });
    await parkedSweep.runOnce();

    const cas = borrowed.casFor(origin.vaultId);
    expect(cas.has(photo.thumbSha)).toBe(false);
    const parked = borrowedEdgeState(audience.gatewayDb, "edge-link-budget");
    expect(parked.state).toBe("parked");
    expect(parked.reason).toMatch(/budget/u);
    expect(parked.reason).not.toMatch(/unreachable/u);

    // Raising the SAME per-link knob — no separate unpark step, no sweep
    // restart — the very next tick resumes.
    setBudget(audience.gatewayDb, linkId, audience.vaultId, 10_000);
    await parkedSweep.runOnce();
    expect(cas.has(photo.thumbSha)).toBe(true);
    // See the comment on the earlier `borrowedEdgeState` assertion: SQLite
    // driver rows, own prototype, `toEqual` not `toStrictEqual`.
    // oxlint-disable-next-line vitest/prefer-strict-equal -- see comment above
    expect(borrowedEdgeState(audience.gatewayDb, "edge-link-budget")).toEqual({
      state: "established",
      reason: null,
    });
  });
});
