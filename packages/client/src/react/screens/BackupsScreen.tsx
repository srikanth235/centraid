import type { JSX } from 'react';
import BackupCard, { type BackupCardProps } from './BackupCard.js';
import styles from './BackupsScreen.module.css';

// The Backups page — your data's safety told in the §6 five-metric contract
// (issue #436): Freshness, Recovery window, Privacy, Cost, and Exit, all on the
// one BackupCard. Split out of the Gateway page's Overview tab: that page
// answers "is the gateway up right now"; this one answers "is my data safe, and
// on my terms". The separate Storage card is gone — its per-store quota bars
// and drift lines were store-class vocabulary the collapse cut; Cost now lives
// inside the five-metric surface.

export interface BackupsScreenProps {
  /** Live clock (route ticks it each second) — drives the relative ages. */
  now: number;
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
  /** Navigates to Settings → Storage — the card's "Manage" link. */
  onOpenStorageSettings: BackupCardProps['onOpenSettings'];
}

export default function BackupsScreen(props: BackupsScreenProps): JSX.Element {
  return (
    <div className={styles.grid}>
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
