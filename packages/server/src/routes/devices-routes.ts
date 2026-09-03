/*
 * Paired-device roster, revoke, and pairing-ticket mint over HTTP (#376).
 * governance: allow-repo-hygiene file-size-limit (#608) cohesive device route owns listing, pairing, rename, compute, and revocation authorization
 *
 * Scope is enrollment-only: the iroh forwarder stamps the caller identity onto
 * `AUTHED_DEVICE_HEADER`, and a request without one has no authority. A vault
 * has exactly one owner (#726), so visibility IS authorization.
 *
 * The revoke cascade must mirror device-admin.ts: revoke the rows, then close
 * the iroh transport once an EndpointId holds no enrollment.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";

import { unrefTimer } from "../lib/unref-timer.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import type {
  DeviceComputeCapabilities,
  DeviceComputeProfile,
  EnrollmentStore,
  DeviceEnrollment,
} from "../serve/enrollment-store.js";
import type { PairingTicketStore } from "../serve/pairing-store.js";
import { handleTicketMint } from "./device-ticket-mint.js";
import { readJson, sendJson } from "./route-helpers.js";

const DEVICES_PATH = "/centraid/_gateway/devices";
const DEVICES_TICKET_PATH = `${DEVICES_PATH}/ticket`;

interface DeviceDTO {
  deviceId: string;
  endpointId: string;
  ownerId: string;
  ownerLabel: string;
  label: string;
  platform?: string;
  transport: "iroh";
  vaultId: string;
  vaultName?: string;
  addedAt?: string;
  lastUsedAt?: string;
  current?: boolean;
  revoked: boolean;
  rememberDevice: boolean;
  grantProfile?: string[];
  compute?: DeviceComputeProfile;
  checkpoint?: {
    epoch: string;
    seq: number;
    schemaEpoch: number;
    updatedAt: string;
  };
}

export interface DevicesRouteDeps {
  enrollments: EnrollmentStore;
  tickets: PairingTicketStore;
  vaultName: (vaultId: string) => string | undefined;
  mintVaultForPerson?: (name: string) => { vaultId: string };
  unmintVaultForPerson?: (vaultId: string) => void;
  endpointTicket?: () => string | undefined;
  defaultVaultId?: () => string | undefined;
  canMintPairingTicket?: (req: IncomingMessage) => boolean;
  vaultIds?: () => string[];
  onRevoked?: (rows: DeviceEnrollment[]) => void | Promise<void>;
  onEndpointRevoked?: (endpointId: string) => void | Promise<void>;
}

function callerDeviceKey(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function makeDevicesRouteHandler(deps: DevicesRouteDeps): RouteHandler {
  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (
      url.pathname !== DEVICES_PATH &&
      !url.pathname.startsWith(`${DEVICES_PATH}/`)
    ) {
      return false;
    }

    const callerKey = callerDeviceKey(req);
    const allowedVaults = new Set(
      callerKey ? deps.enrollments.vaultsFor(callerKey) : []
    );
    const isAllowed = (vaultId: string): boolean => allowedVaults.has(vaultId);

    const method = req.method ?? "GET";

    if (url.pathname === DEVICES_PATH) {
      if (callerKey === undefined) {
        return sendJson(res, 403, {
          error: "device_identity_required",
          message: "this route requires a proved iroh device identity",
        });
      }
      if (method !== "GET") {
        return sendJson(res, 405, { error: "method_not_allowed" });
      }
      const devices = deps.enrollments
        .list()
        .filter((row) => isAllowed(row.vaultId))
        .map((row) => toDto(row, deps, callerKey))
        .sort(compareDevices);
      return sendJson(res, 200, { devices });
    }

    if (url.pathname === DEVICES_TICKET_PATH) {
      return handleTicketMint(
        req,
        res,
        deps,
        callerKey,
        allowedVaults,
        isAllowed
      );
    }

    if (callerKey === undefined) {
      return sendJson(res, 403, {
        error: "device_identity_required",
        message: "this route requires a proved iroh device identity",
      });
    }

    if (url.pathname.endsWith("/compute")) {
      if (method !== "PUT")
        return sendJson(res, 405, { error: "method_not_allowed" });
      const enrollmentId = decodeURIComponent(
        url.pathname.slice(`${DEVICES_PATH}/`.length, -"/compute".length)
      );
      const target = deps.enrollments
        .list()
        .find((row) => row.enrollmentId === enrollmentId);
      if (!target || !isAllowed(target.vaultId)) {
        return sendJson(res, 404, { error: "not_found" });
      }
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: "invalid_body" });
      }
      const compute = parseComputeProfile(body);
      if (!compute) {
        return sendJson(res, 400, {
          error: "invalid_compute_profile",
          message:
            "contribution preference and every capability must be boolean",
        });
      }
      const updated = deps.enrollments.setCompute(enrollmentId, compute);
      return sendJson(res, 200, { device: toDto(updated, deps, callerKey) });
    }

    const enrollmentId = decodeURIComponent(
      url.pathname.slice(`${DEVICES_PATH}/`.length)
    );
    if (method === "PATCH") {
      const target = deps.enrollments
        .list()
        .find((row) => row.enrollmentId === enrollmentId);
      if (!target || !isAllowed(target.vaultId)) {
        return sendJson(res, 404, { error: "not_found" });
      }
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: "invalid_body" });
      }
      if (typeof body.label !== "string" || body.label.trim().length === 0) {
        return sendJson(res, 400, { error: "invalid_label" });
      }
      const renamed = deps.enrollments.rename(enrollmentId, body.label);
      return sendJson(res, 200, {
        device: toDto(renamed, deps, callerKey),
      });
    }
    if (method !== "DELETE") {
      return sendJson(res, 405, { error: "method_not_allowed" });
    }
    if (!enrollmentId) return false;

    const target = deps.enrollments
      .list()
      .find((row) => row.enrollmentId === enrollmentId);
    if (target && !isAllowed(target.vaultId)) {
      return sendJson(res, 404, { error: "not_found" });
    }

    if (target && lastDeviceOfOwner(deps, target)) {
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        body = {};
      }
      const vaultName = deps.vaultName(target.vaultId) ?? target.vaultId;
      if (body.confirmLastDevice !== vaultName) {
        return sendJson(res, 409, {
          error: "last_device_confirmation_required",
          message:
            `this is the owner's last device for ${JSON.stringify(vaultName)}; type that name in ` +
            "confirmLastDevice. Losing it requires filesystem access and the gateway CLI to recover.",
        });
      }
    }

    const removed = deps.enrollments.revoke(enrollmentId);
    if (removed.length === 0) {
      return sendJson(res, 200, { removed: false });
    }
    await deps.onRevoked?.(removed);
    const deadKeys = new Set(
      removed
        .map((r) => r.endpointId)
        .filter((key) => !deps.enrollments.isEnrolled(key))
    );
    const selfKey =
      callerKey && deadKeys.has(callerKey) ? callerKey : undefined;
    await Promise.all(
      [...deadKeys]
        .filter((key) => key !== selfKey)
        .map(async (key) => {
          await deps.onEndpointRevoked?.(key);
        })
    );
    const sent = sendJson(res, 200, { removed: true });
    if (selfKey && deps.onEndpointRevoked) {
      const timer = setTimeout(
        () => void deps.onEndpointRevoked?.(selfKey),
        1_000
      );
      unrefTimer(timer);
    }
    return sent;
  };
}

function lastDeviceOfOwner(
  deps: DevicesRouteDeps,
  row: DeviceEnrollment
): boolean {
  if (deps.enrollments.owners.ownerOf(row.vaultId) !== row.ownerId)
    return false;
  const live = new Set(
    deps.enrollments
      .list()
      .filter(
        (candidate) => candidate.ownerId === row.ownerId && !candidate.revoked
      )
      .map((candidate) => candidate.endpointId)
  );
  return live.size === 1 && live.has(row.endpointId);
}

function toDto(
  row: DeviceEnrollment,
  deps: DevicesRouteDeps,
  callerKey: string
): DeviceDTO {
  const vaultName = deps.vaultName(row.vaultId);
  return {
    deviceId: row.enrollmentId,
    endpointId: row.endpointId,
    ownerId: row.ownerId,
    ownerLabel: row.ownerLabel,
    label: row.label,
    ...(row.platform === undefined ? {} : { platform: row.platform }),
    transport: "iroh",
    vaultId: row.vaultId,
    ...(vaultName === undefined ? {} : { vaultName }),
    addedAt: row.addedAt,
    current: row.endpointId === callerKey,
    revoked: row.revoked,
    rememberDevice: row.rememberDevice,
    ...(row.grantProfile === undefined
      ? {}
      : { grantProfile: [...row.grantProfile] }),
    ...(row.compute ? { compute: row.compute } : {}),
    ...(row.checkpoint ? { checkpoint: row.checkpoint } : {}),
  };
}

const COMPUTE_KEYS: readonly (keyof DeviceComputeCapabilities)[] = [
  "previews",
  "poster",
  "pdfText",
  "ocr",
  "embedding",
  "transcript",
  "edgeSeal",
  "backgroundTransfer",
];

function parseComputeProfile(
  body: Record<string, unknown>
): Omit<DeviceComputeProfile, "updatedAt"> | undefined {
  if (
    typeof body.contributeWhileCharging !== "boolean" ||
    typeof body.capabilities !== "object" ||
    body.capabilities === null
  ) {
    return undefined;
  }
  const raw = body.capabilities as Record<string, unknown>;
  if (!COMPUTE_KEYS.every((key) => typeof raw[key] === "boolean"))
    return undefined;
  return {
    contributeWhileCharging: body.contributeWhileCharging,
    capabilities: Object.fromEntries(
      COMPUTE_KEYS.map((key) => [key, raw[key]])
    ) as unknown as DeviceComputeCapabilities,
  };
}

function compareDevices(a: DeviceDTO, b: DeviceDTO): number {
  if (a.current && !b.current) return -1;
  if (b.current && !a.current) return 1;
  return a.label.localeCompare(b.label);
}
