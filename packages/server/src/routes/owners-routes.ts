import type { IncomingMessage, ServerResponse } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";

import type { RouteHandler } from "../serve/build-gateway.js";
import type {
  DeviceEnrollment,
  EnrollmentStore,
} from "../serve/enrollment-store.js";
import { OwnerRemovalError } from "../serve/owner-store.js";
import type { Owner } from "../serve/owner-store.js";
import { readJson, sendJson } from "./route-helpers.js";

const OWNERS_PATH = "/centraid/_gateway/owners";

export interface OwnersRouteDeps {
  enrollments: EnrollmentStore;
  vaultName: (vaultId: string) => string | undefined;
  isHostCustody?: (req: IncomingMessage) => boolean;
  onRevoked?: (rows: DeviceEnrollment[]) => void | Promise<void>;
  onEndpointRevoked?: (endpointId: string) => void | Promise<void>;
}

function callerDeviceKey(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function ownerDto(
  deps: OwnersRouteDeps,
  owner: Owner
): Record<string, unknown> {
  const devices = deps.enrollments
    .list()
    .filter((row) => row.ownerId === owner.ownerId);
  return {
    ownerId: owner.ownerId,
    label: owner.label,
    createdAt: owner.createdAt,
    vaults: deps.enrollments.owners
      .vaultsOwnedBy(owner.ownerId)
      .map((vaultId) => ({
        vaultId,
        vaultName: deps.vaultName(vaultId),
      })),
    deviceCount: new Set(devices.map((row) => row.endpointId)).size,
  };
}

export function makeOwnersRouteHandler(deps: OwnersRouteDeps): RouteHandler {
  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (
      url.pathname !== OWNERS_PATH &&
      !url.pathname.startsWith(`${OWNERS_PATH}/`)
    ) {
      return false;
    }
    const method = req.method ?? "GET";
    const hostCustody = deps.isHostCustody?.(req) === true;
    const callerKey = callerDeviceKey(req);
    const caller = callerKey ? deps.enrollments.ownerFor(callerKey) : undefined;
    if (!caller && !hostCustody) {
      return sendJson(res, 403, {
        error: "device_identity_required",
        message: "this route requires a proved iroh device identity",
      });
    }
    const owners = deps.enrollments.owners;
    const visible = (owner: Owner): boolean =>
      hostCustody || owner.ownerId === caller?.ownerId;

    if (url.pathname === OWNERS_PATH) {
      if (method === "GET") {
        return sendJson(res, 200, {
          owners: owners
            .list()
            .filter(visible)
            .map((owner) => ownerDto(deps, owner)),
        });
      }
      if (method !== "POST")
        return sendJson(res, 405, { error: "method_not_allowed" });
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: "invalid_body" });
      }
      const label = typeof body.label === "string" ? body.label.trim() : "";
      if (!label) return sendJson(res, 400, { error: "label_required" });
      if (!hostCustody) {
        return sendJson(res, 403, {
          error: "owner_vaults_only",
          message:
            "adding a person mints them a vault of their own (arriving in a later release)",
        });
      }
      const created = owners.create(label);
      return sendJson(res, 201, { owner: ownerDto(deps, created) });
    }

    const ownerId = decodeURIComponent(
      url.pathname.slice(`${OWNERS_PATH}/`.length)
    );
    if (!ownerId) return false;
    const owner = owners.get(ownerId);
    if (!owner || !visible(owner))
      return sendJson(res, 404, { error: "not_found" });

    if (method === "PATCH") {
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: "invalid_body" });
      }
      const label = typeof body.label === "string" ? body.label.trim() : "";
      if (!label) return sendJson(res, 400, { error: "label_required" });
      return sendJson(res, 200, {
        owner: ownerDto(deps, owners.rename(owner.ownerId, label)),
      });
    }

    if (method !== "DELETE")
      return sendJson(res, 405, { error: "method_not_allowed" });
    if (!hostCustody) {
      return sendJson(res, 403, {
        error: "host_custody_required",
        message: "removing a person is a host-custody act on this machine",
      });
    }
    let removed: DeviceEnrollment[];
    try {
      removed = deps.enrollments.removeOwner(owner.ownerId);
    } catch (error) {
      if (error instanceof OwnerRemovalError) {
        return sendJson(res, 409, {
          error: "owner_owns_vaults",
          message: error.message,
          vaultIds: error.ownedVaultIds,
        });
      }
      throw error;
    }
    await deps.onRevoked?.(removed);
    const deadEndpoints = new Set(removed.map((row) => row.endpointId));
    await Promise.all(
      [...deadEndpoints].map(async (endpointId) => {
        await deps.onEndpointRevoked?.(endpointId);
      })
    );
    return sendJson(res, 200, {
      removed: true,
      ownerId: owner.ownerId,
      devices: deadEndpoints.size,
    });
  };
}
