import { useEffect, useState, type JSX } from 'react';
import { formatBytes } from '../../format.js';
import { formatDuration } from '../shell/routes/gatewayData.js';
import buttonCss from '../ui/Button.module.css';
import controlsCss from '../styles/controls.module.css';
import { cx } from '../ui/cx.js';
import styles from './BackupCard.module.css';

export interface InventoryDriftDTO {
  count: number;
  sample: string[];
}

export interface StoreInventoryDTO {
  configured: boolean;
  source: 'provider' | 'bucket' | 'not-configured' | 'unavailable';
  providerAttested: boolean;
  objectCount: number;
  bytes: number;
  softDeletedCount: number;
  missing: InventoryDriftDTO;
  orphans: InventoryDriftDTO;
  attestationDrift?: {
    providerOnly: InventoryDriftDTO;
    bucketOnly: InventoryDriftDTO;
    metadataMismatch: InventoryDriftDTO;
  };
  attestationError?: string;
  error?: string;
}

export interface BackupReconciliationDTO {
  checkedAt: string;
  mode: 'scheduled' | 'bucket';
  status: 'ok' | 'degraded' | 'error';
  backup: StoreInventoryDTO;
  cas: StoreInventoryDTO;
  walGaps: InventoryDriftDTO;
  snapshots: {
    live: number;
    pruned: number;
    recent: Array<{
      seq: number;
      totalBytes: number;
      objectCount: number;
      createdAt: number;
      prunedAt: number | null;
      format: string;
    }>;
  };
  walCoverage: {
    earliestTickMs: number | null;
    latestTickMs: number | null;
    spanDays: number | null;
    segmentCount: number;
    markerCount: number;
  };
  audit: {
    source: 'provider' | 'unavailable';
    eventCount: number;
    recent: Array<{ at: number; kind: string; detail: Record<string, unknown> }>;
    error?: string;
  };
}

export interface ProviderPolicyStatusDTO {
  status: 'pending' | 'synced' | 'drift' | 'rejected' | 'unsupported' | 'error';
  checkedAt: string;
  error?: string;
  errorCode?: string;
}

export interface BackupInventoryPanelProps {
  vaultId: string;
  now: number;
  providerPolicy?: ProviderPolicyStatusDTO;
  reconciliation?: BackupReconciliationDTO;
  onVerifyBucket?: (
    vaultId: string,
  ) => Promise<{ vaultId: string; reconciliation: BackupReconciliationDTO }>;
}

function age(iso: string, now: number): string {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 'unknown' : `${formatDuration(Math.max(0, now - value))} ago`;
}

function epochLabel(value: string | number): string {
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isNaN(date.valueOf())
    ? 'unknown date'
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function sourceLabel(store: StoreInventoryDTO): string {
  if (store.providerAttested) return 'Provider-attested';
  if (store.source === 'bucket') return 'Computed from bucket listing';
  if (!store.configured) return 'Not configured';
  return 'Inventory unavailable';
}

function StoreLine({ label, store }: { label: string; store: StoreInventoryDTO }): JSX.Element {
  const attestationMismatch = store.attestationDrift?.metadataMismatch.count ?? 0;
  const drift = store.missing.count + store.orphans.count + attestationMismatch;
  return (
    <div
      className={styles.inventoryStore}
      data-state={store.missing.count > 0 ? 'error' : undefined}
    >
      <div>
        <strong>{label}</strong>
        <small>{sourceLabel(store)}</small>
      </div>
      <span>
        {store.objectCount.toLocaleString()} objects · {formatBytes(store.bytes)}
      </span>
      {drift > 0 ? (
        <em>
          {store.missing.count > 0 ? `${store.missing.count} missing` : ''}
          {store.missing.count > 0 && store.orphans.count > 0 ? ' · ' : ''}
          {store.orphans.count > 0 ? `${store.orphans.count} orphaned` : ''}
          {(store.missing.count > 0 || store.orphans.count > 0) && attestationMismatch > 0
            ? ' · '
            : ''}
          {attestationMismatch > 0 ? `${attestationMismatch} byte metadata mismatches` : ''}
        </em>
      ) : null}
    </div>
  );
}

function detailText(detail: Record<string, unknown>): string {
  const rung = typeof detail.retentionRung === 'string' ? detail.retentionRung : undefined;
  const key = typeof detail.key === 'string' ? detail.key : undefined;
  if (rung && key) return `${rung} · ${key}`;
  if (rung) return `Retention rung: ${rung}`;
  if (key) return key;
  return 'Provider lifecycle event';
}

export default function BackupInventoryPanel({
  vaultId,
  now,
  providerPolicy,
  reconciliation,
  onVerifyBucket,
}: BackupInventoryPanelProps): JSX.Element {
  const [current, setCurrent] = useState(reconciliation);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setCurrent(reconciliation), [reconciliation]);

  const verify = async (): Promise<void> => {
    if (!onVerifyBucket) return;
    setVerifying(true);
    setError(null);
    try {
      setCurrent((await onVerifyBucket(vaultId)).reconciliation);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setVerifying(false);
    }
  };

  const policyProblem =
    providerPolicy && !['synced', 'unsupported'].includes(providerPolicy.status)
      ? providerPolicy
      : undefined;
  const pruneEvents =
    current?.audit.recent.filter((event) => event.kind === 'prune').slice(-3) ?? [];
  const recentSnapshots = current?.snapshots.recent.slice(0, 3) ?? [];

  return (
    <section className={styles.policyGroup} data-testid="backup-inventory-panel">
      <div className={styles.inventoryHead}>
        <div>
          <h4>What does your provider hold?</h4>
          {current ? (
            <small>
              Reconciled {age(current.checkedAt, now)} ·{' '}
              {current.mode === 'bucket' ? 'raw bucket check' : 'scheduled audit'}
            </small>
          ) : null}
        </div>
        {current ? <span data-state={current.status}>{current.status}</span> : null}
      </div>

      {policyProblem ? (
        <p className={styles.inventoryWarning}>
          Provider policy {policyProblem.status}:{' '}
          {policyProblem.error ?? 'the provider echo differs from this vault'}
        </p>
      ) : null}

      {!current ? (
        <p className={styles.inventoryEmpty}>
          Awaiting the first provider inventory audit. Attachment safety remains pinned until the
          remote is verified.
        </p>
      ) : (
        <>
          <div className={styles.inventoryStores}>
            <StoreLine label="Databases, code & WAL" store={current.backup} />
            <StoreLine label="Attachments" store={current.cas} />
          </div>

          <dl className={styles.inventoryFacts}>
            <div>
              <dt>Snapshots</dt>
              <dd>
                {current.snapshots.live} live · {current.snapshots.pruned} pruned
              </dd>
            </div>
            <div>
              <dt>Point-in-time recovery</dt>
              <dd>
                {current.walCoverage.spanDays !== null
                  ? `${current.walCoverage.spanDays.toFixed(1)} days · ${current.walCoverage.segmentCount} segments`
                  : current.walGaps.count > 0
                    ? `${current.walGaps.count} chain gaps`
                    : 'Chain is complete'}
              </dd>
            </div>
            <div>
              <dt>Provider events</dt>
              <dd>
                {current.audit.source === 'provider' ? current.audit.eventCount : 'Not attested'}
              </dd>
            </div>
          </dl>

          {recentSnapshots.length > 0 ? (
            <div className={styles.inventoryHistory}>
              <strong>Recent snapshots</strong>
              {recentSnapshots.map((snapshot) => (
                <span key={snapshot.seq}>
                  <b>#{snapshot.seq}</b> {epochLabel(snapshot.createdAt)} ·{' '}
                  {formatBytes(snapshot.totalBytes)} · {snapshot.format}
                </span>
              ))}
            </div>
          ) : null}

          {pruneEvents.length > 0 ? (
            <div className={styles.inventoryHistory}>
              <strong>Recent prune history</strong>
              {pruneEvents.map((event) => (
                <span key={`${event.at}-${detailText(event.detail)}`}>
                  <b>{epochLabel(event.at)}</b> {detailText(event.detail)}
                </span>
              ))}
            </div>
          ) : null}
        </>
      )}

      {onVerifyBucket ? (
        <button
          type="button"
          className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft, styles.verifyBucket)}
          disabled={verifying}
          onClick={() => void verify()}
        >
          {verifying ? 'Checking bucket…' : 'Verify against bucket'}
        </button>
      ) : null}
      {error ? <div className={styles.runError}>{error}</div> : null}
    </section>
  );
}
