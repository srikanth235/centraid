import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import Icon from '../ui/Icon.js';
import { cx } from '../ui/cx.js';
import { formatClock, formatDuration } from '../shell/routes/gatewayData.js';
import buttonCss from '../ui/Button.module.css';
import controlsCss from '../styles/controls.module.css';
import gwStyles from './GatewayScreen.module.css';
import styles from './BackupCard.module.css';
import type { UsageInput } from '../../storage-metrics.js';
import type { GatewayHomeDiscoveryDTO } from '../../gateway-client.js';
import { computeStorageMetrics } from './backupMetrics.js';
import BackupHealthMetrics, { ClockLine } from './BackupHealthMetrics.js';
import BackupPolicyPanel, {
  type BackupDestinationDTO,
  type BackupPolicyDTO,
  type BackupPolicyPatchDTO,
} from './BackupPolicyPanel.js';
import BackupInventoryPanel, {
  type BackupReconciliationDTO,
  type ProviderPolicyStatusDTO,
} from './BackupInventoryPanel.js';

// Gateway → Backups: the owner surface over the offsite backup engine. This
// card now renders EXACTLY the five metrics of the §6 contract (issue #436)
// via `BackupHealthMetrics` — Freshness, Recovery window, Privacy, Cost, Exit —
// computed ONCE from `computeStorageMetrics`. Everything that used to sit on
// the primary surface but isn't one of the five (the raw custody clocks, the
// manual back-up/verify triggers, per-vault policy + the provider inventory)
// now lives behind the collapsed "Diagnostics" disclosure. The recovery-kit
// gate stays on the primary surface: it is Privacy/Exit-adjacent and blocking-
// critical — losing the seal key makes every offsite byte unrecoverable.

export interface BackupVaultStatusDTO {
  vaultId: string;
  name?: string;
  lastBackupAt?: string;
  lastVerifyAt?: string;
  lastWalDrainAt?: string;
  lastError?: string;
  running?: boolean;
  /** Required on the v0 wire; optional here so a loading fixture can stay terse. */
  policy?: BackupPolicyDTO;
  destination?: BackupDestinationDTO;
  pendingOffsite?: { count: number; bytes: number };
  providerPolicy?: ProviderPolicyStatusDTO;
  reconciliation?: BackupReconciliationDTO;
}

export interface RecoveryKitStatusDTO {
  /** Epoch SECONDS the operator last confirmed, or `null` if never. */
  confirmedAt: number | null;
}

export interface BackupStatusDTO {
  configured: boolean;
  provider?: string;
  vaults: BackupVaultStatusDTO[];
  /** Optional so a pre-wave-4 fixture / stub still type-checks; treated as
   *  "never confirmed" when absent. */
  recoveryKit?: RecoveryKitStatusDTO;
  /** Provider-declared retention + restore-egress promises (#436 §6) — feeds
   *  the Recovery-window and Exit metrics. Absent ⇒ those degrade to neutral. */
  home?: GatewayHomeDiscoveryDTO;
}

export interface BackupCardProps {
  /** Live clock (parent ticks it) — drives the humanized ages. */
  now: number;
  loadStatus: () => Promise<BackupStatusDTO>;
  /** Aggregate provider-reported usage (the Cost metric's source) — `null`
   *  before the first poll. */
  loadUsage?: () => Promise<UsageInput | null>;
  streamCustody?: (onChange: () => void, signal: AbortSignal) => Promise<void>;
  onRunNow: () => Promise<{ accepted: boolean; alreadyRunning?: boolean }>;
  onVerifyNow?: () => Promise<{ accepted: boolean; alreadyRunning?: boolean }>;
  onUpdatePolicy?: (
    vaultId: string,
    patch: BackupPolicyPatchDTO,
  ) => Promise<{ policy: BackupPolicyDTO }>;
  onVerifyBucket?: (
    vaultId: string,
  ) => Promise<{ vaultId: string; reconciliation: BackupReconciliationDTO }>;
  onExportRecoveryKit?: () => Promise<{ ok: boolean; canceled?: boolean; error?: string }>;
  /** POSTs `_gateway/backup/kit-confirmed` — the recovery-kit gate's confirm button. */
  onConfirmRecoveryKit: () => Promise<{ confirmedAt: number }>;
  /** Navigates to Settings → Storage (the head's "Manage" link). */
  onOpenSettings?: () => void;
}

/** Regular refresh cadence — matches useGatewayHealth's poll order of
 *  magnitude; a manual refresh also fires right after "Back up now". */
const POLL_MS = 10_000;
/** A short follow-up poll after triggering a run — local backups of a
 *  small vault often land well inside this window. */
const FOLLOWUP_MS = 1500;

function ageLabel(iso: string | undefined, now: number): string {
  if (!iso) return 'never';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 'never';
  return `${formatDuration(Math.max(0, now - at))} ago`;
}

function RecoveryKitGate({
  configured,
  recoveryKit,
  onConfirm,
  onExport,
}: {
  configured: boolean;
  recoveryKit: RecoveryKitStatusDTO;
  onConfirm: () => Promise<{ confirmedAt: number }>;
  onExport?: () => Promise<{ ok: boolean; canceled?: boolean; error?: string }>;
}): JSX.Element {
  const [confirmedAt, setConfirmedAt] = useState(recoveryKit.confirmedAt);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The server is the source of truth (a poll can also observe a
  // confirmation made from elsewhere) — resync local state whenever the
  // parent's status refresh lands a new value.
  useEffect(() => setConfirmedAt(recoveryKit.confirmedAt), [recoveryKit.confirmedAt]);

  const confirm = async (): Promise<void> => {
    setConfirming(true);
    setError(null);
    try {
      if (onExport) {
        const exported = await onExport();
        if (!exported.ok) {
          if (exported.canceled) return;
          throw new Error(exported.error ?? 'Recovery kit export failed');
        }
      }
      const result = await onConfirm();
      setConfirmedAt(result.confirmedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirming(false);
    }
  };

  if (confirmedAt != null) {
    return (
      <div className={styles.sealConfirmed} data-testid="recovery-kit-confirmed">
        <Icon name="CheckCircle" size={13} />
        <span>Recovery kit confirmed {formatClock(confirmedAt * 1000)}</span>
      </div>
    );
  }

  return (
    <div className={styles.sealNudge} data-testid="recovery-kit-gate">
      <Icon name="Key" size={13} />
      <div className={styles.sealNudgeBody}>
        <span>
          Save this recovery kit somewhere offline. It is the only way to decrypt a backup on a new
          machine.
        </span>
        {configured ? (
          <>
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft, styles.sealConfirmBtn)}
              disabled={confirming}
              onClick={() => void confirm()}
            >
              {confirming
                ? 'Exporting…'
                : onExport
                  ? 'Export recovery kit'
                  : "I've saved my recovery kit"}
            </button>
            {error ? <div className={styles.runError}>{error}</div> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

const DEFAULT_POLICY: BackupPolicyDTO = {
  rpoSeconds: 60,
  snapshotIntervalHours: 24,
  verifyEveryDays: 7,
  outboxBudgetBytes: 512 * 1024 ** 2,
  reservedHeadroomBytes: 256 * 1024 ** 2,
  walBaseRollBytes: 16 * 1024 ** 2,
  walBaseRollHours: 24,
};

/** One diagnostic custody clock as a plain labelled age. */
function VaultRow({
  vault,
  now,
  provider,
  onUpdatePolicy,
  onVerifyBucket,
}: {
  vault: BackupVaultStatusDTO;
  now: number;
  provider?: string;
  onUpdatePolicy?: BackupCardProps['onUpdatePolicy'];
  onVerifyBucket?: BackupCardProps['onVerifyBucket'];
}): JSX.Element {
  const neverBackedUp = !vault.lastBackupAt;
  const destination = vault.destination ?? { kind: 'gateway-local' as const };
  const hasRemoteInventory =
    destination.kind !== 'gateway-local' ||
    provider !== undefined ||
    vault.providerPolicy !== undefined ||
    vault.reconciliation !== undefined;
  return (
    <div className={styles.vaultRow} data-testid="backup-vault-row">
      <div className={styles.vaultHead}>
        <span className={styles.vaultName}>{vault.name ?? vault.vaultId}</span>
        {vault.running ? <span className={styles.runningBadge}>backing up…</span> : null}
      </div>
      <div className={styles.vaultMeta}>
        <span data-emphasis={neverBackedUp ? 'warn' : undefined}>
          backed up {ageLabel(vault.lastBackupAt, now)}
        </span>
        <span>verified {ageLabel(vault.lastVerifyAt, now)}</span>
      </div>
      {vault.lastError ? <div className={styles.vaultError}>{vault.lastError}</div> : null}
      <BackupPolicyPanel
        vaultId={vault.vaultId}
        now={now}
        policy={vault.policy ?? DEFAULT_POLICY}
        destination={destination}
        snapshotProvider={provider}
        pendingOffsite={vault.pendingOffsite ?? { count: 0, bytes: 0 }}
        lastWalDrainAt={vault.lastWalDrainAt}
        onUpdate={onUpdatePolicy}
      />
      {hasRemoteInventory ? (
        <BackupInventoryPanel
          vaultId={vault.vaultId}
          now={now}
          providerPolicy={vault.providerPolicy}
          reconciliation={vault.reconciliation}
          onVerifyBucket={onVerifyBucket}
        />
      ) : null}
    </div>
  );
}

export default function BackupCard({
  now,
  loadStatus,
  loadUsage,
  streamCustody,
  onRunNow,
  onVerifyNow,
  onUpdatePolicy,
  onVerifyBucket,
  onExportRecoveryKit,
  onConfirmRecoveryKit,
  onOpenSettings,
}: BackupCardProps): JSX.Element {
  const [status, setStatus] = useState<BackupStatusDTO | null>(null);
  const [usage, setUsage] = useState<UsageInput | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  // Guards the two async setState paths (the interval poll and the
  // post-run follow-up) against firing after unmount — the follow-up in
  // particular is a bare `setTimeout` outside the effect below, so it
  // needs its own cleanup rather than relying on an effect's teardown.
  const mountedRef = useRef(true);
  const followupTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback((): void => {
    loadStatus()
      .then((s) => {
        if (!mountedRef.current) return;
        setStatus(s);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    if (loadUsage) {
      loadUsage()
        .then((u) => {
          if (mountedRef.current) setUsage(u);
        })
        .catch(() => {
          // Usage is best-effort — the Cost metric falls back to unmetered/zero.
        });
    }
  }, [loadStatus, loadUsage]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
      if (followupTimerRef.current !== undefined) clearTimeout(followupTimerRef.current);
    };
  }, [refresh]);

  useEffect(() => {
    if (!streamCustody) return;
    const controller = new AbortController();
    void streamCustody(refresh, controller.signal).catch(() => {
      // The regular poll remains the transport-independent fallback.
    });
    return () => controller.abort();
  }, [refresh, streamCustody]);

  const runNow = async (): Promise<void> => {
    setTriggering(true);
    setRunError(null);
    try {
      await onRunNow();
      refresh();
      followupTimerRef.current = setTimeout(refresh, FOLLOWUP_MS);
    } catch (err) {
      if (mountedRef.current) setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setTriggering(false);
    }
  };

  const anyRunning = triggering || (status?.vaults.some((v) => v.running) ?? false);

  const verifyNow = async (): Promise<void> => {
    if (!onVerifyNow) return;
    setVerifying(true);
    setRunError(null);
    try {
      await onVerifyNow();
      refresh();
      followupTimerRef.current = setTimeout(refresh, FOLLOWUP_MS);
    } catch (err) {
      if (mountedRef.current) setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setVerifying(false);
    }
  };

  const metrics = useMemo(
    () => (status ? computeStorageMetrics(status, usage, now) : null),
    [status, usage, now],
  );

  const hasBackups =
    (status?.configured ?? false) || (status?.vaults.some((v) => v.lastBackupAt) ?? false);
  const clocks = metrics?.freshness.clocks;

  return (
    <section className={cx(gwStyles.panel, styles.card)}>
      <div className={gwStyles.panelHead}>
        <h2>Backups</h2>
        <div className={styles.headMeta}>
          {status?.provider ? (
            <div className={styles.providerLine}>
              <Icon name="Key" size={13} />
              <span>Protected by {status.provider}</span>
            </div>
          ) : null}
          {onOpenSettings ? (
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
              onClick={onOpenSettings}
            >
              <Icon name="Settings" size={13} />
              <span>Manage</span>
            </button>
          ) : null}
        </div>
      </div>

      <div className={styles.body}>
        {loadError ? (
          <div className={styles.loadError}>Couldn’t reach the gateway: {loadError}</div>
        ) : !status || !metrics ? (
          <div className={gwStyles.panelEmpty}>Checking backup status…</div>
        ) : !hasBackups ? (
          <>
            <p className={styles.notConfigured}>
              Your data isn’t backed up offsite yet. In Settings → Storage, connect your storage
              provider and set this vault to Hosted. Until then, databases, code, and attachments
              live only on this machine.
            </p>
            <RecoveryKitGate
              configured={status.configured}
              recoveryKit={status.recoveryKit ?? { confirmedAt: null }}
              onConfirm={onConfirmRecoveryKit}
              onExport={onExportRecoveryKit}
            />
          </>
        ) : (
          <>
            <BackupHealthMetrics metrics={metrics} now={now} />

            <RecoveryKitGate
              configured={status.configured}
              recoveryKit={status.recoveryKit ?? { confirmedAt: null }}
              onConfirm={onConfirmRecoveryKit}
              onExport={onExportRecoveryKit}
            />

            <details className={styles.diagnostics} data-testid="backup-diagnostics">
              <summary>Diagnostics</summary>
              <div className={styles.diagnosticsBody}>
                <div className={styles.actions}>
                  {onVerifyNow ? (
                    <button
                      type="button"
                      className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
                      disabled={anyRunning || verifying}
                      onClick={() => void verifyNow()}
                    >
                      <Icon name="CheckCircle" size={13} />
                      <span>{verifying ? 'Verifying…' : 'Verify now'}</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
                    disabled={anyRunning || verifying}
                    onClick={() => void runNow()}
                  >
                    <span className={styles.runIcon} data-spin={anyRunning || undefined}>
                      <Icon name={anyRunning ? 'Loader' : 'Save'} size={13} />
                    </span>
                    <span>{anyRunning ? 'Backing up…' : 'Back up now'}</span>
                  </button>
                </div>
                {runError ? <div className={styles.runError}>{runError}</div> : null}

                {clocks ? (
                  <div className={styles.clockGrid} data-testid="freshness-clocks">
                    <ClockLine
                      label="Newest snapshot"
                      at={clocks.lastRegisteredSnapshotAt}
                      now={now}
                    />
                    <ClockLine
                      label="Last verification"
                      at={clocks.lastSuccessfulVerificationAt}
                      now={now}
                    />
                    <ClockLine
                      label="Newest WAL segment"
                      at={clocks.lastAckedWalSegmentAt}
                      now={now}
                    />
                    <ClockLine
                      label="Outbox drained"
                      at={clocks.outboxDrainedWatermarkAt}
                      now={now}
                    />
                  </div>
                ) : null}

                {status.vaults.length > 0 ? (
                  <div className={styles.vaultList}>
                    {status.vaults.map((v) => (
                      <VaultRow
                        key={v.vaultId}
                        vault={v}
                        now={now}
                        provider={status.provider}
                        onUpdatePolicy={onUpdatePolicy}
                        onVerifyBucket={onVerifyBucket}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            </details>
          </>
        )}
      </div>
    </section>
  );
}
