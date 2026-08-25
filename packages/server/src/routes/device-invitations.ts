/*
 * Who may mint a pairing ticket, for whom (issues #599 Decision 5, #726 P0/P1).
 *
 * Minting splits by TARGET:
 *
 *   self-pair — any enrolled owner may mint a ticket for THEMSELVES, landing
 *               a new device in the vaults they already own. "Ask your
 *               spouse for a QR to pair your own phone" fails the family
 *               test, so no second party is ever required.
 *   a NEW person — the *Add someone* mint (`body.forPerson`, #726 P1): create
 *               the person, mint them a vault of their own (identity keypair
 *               included), claim it, then mint a ticket bound to THAT owner.
 *               Mutually exclusive with `ownerId`/`vaultIds` — it names no
 *               existing owner or vault, because there is none yet. Any
 *               enrolled owner may run this ceremony (it costs disk on THIS
 *               machine, not access to anyone's vault); so may host custody.
 *   another EXISTING person — refused (`owner_vaults_only`): access is
 *               ownership, so a ticket cannot land someone in YOUR vaults,
 *               and minting for a DIFFERENT existing owner from a non-host
 *               caller is not a grant this module hands out.
 *
 * The host-custody lane (landlord bearer on the loopback socket) is L0 root:
 * it may mint for any EXISTING owner — the local recovery path, and the only
 * way back in after every device is lost.
 *
 * A joining device never names its own owner or vaults — this module decides
 * both, and `PairingTicketStore.mint` burns the decision into the ticket.
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

/** The *Add someone* request shape: `body.forPerson`. */
export interface ForPerson {
  label: string;
  vaultName?: string;
}

/** `undefined` = not present (ordinary lane); `null` = malformed. */
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

/** `null` = malformed; `[]` = the caller named no explicit vault list. */
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

/**
 * `body.operationId` — the client-chosen idempotency key the *Add someone*
 * mint lane requires (#750). Shape-checked here so a typo'd id can
 * never silently start a second provision: 8–128 chars of `[A-Za-z0-9._-]`
 * (a UUID fits). `undefined` = absent; `null` = malformed.
 */
export function parseOperationId(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return null;
  return /^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/u.test(raw) ? raw : null;
}

/**
 * Validation-only preflight for the *Add someone* mint lane (#726 P1, #750):
 * every refusal the lane can answer WITHOUT creating anything. The durable
 * workflow itself (owner → vault → ownership → ticket) lives in
 * `device-ticket-mint.ts`'s `executeForPersonMint`, which runs only after
 * this — and after the endpoint-capability preflight — has passed.
 */
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
  // Any enrolled owner may run this ceremony (it costs disk on THIS machine,
  // not access to anyone's vault); so may host custody.
  if (!callerOwner && !input.hostCustody) {
    return {
      status: 403,
      error: "device_identity_required",
      message:
        "minting a vault for a new person requires an enrolled owner device or direct host custody",
    };
  }
  // Mutually exclusive with the self-pair `ownerId`/`vaultIds` lane: there
  // is no existing owner or vault to name yet.
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
  /** Landing vault when the caller named no explicit vault list. */
  target: string;
  body: Record<string, unknown>;
  vaultIds: string[];
}

function orderTargetFirst(
  vaultIds: readonly string[],
  target: string
): string[] {
  // Reorder for defaulted targets too: `target` is the personal vault when
  // the caller named none, and vaultIds[0] decides the ticket's landing vault.
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
    // Creating a person here would land them in the minter's vaults, which
    // ownership forbids. P1 ships the mint that gives them their own vault.
    return {
      status: 403,
      error: "owner_vaults_only",
      message:
        "a ticket enrolls another of your own devices; adding a person mints them a vault of their own (arriving in a later release)",
    };
  }

  // The picker never sends free text: `ownerId` resolves an id (or an exact
  // label, for the CLI's `--owner`) and 404s otherwise, so a typo can never
  // mint a phantom owner with live access.
  const targetOwnerId = owners.ownerOf(input.target);
  const hostDefaultOwner =
    input.hostCustody && requestedOwner === undefined && targetOwnerId
      ? owners.get(targetOwnerId)
      : undefined;
  // An UNOWNED target on the host lane is founding-completion, not an
  // invitation into someone's vault: the owner is minted below, and
  // redemption claims the vault (#603's headless first-enroll, kept).
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
    // Ownership admits no cross-person grant: the only ticket a device may
    // mint is for its own owner. Host custody (L0 recovery) is the exception.
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
    // Topology hiding: a vault this owner does not own is indistinguishable
    // from one that does not exist — `not_found`, never `forbidden`. An
    // UNOWNED vault passes only on the host lane, where redemption claims it.
    const vaultOwner = owners.ownerOf(vaultId);
    const reachable =
      (existing !== undefined && vaultOwner === existing.ownerId) ||
      (vaultOwner === undefined && input.hostCustody);
    if (reachable && input.vaultName(vaultId) !== undefined) continue;
    // Host custody can SEE this vault (it can read the disk) — an honest
    // `owner_only` naming the real owner, never a fake `not_found` (#726
    // P1). Only when the vault genuinely has a DIFFERENT owner: an unknown
    // vault id still 404s below, even for host custody.
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
    // Founding-completion claims the unowned vaults NOW, so a re-mint before
    // redemption converges on this owner instead of inventing another.
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
