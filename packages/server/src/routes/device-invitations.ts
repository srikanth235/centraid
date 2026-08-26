/*
 * Who may mint a pairing ticket, for whom (#599 D5, #726 P0/P1). Self-pair
 * needs no second party; `body.forPerson` mints a NEW person their own vault.
 * Minting for another EXISTING person is refused — access is ownership —
 * except on the L0 host-custody lane.
 */

import type { EnrollmentStore } from "../serve/enrollment-store.js";

export interface InvitationRefusal {
  error: string;
  message: string;
  status: number;
}

export interface Invitation {
  ownerId: string;
  ownerLabel: string;
  vaultIds: string[];
}

export type InvitationDecision = Invitation | InvitationRefusal;

export interface ForPerson {
  label: string;
  vaultName?: string;
}

/** `undefined` = absent; `null` = malformed. */
export function parseForPerson(raw: unknown): ForPerson | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const body = raw as Record<string, unknown>;
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) return null;
  if (body.vaultName !== undefined && typeof body.vaultName !== "string")
    return null;
  const vaultName =
    typeof body.vaultName === "string" ? body.vaultName.trim() : undefined;
  if (vaultName !== undefined && vaultName.length === 0) return null;
  return vaultName ? { label, vaultName } : { label };
}

/** `null` = malformed; `[]` = no explicit list. */
export function parseVaultIds(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const vaultIds: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0) return null;
    vaultIds.push(entry);
  }
  return vaultIds;
}

/** Idempotency key (#750): a typo must not double-provision. */
export function parseOperationId(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return null;
  return /^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/u.test(raw) ? raw : null;
}

/** Refusals answerable WITHOUT creating anything. */
export function preflightForPersonMint(input: {
  enrollments: EnrollmentStore;
  callerKey: string | undefined;
  hostCustody: boolean;
  body: Record<string, unknown>;
  vaultIds: string[];
}): InvitationRefusal | undefined {
  const callerOwner = input.callerKey
    ? input.enrollments.ownerFor(input.callerKey)
    : undefined;
  if (!callerOwner && !input.hostCustody) {
    return {
      status: 403,
      error: "device_identity_required",
      message:
        "minting a vault for a new person requires an enrolled owner device or direct host custody",
    };
  }
  if (typeof input.body.ownerId === "string" || input.vaultIds.length > 0) {
    return {
      status: 400,
      error: "invalid_body",
      message: "forPerson cannot be combined with ownerId or vaultIds",
    };
  }
  return undefined;
}

export interface ResolveInvitationInput {
  enrollments: EnrollmentStore;
  vaultName: (vaultId: string) => string | undefined;
  callerKey: string | undefined;
  hostCustody: boolean;
  /** Landing vault when no list was named. */
  target: string;
  body: Record<string, unknown>;
  vaultIds: string[];
}

function orderTargetFirst(
  vaultIds: readonly string[],
  target: string
): string[] {
  // vaultIds[0] decides the landing vault, defaults included.
  const index = vaultIds.indexOf(target);
  if (index <= 0) return [...vaultIds];
  const picked = vaultIds[index]!;
  return [picked, ...vaultIds.filter((_, at) => at !== index)];
}

export function resolveInvitation(
  input: ResolveInvitationInput
): InvitationDecision {
  const owners = input.enrollments.owners;
  const callerOwner = input.callerKey
    ? input.enrollments.ownerFor(input.callerKey)
    : undefined;

  const requestedOwner =
    typeof input.body.ownerId === "string" ? input.body.ownerId : undefined;
  if (typeof input.body.newOwnerLabel === "string") {
    // This would land them in the minter's vaults.
    return {
      status: 403,
      error: "owner_vaults_only",
      message:
        "a ticket enrolls another of your own devices; adding a person mints them a vault of their own (arriving in a later release)",
    };
  }

  // `ownerId` 404s unless it resolves: no phantom owners.
  const targetOwnerId = owners.ownerOf(input.target);
  const hostDefaultOwner =
    input.hostCustody && requestedOwner === undefined && targetOwnerId
      ? owners.get(targetOwnerId)
      : undefined;
  // An UNOWNED host-lane target is founding-completion.
  const hostFounding =
    input.hostCustody &&
    requestedOwner === undefined &&
    callerOwner === undefined &&
    targetOwnerId === undefined;
  const existing =
    requestedOwner === undefined
      ? (callerOwner ?? hostDefaultOwner)
      : owners.find(requestedOwner);
  if (!existing && !hostFounding) {
    return requestedOwner === undefined
      ? {
          status: 403,
          error: "device_identity_required",
          message:
            "pairing tickets require an enrolled device or direct host custody",
        }
      : {
          status: 404,
          error: "owner_not_found",
          message: `no owner matches "${requestedOwner}"`,
        };
  }
  if (
    existing &&
    !input.hostCustody &&
    existing.ownerId !== callerOwner?.ownerId
  ) {
    // A device mints only for its own owner; host custody excepted.
    return {
      status: 403,
      error: "owner_vaults_only",
      message:
        "a ticket enrolls another of your own devices; adding a person mints them a vault of their own (arriving in a later release)",
    };
  }

  const owned = existing ? owners.vaultsOwnedBy(existing.ownerId) : [];
  const vaultIds =
    input.vaultIds.length > 0
      ? input.vaultIds
      : owned.length > 0
        ? orderTargetFirst(owned, input.target)
        : [input.target];
  if (vaultIds.length === 0) {
    return {
      status: 400,
      error: "vaults_required",
      message: "an invitation must land the device in at least one vault",
    };
  }
  for (const vaultId of vaultIds) {
    // Topology hiding: `not_found`, never `forbidden`.
    const vaultOwner = owners.ownerOf(vaultId);
    const reachable =
      (existing !== undefined && vaultOwner === existing.ownerId) ||
      (vaultOwner === undefined && input.hostCustody);
    if (reachable && input.vaultName(vaultId) !== undefined) continue;
    // Host custody reads the disk, so it earns an honest `owner_only`; an
    // unknown vault id still 404s below.
    if (
      input.hostCustody &&
      vaultOwner !== undefined &&
      input.vaultName(vaultId) !== undefined
    ) {
      const ownerLabel = owners.get(vaultOwner)?.label;
      return {
        status: 403,
        error: "owner_only",
        message: `${ownerLabel ?? "this vault's owner"} owns "${input.vaultName(vaultId)}" — minting a pairing ticket for it takes their own device or ownership`,
      };
    }
    return {
      status: 404,
      error: "not_found",
      message: "unknown vault in vaultIds",
    };
  }

  const owner = existing ?? owners.create("You");
  if (!existing) {
    // Claim NOW: a re-mint must converge on this owner.
    for (const vaultId of vaultIds) {
      if (owners.ownerOf(vaultId) === undefined)
        owners.setOwner(vaultId, owner.ownerId);
    }
  }
  return {
    ownerId: owner.ownerId,
    ownerLabel: owner.label,
    vaultIds,
  };
}
