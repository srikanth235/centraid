/*
 * `GET /centraid/_gateway/backup` + `POST /centraid/_gateway/backup/run` +
 * `POST /centraid/_gateway/backup/kit-confirmed` — the HTTP surface over
 * `BackupService` (issue #351's last workstream: the `centraid-gateway
 * backup` CLI has status/run, but nothing exposes it to the desktop's
 * Gateway page; wave 4 adds the recovery-kit confirmation gate).
 *
 * Thin wiring, same shape as `health-routes.ts`/`diagnostics-routes.ts`:
 * mounted in `extraHandlers` behind the same host bearer gate. When backup
 * isn't configured (`options.backup?.enabled` false), `build-gateway.ts`
 * never constructs a `BackupService` — this handler is built with
 * `backupService: undefined` in that case and answers a `configured: false`
 * body (with `recoveryKit: {confirmedAt: null}`, since there's no state to
 * read) rather than 404, so the UI can render an explainer without a
 * separate "does backup exist" probe.
 *
 * `recoveryKit` is deliberately generic, not backup-card-specific — issue
 * #367 reuses this exact `{confirmedAt}` shape and the same POST to gate
 * the S3-storage enable flow.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import type { BackupService, RecoveryKitState } from '../backup/backup-service.js';
import type { RecoveryKitStateStore } from '../backup/recovery-kit-state.js';
import { sendError, sendJson } from './route-helpers.js';

const BACKUP_PATH = '/centraid/_gateway/backup';
const BACKUP_RUN_PATH = '/centraid/_gateway/backup/run';
const BACKUP_VERIFY_PATH = '/centraid/_gateway/backup/verify';
const BACKUP_KIT_PATH = '/centraid/_gateway/backup/kit';
const BACKUP_KIT_CONFIRMED_PATH = '/centraid/_gateway/backup/kit-confirmed';

export interface BackupVaultStatus {
  vaultId: string;
  name?: string;
  lastBackupAt?: string;
  lastVerifyAt?: string;
  lastError?: string;
  running?: boolean;
}

export interface BackupStatusBody {
  configured: boolean;
  provider?: string;
  vaults: BackupVaultStatus[];
  recoveryKit: RecoveryKitState;
}

export interface BackupRouteDeps {
  /** `undefined` when `options.backup?.enabled` is false — no service exists. */
  backupService?: BackupService;
  /**
   * Gateway-level recovery-kit state (issue #367 §C10) — present even when
   * backup isn't configured, so the confirmation gate the S3-storage enable
   * flow shares can actually be satisfied on a backup-less gateway (the
   * desktop embed) instead of only bypassed with force.
   */
  recoveryKitStore?: RecoveryKitStateStore;
  vaults: VaultRegistry;
}

async function buildStatus(deps: BackupRouteDeps): Promise<BackupStatusBody> {
  const { backupService } = deps;
  if (!backupService) {
    const recoveryKit = (await deps.recoveryKitStore?.status()) ?? { confirmedAt: null };
    return { configured: false, vaults: [], recoveryKit };
  }
  const [configuration, state, recoveryKit] = await Promise.all([
    backupService.configured?.() ?? Promise.resolve({ configured: true }),
    backupService.status(),
    backupService.recoveryKitStatus(),
  ]);
  if (!configuration.configured) return { configured: false, vaults: [], recoveryKit };
  const vaults: BackupVaultStatus[] = deps.vaults.planesList().map((plane) => {
    const vaultId = plane.boot.vaultId;
    const target = state[vaultId];
    return {
      vaultId,
      name: plane.name,
      ...(target?.lastBackupAt ? { lastBackupAt: target.lastBackupAt } : {}),
      ...(target?.lastVerifiedAt ? { lastVerifyAt: target.lastVerifiedAt } : {}),
      ...(target?.lastError ? { lastError: target.lastError } : {}),
      running: backupService.isRunning(vaultId),
    };
  });
  return { configured: true, provider: configuration.provider, vaults, recoveryKit };
}

export function makeBackupRouteHandler(deps: BackupRouteDeps): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');

    if (url.pathname === BACKUP_PATH) {
      if ((req.method ?? 'GET') !== 'GET') {
        return sendJson(res, 405, { error: 'method_not_allowed', message: 'GET only' });
      }
      try {
        return sendJson(res, 200, await buildStatus(deps));
      } catch (err) {
        return sendError(res, err);
      }
    }

    if (url.pathname === BACKUP_RUN_PATH) {
      if ((req.method ?? 'GET') !== 'POST') {
        return sendJson(res, 405, { error: 'method_not_allowed', message: 'POST only' });
      }
      const { backupService } = deps;
      if (
        !backupService ||
        !(await (backupService.configured?.() ?? { configured: true })).configured
      ) {
        return sendJson(res, 409, {
          error: 'not_configured',
          message: 'backup is not configured — add a "backup" block to the gateway config',
        });
      }
      // Serialize: a run already in flight covers every mounted vault
      // (`runAll`), so a second concurrent POST just observes it rather
      // than enqueueing a duplicate pass over the same vaults.
      if (backupService.isRunning()) {
        return sendJson(res, 202, { accepted: true, alreadyRunning: true });
      }
      // Fire-and-forget: `doRunBackup` already records failures into
      // backup state + the `backups` health component, so this catch
      // only silences the unhandled-rejection warning — the UI learns
      // the outcome from the next `GET` (lastError / running flips back).
      void backupService.runAll().catch(() => undefined);
      return sendJson(res, 202, { accepted: true });
    }

    if (url.pathname === BACKUP_VERIFY_PATH) {
      if ((req.method ?? 'GET') !== 'POST') {
        return sendJson(res, 405, { error: 'method_not_allowed', message: 'POST only' });
      }
      const { backupService } = deps;
      if (
        !backupService ||
        !(await (backupService.configured?.() ?? { configured: true })).configured
      ) {
        return sendJson(res, 409, {
          error: 'not_configured',
          message: 'backup is not configured — add a provider backup connection',
        });
      }
      if (backupService.isRunning()) {
        return sendJson(res, 202, { accepted: true, alreadyRunning: true });
      }
      void backupService.verifyAll().catch(() => undefined);
      return sendJson(res, 202, { accepted: true });
    }

    if (url.pathname === BACKUP_KIT_PATH) {
      if ((req.method ?? 'GET') !== 'GET') {
        return sendJson(res, 405, { error: 'method_not_allowed', message: 'GET only' });
      }
      if (!deps.backupService) {
        return sendJson(res, 409, { error: 'not_configured', message: 'backup is not configured' });
      }
      try {
        return sendJson(res, 200, await deps.backupService.recoveryKitDocument());
      } catch (err) {
        return sendError(res, err);
      }
    }

    if (url.pathname === BACKUP_KIT_CONFIRMED_PATH) {
      if ((req.method ?? 'GET') !== 'POST') {
        return sendJson(res, 405, { error: 'method_not_allowed', message: 'POST only' });
      }
      const { backupService, recoveryKitStore } = deps;
      try {
        if (backupService) {
          const recoveryKit = await backupService.confirmRecoveryKit();
          return sendJson(res, 200, { ok: true, ...recoveryKit });
        }
        if (recoveryKitStore) {
          const recoveryKit = await recoveryKitStore.confirm();
          return sendJson(res, 200, { ok: true, ...recoveryKit });
        }
        return sendJson(res, 409, {
          error: 'not_configured',
          message: 'backup is not configured — add a "backup" block to the gateway config',
        });
      } catch (err) {
        return sendError(res, err);
      }
    }

    return false;
  };
}
