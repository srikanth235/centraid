import { useCallback, useEffect, useRef, useState, type JSX } from 'react';

import type {
  LocalUsageReportDTO,
  StorageLimitsDTO,
  StorageLimitsPatchDTO,
} from '../../gateway-client-local-storage.js';
import BackupCard, { type BackupCardProps } from './BackupCard.js';
import LocalFootprintCard from './LocalFootprintCard.js';
import StorageLimitsPanel from './StorageLimitsPanel.js';

import styles from './StorageScreen.module.css';

// The Storage page (issue #544 — this was Backups). It answers the storage
// question in the order an owner actually asks it:
//
//   1. What is Centraid using on this machine, and where did it go?
//   2. What ceiling have I put on that, and what happens when I hit it?
//   3. Is any of it safe if this machine dies?
//
// Backups used to be the whole page and is now the third card — not a
// demotion: it is the answer to the last question, and putting it after the
// local footprint is what makes the page a story rather than a dashboard. The
// backup card itself is unchanged, still rendering the §6 five-metric
// contract (issue #436): Freshness, Recovery window, Privacy, Cost, Exit.
//
// Each card owns its own fetch and its own loading/error state, so a gateway
// that can answer one and not the others renders partially rather than
// blanking — the same reasoning the old Backups route documented for skipping
// the runtime-snapshot gate.

export interface StorageScreenProps {
  /** Live clock (route ticks it) — drives the backup card's relative ages. */
  now: number;
  /** `GET _gateway/storage/local` — the footprint card's source. */
  loadLocalUsage: (opts?: { refresh?: boolean }) => Promise<LocalUsageReportDTO>;
  /** `PUT _gateway/storage/limits`. */
  saveStorageLimits: (patch: StorageLimitsPatchDTO) => Promise<StorageLimitsDTO>;
  /** Backup card data — `GET/POST _gateway/backup`. */
  loadBackupStatus: BackupCardProps['loadStatus'];
  /** Aggregate provider usage — the Cost metric's source. */
  loadStorageUsage?: BackupCardProps['loadUsage'];
  streamBackupCustody?: BackupCardProps['streamCustody'];
  onRunBackupNow: BackupCardProps['onRunNow'];
  onVerifyBackupNow?: BackupCardProps['onVerifyNow'];
  onUpdateBackupPolicy?: BackupCardProps['onUpdatePolicy'];
  onVerifyBackupBucket?: BackupCardProps['onVerifyBucket'];
  onExportRecoveryKit?: BackupCardProps['onExportRecoveryKit'];
  /** Recovery-kit confirmation gate — `POST _gateway/backup/kit-confirmed`. */
  onConfirmRecoveryKit: BackupCardProps['onConfirmRecoveryKit'];
  /** Navigates to Settings → Storage provider — the card's "Manage" link. */
  onOpenStorageSettings: BackupCardProps['onOpenSettings'];
}

/** Footprint refresh cadence. Deliberately slower than the backup card's 10s:
 *  these figures come from a directory walk on the gateway, and disk usage
 *  does not move on a ten-second timescale. The gateway's TTL cache makes an
 *  over-eager poll cheap, but there is no reason to make one. */
const FOOTPRINT_POLL_MS = 60_000;

export default function StorageScreen(props: StorageScreenProps): JSX.Element {
  const { loadLocalUsage, saveStorageLimits } = props;
  const [report, setReport] = useState<LocalUsageReportDTO | null>(null);
  const [limits, setLimits] = useState<StorageLimitsDTO | null>(null);
  const [footprintError, setFootprintError] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const mountedRef = useRef(true);

  // The local report carries the limits with it, so ONE fetch keeps the
  // footprint card and the limits panel in agreement — a limit shown beside a
  // total it wasn't evaluated against is worse than no limit shown.
  const refresh = useCallback(
    async (opts: { refresh?: boolean } = {}): Promise<void> => {
      try {
        const next = await loadLocalUsage(opts);
        if (!mountedRef.current) return;
        setReport(next);
        setLimits(next.limits);
        setFootprintError(null);
      } catch (err) {
        if (!mountedRef.current) return;
        setFootprintError(err instanceof Error ? err.message : String(err));
      }
    },
    [loadLocalUsage],
  );

  useEffect(() => {
    mountedRef.current = true;
    const initialRefresh = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), FOOTPRINT_POLL_MS);
    return () => {
      mountedRef.current = false;
      clearTimeout(initialRefresh);
      clearInterval(timer);
    };
  }, [refresh]);

  const onRescan = (): void => {
    setRescanning(true);
    void refresh({ refresh: true }).finally(() => {
      if (mountedRef.current) setRescanning(false);
    });
  };

  const onSaveLimits = async (patch: StorageLimitsPatchDTO): Promise<void> => {
    const next = await saveStorageLimits(patch);
    if (mountedRef.current) setLimits(next);
    // Re-read rather than patching the cached report locally: the limit
    // EVALUATION (ok / degraded / error) is the gateway's call, not ours.
    await refresh();
  };

  return (
    <div className={styles.grid}>
      <LocalFootprintCard
        report={report}
        loadError={footprintError}
        onRescan={onRescan}
        rescanning={rescanning}
      />

      <StorageLimitsPanel limits={limits} report={report} onSave={onSaveLimits} />

      <BackupCard
        now={props.now}
        loadStatus={props.loadBackupStatus}
        loadUsage={props.loadStorageUsage}
        streamCustody={props.streamBackupCustody}
        onRunNow={props.onRunBackupNow}
        onVerifyNow={props.onVerifyBackupNow}
        onUpdatePolicy={props.onUpdateBackupPolicy}
        onVerifyBucket={props.onVerifyBackupBucket}
        onExportRecoveryKit={props.onExportRecoveryKit}
        onConfirmRecoveryKit={props.onConfirmRecoveryKit}
        onOpenSettings={props.onOpenStorageSettings}
      />
    </div>
  );
}
