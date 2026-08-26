// THE PERMIT LEG OF THE BOUNDARY (README-Locker §2, rows "Per item" and
// "Failures").
//
// A reveal is a GESTURE, NOT A MODE. There is no "trust this session" switch
// anywhere in this app: a fresh confirmation mints ONE permit, for ONE field
// of ONE item, good for about thirty seconds, and it expires whether or not it
// was used. That is why `spend()` exists and why `Permit` carries the field it
// was minted for — a permit that could be pointed at a second field would be a
// session by another name.
//
// The lifecycle is driven by the auth query's `authorize-item` operation and
// nothing else; this module turns its answer into one of three outcomes and
// owns the arithmetic of the countdown. It performs no IO.

import { retryInSeconds } from "../_shared/shared-copy.ts";
import type { AuthPayload } from "./types.ts";

/** About thirty seconds — the permit's whole life, used or not. */
export const PERMIT_LIFE_MS = 30_000;

/** The one-shot grant: this field, of this item, until this instant. */
export interface Permit {
  itemId: string;
  /** The field the member asked for — the permit is not portable to another. */
  field: string;
  /** The host's item token. Spent on the single `item` read it authorises. */
  token: string;
  expiresAt: number;
}

/** What the gate is standing open for, before a permit exists. */
export interface PermitRequest {
  itemId: string;
  field: string;
}

/**
 * The three things `authorize-item` can mean.
 *
 *   `minted`   — the permit exists; read the item once and conceal after.
 *   `relock`   — SESSION_EXPIRED. The session, not the permit, is what ran
 *                out, so the whole boundary closes rather than the gate
 *                re-asking for a passphrase against a session that is gone.
 *   `refused`  — a wrong passphrase or a backoff. Receipted too, which is why
 *                the gate says so rather than silently re-arming.
 */
export type PermitOutcome =
  | { kind: "minted"; permit: Permit }
  | { kind: "relock" }
  | { kind: "refused"; message: string };

/** The host's code for "your session, not your permit, is what expired". */
const SESSION_EXPIRED = "SESSION_EXPIRED";
/** The host's code for a backed-off attempt. */
const RATE_LIMITED = "RATE_LIMITED";

/** The refusal a rate limit wears, in seconds the member can wait out. */
export function backoffText(retryAfterMs: number): string {
  return retryInSeconds(Math.max(1, Math.ceil(retryAfterMs / 1000)));
}

/**
 * Turn one `authorize-item` answer into an outcome. `expiresAt` is the host's
 * if it sent one and it parses; otherwise the permit takes its nominal life
 * from `now`, because a permit with no end is not a permit.
 */
export function permitFromAuth(
  request: PermitRequest,
  payload: AuthPayload,
  now: number = Date.now()
): PermitOutcome {
  if (payload.code === SESSION_EXPIRED) return { kind: "relock" };
  if (!payload.ok || !payload.itemToken) {
    if (payload.code === RATE_LIMITED || payload.retryAfterMs) {
      return {
        kind: "refused",
        message: backoffText(payload.retryAfterMs ?? PERMIT_LIFE_MS),
      };
    }
    return {
      kind: "refused",
      message: payload.message ?? "The passphrase was not accepted.",
    };
  }
  const stated = payload.expiresAt ? Date.parse(payload.expiresAt) : Number.NaN;
  return {
    kind: "minted",
    permit: {
      itemId: request.itemId,
      field: request.field,
      token: payload.itemToken,
      expiresAt: Number.isNaN(stated) ? now + PERMIT_LIFE_MS : stated,
    },
  };
}

/** Is this permit still alive at `now`? */
export function isPermitLive(
  permit: Permit | null,
  now: number = Date.now()
): boolean {
  return permit !== null && permit.expiresAt > now;
}

/** Whole seconds left on a permit, floored at zero. */
export function permitRemainingSeconds(
  permit: Permit | null,
  now: number = Date.now()
): number {
  if (!permit) return 0;
  return Math.max(0, Math.ceil((permit.expiresAt - now) / 1000));
}

/**
 * Does this permit authorise THIS field of THIS item, right now? Asked at the
 * point of use rather than at the point of minting, so a permit cannot be
 * carried to a second field by a re-render.
 */
export function permitCovers(
  permit: Permit | null,
  request: PermitRequest,
  now: number = Date.now()
): boolean {
  return (
    isPermitLive(permit, now) &&
    permit?.itemId === request.itemId &&
    permit.field === request.field
  );
}

/** One shot. Spending a permit returns nothing to hold on to. */
export function spend(): null {
  return null;
}

// ---------------------------------------------------------------------------
// The revealed field's own clock
// ---------------------------------------------------------------------------

/** Whole seconds a revealed value has been on screen. */
export function revealedForSeconds(
  revealedAt: number,
  now: number = Date.now()
): number {
  return Math.max(0, Math.floor((now - revealedAt) / 1000));
}

/** Whole seconds before a revealed value conceals itself. */
export function concealsInSeconds(
  revealedAt: number,
  now: number = Date.now()
): number {
  return Math.max(0, Math.ceil((revealedAt + PERMIT_LIFE_MS - now) / 1000));
}

/** Has a revealed value outlived the permit that bought it? */
export function isRevealExpired(
  revealedAt: number,
  now: number = Date.now()
): boolean {
  return concealsInSeconds(revealedAt, now) <= 0;
}
