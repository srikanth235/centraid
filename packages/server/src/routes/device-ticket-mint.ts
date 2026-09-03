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

const VAULT_HEADER = "x-centraid-vault";

function mintVaultForPersonUnwired(): never {
  throw new Error("mint-for-person is not wired on this gateway");
}

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
    throw new Error("ticket and owner stores must share gateway.db");
  }
  const mintVault = deps.mintVaultForPerson ?? mintVaultForPersonUnwired;
  const minted = mintVault(forPerson.vaultName ?? `${forPerson.label}'s vault`);
  try {
    return database.transaction(() => {
      const owner = owners.createWithinTransaction(forPerson.label);
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
      deps.unmintVaultForPerson?.(minted.vaultId);
    } catch {
      // Intentionally empty.
    }
    throw error;
  }
}

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
      return sendJson(res, 409, {
        error: "operation_id_conflict",
        message:
          "operationId already names a different provisioning request — choose a new operationId for a different request",
      });
    }
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
  if (forPerson === undefined) {
    if (target === undefined) {
      return sendJson(res, 400, { error: "vault_required" });
    }
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
    vaultId: primaryVaultId,
    vaultName: deps.vaultName(primaryVaultId),
    expiresAt: new Date(minted.expiresAt).toISOString(),
  });
}
