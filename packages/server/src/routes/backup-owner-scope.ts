import type { IncomingMessage } from "node:http";

import type { RecoveryKitDocument } from "@centraid/backup";
import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";

import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type { Owner } from "../serve/owner-store.js";

export interface OwnerScopeDeps {
  enrollments?: EnrollmentStore;
  isHostCustody?: (req: IncomingMessage) => boolean;
}

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
