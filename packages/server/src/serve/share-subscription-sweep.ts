/*
 * THE PEER-ROUTED HALF of a subscription (#929). A co-hosted audience settles
 * inside the pass that starts the subscription; a linked one cannot, because a
 * network dial has no business on a commit doorbell. So the pass leaves the row
 * `syncing` (or `remove_sent`) and this sweep drains it.
 *
 * The origin only ever RINGS. The notice carries no rows: the audience seat
 * pulls the shape from this origin over the same link and answers with what it
 * ingested, and that answer — never a timer — is what settles `delivered` and
 * `removed`.
 */

import {
  listPendingShareDeliveries,
  setFulfillmentState,
  shareGrantShapeId,
} from "@centraid/vault";
import type { PendingShareDelivery, VaultDb } from "@centraid/vault";

import { PEER_REPLICA_CHANGES_PATH } from "../routes/peer-replica-route.js";
import type { PeerDial } from "./peer-link-client.js";
import type { LinkRoute } from "./vault-link-row.js";

export interface ShareSubscriptionSweepInput {
  origin: VaultDb;
  originVaultId: string;
  dial: PeerDial;
  /** The link's address data, or `undefined` when the link has ended. */
  routeTo: (audienceVaultId: string) => LinkRoute | undefined;
  now: () => string;
  /** Bounded per pass: a vault with a thousand stalled peers costs one page. */
  limit?: number;
}

export type ShareSweepOutcome =
  | { outcome: "delivered"; apply: string; fieldUpdates: number }
  | { outcome: "removed"; removed: number; retained: number }
  | { outcome: "unreachable"; detail: string };

export interface ShareSweepStep extends PendingShareDelivery {
  result: ShareSweepOutcome;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ring(
  input: ShareSubscriptionSweepInput,
  pending: PendingShareDelivery
): Promise<ShareSweepOutcome> {
  const route = input.routeTo(pending.peerVaultId);
  if (!route)
    return {
      outcome: "unreachable",
      detail: `the link to peer vault ${pending.peerVaultId} has ended`,
    };
  let response: { status: number; json: unknown };
  try {
    response = await input.dial.request({
      endpointTicket: input.dial.endpointTicketFor(
        route.endpointId,
        route.relayHints
      ),
      method: "POST",
      target: PEER_REPLICA_CHANGES_PATH,
      body: {
        shapeId: shareGrantShapeId(pending.grantId),
        originVaultId: input.originVaultId,
        audienceVaultId: pending.peerVaultId,
        revoked: pending.revoked,
      },
    });
  } catch (error) {
    return { outcome: "unreachable", detail: detailOf(error) };
  }
  const body = (response.json ?? {}) as {
    state?: string;
    apply?: string;
    fieldUpdates?: number;
    removed?: number;
    retained?: number;
    detail?: string;
  };
  if (response.status !== 200)
    return {
      outcome: "unreachable",
      detail: body.detail ?? `the audience answered ${response.status}`,
    };
  if (body.state === "removed")
    return {
      outcome: "removed",
      removed: body.removed ?? 0,
      retained: body.retained ?? 0,
    };
  if (body.state === "ingested")
    return {
      outcome: "delivered",
      apply: body.apply ?? "bootstrap",
      fieldUpdates: body.fieldUpdates ?? 0,
    };
  return {
    outcome: "unreachable",
    detail: body.detail ?? "the audience did not acknowledge the shape",
  };
}

/**
 * One pass. Failure-isolated per row: an audience this host cannot reach is
 * that audience's problem, and its row keeps the state it honestly holds.
 */
export async function sweepShareSubscriptions(
  input: ShareSubscriptionSweepInput
): Promise<readonly ShareSweepStep[]> {
  const pending = listPendingShareDeliveries(input.origin.vault, input.limit);
  const steps: ShareSweepStep[] = [];
  for (const row of pending) {
    // A revoked grant's pending row is a removal even when it reads `syncing`:
    // the answer that matters is `delivered_at`, and `stopShareSubscription`
    // already decided this row owes a removal.
    // oxlint-disable-next-line no-await-in-loop -- (#929) one audience never costs another: a dial that stalls must not fan out into every other peer at once
    const result = await ring(input, row);
    const now = input.now();
    if (result.outcome === "delivered")
      setFulfillmentState(input.origin.vault, {
        grantId: row.grantId,
        peerVaultId: row.peerVaultId,
        state: "delivered",
        updatedAt: now,
      });
    else if (result.outcome === "removed")
      setFulfillmentState(input.origin.vault, {
        grantId: row.grantId,
        peerVaultId: row.peerVaultId,
        state: "removed",
        updatedAt: now,
        ...(result.removed === 0 && result.retained === 0
          ? { detail: "the audience vault no longer held a projection" }
          : {}),
      });
    else
      setFulfillmentState(input.origin.vault, {
        grantId: row.grantId,
        peerVaultId: row.peerVaultId,
        state: row.state,
        updatedAt: now,
        detail: result.detail,
      });
    steps.push({ ...row, result });
  }
  return steps;
}
