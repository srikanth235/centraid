/*
 * The daemon's iroh endpoint host (issue #289 phase 3).
 *
 * Glues `@centraid/tunnel`'s generic gateway endpoint to the daemon's
 * policy stores:
 *
 *   - identity: a persistent 32-byte secret in the gateway `KeyStore` —
 *     the derived EndpointId is the gateway's permanent identity (mirror
 *     of the desktop's `phone-link/key.bin`).
 *   - admission: the QUIC listener speaks only to EndpointIds enrolled in
 *     `gateway.db`.
 *   - pairing: `centraid/gw-pair/1` redeems one-time tickets minted by
 *     `centraid-gateway pair` (SSH bootstrap) and enrolls the caller.
 *   - identity forwarding: each tunneled request is forwarded to the
 *     loopback HTTP listener with the device's EndpointId + a per-boot
 *     proof header only this process knows, so the gateway's HTTP layer
 *     can trust `x-centraid-device` came from the QUIC handshake and not
 *     from a client header.
 *
 * The proof matters because the HTTP listener also accepts the loopback
 * landlord bearer directly (issue #505 phase 7): without it, a holder could
 * stamp an arbitrary device key and dodge the per-vault ACL. The sole
 * non-iroh identity lane is an explicitly injected desktop EndpointId,
 * accepted only from a kernel-observed loopback peer; it still resolves
 * through persisted per-vault enrollment rows.
 *
 * Loopback is not an identity (issue #568 items A/B). Every forwarder —
 * this one, the Rust byte relay, and the desktop phone tunnel — hands a
 * REMOTE peer to 127.0.0.1, so each also stamps `TUNNEL_FORWARDED_HEADER`
 * and `isHostCustody` refuses anything carrying it.
 */

import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import os from "node:os";

import type { RuntimeLogger } from "@centraid/app-engine";
import {
  DEVICE_IDENTITY_HEADER,
  DEVICE_PROOF_HEADER as TUNNEL_DEVICE_PROOF_HEADER,
  loadEndpointSecret,
  startGatewayEndpoint,
  TUNNEL_FORWARDED_HEADER,
  type GatewayEndpointHandle,
  type GatewayPairRequest,
  type GatewayPairResponse,
} from "@centraid/tunnel";
import { KeyStore } from "@centraid/vault";

import type { DataPlaneControlOptions } from "../routes/data-plane-control.js";
import {
  isDirectHostRequest,
  isLoopbackRequest,
} from "../routes/route-helpers.js";
import { EnrollmentStore } from "../serve/enrollment-store.js";
import type { GatewayDatabase } from "../serve/gateway-db.js";
import { PairingTicketStore } from "../serve/pairing-store.js";
import type { DeviceAccess } from "../serve/vault-context.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import {
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_SCHEMA_EPOCH,
  GATEWAY_VERSION,
} from "../version.js";
import type { DaemonLayout } from "./paths.js";

/**
 * The transport owns these names (`@centraid/tunnel`'s protocol module) —
 * every forwarder, JS or Rust, strips a client copy before stamping its own.
 * Re-exported here because the HTTP side is where they are consumed.
 */
export const DEVICE_HEADER = DEVICE_IDENTITY_HEADER;
export const DEVICE_PROOF_HEADER = TUNNEL_DEVICE_PROOF_HEADER;
const COMPANION_MODULES = new Set([
  "locker",
  "tasks",
  "notes",
  "docs",
  "agenda",
  "people",
]);

function companionGrantProfile(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  if (
    !value.every(
      (module) => typeof module === "string" && COMPANION_MODULES.has(module)
    )
  ) {
    return null;
  }
  return [...new Set(value as string[])];
}

export interface DaemonDevicePlane {
  /** Wire into `serve()` so requests resolve their vault by enrollment. */
  deviceAccess: DeviceAccess;
  /**
   * Direct authenticated host request: a loopback peer carrying none of the
   * markings a forwarder stamps. Every forwarder in the product — the iroh
   * endpoint, the Rust byte relay, and the desktop phone tunnel — delivers a
   * remote peer to 127.0.0.1, so loopback alone proves nothing (#568 A/B).
   */
  isHostCustody: (req: IncomingMessage) => boolean;
  /** Bind the endpoint once the HTTP listener is up. */
  startEndpoint: (upstream: {
    baseUrl: string;
    token: string;
  }) => Promise<GatewayEndpointHandle | undefined>;
  /** Metadata-only callbacks exposed to the native iroh relay over loopback. */
  dataPlaneControl: DataPlaneControlOptions;
  /** Enrollment and one-time iroh pairing capability stores. */
  pairing: {
    enrollments: EnrollmentStore;
    tickets: PairingTicketStore;
  };
}

export function makeDaemonDevicePlane(input: {
  layout: DaemonLayout;
  gatewayDatabase?: GatewayDatabase;
  /**
   * Resolved lazily: the device plane is constructed BEFORE `serve()` (its
   * `deviceAccess` is a build option) but only redeems tickets after the
   * registry exists.
   */
  vaults: () => VaultRegistry | undefined;
  logger: RuntimeLogger;
  /** Shared only with native byte-plane components on the loopback listener. */
  controlSecret?: string;
  /**
   * iroh relay mode. Defaults to the production n0 relays + discovery;
   * `disabled` keeps the endpoint offline (tests bind on loopback only).
   */
  relays?: "n0" | "disabled";
  /**
   * OS-protected identity of the desktop that spawned this daemon. Direct
   * loopback requests still resolve to a real EndpointId and are authorized
   * through the same per-vault enrollment rows as iroh requests.
   */
  loopbackEndpointId?: string;
  /** Shared gateway KeyStore so endpoint identity uses the host custody backend. */
  keyStore?: KeyStore;
}): DaemonDevicePlane {
  const { layout, logger } = input;
  const keyStore =
    input.keyStore ??
    new KeyStore(layout.keysDir, { warn: (message) => logger.warn(message) });
  const enrollments = EnrollmentStore.open(
    input.gatewayDatabase ?? layout.gatewayDbFile
  );
  const tickets = PairingTicketStore.open(
    input.gatewayDatabase ?? layout.gatewayDbFile
  );
  const knownEndpointIds = new Set(
    enrollments.listFresh().map((row) => row.endpointId)
  );
  // Per-boot proof shared only between the endpoint's forwarder and the
  // HTTP layer's device resolution — never persisted, never on the wire
  // outside this process.
  const deviceProof = crypto.randomBytes(32).toString("hex");
  /** What every forwarder stamps: the proved identity + the forwarded mark. */
  const forwardedIdentityHeaders = (
    endpointId: string
  ): Record<string, string> => ({
    [DEVICE_HEADER]: endpointId,
    [DEVICE_PROOF_HEADER]: deviceProof,
    [TUNNEL_FORWARDED_HEADER]: "1",
  });
  const controlSecret =
    input.controlSecret ?? crypto.randomBytes(32).toString("hex");
  let liveEndpointId: string | undefined;
  // An enrollment is the ONLY admission (issue #603 retired the admit-anyone
  // founding window): a gateway founds itself locally, so no unknown
  // EndpointId ever needs to reach it before it holds a ticket-issued row.
  const authorizeEndpoint = (endpointId: string): boolean =>
    enrollments.isEnrolled(endpointId);

  const deviceAccess: DeviceAccess = {
    deviceKeyFor: (req: IncomingMessage): string | undefined => {
      const device = req.headers[DEVICE_HEADER];
      const proof = req.headers[DEVICE_PROOF_HEADER];
      if (
        (typeof device !== "string" || device.length === 0) &&
        input.loopbackEndpointId &&
        isLoopbackRequest(req)
      ) {
        return input.loopbackEndpointId;
      }
      if (typeof device !== "string" || device.length === 0) return undefined;
      if (typeof proof !== "string" || proof.length !== deviceProof.length)
        return undefined;
      const a = Buffer.from(proof, "utf8");
      const b = Buffer.from(deviceProof, "utf8");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
        return undefined;
      return device;
    },
    vaultsFor: (deviceKey: string): string[] =>
      enrollments.vaultsFor(deviceKey),
  };
  const isHostCustody = isDirectHostRequest;

  const pairDevice = (
    candidate: unknown,
    endpointId: string
  ): GatewayPairResponse => {
    const request = candidate as Partial<GatewayPairRequest> | null;
    if (
      !request ||
      typeof request.ticketId !== "string" ||
      typeof request.secret !== "string" ||
      typeof request.deviceName !== "string" ||
      typeof request.platform !== "string"
    ) {
      return { ok: false, error: "bad_request" };
    }
    const grantProfile = companionGrantProfile(request.grantProfile);
    if (request.platform === "extension" && grantProfile === undefined) {
      return { ok: false, error: "missing_grant_profile" };
    }
    if (grantProfile === null) {
      return { ok: false, error: "bad_grant_profile" };
    }
    const registry = input.vaults();
    if (!registry) return { ok: false, error: "gateway_not_ready" };
    const enrolled = tickets.redeemAndEnroll(
      request.ticketId,
      request.secret,
      enrollments,
      {
        endpointId,
        label: request.deviceName || `device ${endpointId.slice(0, 10)}…`,
        platform: request.platform,
        ...(request.rememberDevice === undefined
          ? {}
          : { rememberDevice: request.rememberDevice }),
        ...(grantProfile === undefined ? {} : { grantProfile }),
      }
    );
    const primary = enrolled?.[0];
    if (!enrolled || !primary) return { ok: false, error: "invalid_ticket" };
    const plane = registry.get(primary.vaultId);
    if (!plane) return { ok: false, error: "vault_gone" };
    knownEndpointIds.add(endpointId);
    // One scan can enrol a device into several vaults, so mirror the device
    // into EVERY granted vault's capability table — not just the first.
    for (const enrollment of enrolled) {
      const granted = registry.get(enrollment.vaultId);
      if (!granted) continue;
      granted.db.blobTransfers.enrollPairedDevice({
        identity: endpointId,
        ownerPartyId: granted.boot.ownerPartyId,
        name: request.deviceName || `device ${endpointId.slice(0, 10)}…`,
        ...(request.platform ? { platform: request.platform } : {}),
        // Vocabulary boundary: the gateway's ROLE (admin/write/read) collapses
        // to the vault's capability mirror (`consent_device.trust`, full/readonly),
        // which only asks "may this device act". Admin's extra powers — minting
        // tickets, revoking peers — are gateway-plane concerns the vault has no
        // opinion about, so `admin` and `write` both land on `full`.
        trust: enrollment.role === "read" ? "readonly" : "full",
      });
    }
    logger.info(
      `device plane: enrolled ${endpointId.slice(0, 10)}… as member ${primary.memberLabel} into ` +
        `vault${enrolled.length === 1 ? "" : "s"} ${enrolled.map((row) => row.vaultId).join(", ")}`
    );
    return {
      ok: true,
      enrollmentId: primary.enrollmentId,
      memberId: primary.memberId,
      memberLabel: primary.memberLabel,
      gatewayId: liveEndpointId,
      gatewayName: os.hostname().replace(/\.local$/u, ""),
      vaultId: primary.vaultId,
      vaultName: plane.name,
      vaultIds: enrolled.map((row) => row.vaultId),
      version: GATEWAY_VERSION,
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
      schemaEpoch: GATEWAY_SCHEMA_EPOCH,
    };
  };

  const dataPlaneControl: DataPlaneControlOptions = {
    secret: controlSecret,
    authorize: (endpointId) => {
      const allowed = authorizeEndpoint(endpointId);
      if (allowed) knownEndpointIds.add(endpointId);
      return {
        allowed,
        ...(allowed ? { headers: forwardedIdentityHeaders(endpointId) } : {}),
      };
    },
    pair: pairDevice,
  };

  const startEndpoint = async (upstream: {
    baseUrl: string;
    token: string;
  }): Promise<GatewayEndpointHandle | undefined> => {
    // Custody corruption is not a transport outage. Resolve it before the
    // best-effort network start so a short/refused identity key aborts boot
    // with the loader's actionable repair message instead of silently serving
    // a gateway whose paired devices can never reach it.
    const secretKey = loadEndpointSecret({
      persistence: {
        load: () => keyStore.load("endpoint-key.bin"),
        store: (secret) =>
          keyStore.store("endpoint-key.bin", Buffer.from(secret)),
      },
      onCorrupt: "refuse",
      label: "gateway endpoint key",
    });
    let handle: GatewayEndpointHandle;
    try {
      handle = await startGatewayEndpoint({
        secretKey,
        upstream: () => upstream,
        authorize: authorizeEndpoint,
        pair: pairDevice,
        requestHeaders: forwardedIdentityHeaders,
        nativeControl: { secret: controlSecret },
        ...(input.relays ? { relays: input.relays } : {}),
      });
    } catch (err) {
      logger.warn(
        "gateway endpoint failed to start (remote iroh transport unavailable; " +
          "HTTP keeps serving): " +
          (err instanceof Error ? err.message : String(err))
      );
      return undefined;
    }
    liveEndpointId = handle.endpointId;
    return {
      endpointId: handle.endpointId,
      ticket: () => handle.ticket(),
      revokeEndpoint: (endpointId) => handle.revokeEndpoint(endpointId),
      close: async () => {
        await handle.close();
      },
    };
  };

  return {
    deviceAccess,
    isHostCustody,
    startEndpoint,
    dataPlaneControl,
    pairing: { enrollments, tickets },
  };
}
