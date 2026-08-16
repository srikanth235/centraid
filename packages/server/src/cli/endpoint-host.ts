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
 *     `centraid-gateway pair` through the live loopback daemon and enrolls
 *     the caller.
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
import { EnrollmentStore } from "../serve/enrollment-store.js";
import type { GatewayDatabase } from "../serve/gateway-db.js";
import { PairingTicketStore } from "../serve/pairing-store.js";
import { startPeerDial } from "../serve/peer-dial.js";
import type { PeerDial } from "../serve/peer-edge-give-client.js";
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

/**
 * Relay hints from a dial ticket. Hints are ADDRESS data that travels with a
 * route assertion; a failure to read them is an empty list, never a throw —
 * a gateway with no relay hint is reachable directly.
 */
function relayHintsOf(ticket: string): string[] {
  try {
    const hint = inspectEndpointTicket(ticket).relayHint;
    return hint ? [hint] : [];
  } catch {
    return [];
  }
}

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
  /**
   * Everything the `/centraid/_peer/*` route layer needs (issue #726 P3).
   * Deliberately NOT auto-registered: the plane's handler must be mounted
   * with the peer proof this process minted, and nothing else may read it.
   */
  peerPlane: {
    links: VaultLinksStore;
    /** Per-boot proof the peer forwarder stamps; the route layer verifies it. */
    proof: string;
    /** This gateway's current dial route, for the ceremony's mutual half. */
    localRoute: () => { endpointId?: string; relayHints: string[] };
    /** Outbound peer-plane dialing (#726 P3), the real iroh transport. */
    dial: PeerDial;
  };
  /** Release the peer dial's iroh endpoint on shutdown. */
  closePeerDial: () => Promise<void>;
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
  /*
   * Persistent iroh identity (issue #289 phase 3). Loaded here, synchronously
   * — NOT inside `startEndpoint` where it used to live — because the peer
   * DIAL capability built from it (below) must exist as soon as this
   * function returns: `serve()`/`buildGateway()` read `peerPlane.dial`
   * before `startEndpoint()` ever runs (it needs the HTTP server's own URL,
   * so it necessarily starts after `serve()`). A corrupt key still aborts
   * boot exactly as before, just before the HTTP listener starts instead of
   * after.
   */
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
  let liveRelayHints: string[] = [];
  // An enrollment is the ONLY admission (issue #603 retired the admit-anyone
  // founding window): a gateway founds itself locally, so no unknown
  // EndpointId ever needs to reach it before it holds a ticket-issued row.
  const authorizeEndpoint = (endpointId: string): boolean =>
    enrollments.isEnrolled(endpointId);

  /*
   * The PEER lane (issue #726 P3, trap 2). Its own proof and its own headers,
   * and pointedly NOT `enrollments.isEnrolled`, which answers "is this one of
   * my owner's devices". A linked gateway must never be able to make that
   * question answer yes. The LINK table is deliberately the shared one (D3:
   * locality is routing, not semantics) — this lane reads only the rows that
   * carry a route, which is precisely the rows that describe a vault
   * elsewhere.
   *
   * Admission is coarse by necessity and narrow by consequence: a peer whose
   * endpoint keypair rotated arrives unrecognised, so the gate is "does this
   * gateway have anyone to hear from at all" — a live link or a live ceremony.
   * With neither, the plane accepts nothing. With either, the only routes an
   * unrecognised caller can reach are the ticket redemption (needs the
   * one-time secret) and the route assertion (needs the peer vault's private
   * key); everything else is `not_found` in the route layer.
   */
  const links = VaultLinksStore.open(
    input.gatewayDatabase ?? layout.gatewayDbFile
  );
  const peerProof = crypto.randomBytes(32).toString("hex");
  /*
   * Outbound peer-plane dialing (#726 P3 — "no production peer dial"). The
   * SAME persistent identity that accepts peer connections (via the native
   * relay, or `startGatewayEndpoint` below when it is unavailable) dials
   * out under here — see `peer-dial.ts` for why that identity match is load
   * bearing, not incidental. Built eagerly (binding itself is lazy) so it is
   * available to `redeemLinkTicket`/`pushRouteAssertion` callers and to
   * `buildGateway`'s `peerPlane.dial` from the moment this function returns.
   */
  const peerDial = startPeerDial({
    secretKey: endpointSecretKey,
    ...(input.relays ? { relays: input.relays } : {}),
  });
  const authorizePeerEndpoint = (endpointId: string): boolean =>
    links.isLinked(endpointId) ||
    links.hasAnyLink() ||
    links.tickets.hasPending();
  /**
   * What the peer forwarder stamps. Disjoint from the device names above.
   * Deliberately does NOT name a vault: `peerForEndpoint` is an endpoint-only,
   * LIMIT-1 lookup, and an endpoint identifies a machine, not a vault (#726
   * P3) — a peer can hold links to several of the owner's vaults, so picking
   * one here would be exactly the ambiguity that lookup was built to avoid.
   * The route layer resolves the actual (endpoint, vault) pair itself, per
   * request, from `endpointId` — see `identify()` in `routes/peer-plane.ts`.
   */
  const peerForwardedHeaders = (
    endpointId: string
  ): Record<string, string> => ({
    [PEER_ENDPOINT_HEADER]: endpointId,
    [PEER_PROOF_HEADER]: peerProof,
    // A peer is a forwarded caller like any other: never host custody.
    [TUNNEL_FORWARDED_HEADER]: "1",
  });

  const deviceAccess: DeviceAccess = {
    deviceKeyFor: (req: IncomingMessage): string | undefined => {
      // Trap 2, last line (issue #726 P3). A request that arrived on the peer
      // lane can never resolve a DEVICE key — not through a forged header, not
      // through the loopback fallback below, not through a future forwarder
      // that stamps both. A link's reach is the peer plane or nothing.
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
        // Vocabulary boundary: gateway-plane authority is ownership (#726),
        // and the vault's capability mirror (`consent_device.trust`) only
        // asks "may this device act". An enrolled device acts for the vault's
        // owner, so it lands on `full`; device attenuation is grant_profile,
        // orthogonal to trust.
        trust: "full",
      });
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
    // Custody corruption is not a transport outage; `endpointSecretKey`
    // above already resolved (or refused) it before this point.
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
    /*
     * Route re-assertion, eager half (issue #750 invariant 3). The moment
     * this gateway's EndpointId is (re)known — first start, key rotation, or
     * recovery onto a new box — every LOCAL vault signs a route claim with
     * its own identity seed and pushes it to every linked peer, so the peers
     * re-discover this gateway without re-running a ceremony.
     * `announceLocalRoutes` no-ops when the endpoint has not changed since
     * the last fully delivered announcement (`gateway_meta` pin), and
     * best-effort failures are logged and retried by the peer-plane sweep
     * tick. Fire-and-forget: endpoint start must not wait on peers.
     */
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
