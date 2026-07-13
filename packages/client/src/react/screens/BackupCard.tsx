import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import Icon from '../ui/Icon.js';
import { cx } from '../ui/cx.js';
import { formatClock, formatDuration } from '../shell/routes/gatewayData.js';
import buttonCss from '../ui/Button.module.css';
import controlsCss from '../styles/controls.module.css';
import gwStyles from './GatewayScreen.module.css';
import styles from './BackupCard.module.css';

// Gateway → Overview → Backups: the owner surface over the offsite backup
// engine's HTTP status (`GET /centraid/_gateway/backup`, issue #351's last
// workstream — the `centraid-gateway backup` CLI had status/run but nothing
// surfaced it to the desktop). Not-configured renders an explainer instead
// of an empty panel; configured renders per-vault last-backup/last-verify
// ages and a manual "Back up now" trigger.
//
// The recovery-kit reminder (wave 4 of #351) is a permanent fixture of the
// card, not a dismissable toast — losing track of the seal key makes every
// snapshot unrecoverable ciphertext. It's now a real gate, not just a
// nudge: unconfirmed renders a prominent call-to-action with a confirm
// button that POSTs `_gateway/backup/kit-confirmed`; confirmed renders a
// quiet one-line state with the date. The flag itself is generic (issue
// #367 reuses it to gate the S3-storage enable flow), so this card is just
// its first consumer, not its owner.

export interface BackupVaultStatusDTO {
  vaultId: string;
  name?: string;
  lastBackupAt?: string;
  lastVerifyAt?: string;
  lastError?: string;
  running?: boolean;
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
}

export interface BackupCardProps {
  /** Live clock (parent ticks it) — drives the humanized ages. */
  now: number;
  loadStatus: () => Promise<BackupStatusDTO>;
  onRunNow: () => Promise<{ accepted: boolean; alreadyRunning?: boolean }>;
  onVerifyNow?: () => Promise<{ accepted: boolean; alreadyRunning?: boolean }>;
  onExportRecoveryKit?: () => Promise<{ ok: boolean; canceled?: boolean; error?: string }>;
  /** POSTs `_gateway/backup/kit-confirmed` — the recovery-kit gate's confirm button. */
  onConfirmRecoveryKit: () => Promise<{ confirmedAt: number }>;
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

function VaultRow({ vault, now }: { vault: BackupVaultStatusDTO; now: number }): JSX.Element {
  const neverBackedUp = !vault.lastBackupAt;
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
    </div>
  );
}

export default function BackupCard({
  now,
  loadStatus,
  onRunNow,
  onVerifyNow,
  onExportRecoveryKit,
  onConfirmRecoveryKit,
}: BackupCardProps): JSX.Element {
  const [status, setStatus] = useState<BackupStatusDTO | null>(null);
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
  }, [loadStatus]);

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

  return (
    <section className={cx(gwStyles.panel, styles.card)}>
      <div className={gwStyles.panelHead}>
        <h2>Backups</h2>
        {status?.configured ? (
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
        ) : null}
      </div>

      <div className={styles.body}>
        {loadError ? (
          <div className={styles.loadError}>Couldn’t reach the gateway: {loadError}</div>
        ) : !status ? (
          <div className={gwStyles.panelEmpty}>Checking backup status…</div>
        ) : !status.configured ? (
          <p className={styles.notConfigured}>
            Backups aren’t set up yet. In Settings → Storage, add a storage provider and enable
            “Encrypted backup snapshots.” The desktop will start protecting every vault
            automatically.
          </p>
        ) : status.vaults.length === 0 ? (
          <div className={gwStyles.panelEmpty}>No vaults mounted yet.</div>
        ) : (
          <>
            {status.provider ? (
              <div className={styles.providerLine}>
                <Icon name="Key" size={13} />
                <span>Protected by {status.provider}</span>
              </div>
            ) : null}
            {runError ? <div className={styles.runError}>{runError}</div> : null}
            <div className={styles.vaultList}>
              {status.vaults.map((v) => (
                <VaultRow key={v.vaultId} vault={v} now={now} />
              ))}
            </div>
          </>
        )}
        <RecoveryKitGate
          configured={status?.configured ?? false}
          recoveryKit={status?.recoveryKit ?? { confirmedAt: null }}
          onConfirm={onConfirmRecoveryKit}
          onExport={onExportRecoveryKit}
        />
      </div>
    </section>
  );
}
