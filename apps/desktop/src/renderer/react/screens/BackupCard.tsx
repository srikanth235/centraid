import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import Icon from '../ui/Icon.js';
import { cx } from '../ui/cx.js';
import { formatDuration } from '../shell/routes/gatewayData.js';
import buttonCss from '../ui/Button.module.css';
import controlsCss from '../styles/controls.module.css';
import gwStyles from './GatewayScreen.module.css';
import styles from './BackupCard.module.css';

// Gateway → Overview → Backups: the owner surface over the offsite backup
// engine's HTTP status (`GET /centraid/_gateway/backup`, issue #351's last
// workstream — the `centraid-gateway backup` CLI had status/run but nothing
// surfaced it to the desktop). Not-configured renders an explainer instead
// of an empty panel; configured renders per-vault last-backup/last-verify
// ages and a manual "Back up now" trigger. The seal-key reminder is a
// permanent fixture of the card, not a dismissable toast — losing track of
// the seal key makes every snapshot unrecoverable ciphertext.

export interface BackupVaultStatusDTO {
  vaultId: string;
  name?: string;
  lastBackupAt?: string;
  lastVerifyAt?: string;
  lastError?: string;
  running?: boolean;
}

export interface BackupStatusDTO {
  configured: boolean;
  vaults: BackupVaultStatusDTO[];
}

export interface BackupCardProps {
  /** Live clock (parent ticks it) — drives the humanized ages. */
  now: number;
  loadStatus: () => Promise<BackupStatusDTO>;
  onRunNow: () => Promise<{ accepted: boolean; alreadyRunning?: boolean }>;
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

function SealKeyNudge(): JSX.Element {
  return (
    <div className={styles.sealNudge}>
      <Icon name="Key" size={13} />
      <span>
        Backups are ciphertext without the seal key — export it once with{' '}
        <code>centraid-gateway backup kit</code> (or <code>key export</code>) and store it offline.
      </span>
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

export default function BackupCard({ now, loadStatus, onRunNow }: BackupCardProps): JSX.Element {
  const [status, setStatus] = useState<BackupStatusDTO | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

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

  return (
    <section className={cx(gwStyles.panel, styles.card)}>
      <div className={gwStyles.panelHead}>
        <h2>Backups</h2>
        {status?.configured ? (
          <button
            type="button"
            className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
            disabled={anyRunning}
            onClick={() => void runNow()}
          >
            <span className={styles.runIcon} data-spin={anyRunning || undefined}>
              <Icon name={anyRunning ? 'Loader' : 'Save'} size={13} />
            </span>
            <span>{anyRunning ? 'Backing up…' : 'Back up now'}</span>
          </button>
        ) : null}
      </div>

      <div className={styles.body}>
        {loadError ? (
          <div className={styles.loadError}>Couldn’t reach the gateway: {loadError}</div>
        ) : !status ? (
          <div className={gwStyles.panelEmpty}>Checking backup status…</div>
        ) : !status.configured ? (
          <p className={styles.notConfigured}>
            Backups aren’t set up for this gateway. Add a <code>backup</code> block to the gateway
            config to enable encrypted, offsite snapshots — see the docs site’s Backups chapter.
          </p>
        ) : status.vaults.length === 0 ? (
          <div className={gwStyles.panelEmpty}>No vaults mounted yet.</div>
        ) : (
          <>
            {runError ? <div className={styles.runError}>{runError}</div> : null}
            <div className={styles.vaultList}>
              {status.vaults.map((v) => (
                <VaultRow key={v.vaultId} vault={v} now={now} />
              ))}
            </div>
          </>
        )}
        <SealKeyNudge />
      </div>
    </section>
  );
}
