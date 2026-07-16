import { useEffect, useState, type JSX } from 'react';
import { formatBytes } from '../../format.js';
import { formatDuration } from '../shell/routes/gatewayData.js';
import styles from './BackupCard.module.css';

export interface BackupPolicyDTO {
  rpoSeconds: number;
  snapshotIntervalHours: number;
  verifyEveryDays: number;
  casAck: 'receipt' | 'replicated';
  outboxBudgetBytes: number;
  reservedHeadroomBytes: number;
  cacheBudgetBytes?: number;
  throttleBytesPerSec?: number;
  storageClass?: string;
  walBaseRollBytes: number;
  walBaseRollHours: number;
}

export type BackupPolicyPatchDTO = {
  [K in keyof BackupPolicyDTO]?: BackupPolicyDTO[K] | null;
};

export interface BackupDestinationDTO {
  kind: 'gateway-local' | 'own-s3' | 'provider';
  connectionId?: string;
}

export interface BackupPolicyPanelProps {
  vaultId: string;
  now: number;
  policy: BackupPolicyDTO;
  destination: BackupDestinationDTO;
  snapshotProvider?: string;
  pendingOffsite: { count: number; bytes: number };
  lastWalDrainAt?: string;
  onUpdate?: (vaultId: string, patch: BackupPolicyPatchDTO) => Promise<{ policy: BackupPolicyDTO }>;
}

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

function SelectSetting({
  label,
  hint,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  options: readonly { value: string; label: string }[];
  disabled: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label className={styles.policySetting}>
      <span>
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </span>
      <select
        className={styles.policySelect}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function destinationLabel(destination: BackupDestinationDTO): string {
  if (destination.kind === 'provider') return 'Storage provider';
  if (destination.kind === 'own-s3') return 'Your S3-compatible store';
  return 'This machine only';
}

function relativeAge(iso: string | undefined, now: number): string {
  if (!iso) return 'Not drained yet';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 'Not drained yet';
  return `Drained ${formatDuration(Math.max(0, now - at))} ago`;
}

export default function BackupPolicyPanel({
  vaultId,
  now,
  policy,
  destination,
  snapshotProvider,
  pendingOffsite,
  lastWalDrainAt,
  onUpdate,
}: BackupPolicyPanelProps): JSX.Element {
  const [current, setCurrent] = useState(policy);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => setCurrent(policy), [policy]);

  const update = async (patch: BackupPolicyPatchDTO): Promise<void> => {
    if (!onUpdate) return;
    setSaving(true);
    setMessage(null);
    try {
      const result = await onUpdate(vaultId, patch);
      setCurrent(result.policy);
      setMessage('Policy saved');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const remote = destination.kind !== 'gateway-local';
  return (
    <div className={styles.policyPanel} data-testid="backup-policy-panel">
      <section className={styles.policyGroup}>
        <h4>Where do backups go?</h4>
        <dl className={styles.destinationGrid}>
          <div>
            <dt>Databases &amp; code</dt>
            <dd>{snapshotProvider ? `Provider · ${snapshotProvider}` : 'This machine only'}</dd>
          </div>
          <div>
            <dt>Attachments</dt>
            <dd>{destinationLabel(destination)}</dd>
          </div>
        </dl>
        {!remote ? (
          <p className={styles.localWarning}>
            Attachments have no offsite copy until a snapshot reaches remote storage.
          </p>
        ) : null}
      </section>

      <section className={styles.policyGroup}>
        <h4>How much could you lose?</h4>
        <SelectSetting
          label="Recovery point"
          hint={`${relativeAge(lastWalDrainAt, now)} · alarm after 2× this window`}
          value={String(current.rpoSeconds)}
          disabled={saving || !onUpdate}
          options={[
            { value: '60', label: '1 minute' },
            { value: '900', label: '15 minutes' },
            { value: '3600', label: '1 hour' },
          ]}
          onChange={(value) => void update({ rpoSeconds: Number(value) })}
        />
      </section>

      <section className={styles.policyGroup}>
        <h4>Attachments</h4>
        <div
          className={styles.pendingLine}
          data-state={pendingOffsite.count > 0 ? 'pending' : 'ok'}
        >
          <span className={styles.pendingDot} />
          {pendingOffsite.count > 0
            ? `${pendingOffsite.count} pending · ${formatBytes(pendingOffsite.bytes)} waiting offsite`
            : remote
              ? 'All received attachment bytes are offsite'
              : 'Stored on this machine'}
        </div>
        {remote ? (
          <SelectSetting
            label="Confirm an attachment"
            value={current.casAck}
            disabled={saving || !onUpdate}
            options={[
              { value: 'receipt', label: 'When received' },
              { value: 'replicated', label: 'When offsite' },
            ]}
            onChange={(value) => void update({ casAck: value as BackupPolicyDTO['casAck'] })}
          />
        ) : null}
      </section>

      <section className={styles.policyGroup}>
        <h4>Snapshots &amp; proof</h4>
        <SelectSetting
          label="Snapshot"
          value={String(current.snapshotIntervalHours)}
          disabled={saving || !onUpdate}
          options={[
            { value: '24', label: 'Daily' },
            { value: '168', label: 'Weekly' },
          ]}
          onChange={(value) => void update({ snapshotIntervalHours: Number(value) })}
        />
        <SelectSetting
          label="Prove restores work"
          value={String(current.verifyEveryDays)}
          disabled={saving || !onUpdate}
          options={[
            { value: '7', label: 'Weekly' },
            { value: '30', label: 'Monthly' },
          ]}
          onChange={(value) => void update({ verifyEveryDays: Number(value) })}
        />
      </section>

      <details className={styles.advancedPolicy}>
        <summary>Advanced</summary>
        <div className={styles.advancedGrid}>
          <SelectSetting
            label="Bandwidth cap"
            value={String(current.throttleBytesPerSec ?? 0)}
            disabled={saving || !onUpdate}
            options={[
              { value: '0', label: 'No cap' },
              { value: String(MIB), label: '1 MB/s' },
              { value: String(5 * MIB), label: '5 MB/s' },
              { value: String(20 * MIB), label: '20 MB/s' },
            ]}
            onChange={(value) =>
              void update({ throttleBytesPerSec: value === '0' ? null : Number(value) })
            }
          />
          <SelectSetting
            label="Storage class"
            value={current.storageClass ?? ''}
            disabled={saving || !onUpdate}
            options={[
              { value: '', label: 'Provider default' },
              { value: 'STANDARD', label: 'Standard' },
              { value: 'INTELLIGENT_TIERING', label: 'Intelligent tiering' },
              { value: 'STANDARD_IA', label: 'Infrequent access' },
            ]}
            onChange={(value) => void update({ storageClass: value || null })}
          />
          <SelectSetting
            label="Cache budget"
            value={String(current.cacheBudgetBytes ?? 0)}
            disabled={saving || !onUpdate}
            options={[
              { value: '0', label: 'Automatic' },
              { value: String(GIB), label: '1 GB' },
              { value: String(5 * GIB), label: '5 GB' },
              { value: String(20 * GIB), label: '20 GB' },
            ]}
            onChange={(value) =>
              void update({ cacheBudgetBytes: value === '0' ? null : Number(value) })
            }
          />
          <SelectSetting
            label="Outbox budget"
            value={String(current.outboxBudgetBytes)}
            disabled={saving || !onUpdate}
            options={[
              { value: String(128 * MIB), label: '128 MB' },
              { value: String(512 * MIB), label: '512 MB' },
              { value: String(2 * GIB), label: '2 GB' },
            ]}
            onChange={(value) => void update({ outboxBudgetBytes: Number(value) })}
          />
          <SelectSetting
            label="Reserved headroom"
            value={String(current.reservedHeadroomBytes)}
            disabled={saving || !onUpdate}
            options={[
              { value: String(128 * MIB), label: '128 MB' },
              { value: String(256 * MIB), label: '256 MB' },
              { value: String(GIB), label: '1 GB' },
            ]}
            onChange={(value) => void update({ reservedHeadroomBytes: Number(value) })}
          />
          <SelectSetting
            label="WAL base roll"
            value={String(current.walBaseRollBytes)}
            disabled={saving || !onUpdate}
            options={[
              { value: String(8 * MIB), label: '8 MB' },
              { value: String(16 * MIB), label: '16 MB' },
              { value: String(64 * MIB), label: '64 MB' },
            ]}
            onChange={(value) => void update({ walBaseRollBytes: Number(value) })}
          />
          <SelectSetting
            label="WAL base interval"
            value={String(current.walBaseRollHours)}
            disabled={saving || !onUpdate}
            options={[
              { value: '12', label: '12 hours' },
              { value: '24', label: '24 hours' },
              { value: '48', label: '48 hours' },
            ]}
            onChange={(value) => void update({ walBaseRollHours: Number(value) })}
          />
        </div>
      </details>
      {message ? (
        <div
          className={styles.policyMessage}
          data-error={message === 'Policy saved' ? undefined : ''}
        >
          {message}
        </div>
      ) : null}
    </div>
  );
}
