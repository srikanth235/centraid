/*
 * The ONE executor of the sharing plane's effect outbox (issue #750
 * abstraction 2). It replaces three specialized drainers —
 * `drainPeerBlobPulls`, `drainPeerRefusals`, and the give attempt the edge
 * route used to run inline — with per-kind handlers over one queue, one
 * retry policy, and one place that decides what "discharged" means.
 *
 * TRANSPORT SELECTION LIVES HERE, AND ONLY HERE. A `deliver-give` effect is
 * emitted by the reducer without knowing where the audience is; this module
 * picks `deliverGiveLocally` (both vaults open in this process) or
 * `deliverGiveOverPeer` (a dial across the peer plane). No domain transition
 * forks on locality (D3) — only this selection does.
 *
 * Handlers never throw for a peer condition: an unreachable origin, a
 * partitioned transfer, a peer that moved are all RETRIES, and the durable
 * row is what makes the next tick's attempt the same obligation rather than a
 * new one. `runShareEffect` is also called INLINE by the edge route, so the
 * common case (peer reachable) still answers the owner synchronously while
 * the outbox covers the case where it is not.
 */

import { moveOutOfVault, shareItemsToVault } from "@centraid/vault";
import type { ShareVaultRef } from "@centraid/vault";

import { deliverGiveOverPeer } from "../routes/edges-reconcile-remote.js";
import { deliverGiveLocally } from "../routes/edges-reconcile.js";
import type { GatewayDatabase } from "./gateway-db.js";
import { runBlobPull } from "./peer-blob-pull.js";
import type { PeerDial } from "./peer-edge-give-client.js";
import { denyEdgeOverPeer } from "./peer-edge-give-client.js";
import { isTerminalEdgeStatus } from "./share-coordinator.js";
import type { ShareEffect } from "./share-coordinator.js";
import { readEdgeRow } from "./share-edge-row.js";
import { applyEdgeSignal, edgeFactsOf } from "./share-edge-store.js";
import {
  claimDueShareEffects,
  completeShareEffect,
  deferShareEffect,
} from "./share-effects.js";
import type { PendingShareEffect } from "./share-effects.js";
import type { VaultLinksStore } from "./vault-links-store.js";

export interface ShareEffectDeps {
  db: GatewayDatabase;
  links: VaultLinksStore;
  vaultFor: (vaultId: string) => ShareVaultRef | undefined;
  /** Absent means this build cannot dial out at all — peer effects wait. */
  dial?: PeerDial;
  share?: typeof shareItemsToVault;
  move?: typeof moveOutOfVault;
  chunkBytes?: number;
}

export type ShareEffectOutcome =
  | { state: "done" }
  | {
      state: "retry";
      reason: string;
      /**
       * True when THIS gateway could not act (a vault call threw, no dial
       * wired) rather than a peer being unavailable. The edge route answers
       * 202 for a fault and 200 for a peer state, which is the distinction
       * the wire contract has always drawn.
       */
      fault: boolean;
      /** Bytes actually moved — retry now, not down the backoff. */
      progressed?: boolean;
    }
  | { state: "abandoned"; reason: string };

export async function runShareEffect(
  deps: ShareEffectDeps,
  effect: ShareEffect
): Promise<ShareEffectOutcome> {
  switch (effect.kind) {
    case "deliver-give":
      return deliverGive(deps, effect);
    case "pull-blob":
      return pullBlob(deps, effect);
    case "deliver-refusal":
      return deliverRefusal(deps, effect);
    case "await-answer":
      // Waiting on a HUMAN. `next_attempt_at IS NULL` keeps these out of the
      // drainer entirely; reaching here at all means a caller ran one by
      // hand, and the honest answer is still "not yet".
      return {
        state: "retry",
        reason: "awaiting the owner's answer",
        fault: false,
      };
  }
}

async function deliverGive(
  deps: ShareEffectDeps,
  effect: Extract<ShareEffect, { kind: "deliver-give" }>
): Promise<ShareEffectOutcome> {
  const row = readEdgeRow(deps.db, effect.edgeId);
  if (!row) return { state: "abandoned", reason: "no such edge" };
  const facts = edgeFactsOf(row, {
    delivery: effect.delivery,
    crossOwner: effect.crossOwner,
  });
  // Terminal already (completed by an earlier attempt, denied by the peer,
  // revoked by its owner) — the obligation is discharged, not retried.
  if (isTerminalEdgeStatus(row.status)) return { state: "done" };
  const origin = deps.vaultFor(row.origin_vault_id);
  if (!origin) {
    return fault(deps, row.edge_id, facts, "the origin vault is not open here");
  }
  if (effect.delivery === "peer") {
    if (!deps.dial) {
      return fault(
        deps,
        row.edge_id,
        facts,
        "this gateway cannot dial out to a peer"
      );
    }
    const route = deps.links.routeFor(row.audience_vault_id);
    if (!route) {
      return fault(deps, row.edge_id, facts, "peer link not reachable");
    }
    const next = await deliverGiveOverPeer({
      db: deps.db,
      row,
      facts,
      origin,
      route,
      dial: deps.dial,
    });
    if (isTerminalEdgeStatus(next.status)) return { state: "done" };
    return {
      state: "retry",
      reason: next.reason ?? "the peer has not taken this give yet",
      fault: false,
    };
  }
  const audience = deps.vaultFor(row.audience_vault_id);
  if (!audience) {
    return fault(
      deps,
      row.edge_id,
      facts,
      "the audience vault is not open here"
    );
  }
  try {
    const next = deliverGiveLocally({
      db: deps.db,
      row,
      facts,
      origin,
      audience,
      share: deps.share ?? shareItemsToVault,
      move: deps.move ?? moveOutOfVault,
    });
    if (isTerminalEdgeStatus(next.status)) return { state: "done" };
    return {
      state: "retry",
      reason: next.reason ?? "the give did not complete",
      fault: true,
    };
  } catch (error) {
    return fault(
      deps,
      row.edge_id,
      facts,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/** Park the edge with a reason, and report the attempt as this gateway's own failure. */
function fault(
  deps: ShareEffectDeps,
  edgeId: string,
  facts: ReturnType<typeof edgeFactsOf>,
  reason: string
): ShareEffectOutcome {
  const row = readEdgeRow(deps.db, edgeId);
  if (row) {
    applyEdgeSignal(deps.db, row, facts, { type: "give-failed", reason });
  }
  return { state: "retry", reason, fault: true };
}

async function pullBlob(
  deps: ShareEffectDeps,
  effect: Extract<ShareEffect, { kind: "pull-blob" }>
): Promise<ShareEffectOutcome> {
  const audience = deps.vaultFor(effect.localVaultId);
  const view = deps.links.peerViewFor(effect.linkId, effect.localVaultId);
  if (!audience || !deps.dial || !view) {
    return {
      state: "retry",
      reason: "no route to the origin right now",
      fault: !deps.dial,
    };
  }
  const outcome = await runBlobPull({
    audience,
    dial: deps.dial,
    route: view.route,
    edgeId: effect.edgeId,
    sha256: effect.sha256,
    size: effect.size,
    tmpPath: effect.tmpPath,
    ...(deps.chunkBytes === undefined ? {} : { chunkBytes: deps.chunkBytes }),
  });
  if (outcome.state === "done") return { state: "done" };
  if (outcome.state === "failed")
    return { state: "abandoned", reason: outcome.reason };
  return {
    state: "retry",
    reason: "the transfer was interrupted",
    fault: false,
    progressed: outcome.progressed,
  };
}

async function deliverRefusal(
  deps: ShareEffectDeps,
  effect: Extract<ShareEffect, { kind: "deliver-refusal" }>
): Promise<ShareEffectOutcome> {
  const view = deps.links.peerViewFor(effect.linkId, effect.localVaultId);
  if (!deps.dial || !view) {
    return {
      state: "retry",
      reason: "no route to the origin right now",
      fault: !deps.dial,
    };
  }
  const outcome = await denyEdgeOverPeer({
    dial: deps.dial,
    route: view.route,
    edgeId: effect.edgeId,
  });
  // `not_found` means the origin has nothing to acknowledge (its own edge is
  // gone, revoked, or never existed the way this effect claims) — retrying
  // forever would never resolve it, so it counts as delivered.
  if (outcome.state === "acknowledged" || outcome.state === "not_found")
    return { state: "done" };
  return { state: "retry", reason: outcome.detail, fault: false };
}

export interface DrainShareEffectsResult {
  done: string[];
  retried: string[];
  abandoned: string[];
}

/**
 * One background tick: advance every effect due now. Each row is an
 * independent obligation (its own edge, its own bytes), so a tick's rows run
 * concurrently rather than one at a time.
 */
export async function drainShareEffects(
  deps: ShareEffectDeps,
  options: { limit?: number; now?: number } = {}
): Promise<DrainShareEffectsResult> {
  const pending = claimDueShareEffects(deps.db, options);
  const result: DrainShareEffectsResult = {
    done: [],
    retried: [],
    abandoned: [],
  };
  await Promise.all(
    pending.map(async (row) => {
      const outcome = await runShareEffect(deps, row.effect);
      settle(deps.db, row, outcome, options.now);
      if (outcome.state === "done") result.done.push(row.effectId);
      else if (outcome.state === "abandoned")
        result.abandoned.push(row.effectId);
      else result.retried.push(row.effectId);
    })
  );
  return result;
}

/** Write an attempt's verdict back to the outbox — the only place that does. */
export function settle(
  db: GatewayDatabase,
  pending: PendingShareEffect,
  outcome: ShareEffectOutcome,
  now?: number
): void {
  if (outcome.state === "retry") {
    deferShareEffect(db, pending.effectId, {
      attempts: pending.attempts,
      ...(outcome.progressed === undefined
        ? {}
        : { progressed: outcome.progressed }),
      ...(now === undefined ? {} : { now }),
    });
    return;
  }
  completeShareEffect(db, pending.effectId);
}
