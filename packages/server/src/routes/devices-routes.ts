/*
 * `GET/DELETE /centraid/_gateway/devices` — the paired-device roster + its
 * revoke gesture over HTTP (#376), the wire twin of `cli/device-admin.ts`'s
 * `devices list` / `devices revoke`. Backs the desktop's Gateway → Devices card.
 *
 * `POST /centraid/_gateway/devices/ticket` — the inverse of revoke: MINT a
 * one-time pairing ticket from the app, the HTTP twin of `centraid-gateway
 * governance: allow-repo-hygiene file-size-limit (#608) cohesive device route owns listing, pairing, rename, compute, and revocation authorization
 * pair`. Same caller-plane scope; the target vault is `body.vaultId` or the
 * addressed `x-centraid-vault`. Requires the daemon's iroh endpoint (the
 * ticket's `gw` pin) — 409 `no_iroh_endpoint` when absent.
 *
 * Scope is enrollment-only. The iroh forwarder stamps the cryptographic
 * caller identity onto `AUTHED_DEVICE_HEADER`; a request without one has no
 * roster authority.
 *
 * A caller sees only vaults its owner owns — and since a vault has exactly
 * one owner (#726), every device it can see is its own owner's.
 *
 * The revoke cascade mirrors device-admin.ts exactly: revoke the enrollment
 * row(s), then close the Rust-owned iroh transport once an EndpointId no
 * longer holds ANY enrollment. Live web control/app cookies die on their
 * next request via `web-control-sessions.ts`'s `isDeviceValid` re-check against
 * `enrollments.isEnrolled`, which this cascade flips.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";

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

/**
 * One paired device on the wire (mirrors the client's `CentraidGatewayDevice`
 * in `@centraid/client`'s `gateway-client-devices.ts` — kept in step by hand,
 * the gateway does not depend on the client package).
 */
interface DeviceDTO {
  deviceId: string;
  endpointId: string;
  /** The person this device acts as — roster grouping keys on it. */
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
  /** Device tombstone — never a role (#726). */
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
  /** One-time pairing-ticket mint store — the `POST /devices/ticket` twin of `pair`. */
  tickets: PairingTicketStore;
  /** Resolves a vault id to its owner-facing name; undefined when unknown. */
  vaultName: (vaultId: string) => string | undefined;
  /**
   * *Add someone* (#726): create + mount a fresh vault for a newly minted
   * person (the registry mints its identity keypair at creation). Wired to
   * `VaultRegistry.create`. Undefined ⇒ `forPerson` requests are refused
   * (never silently downgraded to a self-pair).
   */
  mintVaultForPerson?: (name: string) => { vaultId: string };
  /**
   * Cleanup twin of `mintVaultForPerson` (#750): remove a vault the
   * *Add someone* workflow minted before its gateway.db transaction failed —
   * the dir, the keys inside it, and the registry mount. Wired to
   * `VaultRegistry.delete`. Undefined ⇒ a failed mint leaves an orphan dir
   * (inert debris — no committed row names it), never partial rows.
   */
  unmintVaultForPerson?: (vaultId: string) => void;
  /**
   * The gateway's iroh EndpointTicket (identity pin + relay hint) for a minted
   * ticket's `gw` field, read lazily at mint time; undefined before the daemon
   * has an endpoint (or on the desktop embed).
   */
  endpointTicket?: () => string | undefined;
  /**
   * The registry's default vault — the owner's PERSONAL vault on an
   * auto-founded gateway (marked at founding; never "Shared"). Used when the
   * caller names no target at all, so a bare `centraid-gateway pair` invites
   * into the owner's own space rather than whichever vault happens to sort
   * first in the caller's enrollments.
   */
  defaultVaultId?: () => string | undefined;
  /** Direct host-custody request (authenticated bearer, never iroh-forwarded). */
  canMintPairingTicket?: (req: IncomingMessage) => boolean;
  /** Filesystem registry ids, used only by the direct host-custody mint lane. */
  vaultIds?: () => string[];
  /** Purge vault-local protocol state owned by removed enrollment rows. */
  onRevoked?: (rows: DeviceEnrollment[]) => void | Promise<void>;
  /** Close Rust-owned live transports once a device loses its final enrollment. */
  onEndpointRevoked?: (endpointId: string) => void | Promise<void>;
}

/** The caller's proved iroh EndpointId. */
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

    // POST /centraid/_gateway/devices/ticket — mint a one-time pairing ticket,
    // including the *Add someone* `forPerson` mint lane (#726). Matched
    // BEFORE the DELETE `/:id` branch so `ticket` isn't read as an id.
    // Handled in `device-ticket-mint.ts`.
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

    // PUT /centraid/_gateway/devices/:enrollmentId/compute — advertise what
    // this device can do and opt it into charging + unmetered work leases.
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

    // /centraid/_gateway/devices/:enrollmentId
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

    // Refuse to touch — or even acknowledge — an enrollment outside the
    // caller's allowed vaults. Ownership makes the visibility check the whole
    // authorization: every device inside an allowed vault belongs to the
    // vault's one owner, who is the caller's owner.
    const target = deps.enrollments
      .list()
      .find((row) => row.enrollmentId === enrollmentId);
    if (target && !isAllowed(target.vaultId)) {
      return sendJson(res, 404, { error: "not_found" });
    }

    // Revoking the owner's last live device strands the vault behind
    // filesystem-only recovery, so it demands a typed confirmation.
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
      // Already gone — idempotent, not an error.
      return sendJson(res, 200, { removed: false });
    }
    await deps.onRevoked?.(removed);
    // A device key with no remaining enrollment loses its live iroh transport.
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
      // Let a self-unpair response finish traversing the current QUIC stream.
      // The enrollment is already absent, so the per-stream authorize guard
      // rejects any second request during this short close grace.
      const timer = setTimeout(
        () => void deps.onEndpointRevoked?.(selfKey),
        1_000
      );
      timer.unref();
    }
    return sent;
  };
}

/** Is this the last live device of the OWNER of its vault? */
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

/** Current device first, then by label (locale compare). */
function compareDevices(a: DeviceDTO, b: DeviceDTO): number {
  if (a.current && !b.current) return -1;
  if (b.current && !a.current) return 1;
  return a.label.localeCompare(b.label);
}
