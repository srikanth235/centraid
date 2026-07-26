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
 * The proof matters because the HTTP listener also accepts the ephemeral
 * per-boot loopback secret directly (issue #505 phase 7): without it, a
 * holder could stamp an arbitrary device key and dodge the per-vault ACL.
 * The sole non-iroh identity lane is an explicitly injected desktop
 * EndpointId, accepted only from a kernel-observed loopback peer; it still
 * resolves through persisted per-vault enrollment rows.
 */

import crypto from 'node:crypto';
import os from 'node:os';
import {
  loadEndpointSecret,
  startGatewayEndpoint,
  type GatewayEndpointHandle,
  type GatewayPairRequest,
  type GatewayPairResponse,
} from '@centraid/tunnel';
import type { IncomingMessage } from 'node:http';
import type { DeviceAccess } from '../serve/vault-context.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import type { RuntimeLogger } from '@centraid/app-engine';
import { EnrollmentStore } from '../serve/enrollment-store.js';
import { PairingTicketStore } from '../serve/pairing-store.js';
import {
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_SCHEMA_EPOCH,
  GATEWAY_VERSION,
} from '../version.js';
import type { DataPlaneControlOptions } from '../routes/data-plane-control.js';
import { isLoopbackRequest } from '../routes/route-helpers.js';
import type { DaemonLayout } from './paths.js';
import type { GatewayDatabase } from '../serve/gateway-db.js';
import { KeyStore } from '@centraid/vault';

export const DEVICE_HEADER = 'x-centraid-device';
export const DEVICE_PROOF_HEADER = 'x-centraid-device-proof';
const COMPANION_MODULES = new Set(['locker', 'tasks', 'notes', 'docs', 'agenda', 'people']);

function companionGrantProfile(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  if (!value.every((module) => typeof module === 'string' && COMPANION_MODULES.has(module))) {
    return null;
  }
  return [...new Set(value as string[])];
}

export interface DaemonDevicePlane {
  /** Wire into `serve()` so requests resolve their vault by enrollment. */
  deviceAccess: DeviceAccess;
  /** Bind the endpoint once the HTTP listener is up. */
  startEndpoint(upstream: {
    baseUrl: string;
    token: string;
  }): Promise<GatewayEndpointHandle | undefined>;
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
  relays?: 'n0' | 'disabled';
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
    input.keyStore ?? new KeyStore(layout.keysDir, { warn: (message) => logger.warn(message) });
  const enrollments = EnrollmentStore.open(input.gatewayDatabase ?? layout.devicesFile);
  const tickets = PairingTicketStore.open(input.gatewayDatabase ?? layout.pairingTicketsFile);
  const knownEndpointIds = new Set(enrollments.listFresh().map((row) => row.endpointId));
  // Per-boot proof shared only between the endpoint's forwarder and the
  // HTTP layer's device resolution — never persisted, never on the wire
  // outside this process.
  const deviceProof = crypto.randomBytes(32).toString('hex');
  const controlSecret = input.controlSecret ?? crypto.randomBytes(32).toString('hex');
  let liveEndpointId: string | undefined;
  const authorizeEndpoint = (endpointId: string): boolean =>
    enrollments.isEnrolled(endpointId) ||
    (input.vaults()?.isFresh() === true && tickets.hasActiveFounding());

  const deviceAccess: DeviceAccess = {
    deviceKeyFor: (req: IncomingMessage): string | undefined => {
      const device = req.headers[DEVICE_HEADER];
      const proof = req.headers[DEVICE_PROOF_HEADER];
      if (
        (typeof device !== 'string' || device.length === 0) &&
        input.loopbackEndpointId &&
        isLoopbackRequest(req)
      ) {
        return input.loopbackEndpointId;
      }
      if (typeof device !== 'string' || device.length === 0) return undefined;
      if (typeof proof !== 'string' || proof.length !== deviceProof.length) return undefined;
      const a = Buffer.from(proof, 'utf8');
      const b = Buffer.from(deviceProof, 'utf8');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return undefined;
      return device;
    },
    vaultsFor: (deviceKey: string): string[] => enrollments.vaultsFor(deviceKey),
  };

  const pairDevice = (candidate: unknown, endpointId: string): GatewayPairResponse => {
    const request = candidate as Partial<GatewayPairRequest> | null;
    if (
      !request ||
      typeof request.ticketId !== 'string' ||
      typeof request.secret !== 'string' ||
      typeof request.deviceName !== 'string' ||
      typeof request.platform !== 'string'
    ) {
      return { ok: false, error: 'bad_request' };
    }
    const grantProfile = companionGrantProfile(request.grantProfile);
    if (request.platform === 'extension' && grantProfile === undefined) {
      return { ok: false, error: 'missing_grant_profile' };
    }
    if (grantProfile === null) {
      return { ok: false, error: 'bad_grant_profile' };
    }
    const registry = input.vaults();
    if (!registry) return { ok: false, error: 'gateway_not_ready' };
    const enrollment = tickets.redeemAndEnroll(request.ticketId, request.secret, enrollments, {
      endpointId,
      label: request.deviceName || `device ${endpointId.slice(0, 10)}…`,
      platform: request.platform,
      ...(request.rememberDevice !== undefined ? { rememberDevice: request.rememberDevice } : {}),
      ...(grantProfile !== undefined ? { grantProfile } : {}),
    });
    if (!enrollment) return { ok: false, error: 'invalid_ticket' };
    const plane = registry.get(enrollment.vaultId);
    if (!plane) return { ok: false, error: 'vault_gone' };
    knownEndpointIds.add(endpointId);
    plane.db.blobTransfers.enrollPairedDevice({
      identity: endpointId,
      ownerPartyId: plane.boot.ownerPartyId,
      name: request.deviceName || `device ${endpointId.slice(0, 10)}…`,
      ...(request.platform ? { platform: request.platform } : {}),
      trust: enrollment.trust === 'readonly' ? 'readonly' : 'full',
    });
    logger.info(
      `device plane: enrolled ${endpointId.slice(0, 10)}… into vault ${enrollment.vaultId}`,
    );
    return {
      ok: true,
      enrollmentId: enrollment.enrollmentId,
      gatewayId: liveEndpointId,
      gatewayName: os.hostname().replace(/\.local$/, ''),
      vaultId: enrollment.vaultId,
      vaultName: plane.name,
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
        ...(allowed
          ? {
              headers: {
                [DEVICE_HEADER]: endpointId,
                [DEVICE_PROOF_HEADER]: deviceProof,
              },
            }
          : {}),
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
        secretKey: loadEndpointSecret({
          persistence: {
            load: () => keyStore.load('endpoint.key'),
            store: (secret) => keyStore.store('endpoint.key', Buffer.from(secret)),
          },
          onCorrupt: 'refuse',
          label: 'gateway endpoint key',
        }),
        upstream: () => upstream,
        authorize: authorizeEndpoint,
        pair: pairDevice,
        requestHeaders: (endpointId) => ({
          [DEVICE_HEADER]: endpointId,
          [DEVICE_PROOF_HEADER]: deviceProof,
        }),
        nativeControl: { secret: controlSecret },
        ...(input.relays ? { relays: input.relays } : {}),
      });
    } catch (err) {
      logger.warn(
        'gateway endpoint failed to start (remote iroh transport unavailable; ' +
          'HTTP keeps serving): ' +
          (err instanceof Error ? err.message : String(err)),
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
    startEndpoint,
    dataPlaneControl,
    pairing: { enrollments, tickets },
  };
}
