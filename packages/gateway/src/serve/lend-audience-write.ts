/*
 * The audience's write-back half (#726 P5) — queue + drain for a read+act
 * edge, extracted from `lend-audience.ts` to keep that file under the
 * repo's file-size guidance. Read-tailing and write-draining are different
 * concerns that happen to share the same `BorrowedDeps`/`LendEdgeIdentity`
 * vocabulary; this file owns only the second.
 */

import { isBorrowedIntentInProgress } from "./borrowed-intent.js";
import type { BorrowedIntentRecord, BorrowedStore } from "./borrowed-store.js";
import type { BorrowedDeps, LendEdgeIdentity } from "./lend-audience.js";
import type { LendIntentFrame, LendIntentRequest } from "./lend-intent.js";
import { acceptLease } from "./lend-lease.js";
import type { LendLease } from "./lend-lease.js";

/** How a drain reaches the origin — over the peer plane
 *  (`lend-client.ts::pushLendIntentOverPeer`) or, co-hosted, a direct door
 *  onto `lend-intent.ts::executeLentIntent`. Same shape as `LendPull`. */
export type LendIntentPush = (
  request: LendIntentRequest
) => Promise<
  | { state: "answered"; frame: LendIntentFrame; lease?: LendLease }
  | { state: "not_found" }
  | { state: "unreachable"; detail: string }
>;

interface DrainedBorrowedIntents {
  attempted: number;
  /** Reached a TERMINAL answer this pass (executed/denied/failed/conflict).
   *  A 'parked' answer still owes owner confirmation — it stays queued for
   *  the next tick's poll, same as 'unreachable'/'not_found'. */
  resolved: number;
}

function applyLendIntentFrame(
  store: BorrowedStore,
  intentId: string,
  frame: LendIntentFrame
): BorrowedIntentRecord | undefined {
  switch (frame.state) {
    case "executed":
      return store.recordIntentOutcome(intentId, {
        status: "executed",
        invocationId: frame.invocationId,
        output: frame.output,
      });
    case "parked":
      return store.recordIntentOutcome(intentId, {
        status: "parked",
        invocationId: frame.invocationId,
        reason: frame.reason,
      });
    case "denied":
      return store.recordIntentOutcome(intentId, {
        status: "denied",
        reason: frame.reason,
      });
    case "failed":
      return store.recordIntentOutcome(intentId, {
        status: "failed",
        invocationId: frame.invocationId,
        reason: frame.reason,
      });
    case "conflict":
      return store.recordIntentOutcome(intentId, {
        status: "conflict",
        conflict: frame.conflict,
      });
    case "in_flight":
    case "bad_request":
      // 'in_flight' / 'bad_request': no durable state to record — the row
      // stays exactly as queued and the next tick tries again.
      return undefined;
  }
}

/**
 * Push every intent this edge still owes the origin an answer for, FIFO.
 * Each is pushed through the SAME frame a first attempt, a retry, and a
 * status poll all share, so a queue entry that was already parked at the
 * origin resolves the instant the owner confirms — no separate polling
 * mechanism.
 */
export async function drainBorrowedIntents(
  deps: BorrowedDeps,
  identity: LendEdgeIdentity,
  push: LendIntentPush
): Promise<DrainedBorrowedIntents> {
  const store = deps.storeFor(identity.originVaultId);
  const pending = store.pendingIntents(identity.edgeId);
  let resolved = 0;
  for (const intent of pending) {
    // oxlint-disable-next-line no-await-in-loop -- FIFO by contract (see docstring): each intent must push and resolve in queue order
    const result = await push({
      intentId: intent.intentId,
      action: intent.action,
      input: intent.input,
      payloadHash: intent.payloadHash,
      baseVersions: intent.baseVersions,
    });
    if (result.state !== "answered") continue;
    if (result.lease) {
      const shape = store.shapeForEdge(identity.edgeId);
      if (
        !shape ||
        !acceptLease(result.lease, {
          edgeId: identity.edgeId,
          originVaultId: identity.originVaultId,
          audienceVaultId: identity.audienceVaultId,
          originPublicKey: identity.originPublicKey,
        })
      ) {
        continue;
      }
      store.renewLease(shape.shapeId, result.lease.expiresAt);
    }
    const record = applyLendIntentFrame(store, intent.intentId, result.frame);
    if (record && !isBorrowedIntentInProgress(record.status)) resolved += 1;
  }
  return { attempted: pending.length, resolved };
}
