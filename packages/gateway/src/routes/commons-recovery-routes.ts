/**
 * Owner-tier doors for Commons steward-absence recovery (#731).
 *
 * Two verbs, both same-machine owner-authenticated exactly like
 * `commons-routes.ts`:
 *
 *   GET  /centraid/_gateway/commons/recovery?actorVaultId=…
 *        The escalating steward status per commons grant this vault holds,
 *        plus the local sync instrumentation behind it. This is the surface a
 *        member renders "Alice's device hasn't been reachable for 9 days" from.
 *
 *   POST /centraid/_gateway/commons/recovery
 *        { actorVaultId, grantId, reason? } — perform the ceremony. Deliberate,
 *        never automatic; refuses with a NAMED reason when the seat is parked
 *        on a divergence fault or already stewards the grant.
 *
 * Recovery never fabricates consent: the successor's roster mirrors the old
 * one, but every other seat is INVITED and must accept. Sending those
 * invitations is the ordinary invite path (`invitePeer`), left to the caller
 * so this door does exactly one thing.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import { commonsCurrentSize, recoverCommonsFromReplica } from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import { commonsObservabilityForVault } from "../serve/commons-observability.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import { readJson, sendJson } from "./route-helpers.js";

export const COMMONS_RECOVERY_PATH = "/centraid/_gateway/commons/recovery";

export interface CommonsRecoveryRouteDeps {
  enrollments: EnrollmentStore;
  vaultFor: (vaultId: string) => VaultDb | undefined;
  invitePeer?: (input: {
    stewardVaultId: string;
    memberVaultId: string;
    grantId: string;
    memberPartyId: string;
    capability: "read" | "read+write";
    containerType: string;
    containerId: string;
    containerLabel?: string;
    currentSizeBytes: number;
    maxSizeBytes?: number;
  }) => Promise<boolean>;
}

/** Same shape `RouteHandler` has in `build-gateway.ts`, restated locally so
 *  this module does not import the builder it is mounted into. */
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
      const result = recoverCommonsFromReplica({
        seat: vault,
        localVaultId: actorVaultId,
        grantId,
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
        now: new Date().toISOString(),
      });
      if (result.state !== "recovered") return sendJson(res, 409, result);
      const grant = vault.vault
        .prepare(
          `SELECT max_size_bytes FROM share_circle_grant WHERE grant_id = ?`
        )
        .get(result.grantId) as { max_size_bytes: number | null };
      const label = vault.vault
        .prepare("SELECT name FROM social_circle WHERE circle_id = ?")
        .get(result.circleId) as { name: string } | undefined;
      const invitees = vault.vault
        .prepare(
          `SELECT m.party_id, m.capability, b.vault_id
             FROM social_circle_member m
             JOIN share_party_vault_binding b
               ON b.party_id = m.party_id AND b.revoked_at IS NULL
            WHERE m.circle_id = ? AND m.party_id <>
              (SELECT owner_party_id FROM core_vault LIMIT 1)
            ORDER BY m.party_id`
        )
        .all(result.circleId) as {
        party_id: string;
        capability: "read" | "read+write";
        vault_id: string;
      }[];
      const currentSizeBytes = commonsCurrentSize(
        vault.vault,
        actorVaultId,
        result.grantId
      );
      const invitations = await Promise.all(
        invitees.map(async (invitee) => ({
          partyId: invitee.party_id,
          vaultId: invitee.vault_id,
          delivered:
            (await deps.invitePeer?.({
              stewardVaultId: actorVaultId,
              memberVaultId: invitee.vault_id,
              grantId: result.grantId,
              memberPartyId: invitee.party_id,
              capability: invitee.capability,
              containerType: result.containerType,
              containerId: result.containerId,
              ...(label?.name ? { containerLabel: label.name } : {}),
              currentSizeBytes,
              ...(grant.max_size_bytes === null
                ? {}
                : { maxSizeBytes: grant.max_size_bytes }),
            })) ?? false,
        }))
      );
      return sendJson(res, 200, { ...result, invitations });
    } catch (error) {
      return sendJson(res, 400, {
        error: error instanceof Error ? error.message : "bad_request",
      });
    }
  };
}
