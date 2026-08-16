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

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  parseRecoveryKit,
  recoveryKitFingerprint,
  wrapRecoveryKit,
} from "@centraid/backup";
import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";
import {
  BackupPolicyError,
  readBackupPolicy,
  readBlobStoreSettings,
  updateBackupPolicy,
} from "@centraid/vault";
import type { BackupPolicy, BackupPolicyPatch } from "@centraid/vault";

import type { ProviderPolicySyncState } from "../backup/backup-provider-observability.js";
import type { BackupReconciliationState } from "../backup/backup-reconciliation.js";
import type {
  BackupService,
  HomeDiscovery,
  RecoveryKitState,
} from "../backup/backup-service.js";
import type { RecoveryKitStateStore } from "../backup/recovery-kit-state.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import {
  scopeKitToRequestingOwner,
  vaultOwnerRefusal,
} from "./backup-owner-scope.js";
import { readJson, sendError, sendJson } from "./route-helpers.js";

const BACKUP_PATH = "/centraid/_gateway/backup";
const BACKUP_RUN_PATH = "/centraid/_gateway/backup/run";
const BACKUP_VERIFY_PATH = "/centraid/_gateway/backup/verify";
const BACKUP_KIT_PATH = "/centraid/_gateway/backup/kit";
const BACKUP_KIT_CONFIRMED_PATH = "/centraid/_gateway/backup/kit-confirmed";
const BACKUP_POLICY_PREFIX = "/centraid/_gateway/backup/policy/";
const BACKUP_VERIFY_BUCKET_PREFIX = "/centraid/_gateway/backup/verify-bucket/";

export interface BackupDestinationStatus {
  kind: "gateway-local" | "provider";
  connectionId?: string;
}

export interface BackupVaultStatus {
  vaultId: string;
  name?: string;
  lastBackupAt?: string;
  lastVerifyAt?: string;
  lastWalDrainAt?: string;
  lastError?: string;
  running?: boolean;
  policy: BackupPolicy;
  destination: BackupDestinationStatus;
  pendingOffsite: { count: number; bytes: number };
  providerPolicy?: ProviderPolicySyncState;
  reconciliation?: BackupReconciliationState;
}

export interface BackupStatusBody {
  configured: boolean;
  provider?: string;
  vaults: BackupVaultStatus[];
  recoveryKit: RecoveryKitState;
  /** The home bundle's provider-declared promises (#436 §6) — Recovery window
   *  (`retention`) and Exit (`restoreCostClass`) of the five-metric contract.
   *  Absent when backup isn't configured, or when discovery couldn't be read. */
  home?: HomeDiscovery;
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
  /** Real per-vault enrollments used to keep live key export owner-only. */
  enrollments?: EnrollmentStore;
  /**
   * Direct host-custody request (authenticated bearer, never iroh-forwarded).
   * It can see every vault, so refusals it hits are `owner_only` (naming the
   * real owner) rather than `not_found` topology hiding (#726 P1).
   */
  isHostCustody?: (req: IncomingMessage) => boolean;
  vaults: VaultRegistry;
}

function ownerRequired(
  req: IncomingMessage,
  deps: BackupRouteDeps,
  res: ServerResponse
): boolean {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const endpointId = Array.isArray(raw) ? raw[0] : raw;
  const vaultId = deps.vaults.current().boot.vaultId;
  const enrollment =
    typeof endpointId === "string" && deps.enrollments
      ? deps.enrollments.get(endpointId, vaultId)
      : undefined;
  if (!enrollment || enrollment.revoked) {
    sendJson(res, 403, {
      error: "owner_required",
      message:
        "only the vault owner's device can export or verify live recovery key material",
    });
    return false;
  }
  return true;
}

async function buildStatus(deps: BackupRouteDeps): Promise<BackupStatusBody> {
  const { backupService } = deps;
  if (!backupService) {
    const recoveryKit = (await deps.recoveryKitStore?.status()) ?? {
      confirmedAt: null,
    };
    return {
      configured: false,
      vaults: deps.vaults
        .planesList()
        .map((plane) => vaultStatus(plane, undefined, false)),
      recoveryKit,
    };
  }
  const [configuration, state, casReconciliations, recoveryKit, home] =
    await Promise.all([
      backupService.configured?.() ?? Promise.resolve({ configured: true }),
      backupService.status(),
      backupService.casReconciliationStatus?.() ??
        Promise.resolve<Record<string, BackupReconciliationState>>({}),
      backupService.recoveryKitStatus(),
      // Discovery is a provider round-trip; a failure must never blank the whole
      // status body — the five-metric surface degrades to unknown recovery/exit.
      typeof backupService.homeDiscovery === "function"
        ? backupService.homeDiscovery().catch(() => undefined)
        : Promise.resolve<HomeDiscovery | undefined>(undefined),
    ]);
  const vaults: BackupVaultStatus[] = deps.vaults.planesList().map((plane) => {
    const vaultId = plane.boot.vaultId;
    const target = state[vaultId];
    return vaultStatus(
      plane,
      target,
      backupService.isRunning(vaultId),
      casReconciliations[vaultId]
    );
  });
  return {
    configured: configuration.configured,
    ...(configuration.provider ? { provider: configuration.provider } : {}),
    vaults,
    recoveryKit,
    ...(home ? { home } : {}),
  };
}

function vaultStatus(
  plane: ReturnType<VaultRegistry["current"]>,
  target:
    | {
        lastBackupAt?: string;
        lastVerifiedAt?: string;
        lastWalDrainAt?: string;
        lastError?: string;
        providerPolicy?: ProviderPolicySyncState;
        reconciliation?: BackupReconciliationState;
      }
    | undefined,
  running: boolean,
  casReconciliation?: BackupReconciliationState
): BackupVaultStatus {
  const store = readBlobStoreSettings(plane.db.vault);
  // Every remote CAS connection is a provider home bundle now (#436 §2).
  const destination: BackupDestinationStatus =
    store.kind === "s3"
      ? {
          kind: "provider",
          ...(store.connectionId ? { connectionId: store.connectionId } : {}),
        }
      : { kind: "gateway-local" };
  const outbox = plane.db.blobTransfers.status();
  const reconciliation = newestReconciliation(
    target?.reconciliation,
    casReconciliation
  );
  return {
    vaultId: plane.boot.vaultId,
    name: plane.name,
    policy: readBackupPolicy(plane.db.vault),
    destination,
    pendingOffsite: { count: outbox.pendingCount, bytes: outbox.pendingBytes },
    ...(target?.lastBackupAt ? { lastBackupAt: target.lastBackupAt } : {}),
    ...(target?.lastVerifiedAt ? { lastVerifyAt: target.lastVerifiedAt } : {}),
    ...(target?.lastWalDrainAt
      ? { lastWalDrainAt: target.lastWalDrainAt }
      : {}),
    ...(target?.lastError ? { lastError: target.lastError } : {}),
    ...(target?.providerPolicy
      ? { providerPolicy: target.providerPolicy }
      : {}),
    ...(reconciliation ? { reconciliation } : {}),
    running,
  };
}

function newestReconciliation(
  first: BackupReconciliationState | undefined,
  second: BackupReconciliationState | undefined
): BackupReconciliationState | undefined {
  if (!first) return second;
  if (!second) return first;
  return Date.parse(first.checkedAt) >= Date.parse(second.checkedAt)
    ? first
    : second;
}

// Owner-editable policy keys (issue #436 §4). Deliberately EXCLUDED:
//   - `casAck`: the wire declaration keeps the field (default 'receipt'), but
//     durability semantics are not an owner knob — remote custody is always
//     receipt-acked; the store engine reads the default, the owner never sets it.
//   - `storageClass` / `directToColdOriginals`: store-class vocabulary — the
//     gateway routes store classes internally; not user-facing.
// The cadence fields (rpo/snapshot/verify) stay editable as "advanced", along
// with the transit budgets and WAL-roll knobs.
const POLICY_KEYS: readonly (keyof BackupPolicy)[] = [
  "rpoSeconds",
  "snapshotIntervalHours",
  "verifyEveryDays",
  "outboxBudgetBytes",
  "reservedHeadroomBytes",
  "cacheBudgetBytes",
  "throttleBytesPerSec",
  "walBaseRollBytes",
  "walBaseRollHours",
];

export function makeBackupRouteHandler(deps: BackupRouteDeps): RouteHandler {
  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");

    if (url.pathname === BACKUP_PATH) {
      if ((req.method ?? "GET") !== "GET") {
        return sendJson(res, 405, {
          error: "method_not_allowed",
          message: "GET only",
        });
      }
      try {
        return sendJson(res, 200, await buildStatus(deps));
      } catch (error) {
        return sendError(res, error);
      }
    }

    if (url.pathname.startsWith(BACKUP_POLICY_PREFIX)) {
      const vaultId = decodeURIComponent(
        url.pathname.slice(BACKUP_POLICY_PREFIX.length)
      );
      const plane = deps.vaults.get(vaultId);
      if (!plane)
        return sendJson(res, 404, {
          error: "not_found",
          message: "unknown vault",
        });
      if ((req.method ?? "GET") === "GET") {
        return sendJson(res, 200, {
          vaultId,
          policy: readBackupPolicy(plane.db.vault),
        });
      }
      if ((req.method ?? "GET") !== "PUT") {
        return sendJson(res, 405, {
          error: "method_not_allowed",
          message: "GET, PUT only",
        });
      }
      // Configuring a vault's backup target is an owner act (#726 P1):
      // `backup_targets` rows key by vault_id, but hosting a vault confers
      // no authority over ITS destination/policy.
      const configRefusal = vaultOwnerRefusal(
        req,
        deps,
        vaultId,
        "configure backup for this vault"
      );
      if (configRefusal) {
        return sendJson(res, configRefusal.status, configRefusal.body);
      }
      try {
        const body = await readJson(req);
        const patch: BackupPolicyPatch = {};
        for (const key of POLICY_KEYS) {
          if (key in body) Object.assign(patch, { [key]: body[key] });
        }
        const policy = updateBackupPolicy(plane.db.vault, patch);
        plane.rescheduleWalCapture();
        await deps.backupService?.refreshWalSchedule?.();
        const providerPolicy =
          deps.backupService &&
          typeof deps.backupService.syncPolicy === "function"
            ? await deps.backupService.syncPolicy(vaultId)
            : undefined;
        const response = {
          vaultId,
          policy,
          ...(providerPolicy ? { providerPolicy } : {}),
        };
        if (providerPolicy?.status === "rejected") {
          return sendJson(res, 422, {
            error: "policy_unmet",
            message:
              providerPolicy.error ?? "the provider cannot meet this policy",
            ...response,
          });
        }
        if (providerPolicy?.status === "error") {
          return sendJson(res, 502, {
            error: "provider_policy_sync_failed",
            message:
              providerPolicy.error ?? "provider policy synchronization failed",
            ...response,
          });
        }
        return sendJson(res, 200, response);
      } catch (error) {
        if (error instanceof BackupPolicyError) {
          return sendJson(res, 400, {
            error: "invalid_policy",
            message: error.message,
          });
        }
        return sendError(res, error);
      }
    }

    if (url.pathname.startsWith(BACKUP_VERIFY_BUCKET_PREFIX)) {
      if ((req.method ?? "GET") !== "POST") {
        return sendJson(res, 405, {
          error: "method_not_allowed",
          message: "POST only",
        });
      }
      const vaultId = decodeURIComponent(
        url.pathname.slice(BACKUP_VERIFY_BUCKET_PREFIX.length)
      );
      if (!deps.vaults.get(vaultId)) {
        return sendJson(res, 404, {
          error: "not_found",
          message: "unknown vault",
        });
      }
      const { backupService } = deps;
      if (!backupService) {
        return sendJson(res, 409, {
          error: "not_configured",
          message: "backup and remote CAS inventory are not configured",
        });
      }
      try {
        const reconciliation = await backupService.verifyAgainstBucket(vaultId);
        if (!reconciliation) {
          return sendJson(res, 409, {
            error: "no_backup_target",
            message:
              "run the first backup or configure remote primary storage before verifying",
          });
        }
        return sendJson(res, 200, { vaultId, reconciliation });
      } catch (error) {
        return sendError(res, error);
      }
    }

    if (url.pathname === BACKUP_RUN_PATH) {
      if ((req.method ?? "GET") !== "POST") {
        return sendJson(res, 405, {
          error: "method_not_allowed",
          message: "POST only",
        });
      }
      const { backupService } = deps;
      if (
        !backupService ||
        !(await (backupService.configured?.() ?? { configured: true }))
          .configured
      ) {
        return sendJson(res, 409, {
          error: "not_configured",
          message:
            'backup is not configured — add a "backup" block to the gateway config',
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
      if ((req.method ?? "GET") !== "POST") {
        return sendJson(res, 405, {
          error: "method_not_allowed",
          message: "POST only",
        });
      }
      const { backupService } = deps;
      if (
        !backupService ||
        !(await (backupService.configured?.() ?? { configured: true }))
          .configured
      ) {
        return sendJson(res, 409, {
          error: "not_configured",
          message:
            "backup is not configured — add a provider backup connection",
        });
      }
      if (backupService.isRunning()) {
        return sendJson(res, 202, { accepted: true, alreadyRunning: true });
      }
      void backupService.verifyAll().catch(() => undefined);
      return sendJson(res, 202, { accepted: true });
    }

    if (url.pathname === BACKUP_KIT_PATH) {
      if ((req.method ?? "GET") !== "POST") {
        return sendJson(res, 405, {
          error: "method_not_allowed",
          message: "POST only",
        });
      }
      if (!ownerRequired(req, deps, res)) return true;
      if (!deps.backupService) {
        return sendJson(res, 409, {
          error: "not_configured",
          message: "backup is not configured",
        });
      }
      try {
        const body = await readJson(req);
        if (typeof body.password !== "string" || body.password.length === 0) {
          return sendJson(res, 400, {
            error: "password_required",
            message: "a recovery-kit password is required",
          });
        }
        // Owner-held (#726 P1): a kit carries only the vaults the REQUESTING
        // owner owns — hosting someone else's vault does not entitle you to
        // their recovery material.
        const document = scopeKitToRequestingOwner(
          await deps.backupService.recoveryKitDocument(),
          req,
          deps
        );
        return sendJson(res, 200, wrapRecoveryKit(document, body.password));
      } catch (error) {
        return sendError(res, error);
      }
    }

    if (url.pathname === BACKUP_KIT_CONFIRMED_PATH) {
      if ((req.method ?? "GET") !== "POST") {
        return sendJson(res, 405, {
          error: "method_not_allowed",
          message: "POST only",
        });
      }
      if (!ownerRequired(req, deps, res)) return true;
      const { recoveryKitStore } = deps;
      try {
        const body = await readJson(req);
        if (body.lossConsent !== true) {
          return sendJson(res, 409, {
            error: "loss_consent_required",
            message:
              "confirm that losing this file and password makes backups unrecoverable",
          });
        }
        if (typeof body.password !== "string" || body.password.length === 0) {
          return sendJson(res, 400, { error: "password_required" });
        }
        const document = parseRecoveryKit(body.kit, body.password);
        const fingerprint = recoveryKitFingerprint(document);
        if (recoveryKitStore) {
          const recoveryKit = await recoveryKitStore.verify(fingerprint);
          if (!recoveryKit) {
            return sendJson(res, 409, {
              error: "kit_mismatch",
              message:
                "the selected recovery kit is stale or belongs to another gateway",
            });
          }
          return sendJson(res, 200, { ok: true, ...recoveryKit });
        }
        return sendJson(res, 409, {
          error: "not_configured",
          message:
            'backup is not configured — add a "backup" block to the gateway config',
        });
      } catch (error) {
        return sendError(res, error);
      }
    }

    return false;
  };
}
