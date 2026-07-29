/*
 * `GET/DELETE /centraid/_gateway/devices` — the paired-device roster + its
 * revoke gesture over HTTP (issue #376), the wire twin of `cli/device-admin.ts`'s
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
 * A caller sees only vaults its endpoint identity is enrolled in.
 *
 * The revoke cascade mirrors device-admin.ts exactly: revoke the enrollment
 * row(s), then close the Rust-owned iroh transport once an EndpointId no
 * longer holds ANY enrollment. Live web control/app cookies die on their
 * next request via `web-app-sessions.ts`'s `isDeviceValid` re-check against
 * `enrollments.isEnrolled`, which this cascade flips.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";

import type { RouteHandler } from "../serve/build-gateway.js";
import type {
  DeviceComputeCapabilities,
  DeviceComputeProfile,
  DeviceRole,
  EnrollmentStore,
  DeviceEnrollment,
} from "../serve/enrollment-store.js";
import type { PairingTicketStore } from "../serve/pairing-store.js";
import {
  encodePairingTicket,
  DEFAULT_TICKET_TTL_MS,
} from "../serve/pairing-store.js";
import { parseGrants, resolveInvitation } from "./device-invitations.js";
import { readJson, sendJson } from "./route-helpers.js";

const DEVICES_PATH = "/centraid/_gateway/devices";
const DEVICES_TICKET_PATH = `${DEVICES_PATH}/ticket`;
/** The canonical vault-addressing header (mirrors the client's `VAULT_HEADER`). */
const VAULT_HEADER = "x-centraid-vault";

/**
 * One paired device on the wire (mirrors the client's `CentraidGatewayDevice`
 * in `@centraid/client`'s `gateway-client-devices.ts` — kept in step by hand,
 * the gateway does not depend on the client package).
 */
interface DeviceDTO {
  deviceId: string;
  endpointId: string;
  /** The person this device acts as (#599 L2) — roster grouping keys on it. */
  memberId: string;
  memberLabel: string;
  label: string;
  platform?: string;
  transport: "iroh";
  vaultId: string;
  vaultName?: string;
  addedAt?: string;
  lastUsedAt?: string;
  current?: boolean;
  role: DeviceRole;
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

    // POST /centraid/_gateway/devices/ticket — mint a one-time pairing ticket
    // (the inverse of revoke; the wire twin of `cli/device-admin.ts`'s `pair`).
    // Matched BEFORE the DELETE `/:id` branch so `ticket` isn't read as an id.
    if (url.pathname === DEVICES_TICKET_PATH) {
      if (method !== "POST") {
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
            "pairing tickets require an enrolled admin device or direct host custody",
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
      // `admin` is grantable here, not just `write`/`read`: granting admin is
      // the only way a vault gets a second owner (or replaces a lost one).
      //
      // The default stays `write`: a ticket LEAVES this machine, and whatever
      // redeems it lands at the roles baked into it. Defaulting to admin would
      // let a casually paired phone mint further tickets and revoke this device.
      const role = body.role ?? "write";
      if (role !== "admin" && role !== "write" && role !== "read") {
        return sendJson(res, 400, { error: "invalid_role" });
      }
      const requestedGrants = parseGrants(body.grants);
      if (requestedGrants === null) {
        return sendJson(res, 400, {
          error: "invalid_grants",
          message: "grants must be a list of {vaultId, role}",
        });
      }
      const invitation = resolveInvitation({
        enrollments: deps.enrollments,
        vaultName: deps.vaultName,
        callerKey,
        hostCustody,
        hostVaults,
        target,
        role,
        body,
        grants: requestedGrants,
      });
      if ("error" in invitation) {
        return sendJson(res, invitation.status, {
          error: invitation.error,
          message: invitation.message,
        });
      }
      const ttlMs =
        typeof body.ttlMinutes === "number" && body.ttlMinutes > 0
          ? body.ttlMinutes * 60_000
          : DEFAULT_TICKET_TTL_MS;
      // `gw` is required in `PairingTicketPayload`; a ticket without the iroh
      // endpoint pin can't be redeemed, so refuse rather than mint a dud.
      const gw = deps.endpointTicket?.();
      if (gw === undefined) {
        return sendJson(res, 409, {
          error: "no_iroh_endpoint",
          message:
            "gateway has no iroh endpoint identity yet — start the daemon so it mints its endpoint",
        });
      }
      const minted = deps.tickets.mint(
        { memberId: invitation.memberId, grants: invitation.grants },
        ttlMs
      );
      const primary = invitation.grants[0] ?? { vaultId: target, role };
      const token = encodePairingTicket({
        v: 1,
        kind: "centraid-gw-pair",
        gw,
        t: minted.ticketId,
        s: minted.secret,
        vaultName: deps.vaultName(primary.vaultId) ?? primary.vaultId,
        exp: minted.expiresAt,
      });
      return sendJson(res, 200, {
        ok: true,
        ticket: token,
        memberId: invitation.memberId,
        memberLabel: invitation.memberLabel,
        grants: invitation.grants.map((grant) => ({
          vaultId: grant.vaultId,
          vaultName: deps.vaultName(grant.vaultId),
          role: grant.role,
        })),
        // The first grant is also reported flat so single-vault callers (the
        // `pair` CLI, the desktop panel) need no shape change to keep working.
        vaultId: primary.vaultId,
        vaultName: deps.vaultName(primary.vaultId),
        expiresAt: new Date(minted.expiresAt).toISOString(),
        role: primary.role,
      });
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
      if (
        callerKey !== target.endpointId &&
        deps.enrollments.get(callerKey, target.vaultId)?.role !== "admin"
      ) {
        return sendJson(res, 403, { error: "not_admin" });
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
    // caller's allowed vaults (don't leak another vault's device existence).
    const target = deps.enrollments
      .list()
      .find((row) => row.enrollmentId === enrollmentId);
    if (target && !isAllowed(target.vaultId)) {
      return sendJson(res, 404, { error: "not_found" });
    }

    // A device may unpair itself; revoking a peer requires admin role in this
    // exact vault. This stops a compromised `write` device revoking an admin.
    if (
      target &&
      callerKey !== target.endpointId &&
      deps.enrollments.get(callerKey, target.vaultId)?.role !== "admin"
    ) {
      return sendJson(res, 403, {
        error: "not_admin",
        message: "only an admin device can revoke another device",
      });
    }

    // The ≥1-admin invariant is authored on MEMBERS now, so revoking a device
    // only endangers it when this is the last live device of the vault's last
    // admin member — the case where recovery needs filesystem access.
    if (target && lastAdminDeviceFor(deps, target)) {
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        body = {};
      }
      const vaultName = deps.vaultName(target.vaultId) ?? target.vaultId;
      if (body.confirmLastAdmin !== vaultName) {
        return sendJson(res, 409, {
          error: "last_admin_confirmation_required",
          message:
            `this is the last admin enrollment; type ${JSON.stringify(vaultName)} in ` +
            "confirmLastAdmin. Losing it requires filesystem access and the gateway CLI to recover.",
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

/** Is this the last live device of the last admin MEMBER of its vault? */
function lastAdminDeviceFor(
  deps: DevicesRouteDeps,
  row: DeviceEnrollment
): boolean {
  const admins = deps.enrollments.members.adminsOf(row.vaultId);
  if (admins.length !== 1 || admins[0] !== row.memberId) return false;
  const live = new Set(
    deps.enrollments
      .list()
      .filter(
        (candidate) =>
          candidate.memberId === row.memberId && candidate.role !== "revoked"
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
    memberId: row.memberId,
    memberLabel: row.memberLabel,
    label: row.label,
    ...(row.platform === undefined ? {} : { platform: row.platform }),
    transport: "iroh",
    vaultId: row.vaultId,
    ...(vaultName === undefined ? {} : { vaultName }),
    addedAt: row.addedAt,
    current: row.endpointId === callerKey,
    role: row.role,
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
