/*
 * The vault plane (duaility §12) — the gateway's mount of the owner's
 * personal vault (`@centraid/vault`) beside the per-app data silos.
 *
 * The gateway process is the sole holder of the vault connection. Apps
 * reach it only through `ctx.vault`, whose worker messages land in
 * `bridgeFor(appId)`: the running app is resolved to its enrolled
 * `consent.app` credential HERE, host-side — no signing key ever crosses
 * into a handler worker. Consent, contracts, receipts and provenance are
 * the vault gateway's own five-stage pipeline; this module adds nothing
 * on top and takes nothing away.
 *
 * Lifecycle: `openVaultPlane()` opens/creates the two SQLite files under
 * `paths.vaultDir`, bootstraps the owner idempotently (recovery re-derives
 * the owner-device credential from the model), and registers the four
 * foundation domains. `start()` begins the sweep clock; `stop()` sweeps
 * the clock down, WAL-checkpoints, and closes the files.
 */

import {
  createGateway,
  createGrant,
  ensureAppEnrolled,
  ensureVaultBootstrapped,
  GatewayError,
  listActiveGrants,
  listEnrolledApps,
  lookupAppByName,
  markAppRevoked,
  openVaultDb,
  purposeConceptId,
  registerAttachmentCommands,
  registerBookingCommands,
  registerBusinessCommands,
  registerDocumentCommands,
  registerFinanceCommands,
  registerHealthCommands,
  registerHomeCommands,
  registerKnowledgeCommands,
  registerMediaCommands,
  registerPartyCommands,
  registerScheduleCommands,
  registerSocialCommands,
  registerSubscriptionCommands,
  registerTaskCommands,
  type AppSummary,
  type Credential,
  type Gateway as VaultGateway,
  type GrantSummary,
  type HostBootstrap,
  type InvokeOutcome,
  type InvokeRequest,
  type ParkedSummary,
  type ReadRequest,
  type RevocationResult,
  type ScopeSpec,
  type SweepResult,
  type VaultDb,
} from '@centraid/vault';
import type { RuntimeLogger, VaultBridge, VaultCallResult } from '@centraid/app-engine';

export interface VaultPlaneOptions {
  /** Directory holding `vault.db` + `journal.db`. Created if absent. */
  dir: string;
  logger: RuntimeLogger;
  /** Owner display name used only on first boot. */
  ownerName?: string;
  /** Sweep cadence for lifecycle duties. Default: hourly. */
  sweepIntervalMs?: number;
}

/** A grant request the owner approves — scopes as the manifest declares them. */
export interface GrantRequest {
  purpose: string;
  scopes: ScopeSpec[];
  expiresAt?: string;
}

export class VaultPlane {
  readonly db: VaultDb;
  readonly gateway: VaultGateway;
  readonly boot: HostBootstrap;
  private readonly logger: RuntimeLogger;
  private readonly sweepIntervalMs: number;
  private sweepTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(options: VaultPlaneOptions) {
    this.logger = options.logger;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60 * 60 * 1000;
    this.db = openVaultDb({ dir: options.dir });
    this.boot = ensureVaultBootstrapped(this.db, { ownerName: options.ownerName ?? 'Owner' });
    this.gateway = createGateway(this.db);
    registerScheduleCommands(this.gateway);
    registerTaskCommands(this.gateway);
    registerSocialCommands(this.gateway);
    registerFinanceCommands(this.gateway);
    registerHealthCommands(this.gateway);
    registerKnowledgeCommands(this.gateway);
    registerBusinessCommands(this.gateway);
    registerAttachmentCommands(this.gateway);
    registerBookingCommands(this.gateway);
    registerSubscriptionCommands(this.gateway);
    registerPartyCommands(this.gateway);
    registerMediaCommands(this.gateway);
    registerDocumentCommands(this.gateway);
    registerHomeCommands(this.gateway);
    this.logger.info(
      this.boot.fresh
        ? `vault plane: bootstrapped a fresh vault at ${options.dir}`
        : `vault plane: recovered vault ${this.boot.vaultId} at ${options.dir}`,
    );
  }

  /** The owner-device credential the host acts with (confirm/revoke/sweep). */
  get ownerCredential(): Credential {
    return { kind: 'device', deviceId: this.boot.deviceId, deviceKey: this.boot.deviceKey };
  }

  /**
   * Enroll a live app as a `consent.app` row, once. Called on every
   * app-live event; re-publishes are no-ops. Enrollment is identity only —
   * access still requires an owner-approved grant (deny-by-default).
   */
  enrollApp(appId: string): void {
    const enrolled = ensureAppEnrolled(this.db, appId, { origin: 'generated' });
    if (enrolled.created) this.logger.info(`vault plane: enrolled app "${appId}"`);
  }

  /**
   * Uninstall cascade: revoke every active grant (views invalidated, parked
   * invocations dropped, appext file deleted on the last one), then retire
   * the enrollment row. Model rows and receipts remain — §11's success test.
   */
  revokeApp(appId: string): { grantsRevoked: number } {
    const app = lookupAppByName(this.db, appId);
    if (!app) return { grantsRevoked: 0 };
    const grants = listActiveGrants(this.db, app.appId);
    let revoked = 0;
    for (const grant of grants) {
      const result: RevocationResult = this.gateway.revokeGrant(
        this.ownerCredential,
        grant.grantId,
      );
      revoked += 1;
      this.logger.info(
        `vault plane: revoked grant ${grant.grantId} for "${appId}" ` +
          `(views ${result.viewsRevoked}, parked ${result.parkedDropped})`,
      );
    }
    markAppRevoked(this.db, app.appId);
    return { grantsRevoked: revoked };
  }

  /**
   * Owner approval of a requested grant. `purpose` is a DPV notation the
   * vault's seed vocabulary knows; unknown purposes are refused rather
   * than silently minted.
   */
  approveGrant(appId: string, request: GrantRequest): string {
    const app = ensureAppEnrolled(this.db, appId, { origin: 'generated' });
    const purpose = purposeConceptId(this.db, request.purpose);
    if (!purpose) throw new Error(`unknown purpose notation "${request.purpose}"`);
    if (request.scopes.length === 0) throw new Error('a grant needs at least one scope');
    return createGrant(this.db, {
      appId: app.appId,
      purposeConceptId: purpose,
      grantedByPartyId: this.boot.ownerPartyId,
      scopes: request.scopes,
      ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
    });
  }

  /** Enrolled apps with their active grants — the owner consent surface. */
  listApps(): Array<AppSummary & { grants: GrantSummary[] }> {
    return listEnrolledApps(this.db).map((app) => ({
      ...app,
      grants: listActiveGrants(this.db, app.appId),
    }));
  }

  /** Revoke one grant by id (owner act; the cascade runs). */
  revokeGrant(grantId: string): RevocationResult {
    return this.gateway.revokeGrant(this.ownerCredential, grantId);
  }

  listParked(): ParkedSummary[] {
    return this.gateway.listParked();
  }

  confirmParked(invocationId: string, approve: boolean): InvokeOutcome {
    return this.gateway.confirm(this.ownerCredential, invocationId, approve);
  }

  sweep(): SweepResult {
    return this.gateway.sweep(this.ownerCredential);
  }

  /**
   * The per-app `ctx.vault` executor. Credential resolution happens per
   * call so a revocation lands immediately — there is no cached identity
   * a stale worker could keep using.
   */
  bridgeFor(appId: string): VaultBridge {
    return async (call): Promise<VaultCallResult> => {
      const app = lookupAppByName(this.db, appId);
      if (!app) {
        return {
          ok: false,
          code: 'VAULT_NOT_ENROLLED',
          error: `app "${appId}" is not enrolled in the vault`,
        };
      }
      const cred: Credential = { kind: 'app', appId: app.appId, signingKey: app.signingKey };
      try {
        switch (call.op) {
          case 'read':
            return {
              ok: true,
              result: this.gateway.read(cred, call.payload as unknown as ReadRequest),
            };
          case 'invoke':
            return {
              ok: true,
              result: this.gateway.invoke(cred, call.payload as unknown as InvokeRequest),
            };
          case 'query':
            return {
              ok: true,
              result: this.gateway.queryView(
                cred,
                String(call.payload.view ?? ''),
                String(call.payload.purpose ?? ''),
                app.appId,
              ),
            };
          case 'describe':
            return { ok: true, result: this.gateway.discover(cred) };
          default:
            return { ok: false, code: 'VAULT_ERROR', error: `unknown vault op` };
        }
      } catch (err) {
        if (err instanceof GatewayError) {
          return { ok: false, code: `VAULT_${err.stage.toUpperCase()}`, error: err.message };
        }
        return {
          ok: false,
          code: 'VAULT_ERROR',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };
  }

  /** Begin the standing-duty clock: a sweep now, then one per interval. */
  start(): void {
    this.runSweep();
    this.sweepTimer = setInterval(() => this.runSweep(), this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  private runSweep(): void {
    try {
      const result = this.sweep();
      const touched =
        result.grantsExpired +
        result.sharesExpired +
        result.contentPurged +
        result.retentionDeleted;
      if (touched > 0) {
        this.logger.info(
          `vault plane: sweep grantsExpired=${result.grantsExpired} sharesExpired=${result.sharesExpired} ` +
            `contentPurged=${result.contentPurged} retentionDeleted=${result.retentionDeleted}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `vault plane: sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Stop the clock, checkpoint the WALs, close the files. Idempotent. */
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    try {
      this.gateway.checkpoint(this.ownerCredential);
    } catch (err) {
      this.logger.warn(
        `vault plane: checkpoint on stop failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.db.close();
  }
}

export function openVaultPlane(options: VaultPlaneOptions): VaultPlane {
  return new VaultPlane(options);
}
