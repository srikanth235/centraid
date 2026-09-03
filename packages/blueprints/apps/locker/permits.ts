import { retryInSeconds } from "../_shared/shared-copy.ts";
import type { AuthPayload } from "./types.ts";

export const PERMIT_LIFE_MS = 30_000;

export interface Permit {
  itemId: string;
  field: string;
  token: string;
  expiresAt: number;
}

export interface SidecarTarget {
  entity: string;
  entityId: string;
  column: string;
}

export interface PermitRequest {
  itemId: string;
  field: string;
  sidecar?: SidecarTarget;
  label?: string;
}

export type PermitOutcome =
  | { kind: "minted"; permit: Permit }
  | { kind: "relock" }
  | { kind: "refused"; message: string };

const SESSION_EXPIRED = "SESSION_EXPIRED";
const RATE_LIMITED = "RATE_LIMITED";

export function backoffText(retryAfterMs: number): string {
  return retryInSeconds(Math.max(1, Math.ceil(retryAfterMs / 1000)));
}

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

export function isPermitLive(
  permit: Permit | null,
  now: number = Date.now()
): boolean {
  return permit !== null && permit.expiresAt > now;
}

export function permitRemainingSeconds(
  permit: Permit | null,
  now: number = Date.now()
): number {
  if (!permit) return 0;
  return Math.max(0, Math.ceil((permit.expiresAt - now) / 1000));
}

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

export function spend(): null {
  return null;
}

export function revealedForSeconds(
  revealedAt: number,
  now: number = Date.now()
): number {
  return Math.max(0, Math.floor((now - revealedAt) / 1000));
}

export function concealsInSeconds(
  revealedAt: number,
  now: number = Date.now()
): number {
  return Math.max(0, Math.ceil((revealedAt + PERMIT_LIFE_MS - now) / 1000));
}

export function isRevealExpired(
  revealedAt: number,
  now: number = Date.now()
): boolean {
  return concealsInSeconds(revealedAt, now) <= 0;
}
