import type { IncomingMessage, ServerResponse } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";
import { recoverCommonsFromReplica } from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import { commonsObservabilityForVault } from "../serve/commons-observability.js";
import { deliverCommonsRecoveryInvitations } from "../serve/commons-recovery-invites.js";
import type { DeliverCommonsRecoveryInvitationsInput } from "../serve/commons-recovery-invites.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import { readJson, sendJson } from "./route-helpers.js";

export const COMMONS_RECOVERY_PATH = "/centraid/_gateway/commons/recovery";

export interface CommonsRecoveryRouteDeps {
  enrollments: EnrollmentStore;
  vaultFor: (vaultId: string) => VaultDb | undefined;
  invitePeer?: DeliverCommonsRecoveryInvitationsInput["invitePeer"];
}

export type CommonsRecoveryRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse
) => Promise<boolean>;

function callerOwnerId(
  req: IncomingMessage,
  deps: CommonsRecoveryRouteDeps
): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length === 0) return undefined;
  return deps.enrollments.ownerFor(value)?.ownerId;
}

function ownedVault(
  deps: CommonsRecoveryRouteDeps,
  ownerId: string,
  vaultId: string
): VaultDb {
  if (deps.enrollments.owners.ownerOf(vaultId) !== ownerId)
    throw new Error("actor vault is not owned by this caller");
  const vault = deps.vaultFor(vaultId);
  if (!vault) throw new Error("actor vault is not mounted");
  return vault;
}

export function makeCommonsRecoveryRouteHandler(
  deps: CommonsRecoveryRouteDeps
): CommonsRecoveryRouteHandler {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname !== COMMONS_RECOVERY_PATH) return false;
    const ownerId = callerOwnerId(req, deps);
    if (!ownerId)
      return sendJson(res, 403, { error: "device_identity_required" });
    try {
      if (req.method === "GET") {
        const actorVaultId = url.searchParams.get("actorVaultId") ?? "";
        const vault = ownedVault(deps, ownerId, actorVaultId);
        return sendJson(res, 200, {
          ...commonsObservabilityForVault({ db: vault, vaultId: actorVaultId }),
        });
      }
      if (req.method !== "POST") return false;
      const body = await readJson(req);
      const actorVaultId =
        typeof body.actorVaultId === "string" ? body.actorVaultId : "";
      const grantId = typeof body.grantId === "string" ? body.grantId : "";
      if (!grantId) throw new Error("grantId is required");
      const vault = ownedVault(deps, ownerId, actorVaultId);
      const now = new Date().toISOString();
      const result = recoverCommonsFromReplica({
        seat: vault,
        localVaultId: actorVaultId,
        grantId,
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
        now,
      });
      if (result.state !== "recovered") return sendJson(res, 409, result);
      const invitations = await deliverCommonsRecoveryInvitations({
        seat: vault,
        stewardVaultId: actorVaultId,
        grantId: result.grantId,
        vaultFor: deps.vaultFor,
        ...(deps.invitePeer ? { invitePeer: deps.invitePeer } : {}),
        now,
      });
      return sendJson(res, 200, { ...result, invitations });
    } catch (error) {
      return sendJson(res, 400, {
        error: error instanceof Error ? error.message : "bad_request",
      });
    }
  };
}
