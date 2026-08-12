/*
 * `POST /centraid/_gateway/devices/ticket` — mint a one-time pairing ticket
 * (the inverse of revoke; the wire twin of `cli/device-admin.ts`'s `pair`).
 * Split out of `devices-routes.ts` (issue #726 P1 — the *Add someone* mint
 * lane grew this branch past the file-size cap) purely to keep files small;
 * it shares `devices-routes.ts`'s deps/caller-scope shape exactly.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  encodePairingTicket,
  DEFAULT_TICKET_TTL_MS,
} from "../serve/pairing-store.js";
import {
  parseForPerson,
  parseVaultIds,
  resolveInvitation,
} from "./device-invitations.js";
import type { DevicesRouteDeps } from "./devices-routes.js";
import { readJson, sendJson } from "./route-helpers.js";

/** The canonical vault-addressing header (mirrors the client's `VAULT_HEADER`). */
const VAULT_HEADER = "x-centraid-vault";

export async function handleTicketMint(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DevicesRouteDeps,
  callerKey: string | undefined,
  allowedVaults: ReadonlySet<string>,
  isAllowed: (vaultId: string) => boolean
): Promise<boolean> {
  if ((req.method ?? "GET") !== "POST") {
    return sendJson(res, 405, { error: "method_not_allowed" });
  }
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { error: "invalid_body" });
  }
  // Target vault: explicit `body.vaultId`, else the addressed-vault header
  // the shell/web control session stamps on every request.
  const headerVault = req.headers[VAULT_HEADER];
  const requested =
    typeof body.vaultId === "string"
      ? body.vaultId
      : typeof headerVault === "string"
        ? headerVault
        : undefined;
  const hostCustody = deps.canMintPairingTicket?.(req) === true;
  if (!callerKey && !hostCustody) {
    return sendJson(res, 403, {
      error: "device_identity_required",
      message:
        "pairing tickets require an enrolled owner device or direct host custody",
    });
  }
  const forPerson = parseForPerson(body.forPerson);
  if (forPerson === null) {
    return sendJson(res, 400, {
      error: "invalid_for_person",
      message:
        "forPerson must carry a stable operationId and a non-empty label",
    });
  }
  const hostVaults = hostCustody ? (deps.vaultIds?.() ?? []) : [];
  // No named target → the registry default (the personal vault), but only when the
  // caller may actually address it; otherwise fall back to what it holds.
  const preferred = deps.defaultVaultId?.();
  const target =
    requested === undefined
      ? ((preferred !== undefined &&
        (allowedVaults.has(preferred) || hostVaults.includes(preferred))
          ? preferred
          : undefined) ??
        [...allowedVaults][0] ??
        hostVaults[0])
      : [...allowedVaults, ...hostVaults].find(
          (vaultId) =>
            vaultId === requested || deps.vaultName(vaultId) === requested
        );
  // The *Add someone* lane names no existing vault, so the ordinary
  // target-resolution/existence guard below does not apply to it.
  if (forPerson === undefined) {
    if (target === undefined) {
      return sendJson(res, 400, { error: "vault_required" });
    }
    // Scope + existence guard (no existence leak — a device caller outside
    // the vault, or an unknown vault, both 404 the same way).
    if (
      (!isAllowed(target) && !hostVaults.includes(target)) ||
      deps.vaultName(target) === undefined
    ) {
      return sendJson(res, 404, { error: "not_found" });
    }
  }
  const requestedVaultIds = parseVaultIds(body.vaultIds);
  if (requestedVaultIds === null) {
    return sendJson(res, 400, {
      error: "invalid_vault_ids",
      message: "vaultIds must be a list of vault ids",
    });
  }
  const ttlMs =
    typeof body.ttlMinutes === "number" && body.ttlMinutes > 0
      ? body.ttlMinutes * 60_000
      : DEFAULT_TICKET_TTL_MS;
  // Preflight every external requirement before the Add-someone workflow
  // creates a principal, vault, or ownership row (#750).
  const gw = deps.endpointTicket?.();
  if (gw === undefined) {
    return sendJson(res, 409, {
      error: "no_iroh_endpoint",
      message:
        "gateway has no iroh endpoint identity yet — start the daemon so it mints its endpoint",
    });
  }
  if (forPerson) {
    if (typeof body.ownerId === "string" || requestedVaultIds.length > 0) {
      return sendJson(res, 400, {
        error: "invalid_body",
        message: "forPerson cannot be combined with ownerId or vaultIds",
      });
    }
    if (!deps.provisionPerson)
      return sendJson(res, 503, {
        error: "provision_person_unavailable",
        message: "resumable person provisioning is not wired on this gateway",
      });
    let provisioned;
    try {
      provisioned = deps.provisionPerson({
        operationId: forPerson.operationId,
        ownerLabel: forPerson.label,
        vaultName: forPerson.vaultName ?? `${forPerson.label}'s vault`,
        ttlMs,
      });
    } catch (error) {
      return sendJson(res, 409, {
        error: "provision_person_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const token = encodePairingTicket({
      v: 1,
      kind: "centraid-gw-pair",
      gw,
      t: provisioned.ticketId,
      s: provisioned.secret,
      vaultName: provisioned.vaultName,
      exp: provisioned.expiresAt,
    });
    return sendJson(res, 200, {
      ok: true,
      ticket: token,
      ownerId: provisioned.ownerId,
      ownerLabel: provisioned.ownerLabel,
      vaults: [
        {
          vaultId: provisioned.vaultId,
          vaultName: provisioned.vaultName,
        },
      ],
      vaultId: provisioned.vaultId,
      vaultName: provisioned.vaultName,
      expiresAt: new Date(provisioned.expiresAt).toISOString(),
    });
  }
  const invitation = resolveInvitation({
    enrollments: deps.enrollments,
    vaultName: deps.vaultName,
    callerKey,
    hostCustody,
    target: target ?? "",
    body,
    vaultIds: requestedVaultIds,
  });
  if ("error" in invitation) {
    return sendJson(res, invitation.status, {
      error: invitation.error,
      message: invitation.message,
    });
  }
  const minted = deps.tickets.mint(
    { ownerId: invitation.ownerId, vaultIds: invitation.vaultIds },
    ttlMs
  );
  // `resolveInvitation` never returns an empty `vaultIds` on success
  // (ordinary lane: `vaults_required` refuses first; mint lane: the freshly
  // created vault is always vaultIds[0]).
  const primaryVaultId = invitation.vaultIds[0]!;
  const token = encodePairingTicket({
    v: 1,
    kind: "centraid-gw-pair",
    gw,
    t: minted.ticketId,
    s: minted.secret,
    vaultName: deps.vaultName(primaryVaultId) ?? primaryVaultId,
    exp: minted.expiresAt,
  });
  return sendJson(res, 200, {
    ok: true,
    ticket: token,
    ownerId: invitation.ownerId,
    ownerLabel: invitation.ownerLabel,
    vaults: invitation.vaultIds.map((vaultId) => ({
      vaultId,
      vaultName: deps.vaultName(vaultId),
    })),
    // The first vault is also reported flat so single-vault callers (the
    // `pair` CLI, the desktop panel) need no shape change to keep working.
    vaultId: primaryVaultId,
    vaultName: deps.vaultName(primaryVaultId),
    expiresAt: new Date(minted.expiresAt).toISOString(),
  });
}
