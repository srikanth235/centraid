/*
 * Owner-held backup (#726). Hosting a vault confers no authority
 * over ITS backup destination/policy or recovery material: configuring a
 * target, and exporting a recovery kit, are both owner acts scoped to the
 * vault(s) the REQUESTING owner actually owns.
 */

import type { IncomingMessage } from "node:http";

import type { RecoveryKitDocument } from "@centraid/backup";
import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";

import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type { Owner } from "../serve/owner-store.js";

export interface OwnerScopeDeps {
  enrollments?: EnrollmentStore;
  /**
   * Direct host-custody request (authenticated bearer, never iroh-forwarded).
   * It can see every vault, so refusals it hits are `owner_only` (naming the
   * real owner) rather than the ordinary `owner_required`.
   */
  isHostCustody?: (req: IncomingMessage) => boolean;
}

/** The caller's OWNER, resolved from the proved device header — regardless
 *  of which vault is addressed. `undefined` for host custody, an unenrolled
 *  caller, or a harness that never wired `enrollments`. */
export function requestingOwner(
  req: IncomingMessage,
  deps: OwnerScopeDeps
): Owner | undefined {
  const raw = req.headers?.[AUTHED_DEVICE_HEADER];
  const endpointId = Array.isArray(raw) ? raw[0] : raw;
  return typeof endpointId === "string" && deps.enrollments
    ? deps.enrollments.ownerFor(endpointId)
    : undefined;
}

/**
 * Refuse a vault-scoped act unless the caller owns `vaultId` — `undefined`
 * when allowed. Enforced ONLY when `enrollments` is wired: a host that never
 * wires ownership has no "acting owner" concept to check against.
 */
export function vaultOwnerRefusal(
  req: IncomingMessage,
  deps: OwnerScopeDeps,
  vaultId: string,
  verb: string
): { status: number; body: { error: string; message: string } } | undefined {
  if (!deps.enrollments) return undefined;
  const configOwner = requestingOwner(req, deps);
  const vaultOwnerId = deps.enrollments.owners.ownerOf(vaultId);
  if (configOwner && configOwner.ownerId === vaultOwnerId) return undefined;
  if (deps.isHostCustody?.(req) === true) {
    const ownerLabel = vaultOwnerId
      ? deps.enrollments.owners.get(vaultOwnerId)?.label
      : undefined;
    return {
      status: 403,
      body: {
        error: "owner_only",
        message: `only ${ownerLabel ?? "this vault's owner"} can ${verb}`,
      },
    };
  }
  return {
    status: 403,
    body: {
      error: "owner_required",
      message: `only the vault owner's device can ${verb}`,
    },
  };
}

/** A recovery-kit document scoped to ONLY the vaults the requesting owner
 *  owns. Fails closed to an empty `targets` array when no owner resolves. */
export function scopeKitToRequestingOwner(
  document: RecoveryKitDocument,
  req: IncomingMessage,
  deps: OwnerScopeDeps
): RecoveryKitDocument {
  const owner = requestingOwner(req, deps);
  const targets = document.targets.filter(
    (target) =>
      owner !== undefined &&
      deps.enrollments?.owners.ownerOf(target.vaultId) === owner.ownerId
  );
  return { ...document, targets };
}
