/*
 * The ONE executor of the sharing plane's effect outbox (#750
 * abstraction 2): per-kind handlers over one queue, one retry policy, and one
 * place that decides what "discharged" means.
 *
 * ONE HANDLER (#825, ruling G-copy). There is no peer transport to select
 * between — no `deliverGiveOverPeer`, no background blob pull, no relayed
 * refusal — and every `deliver-give` is a same-owner placement whose two
 * vaults are open in this process. What is left is the retry policy around
 * one vault call.
 *
 * The handler never throws for a vault condition: a vault this gateway cannot
 * open right now is a RETRY, and the durable row is what makes the next tick's
 * attempt the same obligation rather than a new one. `runShareEffect` is also
 * called INLINE by the edge route, so the common case still answers the owner
 * synchronously while the outbox covers the case where it could not act.
 */

import { moveOutOfVault, shareItemsToVault } from "@centraid/vault";
import type { ShareVaultRef } from "@centraid/vault";

import { deliverGiveLocally } from "../routes/edges-reconcile.js";
import type { GatewayDatabase } from "./gateway-db.js";
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

export interface ShareEffectDeps {
  db: GatewayDatabase;
  vaultFor: (vaultId: string) => ShareVaultRef | undefined;
  share?: typeof shareItemsToVault;
  move?: typeof moveOutOfVault;
}

export type ShareEffectOutcome =
  | { state: "done" }
  | {
      state: "retry";
      reason: string;
      /**
       * True when THIS gateway could not act (a vault call threw, a vault not
       * open here) rather than the edge simply not having completed. The edge
       * route answers 202 for a fault and 200 otherwise, which is the
       * distinction the wire contract has always drawn.
       */
      fault: boolean;
    }
  | { state: "abandoned"; reason: string };

export function runShareEffect(
  deps: ShareEffectDeps,
  effect: ShareEffect
): ShareEffectOutcome {
  const row = readEdgeRow(deps.db, effect.edgeId);
  if (!row) return { state: "abandoned", reason: "no such edge" };
  const facts = edgeFactsOf(row);
  // Terminal already (completed by an earlier attempt, revoked by its owner)
  // — the obligation is discharged, not retried.
  if (isTerminalEdgeStatus(row.status)) return { state: "done" };
  const origin = deps.vaultFor(row.origin_vault_id);
  if (!origin) {
    return fault(deps, row.edge_id, facts, "the origin vault is not open here");
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

export interface DrainShareEffectsResult {
  done: string[];
  retried: string[];
  abandoned: string[];
}

/** One background tick: advance every effect due now. */
export function drainShareEffects(
  deps: ShareEffectDeps,
  options: { limit?: number; now?: number } = {}
): DrainShareEffectsResult {
  const pending = claimDueShareEffects(deps.db, options);
  const result: DrainShareEffectsResult = {
    done: [],
    retried: [],
    abandoned: [],
  };
  for (const row of pending) {
    const outcome = runShareEffect(deps, row.effect);
    settle(deps.db, row, outcome, options.now);
    if (outcome.state === "done") result.done.push(row.effectId);
    else if (outcome.state === "abandoned") result.abandoned.push(row.effectId);
    else result.retried.push(row.effectId);
  }
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
      ...(now === undefined ? {} : { now }),
    });
    return;
  }
  completeShareEffect(db, pending.effectId);
}
