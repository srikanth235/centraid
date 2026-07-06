/*
 * The daemon's iroh endpoint host (issue #289 phase 3).
 *
 * Glues `@centraid/tunnel`'s generic gateway endpoint to the daemon's
 * policy stores:
 *
 *   - identity: a persistent 32-byte secret key at `endpoint-key.bin` —
 *     the derived EndpointId is the gateway's permanent identity (mirror
 *     of the desktop's `phone-link/key.bin`).
 *   - admission: the QUIC listener speaks only to enrolled device keys
 *     (`devices.json` via `EnrollmentStore`).
 *   - pairing: `centraid/gw-pair/1` redeems one-time tickets minted by
 *     `centraid-gateway pair` (SSH bootstrap) and enrolls the caller.
 *   - identity forwarding: each tunneled request is forwarded to the
 *     loopback HTTP listener with the device's EndpointId + a per-boot
 *     proof header only this process knows, so the gateway's HTTP layer
 *     can trust `x-centraid-device` came from the QUIC handshake and not
 *     from a client header.
 *
 * The proof matters because the HTTP listener still accepts the shared
 * bearer directly (loopback / `direct` transports): without it, any
 * bearer-holder could stamp an arbitrary device key and dodge the
 * per-vault enrollment check.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import {
  startGatewayEndpoint,
  type GatewayEndpointHandle,
  type GatewayPairResponse,
} from '@centraid/tunnel';
import type { IncomingMessage } from 'node:http';
import type { DeviceAccess } from '../serve/vault-context.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import type { RuntimeLogger } from '@centraid/app-engine';
import { EnrollmentStore } from '../serve/enrollment-store.js';
import { PairingTicketStore } from '../serve/pairing-store.js';
import { GATEWAY_SCHEMA_EPOCH, GATEWAY_VERSION } from '../version.js';
import type { DaemonLayout } from './paths.js';

export const DEVICE_HEADER = 'x-centraid-device';
export const DEVICE_PROOF_HEADER = 'x-centraid-device-proof';

export interface DaemonDevicePlane {
  /** Wire into `serve()` so requests resolve their vault by enrollment. */
  deviceAccess: DeviceAccess;
  /** Bind the endpoint once the HTTP listener is up. */
  startEndpoint(upstream: {
    baseUrl: string;
    token: string;
  }): Promise<GatewayEndpointHandle | undefined>;
}

function readOrMintSecretKey(file: string): Uint8Array {
  try {
    const bytes = fs.readFileSync(file);
    if (bytes.length === 32) return Uint8Array.from(bytes);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key, { mode: 0o600 });
  return Uint8Array.from(key);
}

export function makeDaemonDevicePlane(input: {
  layout: DaemonLayout;
  /**
   * Resolved lazily: the device plane is constructed BEFORE `serve()` (its
   * `deviceAccess` is a build option) but only redeems tickets after the
   * registry exists.
   */
  vaults: () => VaultRegistry | undefined;
  logger: RuntimeLogger;
  /**
   * iroh relay mode. Defaults to the production n0 relays + discovery;
   * `disabled` keeps the endpoint offline (tests bind on loopback only).
   */
  relays?: 'n0' | 'disabled';
}): DaemonDevicePlane {
  const { layout, logger } = input;
  const enrollments = EnrollmentStore.open(layout.devicesFile);
  const tickets = PairingTicketStore.open(layout.pairingTicketsFile);
  // Per-boot proof shared only between the endpoint's forwarder and the
  // HTTP layer's device resolution — never persisted, never on the wire
  // outside this process.
  const deviceProof = crypto.randomBytes(32).toString('hex');

  const deviceAccess: DeviceAccess = {
    deviceKeyFor: (req: IncomingMessage): string | undefined => {
      const device = req.headers[DEVICE_HEADER];
      const proof = req.headers[DEVICE_PROOF_HEADER];
      if (typeof device !== 'string' || device.length === 0) return undefined;
      if (typeof proof !== 'string' || proof.length !== deviceProof.length) return undefined;
      const a = Buffer.from(proof, 'utf8');
      const b = Buffer.from(deviceProof, 'utf8');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return undefined;
      return device;
    },
    vaultsFor: (deviceKey: string): string[] => enrollments.vaultsFor(deviceKey),
  };

  const startEndpoint = async (upstream: {
    baseUrl: string;
    token: string;
  }): Promise<GatewayEndpointHandle | undefined> => {
    let handle: GatewayEndpointHandle;
    try {
      handle = await startGatewayEndpoint({
        secretKey: readOrMintSecretKey(layout.endpointKeyFile),
        upstream: () => upstream,
        authorize: (endpointId) => enrollments.isEnrolled(endpointId),
        pair: (request, endpointId): GatewayPairResponse => {
          const registry = input.vaults();
          if (!registry) return { ok: false, error: 'gateway_not_ready' };
          const redeemed = tickets.redeem(request.ticketId, request.secret);
          if (!redeemed) return { ok: false, error: 'invalid_ticket' };
          const plane = registry.get(redeemed.vaultId);
          if (!plane) return { ok: false, error: 'vault_gone' };
          enrollments.enroll({
            endpointId,
            vaultId: redeemed.vaultId,
            label: request.deviceName || `device ${endpointId.slice(0, 10)}…`,
            platform: request.platform,
          });
          logger.info(
            `device plane: enrolled ${endpointId.slice(0, 10)}… into vault ${redeemed.vaultId}`,
          );
          return {
            ok: true,
            gatewayName: os.hostname().replace(/\.local$/, ''),
            vaultId: redeemed.vaultId,
            vaultName: plane.name,
            version: GATEWAY_VERSION,
            schemaEpoch: GATEWAY_SCHEMA_EPOCH,
          };
        },
        requestHeaders: (endpointId) => ({
          [DEVICE_HEADER]: endpointId,
          [DEVICE_PROOF_HEADER]: deviceProof,
        }),
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
    // Publish the live identity for the `pair` CLI (a separate process):
    // EndpointId is permanent; the dial ticket carries fresh relay hints.
    fs.writeFileSync(
      layout.endpointStateFile,
      `${JSON.stringify({ endpointId: handle.endpointId, ticket: handle.ticket() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return handle;
  };

  return { deviceAccess, startEndpoint };
}
