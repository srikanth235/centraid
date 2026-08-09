/*
 * Opening a LIVE edge from the origin's route (#726 P4). Split out of
 * `edges-routes.ts` so that file stays a router: everything here is the
 * difference between a snapshot and a window.
 *
 * A snapshot edge reaches `completed` — the copy is made, the relationship is
 * over. A live edge reaches `established` and STAYS there, because there is
 * nothing to finish: the audience holds a view of rows that still live here,
 * and the origin can close it at any time.
 */

import type { ShareVaultRef } from "@centraid/vault";

import type { GatewayDatabase } from "../serve/gateway-db.js";
import type { BorrowedDeps } from "../serve/lend-audience.js";
import {
  dropBorrowedEdge,
  readBorrowedEdge,
  recordBorrowedEdge,
  setBorrowedEdgeState,
  syncBorrowedEdge,
} from "../serve/lend-audience.js";
import { closeLendOverPeer, openLendOverPeer } from "../serve/lend-client.js";
import { recordPendingLendClose } from "../serve/lend-close-relay.js";
import type { LendScope } from "../serve/lend-grant.js";
import { mintLease } from "../serve/lend-lease.js";
import type { LeaseSigner } from "../serve/lend-lease.js";
import {
  localLendPull,
  openLentEdge,
  revokeLentEdge,
} from "../serve/lend-origin.js";
import type { PeerDial } from "../serve/peer-edge-give-client.js";
import { recordShareAccessReceipt } from "../serve/share-access-receipts.js";
import type { LinkRoute } from "../serve/vault-link-row.js";
import type { EdgeRow } from "./edges-reconcile.js";
import { readEdgeRow, updateStatus } from "./edges-reconcile.js";

export interface OpenLiveEdgeInput {
  db: GatewayDatabase;
  row: EdgeRow;
  origin: ShareVaultRef;
  audienceLabel: string;
  scopes: readonly LendScope[];
  /** 'read' or 'read+act' (#726 P5) — fixed for the life of the edge. */
  verbs: "read" | "read+act";
  signAsVault: LeaseSigner;
  /** Present when the audience is elsewhere — the only thing remoteness adds. */
  route?: LinkRoute;
  peerDial?: PeerDial;
  /**
   * The CO-HOSTED case: both vaults sit on this gateway, so the borrowing half
   * runs here too, over a loopback pull rather than a wire. Same frames, same
   * store, same lease.
   */
  borrowed?: BorrowedDeps;
  /** Base64 identity key of a local vault (P1) — what a local lease verifies against. */
  vaultPublicKey?: (vaultId: string) => string | undefined;
}

/**
 * Mint the consent, mint the lease, tell the audience. The order matters: the
 * grant exists before anyone is told the window is open, so a peer that dials
 * back instantly finds an edge it can actually read.
 */
export async function openLiveEdge(input: OpenLiveEdgeInput): Promise<EdgeRow> {
  const { db, row } = input;
  if (row.status === "established") return row;
  updateStatus(db, row.edge_id, "in-flight", null);
  const lease = mintLease(input.signAsVault, {
    edgeId: row.edge_id,
    originVaultId: row.origin_vault_id,
    audienceVaultId: row.audience_vault_id,
  });
  // A vault this gateway cannot sign as cannot lend: the lease IS the
  // audience's authority to hold anything, so there is no unsigned fallback.
  if (!lease) {
    updateStatus(db, row.edge_id, "parked", "this vault cannot sign a lease");
    return readEdgeRow(db, row.edge_id)!;
  }
  openLentEdge(db, input.origin, {
    edgeId: row.edge_id,
    originVaultId: row.origin_vault_id,
    audienceVaultId: row.audience_vault_id,
    audienceLabel: input.audienceLabel,
    itemType: row.item_type,
    scopes: input.scopes,
    verbs: input.verbs,
    leaseExpiresAt: lease.expiresAt,
  });

  if (input.route) {
    if (!input.peerDial) {
      updateStatus(
        db,
        row.edge_id,
        "parked",
        "this gateway cannot dial out to a peer"
      );
      return readEdgeRow(db, row.edge_id)!;
    }
    const opened = await openLendOverPeer({
      dial: input.peerDial,
      route: input.route,
      edgeId: row.edge_id,
      itemType: row.item_type,
      verbs: input.verbs,
      lease,
    });
    if (opened.state !== "opened") {
      // Parked, never failed: the grant stands, and a later contact opens the
      // same window without a second ceremony.
      updateStatus(
        db,
        row.edge_id,
        "parked",
        `peer did not open the window: ${opened.state}`
      );
      return readEdgeRow(db, row.edge_id)!;
    }
  } else {
    const landed = await landCoHostedWindow(input);
    if (landed) {
      updateStatus(db, row.edge_id, "parked", landed);
      return readEdgeRow(db, row.edge_id)!;
    }
  }

  db.transaction(() => {
    recordShareAccessReceipt(db, {
      edgeId: row.edge_id,
      ownerId: row.owner_id,
      action: "share",
      itemType: row.item_type,
      originVaultId: row.origin_vault_id,
      originItemIds: JSON.parse(row.scope_json ?? "[]") as string[],
      audienceVaultId: row.audience_vault_id,
      // A live edge places no items: what crosses is a view, and its contents
      // are whatever the scope covers at read time.
      audienceItemIds: [],
    });
  });
  updateStatus(db, row.edge_id, "established", null);
  return readEdgeRow(db, row.edge_id)!;
}

/**
 * Land a co-hosted window into this gateway's own borrowed slot. Returns a
 * refusal reason, or `undefined` on success — a build that cannot borrow parks
 * the edge rather than reporting a window nobody can see through.
 */
async function landCoHostedWindow(
  input: OpenLiveEdgeInput
): Promise<string | undefined> {
  const { db, row } = input;
  const publicKey = input.vaultPublicKey?.(row.origin_vault_id);
  if (!input.borrowed || !publicKey)
    return "this gateway cannot hold a borrowed scope";
  const identity = {
    edgeId: row.edge_id,
    originVaultId: row.origin_vault_id,
    audienceVaultId: row.audience_vault_id,
    originPublicKey: publicKey,
    holderLabel: input.audienceLabel,
    itemType: row.item_type,
    verbs: input.verbs,
  };
  recordBorrowedEdge(db, { ...identity, linkId: `local:${row.edge_id}` });
  const outcome = await syncBorrowedEdge(
    input.borrowed,
    identity,
    localLendPull(db, input.origin, row.edge_id, input.signAsVault)
  );
  if (outcome.state !== "established")
    return `the borrowed scope did not land: ${outcome.state}`;
  setBorrowedEdgeState(db, row.edge_id, "established", null);
  return undefined;
}

/**
 * Close a window this gateway opened, and tell the borrower it is shut
 * (#726 P4; the owner-facing route added in P6 gap 1).
 *
 * The revoke is complete and durable the instant `revokeLentEdge` returns:
 * `lent_edges.revoked_at` is set and the grant is revoked, so a later pull —
 * whenever it happens — answers `not_found` regardless of anything below.
 * Everything past that point is only about telling the audience SOONER than
 * its own lease expiry or next scheduled tail would:
 *
 *   - co-hosted (no `route`): no wire needed at all (D3) — drop the borrowed
 *     shape directly, through the SAME converged deletion path
 *     (`dropBorrowedEdge`) expiry/revoke/self-drop already share.
 *   - remote and reachable right now: push `lend/close` and it lands.
 *   - remote and unreachable (or this build cannot dial out at all): durably
 *     record the courtesy push (`peer-refusal-relay.ts`'s "record now,
 *     deliver on next contact" shape) rather than blocking the owner's
 *     action on a peer that may not answer for days.
 */
export async function closeLiveEdge(input: {
  db: GatewayDatabase;
  row: EdgeRow;
  origin: ShareVaultRef;
  route?: LinkRoute;
  peerDial?: PeerDial;
  /** The co-hosted audience's own borrowed slots (#726 P6 gap 1) — present
   *  only when this build can hold a lent scope at all. */
  borrowed?: BorrowedDeps;
  /** The `vault_links` row this edge crossed, so an unreachable close can be
   *  durably queued for delivery (#726 P6 gap 1). Absent only for a
   *  same-owner edge, which has no link and needs no delivery either way. */
  linkId?: string;
}): Promise<EdgeRow> {
  revokeLentEdge(input.db, input.origin, input.row.edge_id);
  updateStatus(
    input.db,
    input.row.edge_id,
    "revoked",
    "the lender closed this share"
  );
  if (input.route) {
    const outcome = input.peerDial
      ? await closeLendOverPeer({
          dial: input.peerDial,
          route: input.route,
          edgeId: input.row.edge_id,
        })
      : ({ state: "unreachable" } as const);
    if (outcome.state === "unreachable" && input.linkId) {
      recordPendingLendClose(input.db, {
        edgeId: input.row.edge_id,
        linkId: input.linkId,
        peerVaultId: input.row.audience_vault_id,
        localVaultId: input.row.origin_vault_id,
      });
    }
  } else if (input.borrowed) {
    // Co-hosted: this gateway's own borrowed_edges row for this edge IS the
    // audience's copy — no wire, so no delivery to record.
    const identity = readBorrowedEdge(input.db, input.row.edge_id);
    if (identity) {
      dropBorrowedEdge(
        input.borrowed,
        identity,
        "the lender closed this share"
      );
    }
  }
  return readEdgeRow(input.db, input.row.edge_id)!;
}
