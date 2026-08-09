// Shared fixture vocabulary for the live-edge suites (#726 P4), layered on
// `peer-give.test-fixtures.ts`'s "two gateways, one process" harness so the
// lend tests exercise the SAME peer transport the give tests do.
import crypto from "node:crypto";
import path from "node:path";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { openLiveEdge } from "../routes/edges-live.js";
import { readEdgeRow } from "../routes/edges-reconcile.js";
import type { EdgeRow } from "../routes/edges-reconcile.js";
import { BorrowedSlots } from "./borrowed-slots.js";
import type { LendEdgeIdentity, LendPull } from "./lend-audience.js";
import { peerLendPull } from "./lend-client.js";
import type { LendScope } from "./lend-grant.js";
import type { PeerDial } from "./peer-edge-give-client.js";
import type { Side } from "./peer-give.test-fixtures.js";
import { dialFrom, routeFrom } from "./peer-give.test-fixtures.js";

export function borrowedSlotsFor(side: Side): BorrowedSlots {
  const dataDir = tempDirSync(`centraid-borrowed-${side.label}-`);
  return new BorrowedSlots(side.gatewayDb, path.join(dataDir, "data"));
}

export interface SeededList {
  collectionId: string;
  entryIds: string[];
}

/** A list: one collection plus its entries. The unit the exit evidence lends. */
export function seedList(
  side: Side,
  name: string,
  entries: number
): SeededList {
  const now = new Date().toISOString();
  const collectionId = crypto.randomUUID();
  side.vault.vault
    .prepare(
      `INSERT INTO core_collection
         (collection_id, owner_party_id, name, cover_content_id,
          parent_collection_id, sort_order, created_at)
       VALUES (?, ?, ?, NULL, NULL, 0, ?)`
    )
    .run(collectionId, side.ownerPartyId, name, now);
  const entryIds: string[] = [];
  for (let index = 0; index < entries; index += 1) {
    entryIds.push(addListEntry(side, collectionId, index));
  }
  return { collectionId, entryIds };
}

export function addListEntry(
  side: Side,
  collectionId: string,
  position: number
): string {
  const entryId = crypto.randomUUID();
  side.vault.vault
    .prepare(
      `INSERT INTO core_collection_entry
         (entry_id, collection_id, target_type, target_id, position, added_at)
       VALUES (?, ?, 'media.media_asset', ?, ?, ?)`
    )
    .run(
      entryId,
      collectionId,
      crypto.randomUUID(),
      position,
      new Date().toISOString()
    );
  return entryId;
}

export function insertLiveEdgeRow(
  origin: Side,
  input: {
    edgeId: string;
    audienceVaultId: string;
    itemType: string;
    scopes: readonly LendScope[];
    verbs?: "read" | "read+act";
  }
): EdgeRow {
  const now = new Date().toISOString();
  origin.gatewayDb.run(
    `INSERT INTO share_edges
       (edge_id, created_by_device, owner_id, kind, mode, item_type,
        scope_json, origin_vault_id, audience_vault_id, verbs,
        target_state, source_state, status, created_at, updated_at)
     VALUES (?, ?, ?, 'add', 'live', ?, ?, ?, ?, ?,
             'queued', 'not-needed', 'queued', ?, ?)`,
    input.edgeId,
    origin.deviceId,
    origin.ownerId,
    input.itemType,
    JSON.stringify(input.scopes),
    origin.vaultId,
    input.audienceVaultId,
    input.verbs ?? "read",
    now,
    now
  );
  return readEdgeRow(origin.gatewayDb, input.edgeId)!;
}

/**
 * Open a live edge from `origin` to `audience` over the real peer plane, and
 * hand back the puller the audience drives it with. Deliberately two steps,
 * mirroring production: the origin announces the window, the audience pulls.
 */
export async function lend(
  origin: Side,
  audience: Side,
  audienceBorrowed: BorrowedSlots,
  input: {
    edgeId: string;
    itemType: string;
    scopes: readonly LendScope[];
    /** 'read' or 'read+act' (#726 P5) — defaults to 'read', P4's only shape. */
    verbs?: "read" | "read+act";
    /** Closure-evidence tests inject the real iroh-backed transport; focused
     *  unit suites keep the in-process peer-plane double. */
    transport?: {
      originToAudience: PeerDial;
      audienceToOrigin: PeerDial;
    };
  }
): Promise<{ edge: EdgeRow; identity: LendEdgeIdentity; pull: LendPull }> {
  const verbs = input.verbs ?? "read";
  const row = insertLiveEdgeRow(origin, {
    edgeId: input.edgeId,
    audienceVaultId: audience.vaultId,
    itemType: input.itemType,
    scopes: input.scopes,
    verbs,
  });
  const edge = await openLiveEdge({
    db: origin.gatewayDb,
    row,
    origin: origin.vault,
    audienceLabel: audience.label,
    scopes: input.scopes,
    verbs,
    signAsVault: origin.signAsVault,
    route: routeFrom(origin, audience),
    peerDial:
      input.transport?.originToAudience ??
      dialFrom(origin, audience, audienceBorrowed),
  });
  return {
    edge,
    identity: {
      edgeId: input.edgeId,
      originVaultId: origin.vaultId,
      audienceVaultId: audience.vaultId,
      originPublicKey: origin.publicKey,
      holderLabel: origin.label,
      itemType: input.itemType,
      verbs,
    },
    pull: peerLendPull({
      dial: input.transport?.audienceToOrigin ?? dialFrom(audience, origin),
      route: routeFrom(audience, origin),
    }),
  };
}
