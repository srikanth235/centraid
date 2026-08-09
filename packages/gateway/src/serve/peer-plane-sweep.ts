/*
 * Peer-plane background delivery (#726 P3 gaps 2 & 3, #726 P4 reach), the
 * SAME adaptive self-rescheduling timer shape `build-gateway.ts`'s outbox
 * sweep uses — extracted to its own file rather than grown inline, per the
 * repo's file-size guidance (`build-gateway.ts` already owns a large amount
 * of construction wiring).
 *
 * One tick drains what a peer-plane response can leave behind, and drives
 * what a live borrowed edge owes on its own clock:
 *   - `peer_blob_pulls` — a give's ORIGINAL bytes, ranged + resumable
 *     (`peer-blob-pull.ts`).
 *   - `peer_pending_refusals` — a D9 'refuse' the origin has not yet heard
 *     (`peer-refusal-relay.ts`).
 *   - `peer_pending_lend_closes` — a revoke the origin decided while its
 *     audience was unreachable (#726 P6 gap 1, `lend-close-relay.ts`).
 *   - borrowed leases (#726 P4 D8) — expiry is checked BEFORE anything
 *     reachability-dependent, deliberately: an audience that has been
 *     offline past expiry must drop the borrowed shape unprompted, and a
 *     sweep that needed a working dial to notice would do exactly the
 *     opposite.
 *   - live borrowed edges (#726 P4 gap) — `syncBorrowedEdge` per LIVE edge,
 *     so a live edge actually tails instead of bootstrapping once and going
 *     quiet, and `fillBorrowedBlobs*` so a lent album's thumbnails actually
 *     arrive rather than sitting as rows with no bytes behind them.
 * Bounded per tick (`rowLimit` caps rows/edges drained from EACH source) and
 * never throws out of the timer loop — a DB or network failure backs off the
 * next tick exactly like the outbox sweep, never spins. A gateway with no
 * peer dial wired (`dial()` returns `undefined`) still tails a CO-HOSTED live
 * edge (no wire involved, D3) but idles the remote-only work forever at
 * `idleIntervalMs`.
 */

import type { Gateway as VaultGateway, ShareVaultRef } from "@centraid/vault";

import type { GatewayDatabase } from "./gateway-db.js";
import type { BorrowedDeps, LendEdgeIdentity } from "./lend-audience.js";
import {
  drainBorrowedIntents,
  liveBorrowedEdges,
  setBorrowedEdgeState,
  sweepExpiredBorrowedEdges,
  syncBorrowedEdge,
} from "./lend-audience.js";
import {
  fillBorrowedBlobsLocally,
  fillBorrowedBlobsOverPeer,
} from "./lend-blob-pull.js";
import { customBudgetFor } from "./lend-budget-settings.js";
import { peerLendPull, pushLendIntentOverPeer } from "./lend-client.js";
import { drainPendingLendCloses } from "./lend-close-relay.js";
import type { LeaseSigner } from "./lend-lease.js";
import { localLendIntentPush, localLendPull } from "./lend-origin.js";
import { drainPeerBlobPulls } from "./peer-blob-pull.js";
import type { PeerDial } from "./peer-edge-give-client.js";
import { drainPeerRefusals } from "./peer-refusal-relay.js";
import { peerViewOf } from "./vault-link-row.js";
import type { VaultLinksStore } from "./vault-links-store.js";

const DEFAULT_ROW_LIMIT = 25;
const DEFAULT_ACTIVE_MS = 5_000;
const DEFAULT_IDLE_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;

export interface PeerPlaneSweepOptions {
  db: GatewayDatabase;
  links: VaultLinksStore;
  vaultFor: (vaultId: string) => ShareVaultRef | undefined;
  /** Live, not a snapshot: a dial wired after boot is picked up on the next tick. */
  dial: () => PeerDial | undefined;
  /** Rows drained per queue, per tick. Defaults to 25. */
  rowLimit?: number;
  /** Cadence while queues are empty or stuck. Defaults to 60s. */
  idleIntervalMs?: number;
  /** Cadence right after a tick made progress. Defaults to 5s. */
  activeIntervalMs?: number;
  shouldDefer?: () => boolean;
  logger?: { warn: (message: string) => void };
  /** The borrowed slots, when this build can hold a lent scope (#726 P4). */
  borrowed?: BorrowedDeps;
  /**
   * `VaultRegistry.signAsVault` — required to tail a CO-HOSTED live edge (the
   * origin is on this same gateway, so this gateway signs its lease renewals
   * itself). Absent on a build with no borrowed slots at all; a co-hosted
   * edge simply cannot progress without it, and is left for the next tick
   * rather than treated as a failure.
   */
  signAsVault?: LeaseSigner;
  /** Per-link byte budget (#726 P4 item 8). Defaults to a generous constant;
   *  tests override it small to exercise parking without allocating gigabytes. */
  borrowedByteBudgetBytes?: number;
  /**
   * The mounted origin vault's own `Gateway` (#726 P5) — required to drain a
   * CO-HOSTED write-capable edge's queued intents (`localLendIntentPush`
   * runs `Gateway.invokeAsIdentity` directly, no wire). Absent on a build
   * with no lend-write plane at all; a co-hosted edge's intents then simply
   * wait for the next tick, same posture as a missing `signAsVault`.
   */
  gatewayFor?: (vaultId: string) => VaultGateway | undefined;
}

export interface PeerPlaneSweep {
  start: () => void;
  stop: () => void;
  /** Test seam: run one pass immediately, bypassing the timer. */
  runOnce: () => Promise<void>;
}

/**
 * Drive every LIVE borrowed edge one step: bootstrap it if it never landed,
 * tail it if it did, and — once a tail lands rows — try to fill whatever
 * pinned blobs those rows named. Bounded to `limit` edges per tick, and one
 * edge's failure (a bad row, a transport hiccup outside `syncBorrowedEdge`'s
 * own `unreachable` handling) is caught and logged rather than aborting the
 * rest of the edges or the tick.
 *
 * Routing is resolved fresh every call, per edge: `vaultFor` answers whether
 * the origin is CO-HOSTED (this gateway holds it too, so the pull is a local
 * door with no network — `lend-origin.ts::localLendPull`) or remote (a real
 * `vault_links` row supplies the route the peer dial needs). An edge whose
 * route or signer isn't available yet is left alone for the next tick —
 * "cannot progress right now" is not a failure.
 */
async function tailLiveBorrowedEdges(
  options: PeerPlaneSweepOptions,
  dial: PeerDial | undefined,
  limit: number
): Promise<boolean> {
  const borrowed = options.borrowed;
  if (!borrowed) return false;
  const edges = liveBorrowedEdges(borrowed.gatewayDatabase).slice(0, limit);
  const results = await Promise.all(
    edges.map(async (identity): Promise<boolean> => {
      try {
        return await tailOneBorrowedEdge(
          options,
          borrowed,
          identity,
          dial,
          limit
        );
      } catch (error) {
        options.logger?.warn(
          `lend tail failed for edge ${identity.edgeId}: ${error instanceof Error ? error.message : String(error)}`
        );
        return false;
      }
    })
  );
  return results.some(Boolean);
}

/**
 * Record what a sync attempt actually settled on, on the AUDIENCE's own
 * ledger row (#726 P4 item 8's home): `established` when rows AND every
 * pinned blob that fit under budget landed; `parked` — with a reason that
 * says which of the two things stopped it — otherwise. A `dropped` outcome
 * needs nothing here; `dropBorrowedEdge` already wrote its own state inside
 * `syncBorrowedEdge`.
 */
function recordSyncOutcome(
  db: GatewayDatabase,
  identity: LendEdgeIdentity,
  outcome: Awaited<ReturnType<typeof syncBorrowedEdge>>,
  parkedBlobs: readonly string[]
): boolean {
  if (outcome.state === "dropped") return false;
  if (outcome.state !== "established") {
    setBorrowedEdgeState(
      db,
      identity.edgeId,
      "parked",
      `unreachable: ${outcome.detail}`
    );
    return false;
  }
  if (parkedBlobs.length > 0) {
    setBorrowedEdgeState(db, identity.edgeId, "parked", "byte budget reached");
    return true; // the row tail still made progress even while blobs wait
  }
  setBorrowedEdgeState(db, identity.edgeId, "established", null);
  return true;
}

/**
 * The budget to enforce for THIS edge's counterparty (#726 P6 gap 2): a
 * per-link row, when the owner set one, always wins over the wider
 * `options.borrowedByteBudgetBytes` — that constant is a build-level default,
 * not a ceiling a per-link choice must respect. Falls back to the build
 * default (itself falling back to `DEFAULT_BORROWED_LINK_BYTE_BUDGET` inside
 * `fillBorrowedBlobs*`) when no per-link row exists or the identity carries
 * no `linkId` at all.
 */
function budgetForIdentity(
  options: PeerPlaneSweepOptions,
  identity: LendEdgeIdentity
): number | undefined {
  if (identity.linkId === undefined) return options.borrowedByteBudgetBytes;
  return (
    customBudgetFor(options.db, identity.linkId, identity.audienceVaultId) ??
    options.borrowedByteBudgetBytes
  );
}

async function tailOneBorrowedEdge(
  options: PeerPlaneSweepOptions,
  borrowed: BorrowedDeps,
  identity: LendEdgeIdentity,
  dial: PeerDial | undefined,
  blobLimit: number
): Promise<boolean> {
  const budgetBytes = budgetForIdentity(options, identity);
  const originRef = options.vaultFor(identity.originVaultId);
  if (originRef && options.signAsVault) {
    const outcome = await syncBorrowedEdge(
      borrowed,
      identity,
      localLendPull(options.db, originRef, identity.edgeId, options.signAsVault)
    );
    if (outcome.state !== "established")
      return recordSyncOutcome(options.db, identity, outcome, []);
    const filled = fillBorrowedBlobsLocally({
      store: borrowed.storeFor(identity.originVaultId),
      cas: borrowed.casFor(identity.originVaultId),
      shapeId: outcome.shapeId,
      origin: originRef.blobs.local,
      limit: blobLimit,
      budgetBytes,
    });
    return recordSyncOutcome(options.db, identity, outcome, filled.parked);
  }
  if (!dial) return false; // remote origin, nothing to dial this tick
  const link = options.links.findPair(
    identity.originVaultId,
    identity.audienceVaultId
  );
  const view = link ? peerViewOf(link, identity.audienceVaultId) : undefined;
  if (!view) return false; // route not yet known; try again next tick
  const outcome = await syncBorrowedEdge(
    borrowed,
    identity,
    peerLendPull({ dial, route: view.route })
  );
  if (outcome.state !== "established")
    return recordSyncOutcome(options.db, identity, outcome, []);
  const filled = await fillBorrowedBlobsOverPeer({
    store: borrowed.storeFor(identity.originVaultId),
    cas: borrowed.casFor(identity.originVaultId),
    shapeId: outcome.shapeId,
    dial,
    route: view.route,
    identity,
    edgeId: identity.edgeId,
    limit: blobLimit,
    budgetBytes,
  });
  return recordSyncOutcome(options.db, identity, outcome, filled.parked);
}

/**
 * Drain every read+act edge's queued intents one step (#726 P5) — the write
 * analogue of {@link tailLiveBorrowedEdges}, run right after it so a tick
 * that just landed rows also tries the writes waiting behind them. Routing
 * follows the SAME rule: co-hosted needs no dial (`localLendIntentPush`),
 * remote needs a resolved route AND a dial. A read-only edge is skipped —
 * there is nothing queued against it (`edges-routes.ts` never lets a
 * device queue against one; this is defense in depth, not the gate).
 */
async function drainIntentsForBorrowedEdges(
  options: PeerPlaneSweepOptions,
  dial: PeerDial | undefined,
  limit: number
): Promise<boolean> {
  const borrowed = options.borrowed;
  if (!borrowed) return false;
  const edges = liveBorrowedEdges(borrowed.gatewayDatabase)
    .filter((identity) => identity.verbs === "read+act")
    .slice(0, limit);
  const results = await Promise.all(
    edges.map(async (identity): Promise<boolean> => {
      try {
        const originRef = options.vaultFor(identity.originVaultId);
        const gateway = options.gatewayFor?.(identity.originVaultId);
        if (originRef && gateway) {
          const outcome = await drainBorrowedIntents(
            borrowed,
            identity,
            localLendIntentPush(options.db, originRef, gateway, identity.edgeId)
          );
          return outcome.resolved > 0;
        }
        if (!dial) return false; // remote origin, nothing to dial this tick
        const link = options.links.findPair(
          identity.originVaultId,
          identity.audienceVaultId
        );
        const view = link
          ? peerViewOf(link, identity.audienceVaultId)
          : undefined;
        if (!view) return false; // route not yet known; try again next tick
        const outcome = await drainBorrowedIntents(
          borrowed,
          identity,
          (request) =>
            pushLendIntentOverPeer({
              dial,
              route: view.route,
              edgeId: identity.edgeId,
              request,
            })
        );
        return outcome.resolved > 0;
      } catch (error) {
        options.logger?.warn(
          `lend intent drain failed for edge ${identity.edgeId}: ${error instanceof Error ? error.message : String(error)}`
        );
        return false;
      }
    })
  );
  return results.some(Boolean);
}

export function createPeerPlaneSweep(
  options: PeerPlaneSweepOptions
): PeerPlaneSweep {
  const idleMs = options.idleIntervalMs ?? DEFAULT_IDLE_MS;
  const activeMs = options.activeIntervalMs ?? DEFAULT_ACTIVE_MS;
  const rowLimit = options.rowLimit ?? DEFAULT_ROW_LIMIT;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const schedule = (delayMs: number): void => {
    if (!running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), delayMs);
    timer.unref?.();
  };

  const tick = async (): Promise<void> => {
    // Before anything that needs a peer: a lease that ran out is a deletion
    // this gateway owes whether or not it can reach anyone.
    if (options.borrowed) {
      try {
        sweepExpiredBorrowedEdges(options.borrowed);
      } catch (error) {
        options.logger?.warn(
          `borrowed lease sweep failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (options.shouldDefer?.()) {
      schedule(idleMs);
      return;
    }
    let progressed = false;
    // A co-hosted live edge needs no dial at all (D3, "locality is routing");
    // a remote one does, but `tailLiveBorrowedEdges` skips what it cannot
    // reach this tick rather than blocking the rest of the sweep on it.
    if (options.borrowed) {
      try {
        progressed =
          (await tailLiveBorrowedEdges(options, options.dial(), rowLimit)) ||
          progressed;
      } catch (error) {
        options.logger?.warn(
          `lend tail sweep failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      try {
        progressed =
          (await drainIntentsForBorrowedEdges(
            options,
            options.dial(),
            rowLimit
          )) || progressed;
      } catch (error) {
        options.logger?.warn(
          `lend intent sweep failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    const dial = options.dial();
    if (!dial) {
      schedule(progressed ? activeMs : idleMs);
      return;
    }
    try {
      const blobPulls = await drainPeerBlobPulls({
        db: options.db,
        links: options.links,
        vaultFor: options.vaultFor,
        dial,
        limit: rowLimit,
      });
      const refusals = await drainPeerRefusals({
        db: options.db,
        links: options.links,
        dial,
        limit: rowLimit,
      });
      // A revoke the origin decided while its audience was unreachable
      // (#726 P6 gap 1) — same drain shape as a D9 refusal, delivered here.
      const lendCloses = await drainPendingLendCloses({
        db: options.db,
        links: options.links,
        dial,
        limit: rowLimit,
      });
      progressed ||=
        blobPulls.done.length > 0 ||
        refusals.acknowledged.length > 0 ||
        lendCloses.acknowledged.length > 0;
    } catch (error) {
      options.logger?.warn(
        `peer plane sweep failed: ${error instanceof Error ? error.message : String(error)}`
      );
      schedule(Math.min(idleMs * 2, MAX_BACKOFF_MS));
      return;
    }
    schedule(progressed ? activeMs : idleMs);
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      schedule(0);
    },
    stop(): void {
      running = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    runOnce: tick,
  };
}
