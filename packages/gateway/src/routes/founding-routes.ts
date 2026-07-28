/*
 * Gateway founding plane (issue #555): possession mints one short-lived
 * grant; the proved first device consumes it to create the zero→one vault and
 * becomes that vault's owner. Ordinary enrollment never runs through here.
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  parseRecoveryKit,
  recoveryKitFingerprint,
  validateKeyring,
  wrapRecoveryKit,
  type Keyring,
  type RecoveryKitDocument,
} from '@centraid/backup';
import { ROUTES } from '@centraid/protocol';
import { KeyStore, uuidv7 } from '@centraid/vault';
import { recover, type RecoverReport } from '../backup/recover.js';
import type { RecoveryKitStateStore } from '../backup/recovery-kit-state.js';
import type { DeviceAccess } from '../serve/vault-context.js';
import type { EnrollmentStore } from '../serve/enrollment-store.js';
import {
  encodePairingTicket,
  FOUNDING_TICKET_TTL_MS,
  parseFoundingTicket,
  type PairingTicketStore,
} from '../serve/pairing-store.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import type { RouteHandler } from '../serve/build-gateway.js';
import { readJson, sendJson } from './route-helpers.js';

export interface FoundingRouteDeps {
  vaults: VaultRegistry;
  enrollments: EnrollmentStore;
  tickets: PairingTicketStore;
  keys: KeyStore;
  recoveryKit: RecoveryKitStateStore;
  deviceAccess?: DeviceAccess;
  endpointTicket?: () => string | undefined;
  sourceInstanceId?: string;
  /** True only for a bearer-authenticated direct request from the gateway host. */
  canMintFoundingTicket?: (req: IncomingMessage) => boolean;
  /** Test seam for a process failure after ticket consumption but before enrollment. */
  beforeFoundingEnrollment?: () => void;
}

function keyringFor(keys: KeyStore): Keyring {
  const existing = keys.export('keyring.key');
  if (existing) return validateKeyring(JSON.parse(existing.toString('utf8')));
  const keyring: Keyring = {
    version: 1,
    active: 1,
    epochs: [
      {
        epoch: 1,
        key: randomBytes(32).toString('base64'),
        createdAt: new Date().toISOString(),
      },
    ],
  };
  keys.import('keyring.key', Buffer.from(JSON.stringify(keyring), 'utf8'));
  return keyring;
}

function deviceEndpoint(req: IncomingMessage, deps: FoundingRouteDeps): string | undefined {
  return deps.deviceAccess?.deviceKeyFor(req);
}

function foundingVaultIdsAreSafe(root: string, vaultIds: readonly string[]): boolean {
  const resolvedRoot = path.resolve(root);
  return (
    vaultIds.length > 0 &&
    vaultIds.every((vaultId) => {
      const candidate = path.resolve(resolvedRoot, vaultId);
      return path.dirname(candidate) === resolvedRoot && !existsSync(candidate);
    })
  );
}

function rollbackFoundingVaults(
  deps: FoundingRouteDeps,
  reservation: string,
  vaultIds: readonly string[],
): void {
  for (const vaultId of vaultIds) {
    deps.vaults.discardPendingFoundingVault(vaultId);
    deps.keys.destroy(`${vaultId}.sealkey`);
    deps.tickets.gatewayDatabase.run('DELETE FROM backup_targets WHERE vault_id = ?', vaultId);
    deps.tickets.gatewayDatabase.run('DELETE FROM cas_reconciliations WHERE vault_id = ?', vaultId);
  }
  deps.tickets.clearReservedFoundingVaults(reservation, vaultIds);
  // Hand the founding slot back: nothing was consumed, so the same QR must
  // stay usable for a retry rather than wedging `mintFounding` for the
  // reservation's full TTL (issue #568 item K).
  deps.tickets.releaseFounding(reservation);
}

export function makeFoundingRouteHandler(deps: FoundingRouteDeps): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (
      url.pathname !== ROUTES.gatewayFoundingTicket &&
      url.pathname !== ROUTES.vaultInitialize &&
      url.pathname !== ROUTES.vaultInitializeVerify &&
      url.pathname !== ROUTES.vaultRestore
    ) {
      return false;
    }
    if ((req.method ?? 'GET') !== 'POST') {
      return sendJson(res, 405, { error: 'method_not_allowed', message: 'POST only' });
    }

    if (url.pathname === ROUTES.gatewayFoundingTicket) {
      if (!deps.canMintFoundingTicket?.(req)) {
        return sendJson(res, 403, {
          error: 'possession_required',
          message:
            'founding tickets require the gateway host credential and cannot be minted through the iroh forwarding plane',
        });
      }
      if (!deps.vaults.isFresh()) {
        return sendJson(res, 409, {
          error: 'already_initialized',
          message: 'gateway already has a vault; use ordinary device pairing',
        });
      }
      const gw = deps.endpointTicket?.();
      if (!gw) {
        return sendJson(res, 409, {
          error: 'endpoint_not_ready',
          message: 'daemon is running but its iroh endpoint is not ready',
        });
      }
      const minted = deps.tickets.mintFounding(FOUNDING_TICKET_TTL_MS);
      if (!minted) {
        // A ceremony already holds the one founding slot. Replacing its
        // ticket would roll back an in-flight restore (issue #568 item K).
        return sendJson(res, 409, {
          error: 'founding_in_progress',
          message:
            'a founding ceremony is already running on this gateway; wait for it to finish or fail before minting another ticket',
        });
      }
      return sendJson(res, 200, {
        ok: true,
        ticket: encodePairingTicket({
          v: 1,
          kind: 'centraid-gw-found',
          gw,
          t: minted.ticketId,
          s: minted.secret,
          exp: minted.expiresAt,
        }),
        expiresAt: new Date(minted.expiresAt).toISOString(),
      });
    }

    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: 'invalid_body' });
    }
    const endpointId = deviceEndpoint(req, deps);
    if (!endpointId) {
      return sendJson(res, 403, {
        error: 'device_identity_required',
        message: 'founding requires a proved iroh device identity',
      });
    }

    if (url.pathname === ROUTES.vaultInitializeVerify) {
      const admin = deps.enrollments
        .list()
        .find((row) => row.endpointId === endpointId && row.role === 'admin');
      if (!admin) return sendJson(res, 403, { error: 'admin_required' });
      if (body.lossConsent !== true) {
        return sendJson(res, 409, {
          error: 'loss_consent_required',
          message: 'confirm that losing this file and password makes backups unrecoverable',
        });
      }
      if (typeof body.password !== 'string') {
        return sendJson(res, 400, { error: 'password_required' });
      }
      let document: RecoveryKitDocument;
      try {
        document = parseRecoveryKit(body.kit, body.password);
      } catch (error) {
        return sendJson(res, 400, {
          error: 'kit_verification_failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const fingerprint = recoveryKitFingerprint(document);
      const verified = await deps.recoveryKit.verify(fingerprint);
      if (!verified) {
        return sendJson(res, 409, {
          error: 'kit_mismatch',
          message: 'the selected recovery kit is not the one this gateway just created',
        });
      }
      return sendJson(res, 200, { ok: true, vaultId: admin.vaultId, fingerprint });
    }

    if (!deps.vaults.isFresh()) {
      return sendJson(res, 409, {
        error: 'already_initialized',
        message: 'vault initialization is allowed only while the gateway has zero vaults',
      });
    }

    if (url.pathname === ROUTES.vaultRestore) {
      if (
        typeof body.ticket !== 'string' ||
        typeof body.password !== 'string' ||
        body.password.length === 0 ||
        typeof body.apiKey !== 'string'
      ) {
        return sendJson(res, 400, {
          error: 'founding_credentials_required',
          message: 'ticket, recovery-kit password, kit, and provider credential are required',
        });
      }
      const ticket = parseFoundingTicket(body.ticket);
      const reservation = ticket ? deps.tickets.reserveFounding(ticket.t, ticket.s) : undefined;
      if (!ticket || !reservation) {
        return sendJson(res, 403, { error: 'invalid_or_expired_founding_ticket' });
      }
      let kit: RecoveryKitDocument;
      try {
        kit = parseRecoveryKit(body.kit, body.password);
        if (kit.targets.length === 0) {
          throw new Error('recovery kit has no backed-up vaults');
        }
      } catch (error) {
        deps.tickets.releaseFounding(reservation);
        return sendJson(res, 400, {
          error: 'restore_failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const pendingVaultIds = kit.targets.map((target) => target.vaultId);
      if (!foundingVaultIdsAreSafe(deps.vaults.rootPath(), pendingVaultIds)) {
        deps.tickets.releaseFounding(reservation);
        return sendJson(res, 409, {
          error: 'restore_target_conflict',
          message: 'one or more recovery-kit vault ids are invalid or already exist locally',
        });
      }
      if (!deps.tickets.stageReservedFoundingVaults(reservation, pendingVaultIds)) {
        deps.tickets.releaseFounding(reservation);
        return sendJson(res, 409, { error: 'founding_ticket_raced' });
      }
      const reports: RecoverReport[] = [];
      try {
        for (const target of kit.targets) {
          reports.push(
            await recover({
              kitDocument: body.kit,
              password: body.password,
              apiKey: body.apiKey,
              vaultId: target.vaultId,
              vaultRoot: deps.vaults.rootPath(),
              gatewayDatabase: deps.tickets.gatewayDatabase,
              keyStore: deps.keys,
              ...(deps.sourceInstanceId ? { sourceInstanceId: deps.sourceInstanceId } : {}),
              onAdopted: ({ vaultId }) => {
                deps.vaults.adopt(vaultId);
              },
            }),
          );
        }
      } catch (error) {
        rollbackFoundingVaults(deps, reservation, pendingVaultIds);
        return sendJson(res, 400, {
          error: 'restore_failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const restoredVaultIds = reports.map((report) => report.vaultId);
      const enrollments = deps.tickets.redeemReservedFoundingAndEnrollMany(
        reservation,
        deps.enrollments,
        {
          endpointId,
          vaultIds: restoredVaultIds,
          label:
            typeof body.deviceName === 'string' && body.deviceName.trim()
              ? body.deviceName.trim()
              : `founder ${endpointId.slice(0, 10)}…`,
          ...(typeof body.platform === 'string' ? { platform: body.platform } : {}),
        },
        deps.beforeFoundingEnrollment,
      );
      if (!enrollments) {
        rollbackFoundingVaults(deps, reservation, restoredVaultIds);
        return sendJson(res, 409, {
          error: 'founding_ticket_raced',
          message: 'the founding ticket was redeemed by another caller during restore',
        });
      }
      return sendJson(res, 201, {
        ok: true,
        report: reports[0],
        reports,
        enrollment: enrollments[0],
        enrollments,
      });
    }

    if (
      typeof body.ticket !== 'string' ||
      typeof body.password !== 'string' ||
      body.password.length === 0
    ) {
      return sendJson(res, 400, {
        error: 'founding_credentials_required',
        message: 'ticket and recovery-kit password are required',
      });
    }
    const ticket = parseFoundingTicket(body.ticket);
    if (!ticket) return sendJson(res, 403, { error: 'invalid_founding_ticket' });
    const reservation = deps.tickets.reserveFounding(ticket.t, ticket.s);
    if (!reservation) {
      return sendJson(res, 403, { error: 'invalid_or_expired_founding_ticket' });
    }

    const vaultId = uuidv7();
    if (!deps.tickets.stageReservedFoundingVaults(reservation, [vaultId])) {
      deps.tickets.releaseFounding(reservation);
      return sendJson(res, 409, { error: 'founding_ticket_raced' });
    }
    let created: ReturnType<VaultRegistry['create']> | undefined;
    let enrollment;
    try {
      created = deps.vaults.create(
        typeof body.name === 'string' && body.name.trim() ? body.name : 'Personal',
        vaultId,
      );
      const document: RecoveryKitDocument = {
        version: 1,
        kind: 'centraid-recovery-kit',
        createdAt: new Date().toISOString(),
        keyring: keyringFor(deps.keys),
        // A local-only vault has no offsite recovery target. Adding one makes
        // the gateway kit stale and adds this vault's DEK to its target row.
        targets: [],
      };
      const kit = wrapRecoveryKit(document, body.password);
      enrollment = deps.tickets.redeemReservedFoundingAndEnrollMany(
        reservation,
        deps.enrollments,
        {
          endpointId,
          vaultIds: [created.vaultId],
          label:
            typeof body.deviceName === 'string' && body.deviceName.trim()
              ? body.deviceName.trim()
              : `founder ${endpointId.slice(0, 10)}…`,
          ...(typeof body.platform === 'string' ? { platform: body.platform } : {}),
        },
        deps.beforeFoundingEnrollment,
        () =>
          deps.recoveryKit.beginWithinTransaction(kit.fingerprint, {
            founding: true,
          }),
      )?.[0];
      if (!enrollment) {
        rollbackFoundingVaults(deps, reservation, [created.vaultId]);
        return sendJson(res, 403, { error: 'invalid_or_expired_founding_ticket' });
      }
      return sendJson(res, 201, {
        ok: true,
        vault: created,
        enrollment,
        kit,
        fingerprint: kit.fingerprint,
        recoveryScope: 'future backed-up vaults',
      });
    } catch (error) {
      rollbackFoundingVaults(deps, reservation, [created?.vaultId ?? vaultId]);
      return sendJson(res, 500, {
        error: 'founding_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
