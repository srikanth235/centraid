/*
 * `POST /centraid/_gateway/devices/ticket` — mint a one-time pairing ticket
 * (the inverse of revoke; the wire twin of `cli/device-admin.ts`'s `pair`).
 * Split out of `devices-routes.ts` (issue #726 P1 — the *Add someone* mint
 * lane grew this branch past the file-size cap) purely to keep files small;
 * it shares `devices-routes.ts`'s deps/caller-scope shape exactly.
 *
 * The *Add someone* lane (`body.forPerson`, #726 P1) is a durable PROVISION
 * (issue #750): it preflights every refusable condition — including the iroh
 * endpoint capability — BEFORE creating anything, and it is idempotent under
 * a client-chosen `operationId` (see `executeForPersonMint`).
 */

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { GatewayDatabase } from "../serve/gateway-db.js";
import {
  encodePairingTicket,
  DEFAULT_TICKET_TTL_MS,
} from "../serve/pairing-store.js";
import type { ForPerson } from "./device-invitations.js";
import {
  parseForPerson,
  parseOperationId,
  parseVaultIds,
  preflightForPersonMint,
  resolveInvitation,
} from "./device-invitations.js";
import type { DevicesRouteDeps } from "./devices-routes.js";
import { readJson, sendJson } from "./route-helpers.js";

/** The canonical vault-addressing header (mirrors the client's `VAULT_HEADER`). */
const VAULT_HEADER = "x-centraid-vault";

function mintVaultForPersonUnwired(): never {
  throw new Error("mint-for-person is not wired on this gateway");
}

/** The recorded outcome of a provision operation, if one exists, alongside
 *  the request fingerprint it was recorded under. */
function readProvisionOperation(
  database: GatewayDatabase,
  operationId: string
): { requestHash: string; result: Record<string, unknown> } | undefined {
  const row = database.db
    .prepare(
      "SELECT request_hash, result_json FROM provision_operations WHERE operation_id = ?"
    )
    .get(operationId) as
    | { request_hash: string; result_json: string }
    | undefined;
  return row
    ? {
        requestHash: row.request_hash,
        result: JSON.parse(row.result_json) as Record<string, unknown>,
      }
    : undefined;
}

/**
 * Fingerprint of the provisioning request's defining inputs (issue #750
 * audit): an explicit, ORDERED field list — never an object — so key order
 * can never perturb the hash. An `operationId` replayed with a matching hash
 * replays the recorded result; a different hash means the id names a
 * DIFFERENT request and must be refused, never silently answered with the
 * first request's result.
 */
function hashProvisionRequest(input: {
  forPerson: ForPerson;
  ttlMs: number;
}): string {
  const fields = [
    input.forPerson.label,
    input.forPerson.vaultName ?? "",
    String(input.ttlMs),
  ];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/**
 * The *Add someone* durable workflow (issue #750): owner → vault → ownership
 * → ticket → operation record. Atomicity is by CONSTRUCTION, not by resume:
 *
 *   1. The ONE non-transactional step — the vault dir on disk, its SQLite
 *      files and identity keypair inside it (`VaultRegistry.create`) — runs
 *      FIRST. If it throws, nothing durable exists yet.
 *   2. Every gateway.db row (owner, vault_owners, ticket, the
 *      provision_operations record) then commits in ONE transaction. If any
 *      step throws, the rollback leaves ZERO rows and the only debris is the
 *      orphan vault from step 1, which `unmintVaultForPerson` removes
 *      (dir + keys + registry mount) before the failure is rethrown.
 *
 * Rollback was chosen over resume because the workflow is cheap to redo and
 * resume would need per-step provenance; a retry with the SAME `operationId`
 * simply starts over from nothing (or replays the recorded result if a prior
 * attempt committed).
 *
 * Replay semantics: the recorded result is the FULL original response,
 * returned verbatim — including the ORIGINAL ticket. Replaying does not mint
 * a fresh ticket (that would make replay a write and let one operation id
 * mint unbounded live tickets); a client holding an EXPIRED replayed ticket
 * mints a new operation (fresh `operationId`) instead. An `operationId` reused
 * with a DIFFERENT request (see `hashProvisionRequest`) is refused rather than
 * replayed — an operation id names exactly one request, forever.
 *
 * Two racing requests with the same `operationId` are decided by the
 * `provision_operations` PRIMARY KEY: the loser's transaction rolls back
 * (vault cleaned up as above) and its retry replays the winner's result.
 */
function executeForPersonMint(input: {
  deps: DevicesRouteDeps;
  database: GatewayDatabase;
  gw: string;
  forPerson: ForPerson;
  operationId: string;
  requestHash: string;
  ttlMs: number;
}): Record<string, unknown> {
  const { deps, database, forPerson } = input;
  const owners = deps.enrollments.owners;
  if (deps.tickets.gatewayDatabase.file !== database.file) {
    // Single-transaction atomicity below depends on the stores sharing one
    // handle's database (mirrors `redeemAndEnroll`'s guard).
    throw new Error("ticket and owner stores must share gateway.db");
  }
  const mintVault = deps.mintVaultForPerson ?? mintVaultForPersonUnwired;
  const minted = mintVault(forPerson.vaultName ?? `${forPerson.label}'s vault`);
  try {
    return database.transaction(() => {
      const owner = owners.createWithinTransaction(forPerson.label);
      // Claim right after mount (same ordering `enrollWithinTransaction` uses
      // for founding/`vault create`): the vault exists on disk first, then
      // the ownership row lands with the rest of this transaction.
      owners.setOwner(minted.vaultId, owner.ownerId);
      const ticket = deps.tickets.mint(
        { ownerId: owner.ownerId, vaultIds: [minted.vaultId] },
        input.ttlMs
      );
      const vaultName = deps.vaultName(minted.vaultId);
      const response: Record<string, unknown> = {
        ok: true,
        ticket: encodePairingTicket({
          v: 1,
          kind: "centraid-gw-pair",
          gw: input.gw,
          t: ticket.ticketId,
          s: ticket.secret,
          vaultName: vaultName ?? minted.vaultId,
          exp: ticket.expiresAt,
        }),
        ownerId: owner.ownerId,
        ownerLabel: owner.label,
        vaults: [
          {
            vaultId: minted.vaultId,
            ...(vaultName === undefined ? {} : { vaultName }),
          },
        ],
        // The first vault is also reported flat so single-vault callers (the
        // `pair` CLI, the desktop panel) need no shape change to keep working.
        vaultId: minted.vaultId,
        ...(vaultName === undefined ? {} : { vaultName }),
        expiresAt: new Date(ticket.expiresAt).toISOString(),
      };
      database.db
        .prepare(
          "INSERT INTO provision_operations (operation_id, request_hash, result_json, created_at) VALUES (?, ?, ?, ?)"
        )
        .run(
          input.operationId,
          input.requestHash,
          JSON.stringify(response),
          new Date().toISOString()
        );
      return response;
    });
  } catch (error) {
    try {
      // The rolled-back transaction left zero rows; remove the one orphan —
      // the vault dir (and the keys inside it) minted before the transaction.
      deps.unmintVaultForPerson?.(minted.vaultId);
    } catch {
      // Keep the ORIGINAL failure. The orphan dir is inert debris: nothing
      // references a vault id no committed row names, and ids never repeat.
    }
    throw error;
  }
}

/** The idempotent *Add someone* lane, after every preflight has passed. */
function handleForPersonMint(
  res: ServerResponse,
  deps: DevicesRouteDeps,
  args: {
    callerKey: string | undefined;
    hostCustody: boolean;
    body: Record<string, unknown>;
    vaultIds: string[];
    forPerson: ForPerson;
    gw: string;
    ttlMs: number;
  }
): boolean {
  const refusal = preflightForPersonMint({
    enrollments: deps.enrollments,
    callerKey: args.callerKey,
    hostCustody: args.hostCustody,
    body: args.body,
    vaultIds: args.vaultIds,
  });
  if (refusal) {
    return sendJson(res, refusal.status, {
      error: refusal.error,
      message: refusal.message,
    });
  }
  const operationId = parseOperationId(args.body.operationId);
  if (operationId === undefined) {
    return sendJson(res, 400, {
      error: "operation_id_required",
      message:
        "forPerson mints durable state, so it requires an operationId — a client-chosen idempotency key a retry reuses",
    });
  }
  if (operationId === null) {
    return sendJson(res, 400, {
      error: "invalid_operation_id",
      message:
        "operationId must be 8-128 characters of letters, digits, '.', '_' or '-' (a UUID fits)",
    });
  }
  const database = deps.enrollments.owners.gatewayDatabase;
  const requestHash = hashProvisionRequest({
    forPerson: args.forPerson,
    ttlMs: args.ttlMs,
  });
  const recorded = readProvisionOperation(database, operationId);
  if (recorded !== undefined) {
    if (recorded.requestHash !== requestHash) {
      // The id already names a DIFFERENT request: replaying it here would
      // hand the caller someone else's result while recording nothing of
      // their own — refuse instead (issue #750 audit).
      return sendJson(res, 409, {
        error: "operation_id_conflict",
        message:
          "operationId already names a different provisioning request — choose a new operationId for a different request",
      });
    }
    // Idempotent replay: the recorded original response, verbatim; nothing
    // is re-minted. See `executeForPersonMint` for the expired-ticket rule.
    return sendJson(res, 200, recorded.result);
  }
  try {
    return sendJson(
      res,
      200,
      executeForPersonMint({
        deps,
        database,
        gw: args.gw,
        forPerson: args.forPerson,
        operationId,
        requestHash,
        ttlMs: args.ttlMs,
      })
    );
  } catch (error) {
    // HTTP boundary (fallible-action contract): the workflow cleaned up
    // after itself, so report the failure instead of hanging the request.
    return sendJson(res, 500, {
      error: "provision_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

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
      message: "forPerson must be an object with a non-empty label",
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
  // Endpoint-capability PREFLIGHT (issue #750): `gw` is required in
  // `PairingTicketPayload` — a ticket without the iroh endpoint pin can't be
  // redeemed. It runs BEFORE any invitation resolution or minting, so an
  // endpoint-less gateway refuses without creating anything (everything
  // above this line is parse/validation only — no writes precede it).
  const gw = deps.endpointTicket?.();
  if (gw === undefined) {
    return sendJson(res, 409, {
      error: "no_iroh_endpoint",
      message:
        "gateway has no iroh endpoint identity yet — start the daemon so it mints its endpoint",
    });
  }
  const ttlMs =
    typeof body.ttlMinutes === "number" && body.ttlMinutes > 0
      ? body.ttlMinutes * 60_000
      : DEFAULT_TICKET_TTL_MS;
  if (forPerson !== undefined) {
    // *Add someone* (#726 P1, #750): the idempotent provision lane.
    return handleForPersonMint(res, deps, {
      callerKey,
      hostCustody,
      body,
      vaultIds: requestedVaultIds,
      forPerson,
      gw,
      ttlMs,
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
  // (`vaults_required` refuses first).
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
