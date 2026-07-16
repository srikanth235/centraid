import type { JSX } from 'react';
import BackupCard, { type BackupCardProps } from './BackupCard.js';
import StorageCard, { type StorageCardProps } from './StorageCard.js';
import styles from './BackupsScreen.module.css';

// The Backups page — offsite snapshot custody and the remote bytes behind it.
// Split out of the Gateway page's Overview tab: that page answers "is the
// gateway up and healthy right now" (heartbeat, components, logs, alerts,
// paired devices), which is a different question from "are my bytes safe and
// where are they" — different cadence, different reader, different moment.
// Both live under the sidebar's Operations section.
//
// The two cards are unchanged from their Gateway-Overview incarnation; this
// screen only lays them out. Each owns its own fetch + loading/error state,
// so there is deliberately no page-level gate here.

export interface BackupsScreenProps {
  /** Live clock (route ticks it each second) — drives the relative ages. */
  now: number;
  /** Backup card data — `GET/POST _gateway/backup`. */
  loadBackupStatus: BackupCardProps['loadStatus'];
  streamBackupCustody?: BackupCardProps['streamCustody'];
  onRunBackupNow: BackupCardProps['onRunNow'];
  onVerifyBackupNow?: BackupCardProps['onVerifyNow'];
  onUpdateBackupPolicy?: BackupCardProps['onUpdatePolicy'];
  onVerifyBackupBucket?: BackupCardProps['onVerifyBucket'];
  onExportRecoveryKit?: BackupCardProps['onExportRecoveryKit'];
  /** Recovery-kit confirmation gate — `POST _gateway/backup/kit-confirmed`. */
  onConfirmRecoveryKit: BackupCardProps['onConfirmRecoveryKit'];
  /** Storage card data — per-connection usage + per-vault replication status
   *  (issue #367 §D3). */
  loadStorageStatus: StorageCardProps['loadStatus'];
  /** Navigates to Settings → Storage — the card's "Manage" link and empty state. */
  onOpenStorageSettings: StorageCardProps['onOpenSettings'];
}

export default function BackupsScreen(props: BackupsScreenProps): JSX.Element {
  return (
    <div className={styles.grid}>
      {/* Offsite snapshot and byte-custody status (#351/#414). */}
      <BackupCard
        now={props.now}
        loadStatus={props.loadBackupStatus}
        streamCustody={props.streamBackupCustody}
        onRunNow={props.onRunBackupNow}
        onVerifyNow={props.onVerifyBackupNow}
        onUpdatePolicy={props.onUpdateBackupPolicy}
        onVerifyBucket={props.onVerifyBackupBucket}
        onExportRecoveryKit={props.onExportRecoveryKit}
        onConfirmRecoveryKit={props.onConfirmRecoveryKit}
      />

      {/* Remote quota and replication drift (#367 §D3). */}
      <StorageCard
        now={props.now}
        loadStatus={props.loadStorageStatus}
        onOpenSettings={props.onOpenStorageSettings}
      />
    </div>
  );
}
