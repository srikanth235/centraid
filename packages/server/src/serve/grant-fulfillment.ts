/*
 * The host seam for the grant plane's fulfillment engine (issue #825).
 *
 * The engine in `@centraid/vault` knows how to keep one grant true; it does
 * not know which vaults this host has mounted, and it must not. This file is
 * the join: it turns the gateway's vault registry into the engine's `seatFor`
 * and drives the two host-level questions —
 *
 *   - a SUBJECT changed, so every live grant over it has work to do;
 *   - a grant was REVOKED, so its removal has to go out.
 *
 * One audience must never cost another. A grant that fails — a subject over
 * its ceiling, an audience vault that will not open — is reported as a failure
 * for THAT grant and the pass carries on, because the alternative is one
 * unreachable peer silently stalling every other person's copy.
 *
 * Delivery is best-effort by nature and the report says so plainly: nothing
 * here retries, waits, or promotes a `remove_sent` into a `removed`. What the
 * host could do, it did; the fulfillment rows are the durable record of the
 * rest.
 */

import {
  fulfillShareGrant,
  listShareGrantsForSubject,
  propagateShareGrantRevocation,
} from "@centraid/vault";
import type {
  GrantFulfillmentResult,
  GrantRemovalResult,
  ShareableItemType,
  VaultDb,
} from "@centraid/vault";

/** What the host can reach right now. */
export interface GrantFulfillmentHost {
  /** The mounted vault for a gateway vault id, or `undefined` when it is not
   *  mounted here — a fact about this host, never about the grant. */
  vaultFor: (vaultId: string) => VaultDb | undefined;
  logger?: { warn: (message: string) => void };
}

/** One grant's pass. `failed` carries the reason instead of throwing it. */
export type GrantFulfillmentReport =
  | { grantId: string; outcome: "fulfilled"; result: GrantFulfillmentResult }
  | { grantId: string; outcome: "failed"; reason: string };

export type GrantRemovalReport =
  | { grantId: string; outcome: "propagated"; result: GrantRemovalResult }
  | { grantId: string; outcome: "failed"; reason: string };

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Carry a subject's current truth to every live grant over it. Called after
 * the subject changed — a photo added to a shared album, a document edited —
 * which is the whole of "view grants sync forward".
 */
export function fulfillGrantsForSubject(input: {
  host: GrantFulfillmentHost;
  /** The vault the subject lives in, and its gateway id. */
  originVaultId: string;
  subjectType: ShareableItemType;
  subjectId: string;
  now: string;
}): GrantFulfillmentReport[] {
  const origin = input.host.vaultFor(input.originVaultId);
  if (!origin) return [];
  const seatFor = (vaultId: string): VaultDb | undefined =>
    input.host.vaultFor(vaultId);
  return listShareGrantsForSubject(
    origin.vault,
    input.subjectType,
    input.subjectId
  ).map((grant): GrantFulfillmentReport => {
    try {
      return {
        grantId: grant.grantId,
        outcome: "fulfilled",
        result: fulfillShareGrant({
          origin,
          originVaultId: input.originVaultId,
          grantId: grant.grantId,
          seatFor,
          now: input.now,
        }),
      };
    } catch (error) {
      const reason = reasonOf(error);
      input.host.logger?.warn(
        `share grant ${grant.grantId} could not be fulfilled — ${reason}`
      );
      return { grantId: grant.grantId, outcome: "failed", reason };
    }
  });
}

/**
 * Send one revoked grant's removal out to the audience vaults it was
 * delivered to. The store dated the revocation already; this is the delivery
 * half, and it is the only thing that ever writes `removed`.
 */
export function propagateGrantRemoval(input: {
  host: GrantFulfillmentHost;
  originVaultId: string;
  grantId: string;
  now: string;
}): GrantRemovalReport {
  const origin = input.host.vaultFor(input.originVaultId);
  if (!origin)
    return {
      grantId: input.grantId,
      outcome: "failed",
      reason: `origin vault ${input.originVaultId} is not mounted on this host`,
    };
  try {
    return {
      grantId: input.grantId,
      outcome: "propagated",
      result: propagateShareGrantRevocation({
        origin,
        originVaultId: input.originVaultId,
        grantId: input.grantId,
        seatFor: (vaultId) => input.host.vaultFor(vaultId),
        now: input.now,
      }),
    };
  } catch (error) {
    const reason = reasonOf(error);
    input.host.logger?.warn(
      `share grant ${input.grantId} removal could not be propagated — ${reason}`
    );
    return { grantId: input.grantId, outcome: "failed", reason };
  }
}
