/*
 * The daemon's iroh endpoint host (#289). The per-boot proof header exists
 * because the HTTP listener also accepts the loopback landlord bearer (#505):
 * without it a holder could stamp any device key and dodge the per-vault ACL.
 * Loopback is not an identity either (#568 A/B).
 */

import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import os from "node:os";

import type { RuntimeLogger } from "@centraid/server/engine";
import {
  DEVICE_IDENTITY_HEADER,
  DEVICE_PROOF_HEADER as TUNNEL_DEVICE_PROOF_HEADER,
  inspectEndpointTicket,
  loadEndpointSecret,
  PEER_ENDPOINT_HEADER,
  PEER_PROOF_HEADER,
  startGatewayEndpoint,
  TUNNEL_FORWARDED_HEADER,
} from "@centraid/tunnel";
import type {
  GatewayEndpointHandle,
  GatewayPairRequest,
  GatewayPairResponse,
} from "@centraid/tunnel";
import { KeyStore } from "@centraid/vault";

import type { DataPlaneControlOptions } from "../routes/data-plane-control.js";
import {
  isDirectHostRequest,
  isLoopbackRequest,
} from "../routes/route-helpers.js";
import { recordCompanionAttenuation } from "../serve/companion-access.js";
import { EnrollmentStore } from "../serve/enrollment-store.js";
import type { GatewayDatabase } from "../serve/gateway-db.js";
import { PairingTicketStore } from "../serve/pairing-store.js";
import { startPeerDial } from "../serve/peer-dial.js";
import type { PeerDial } from "../serve/peer-link-client.js";
import { announceLocalRoutes } from "../serve/peer-route-announce.js";
import type { DeviceAccess } from "../serve/vault-context.js";
import { VaultLinksStore } from "../serve/vault-links-store.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import {
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_VERSION,
} from "../version.js";
import type { DaemonLayout } from "./paths.js";

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

/** A read failure is an empty list: no relay hint ⇒ reachable directly. */
function relayHintsOf(ticket: string): string[] {
  try {
    const hint = inspectEndpointTicket(ticket).relayHint;
    return hint ? [hint] : [];
  } catch {
    return [];
  }
}

/** The surface set a Companion pairing request declares, validated. */
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
  deviceAccess: DeviceAccess;
  isHostCustody: (req: IncomingMessage) => boolean;
  startEndpoint: (upstream: {
    baseUrl: string;
    token: string;
  }) => Promise<GatewayEndpointHandle | undefined>;
  dataPlaneControl: DataPlaneControlOptions;
  pairing: {
    enrollments: EnrollmentStore;
    tickets: PairingTicketStore;
  };
  /** NOT auto-registered: the handler needs this process's peer proof (#726). */
  peerPlane: {
    links: VaultLinksStore;
    /** Per-boot; the route layer verifies it. */
    proof: string;
    localRoute: () => { endpointId?: string; relayHints: string[] };
    dial: PeerDial;
  };
  closePeerDial: () => Promise<void>;
}

export function makeDaemonDevicePlane(input: {
  layout: DaemonLayout;
  gatewayDatabase?: GatewayDatabase;
  vaults: () => VaultRegistry | undefined;
  logger: RuntimeLogger;
  controlSecret?: string;
  relays?: "n0" | "disabled";
  /** Authorized through the same per-vault enrollment rows as iroh. */
  loopbackEndpointId?: string;
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
  // Synchronous, NOT inside `startEndpoint`: `buildGateway()` reads
  // `peerPlane.dial` — built from this key — before `startEndpoint()` can run.
  const endpointSecretKey = loadEndpointSecret({
    persistence: {
      load: () => keyStore.load("endpoint-key.bin"),
      store: (secret) =>
        keyStore.store("endpoint-key.bin", Buffer.from(secret)),
    },
    onCorrupt: "refuse",
    label: "gateway endpoint key",
  });
  const knownEndpointIds = new Set(
    enrollments.listFresh().map((row) => row.endpointId)
  );
  const deviceProof = crypto.randomBytes(32).toString("hex");
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
  let liveRelayHints: string[] = [];
  // An enrollment is the ONLY admission (#603): a gateway founds itself
  // locally, so no unknown EndpointId needs to reach it first.
  const authorizeEndpoint = (endpointId: string): boolean =>
    enrollments.isEnrolled(endpointId);

  /*
   * The PEER lane (#726 P3, trap 2): its own proof and headers, pointedly NOT
   * `enrollments.isEnrolled` — a linked gateway must never make "is this one of
   * my owner's devices" answer yes. Coarse admission stays narrow: an
   * unrecognised caller reaches only routes demanding their own secret.
   */
  const links = VaultLinksStore.open(
    input.gatewayDatabase ?? layout.gatewayDbFile
  );
  const peerProof = crypto.randomBytes(32).toString("hex");
  // The SAME identity that ACCEPTS peer connections also dials out (#726 P3);
  // `startPeerDial` explains why that match is load bearing.
  const peerDial = startPeerDial({
    secretKey: endpointSecretKey,
    ...(input.relays ? { relays: input.relays } : {}),
  });
  const authorizePeerEndpoint = (endpointId: string): boolean =>
    links.isLinked(endpointId) ||
    links.hasAnyLink() ||
    links.tickets.hasPending();
  /** Does NOT name a vault: an endpoint identifies a machine (#726 P3). */
  const peerForwardedHeaders = (
    endpointId: string
  ): Record<string, string> => ({
    [PEER_ENDPOINT_HEADER]: endpointId,
    [PEER_PROOF_HEADER]: peerProof,
    [TUNNEL_FORWARDED_HEADER]: "1",
  });

  const deviceAccess: DeviceAccess = {
    deviceKeyFor: (req: IncomingMessage): string | undefined => {
      // Trap 2, last line (#726): a link's reach is the peer plane or nothing.
      if (req.headers[PEER_ENDPOINT_HEADER] !== undefined) return undefined;
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
    const surfaces = companionGrantProfile(request.grantProfile);
    if (request.platform === "extension" && surfaces === undefined) {
      return { ok: false, error: "missing_grant_profile" };
    }
    if (surfaces === null) {
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
        ...(surfaces === undefined ? {} : { surfaces }),
      }
    );
    const primary = enrolled?.[0];
    if (!enrolled || !primary) return { ok: false, error: "invalid_ticket" };
    const plane = registry.get(primary.vaultId);
    if (!plane) return { ok: false, error: "vault_gone" };
    knownEndpointIds.add(endpointId);
    for (const enrollment of enrolled) {
      const granted = registry.get(enrollment.vaultId);
      if (!granted) continue;
      granted.db.blobTransfers.enrollPairedDevice({
        identity: endpointId,
        ownerPartyId: granted.boot.ownerPartyId,
        name: request.deviceName || `device ${endpointId.slice(0, 10)}…`,
        ...(request.platform ? { platform: request.platform } : {}),
        // `trust` only asks "may this device act" (#726); the attenuation
        // below is orthogonal to it.
        trust: "full",
      });
      // The ticket the owner minted IS the answer, so it is written into the
      // vault as authority rows here and projected for the request path in the
      // same act (#928 A6). A Companion enrolled into a vault that is not
      // mounted gets no rows and no projection, and is refused until it is —
      // the closed direction.
      if (surfaces !== undefined) {
        recordCompanionAttenuation(enrollments, granted, {
          endpointId,
          surfaces,
          now: new Date().toISOString(),
        });
      }
    }
    logger.info(
      `device plane: enrolled ${endpointId.slice(0, 10)}… as owner ${primary.ownerLabel} into ` +
        `vault${enrolled.length === 1 ? "" : "s"} ${enrolled.map((row) => row.vaultId).join(", ")}`
    );
    return {
      ok: true,
      enrollmentId: primary.enrollmentId,
      ownerId: primary.ownerId,
      ownerLabel: primary.ownerLabel,
      gatewayId: liveEndpointId,
      gatewayName: os.hostname().replace(/\.local$/u, ""),
      vaultId: primary.vaultId,
      vaultName: plane.name,
      vaultIds: enrolled.map((row) => row.vaultId),
      vaults: enrolled.map((row) => ({
        enrollmentId: row.enrollmentId,
        vaultId: row.vaultId,
        vaultName: registry.get(row.vaultId)?.name,
      })),
      version: GATEWAY_VERSION,
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
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
    authorizePeer: (endpointId) => {
      const allowed = authorizePeerEndpoint(endpointId);
      return {
        allowed,
        ...(allowed ? { headers: peerForwardedHeaders(endpointId) } : {}),
      };
    },
    pair: pairDevice,
  };

  const startEndpoint = async (upstream: {
    baseUrl: string;
    token: string;
  }): Promise<GatewayEndpointHandle | undefined> => {
    let handle: GatewayEndpointHandle;
    try {
      handle = await startGatewayEndpoint({
        secretKey: endpointSecretKey,
        upstream: () => upstream,
        authorize: authorizeEndpoint,
        pair: pairDevice,
        requestHeaders: forwardedIdentityHeaders,
        authorizePeer: authorizePeerEndpoint,
        peerRequestHeaders: peerForwardedHeaders,
        nativeControl: { secret: controlSecret },
        ...(input.relays ? { relays: input.relays } : {}),
      });
    } catch (error) {
      logger.warn(
        "gateway endpoint failed to start (remote iroh transport unavailable; " +
          "HTTP keeps serving): " +
          (error instanceof Error ? error.message : String(error))
      );
      return undefined;
    }
    liveEndpointId = handle.endpointId;
    liveRelayHints = relayHintsOf(handle.ticket());
    // Route re-assertion, eager half (#750 invariant 3). Fire-and-forget:
    // endpoint start must not wait on peers.
    const registry = input.vaults();
    if (registry) {
      void announceLocalRoutes({
        links,
        dial: peerDial,
        signAsVault: (vaultId, bytes) => registry.signAsVault(vaultId, bytes),
        localVaultIds: () =>
          registry.planesList().map((plane) => plane.boot.vaultId),
        route: () => ({
          endpointId: handle.endpointId,
          relayHints: liveRelayHints,
        }),
        log: {
          info: (message) => logger.info(message),
          warn: (message) => logger.warn(message),
        },
      }).catch((error) => {
        logger.warn(
          "route re-assertion failed (will retry on next start/tick): " +
            (error instanceof Error ? error.message : String(error))
        );
      });
    }
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
    peerPlane: {
      links,
      proof: peerProof,
      localRoute: () => ({
        ...(liveEndpointId === undefined ? {} : { endpointId: liveEndpointId }),
        relayHints: liveRelayHints,
      }),
      dial: peerDial,
    },
    closePeerDial: () => peerDial.close(),
  };
}
