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
 * The proof matters because the HTTP listener still accepts the ephemeral
 * per-boot loopback secret directly (issue #505 phase 7): without it, a
 * holder of that secret could stamp an arbitrary device key and dodge the
 * per-vault enrollment check. The forwarder is the only in-process holder of
 * both the secret and the proof, so a proved iroh request is the only way a
 * device key ever reaches `composedHandler`.
 *
 * Issue #376 extends the same ACL to the HTTP surface itself: this module
 * also opens a `DeviceTokenStore` and exposes it (alongside the
 * `EnrollmentStore` + `PairingTicketStore` it already owned) as `pairing`
 * — `cli.ts` threads that into `serve()`'s `devicePairing` option (mounts
 * `POST /centraid/_gateway/pair`) and builds the HTTP listener's
 * `authorizeBearer` from it, so a per-device HTTP token is confined to its
 * enrollments the exact same way an iroh-proved request is.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
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
import { DeviceTokenStore } from '../serve/device-token-store.js';
import {
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_SCHEMA_EPOCH,
  GATEWAY_VERSION,
} from '../version.js';
import type { DataPlaneControlOptions } from '../routes/data-plane-control.js';
import type { DaemonLayout } from './paths.js';

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
  /**
   * The device-pairing stores (issue #376) — threaded into `serve()`'s
   * `devicePairing` option (mounts the HTTP ticket-redemption route) and
   * used by `cli.ts` to build the HTTP listener's `authorizeBearer`.
   */
  pairing: {
    enrollments: EnrollmentStore;
    tickets: PairingTicketStore;
    deviceTokens: DeviceTokenStore;
  };
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

export interface EnrollmentRevocationWatcher {
  close(): Promise<void>;
}

/**
 * Bridge the SSH admin CLI's atomic devices.json rewrites into the live
 * native relay. Directory watching survives the file's rename-based replace
 * and adds no idle polling wakeup; the enrollment store is force-refreshed
 * only after an OS change notification.
 */
export function watchEnrollmentRevocations(input: {
  file: string;
  enrollments: EnrollmentStore;
  knownEndpointIds?: Set<string>;
  onRevoked: (endpointId: string) => void | Promise<void>;
  logger: RuntimeLogger;
}): EnrollmentRevocationWatcher {
  const known =
    input.knownEndpointIds ?? new Set(input.enrollments.listFresh().map((row) => row.endpointId));
  let pending = Promise.resolve();
  let closed = false;
  let settleTimer: NodeJS.Timeout | undefined;
  const refresh = (): void => {
    pending = pending
      .then(async () => {
        const next = new Set(input.enrollments.listFresh().map((row) => row.endpointId));
        const revoked = [...known].filter((endpointId) => !next.has(endpointId));
        known.clear();
        for (const endpointId of next) known.add(endpointId);
        for (const endpointId of revoked) await input.onRevoked(endpointId);
      })
      .catch((error) => {
        input.logger.warn(
          `device plane: failed to propagate external revocation: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };
  const watcher = fs.watch(path.dirname(input.file), () => {
    if (closed) return;
    // Atomic replacement is allowed to report only the temporary filename
    // on some platforms. The directory is the gateway's small control dir,
    // so refreshing on any notification is cheap. Briefly debounce the
    // notification so a temp-file event cannot read the old destination just
    // before rename; this timer exists only after a write, never while idle.
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      refresh();
    }, 10);
    settleTimer.unref();
  });
  watcher.on('error', (error) => {
    input.logger.warn(`device plane: enrollment watch failed: ${error.message}`);
  });
  return {
    close: async () => {
      closed = true;
      watcher.close();
      if (settleTimer) clearTimeout(settleTimer);
      await pending;
    },
  };
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
  /** Shared only with native byte-plane components on the loopback listener. */
  controlSecret?: string;
  /**
   * iroh relay mode. Defaults to the production n0 relays + discovery;
   * `disabled` keeps the endpoint offline (tests bind on loopback only).
   */
  relays?: 'n0' | 'disabled';
}): DaemonDevicePlane {
  const { layout, logger } = input;
  const enrollments = EnrollmentStore.open(layout.devicesFile);
  const tickets = PairingTicketStore.open(layout.pairingTicketsFile);
  const deviceTokens = DeviceTokenStore.open(layout.deviceTokensFile);
  const knownEndpointIds = new Set(enrollments.listFresh().map((row) => row.endpointId));
  // Per-boot proof shared only between the endpoint's forwarder and the
  // HTTP layer's device resolution — never persisted, never on the wire
  // outside this process.
  const deviceProof = crypto.randomBytes(32).toString('hex');
  const controlSecret = input.controlSecret ?? crypto.randomBytes(32).toString('hex');
  let liveEndpointId: string | undefined;

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
    const redeemed = tickets.redeem(request.ticketId, request.secret);
    if (!redeemed) return { ok: false, error: 'invalid_ticket' };
    const plane = registry.get(redeemed.vaultId);
    if (!plane) return { ok: false, error: 'vault_gone' };
    const enrollment = enrollments.enroll({
      endpointId,
      vaultId: redeemed.vaultId,
      label: request.deviceName || `device ${endpointId.slice(0, 10)}…`,
      platform: request.platform,
      ...(request.rememberDevice !== undefined ? { rememberDevice: request.rememberDevice } : {}),
      trust: redeemed.trust,
      ...(grantProfile !== undefined ? { grantProfile } : {}),
    });
    knownEndpointIds.add(endpointId);
    plane.db.blobTransfers.enrollPairedDevice({
      identity: endpointId,
      ownerPartyId: plane.boot.ownerPartyId,
      name: request.deviceName || `device ${endpointId.slice(0, 10)}…`,
      ...(request.platform ? { platform: request.platform } : {}),
      trust: enrollment.trust === 'readonly' ? 'readonly' : 'full',
    });
    logger.info(
      `device plane: enrolled ${endpointId.slice(0, 10)}… into vault ${redeemed.vaultId}`,
    );
    return {
      ok: true,
      enrollmentId: enrollment.enrollmentId,
      gatewayId: liveEndpointId,
      gatewayName: os.hostname().replace(/\.local$/, ''),
      vaultId: redeemed.vaultId,
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
      const allowed = enrollments.isEnrolled(endpointId);
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
        secretKey: readOrMintSecretKey(layout.endpointKeyFile),
        upstream: () => upstream,
        authorize: (endpointId) => enrollments.isEnrolled(endpointId),
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
    const revocations = watchEnrollmentRevocations({
      file: layout.devicesFile,
      enrollments,
      knownEndpointIds,
      onRevoked: (endpointId) => handle.revokeEndpoint(endpointId),
      logger,
    });
    // Publish the live identity for the `pair` CLI (a separate process):
    // EndpointId is permanent; the dial ticket carries fresh relay hints.
    fs.writeFileSync(
      layout.endpointStateFile,
      `${JSON.stringify({ endpointId: handle.endpointId, ticket: handle.ticket() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return {
      endpointId: handle.endpointId,
      ticket: () => handle.ticket(),
      revokeEndpoint: (endpointId) => handle.revokeEndpoint(endpointId),
      close: async () => {
        await revocations.close();
        await handle.close();
      },
    };
  };

  return {
    deviceAccess,
    startEndpoint,
    dataPlaneControl,
    pairing: { enrollments, tickets, deviceTokens },
  };
}
