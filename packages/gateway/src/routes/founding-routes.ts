/*
 * Gateway founding plane (issue #555): possession mints one short-lived
 * grant; the proved first device consumes it to create the zero→one vault and
 * becomes that vault's owner. Ordinary enrollment never runs through here.
 */

import { randomBytes } from 'node:crypto';
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
import { KeyStore } from '@centraid/vault';
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
import { isLoopbackRequest, readJson, sendJson } from './route-helpers.js';

export interface FoundingRouteDeps {
  vaults: VaultRegistry;
  enrollments: EnrollmentStore;
  tickets: PairingTicketStore;
  keys: KeyStore;
  recoveryKit: RecoveryKitStateStore;
  deviceAccess?: DeviceAccess;
  endpointTicket?: () => string | undefined;
  sourceInstanceId?: string;
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

function deviceEndpoint(
  req: IncomingMessage,
  body: Record<string, unknown>,
  deps: FoundingRouteDeps,
): string | undefined {
  const proved = deps.deviceAccess?.deviceKeyFor(req);
  if (proved) return proved;
  if (isLoopbackRequest(req) && typeof body.endpointId === 'string' && body.endpointId.length > 0) {
    return body.endpointId;
  }
  return undefined;
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
      if (!isLoopbackRequest(req)) {
        return sendJson(res, 403, {
          error: 'possession_required',
          message: 'founding tickets can only be minted from the gateway host',
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
    const endpointId = deviceEndpoint(req, body, deps);
    if (!endpointId) {
      return sendJson(res, 403, {
        error: 'device_identity_required',
        message: 'founding requires a proved iroh device identity',
      });
    }

    if (url.pathname === ROUTES.vaultInitializeVerify) {
      const owner = deps.enrollments
        .list()
        .find((row) => row.endpointId === endpointId && row.trust === 'owner');
      if (!owner) return sendJson(res, 403, { error: 'owner_required' });
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
      return sendJson(res, 200, { ok: true, vaultId: owner.vaultId, fingerprint });
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
      if (!ticket || !deps.tickets.validatesFounding(ticket.t, ticket.s)) {
        return sendJson(res, 403, { error: 'invalid_or_expired_founding_ticket' });
      }
      let kit: RecoveryKitDocument;
      try {
        kit = parseRecoveryKit(body.kit, body.password);
        if (kit.targets.length === 0) {
          throw new Error('recovery kit has no backed-up vaults');
        }
      } catch (error) {
        return sendJson(res, 400, {
          error: 'restore_failed',
          message: error instanceof Error ? error.message : String(error),
        });
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
        for (const restored of reports.toReversed()) {
          if (deps.vaults.get(restored.vaultId)) deps.vaults.delete(restored.vaultId);
          deps.keys.destroy(`${restored.vaultId}.sealkey`);
          deps.tickets.gatewayDatabase.run(
            'DELETE FROM backup_targets WHERE vault_id = ?',
            restored.vaultId,
          );
          deps.tickets.gatewayDatabase.run(
            'DELETE FROM cas_reconciliations WHERE vault_id = ?',
            restored.vaultId,
          );
        }
        return sendJson(res, 400, {
          error: 'restore_failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const enrollments = deps.tickets.redeemFoundingAndEnrollMany(
        ticket.t,
        ticket.s,
        deps.enrollments,
        {
          endpointId,
          vaultIds: reports.map((report) => report.vaultId),
          label:
            typeof body.deviceName === 'string' && body.deviceName.trim()
              ? body.deviceName.trim()
              : `founder ${endpointId.slice(0, 10)}…`,
          ...(typeof body.platform === 'string' ? { platform: body.platform } : {}),
        },
        deps.beforeFoundingEnrollment,
      );
      if (!enrollments) {
        for (const report of reports.toReversed()) {
          if (deps.vaults.get(report.vaultId)) deps.vaults.delete(report.vaultId);
          deps.keys.destroy(`${report.vaultId}.sealkey`);
          deps.tickets.gatewayDatabase.run(
            'DELETE FROM backup_targets WHERE vault_id = ?',
            report.vaultId,
          );
          deps.tickets.gatewayDatabase.run(
            'DELETE FROM cas_reconciliations WHERE vault_id = ?',
            report.vaultId,
          );
        }
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

    const created = deps.vaults.create(
      typeof body.name === 'string' && body.name.trim() ? body.name : 'Personal',
    );
    let enrollment;
    try {
      enrollment = deps.tickets.redeemFoundingAndEnroll(
        ticket.t,
        ticket.s,
        deps.enrollments,
        {
          endpointId,
          vaultId: created.vaultId,
          label:
            typeof body.deviceName === 'string' && body.deviceName.trim()
              ? body.deviceName.trim()
              : `founder ${endpointId.slice(0, 10)}…`,
          ...(typeof body.platform === 'string' ? { platform: body.platform } : {}),
        },
        deps.beforeFoundingEnrollment,
      );
      if (!enrollment) {
        deps.vaults.delete(created.vaultId);
        deps.keys.destroy(`${created.vaultId}.sealkey`);
        return sendJson(res, 403, { error: 'invalid_or_expired_founding_ticket' });
      }
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
      await deps.recoveryKit.begin(kit.fingerprint);
      return sendJson(res, 201, {
        ok: true,
        vault: created,
        enrollment,
        kit,
        fingerprint: kit.fingerprint,
        recoveryScope: 'future backed-up vaults',
      });
    } catch (error) {
      if (deps.vaults.get(created.vaultId)) deps.vaults.delete(created.vaultId);
      deps.keys.destroy(`${created.vaultId}.sealkey`);
      return sendJson(res, 500, {
        error: 'founding_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
