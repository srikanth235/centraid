import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import Icon from '../ui/Icon.js';
import { cx } from '../ui/cx.js';
import { formatBytes, relativeWhen } from '../../format.js';
import buttonCss from '../ui/Button.module.css';
import controlsCss from '../styles/controls.module.css';
import gwStyles from './GatewayScreen.module.css';
import styles from './StorageCard.module.css';

// Gateway → Overview → Storage (issue #367 §D3): the owner surface over the
// gateway-level storage-connection entity (Section C's storage-routes.ts) —
// a sibling of BackupCard, same card anatomy (panel/panelHead/panelEmpty
// from GatewayScreen.module.css). Where BackupCard reads "did the last
// snapshot land", this card reads "how much of my remote budget is used,
// and does what the provider bills me for match what custody actually
// confirmed replicated" — the quota bar is the hero, and the drift line
// underneath it is a deliberate honesty check, not decoration: a provider's
// own account page and Centraid's local custody ledger are two independent
// witnesses, and if they disagree that's worth surfacing before it becomes
// a support ticket.
//
// No "sweep now" trigger here (issue #367 §D3) — the replication sweep runs
// on its own interval per mounted vault (VaultPlane.runSweep) and the
// gateway exposes no manual-trigger route; inventing one was explicitly
// out of scope for this wave (see the NEEDS-WIRING note in this repo's
// issue #367 tracking).

export type StorageConnectionKindDTO = 'byo-s3' | 'provider';
export type StorageConnectionUseDTO = 'backup' | 'cas';

export interface StorageStoreUsageDTO {
  bytesStored: number;
  quotaBytes: number | null;
}

export interface StorageConnectionCardDTO {
  id: string;
  kind: StorageConnectionKindDTO;
  name: string;
  uses: StorageConnectionUseDTO[];
  /** `null` for byo-s3 (no metering endpoint) or before the first successful poll. */
  providerReported: { backup?: StorageStoreUsageDTO; cas?: StorageStoreUsageDTO } | null;
  /** Locally-computed replicated CAS bytes — custody's own ground truth. */
  localReplicatedBytes: number;
  fetchedAt?: string;
  /** Set when the most recent provider-usage poll failed — the last-known-good report still renders above it. */
  error?: string;
}

/** Bounded storage-tier health for one vault (issue #405 §7) — process-
 *  lifetime custody counters. `budgetBytes` is `null` for an unlimited tier. */
export interface StorageCacheCardDTO {
  spoolBytes: number;
  budgetBytes: number | null;
  localHits: number;
  readThroughs: number;
  rangedRemoteReads: number;
  bytesServedLocal: number;
  bytesServedRemote: number;
  evictedBlobs: number;
  evictedBytes: number;
  backpressureEvents: number;
}

export interface StorageVaultCardDTO {
  vaultId: string;
  name: string;
  configured: boolean;
  connectionId?: string;
  replicated: { count: number; bytes: number };
  backlog: { count: number; bytes: number };
  lastSweep: {
    completedAt: string | null;
    error: string | null;
    consecutiveFailures: number;
  };
  /** Bounded storage-tier metrics (issue #405 §7); absent on older gateways. */
  cache?: StorageCacheCardDTO;
}

export interface StorageCardStatusDTO {
  connections: StorageConnectionCardDTO[];
  vaults: StorageVaultCardDTO[];
}

export interface StorageCardProps {
  /** Live clock (parent ticks it) — drives the humanized ages. */
  now: number;
  loadStatus: () => Promise<StorageCardStatusDTO>;
  /** Navigates to Settings → Storage — used by both the empty state and the "Manage" link. */
  onOpenSettings: () => void;
}

const POLL_MS = 10_000;
/** A local/provider byte gap under this fraction reads as normal replication
 *  lag, not a discrepancy worth flagging in amber. */
const DRIFT_WARN_FRACTION = 0.05;
const KIND_LABEL: Record<StorageConnectionKindDTO, string> = {
  'byo-s3': 'BYO S3',
  provider: 'Provider',
};
const USE_LABEL: Record<StorageConnectionUseDTO, string> = { backup: 'Backup', cas: 'CAS' };
const STORE_LABEL: Record<'backup' | 'cas', string> = { backup: 'Backup', cas: 'CAS' };

function pct(used: number, quota: number): number {
  if (quota <= 0) return 100;
  return Math.min(100, Math.round((used / quota) * 100));
}

/** The quota bar — the hero element. Layered per-store segments over the
 *  connection's total quota, not a generic single-color progress div: each
 *  store class gets its own hue, so "what's eating my budget" reads at a
 *  glance instead of needing a tooltip. */
function QuotaBar({
  backup,
  cas,
  quotaBytes,
}: {
  backup?: StorageStoreUsageDTO;
  cas?: StorageStoreUsageDTO;
  quotaBytes: number;
}): JSX.Element {
  const backupBytes = backup?.bytesStored ?? 0;
  const casBytes = cas?.bytesStored ?? 0;
  const totalBytes = backupBytes + casBytes;
  const backupPct = quotaBytes > 0 ? Math.min(100, (backupBytes / quotaBytes) * 100) : 0;
  const casPct = quotaBytes > 0 ? Math.min(100, (casBytes / quotaBytes) * 100) : 0;
  const totalPct = pct(totalBytes, quotaBytes);
  const severity = totalPct >= 95 ? 'error' : totalPct >= 80 ? 'warn' : 'ok';

  return (
    <div className={styles.quotaBlock} data-testid="quota-bar">
      <div className={styles.quotaTrack} data-severity={severity}>
        <span className={styles.quotaSegBackup} style={{ width: `${backupPct}%` }} />
        <span
          className={styles.quotaSegCas}
          style={{ width: `${casPct}%`, left: `${backupPct}%` }}
        />
      </div>
      <div className={styles.quotaFoot}>
        <span className={styles.quotaFootUsed}>
          {formatBytes(totalBytes)} of {formatBytes(quotaBytes)} used
        </span>
        <span className={styles.quotaFootPct} data-severity={severity}>
          {totalPct}%
        </span>
      </div>
      <div className={styles.quotaLegend}>
        {backup ? (
          <span className={styles.legendItem}>
            <span className={cx(styles.legendDot, styles.legendDotBackup)} />
            Backup {formatBytes(backupBytes)}
          </span>
        ) : null}
        {cas ? (
          <span className={styles.legendItem}>
            <span className={cx(styles.legendDot, styles.legendDotCas)} />
            CAS {formatBytes(casBytes)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The provider-vs-local integrity read — two independent witnesses to the
 *  same fact (bytes actually sitting in the CAS remote tier), read side by
 *  side with the gap named plainly rather than picking one number to show. */
function DriftLine({ connection }: { connection: StorageConnectionCardDTO }): JSX.Element | null {
  const casReported = connection.providerReported?.cas;
  if (connection.kind === 'byo-s3' || !casReported) {
    // No provider witness to compare against — say what custody itself
    // confirmed, without implying a cross-check that didn't happen.
    return (
      <div className={styles.driftLine} data-testid="drift-line">
        <Icon name="Check" size={11} />
        <span>{formatBytes(connection.localReplicatedBytes)} locally verified replicated</span>
      </div>
    );
  }
  const reported = casReported.bytesStored;
  const local = connection.localReplicatedBytes;
  const denom = Math.max(reported, local, 1);
  const gap = Math.abs(reported - local);
  const drifted = gap / denom > DRIFT_WARN_FRACTION;
  return (
    <div
      className={styles.driftLine}
      data-emphasis={drifted ? 'warn' : undefined}
      data-testid="drift-line"
    >
      <Icon name={drifted ? 'AlertTriangle' : 'Check'} size={11} />
      <span>
        provider reports {formatBytes(reported)} · locally verified {formatBytes(local)}
        {drifted ? ' — drift worth a look' : ''}
      </span>
    </div>
  );
}

function ConnectionPanel({ connection }: { connection: StorageConnectionCardDTO }): JSX.Element {
  const quotaBytes =
    connection.providerReported?.backup?.quotaBytes ?? connection.providerReported?.cas?.quotaBytes;
  const hasQuota = typeof quotaBytes === 'number' && quotaBytes > 0;

  return (
    <div className={styles.connectionPanel} data-testid="storage-connection-panel">
      <div className={styles.connectionHead}>
        <span className={styles.connectionName}>{connection.name}</span>
        <span className={styles.kindBadge} data-kind={connection.kind}>
          {KIND_LABEL[connection.kind]}
        </span>
        <div className={styles.useBadges}>
          {connection.uses.map((u) => (
            <span key={u} className={styles.useBadge}>
              {USE_LABEL[u]}
            </span>
          ))}
        </div>
      </div>

      {connection.kind === 'provider' ? (
        hasQuota ? (
          <QuotaBar
            backup={connection.providerReported?.backup}
            cas={connection.providerReported?.cas}
            quotaBytes={quotaBytes}
          />
        ) : connection.providerReported ? (
          <div className={styles.unmetered}>
            {(['backup', 'cas'] as const)
              .filter((s) => connection.providerReported?.[s])
              .map((s) => (
                // Unclassed on purpose: `.unmetered` is already the flex row,
                // and inline flow inside the span puts the tag on the byte
                // count's line. The span is here to group each store into ONE
                // flex item, so the row's gap separates stores, not words.
                <span key={s}>
                  {STORE_LABEL[s]} {formatBytes(connection.providerReported?.[s]?.bytesStored ?? 0)}{' '}
                  <span className={styles.unmeteredTag}>unmetered</span>
                </span>
              ))}
          </div>
        ) : (
          <div className={styles.pendingUsage}>Provider usage hasn’t reported in yet.</div>
        )
      ) : null}

      <DriftLine connection={connection} />

      {connection.fetchedAt ? (
        <div className={styles.fetchedAt}>
          provider figures as of {relativeWhen(connection.fetchedAt)}
        </div>
      ) : null}
      {connection.error ? <div className={styles.usageError}>{connection.error}</div> : null}
    </div>
  );
}

/** Cache-tier health (issue #405 §7 — "tier health is invisible today"). The
 *  spool-vs-budget bar mirrors the connection quota bar's anatomy so the two
 *  reads feel of a piece; the hit-rate is derived here from the raw counters
 *  (the route ships counts, not a ratio) with the counts kept in a subline so
 *  a percentage never floats free of its sample size. On a local-only vault
 *  the remote-facing numbers are all-zero noise, so only the spool bar shows —
 *  the one metric that still means something without a remote tier. */
function CacheSection({
  cache,
  configured,
}: {
  cache: StorageCacheCardDTO;
  configured: boolean;
}): JSX.Element {
  const unlimited = cache.budgetBytes === null;
  const budget = cache.budgetBytes ?? 0;
  const spoolPct =
    !unlimited && budget > 0 ? Math.min(100, Math.round((cache.spoolBytes / budget) * 100)) : 0;
  const spoolSeverity = spoolPct >= 95 ? 'error' : spoolPct >= 80 ? 'warn' : 'ok';

  const reads = cache.localHits + cache.readThroughs;
  // Trivially 100% before any read, and on a local-only vault (nothing reads
  // through a remote that isn't there) — sensible, not a divide-by-zero.
  const hitRate = reads > 0 ? Math.round((cache.localHits / reads) * 100) : 100;
  const hasEvictions = cache.evictedBlobs > 0;
  const hasBackpressure = cache.backpressureEvents > 0;

  return (
    <div className={styles.cacheSection} data-testid="storage-cache-section">
      <div className={styles.cacheSpoolFoot}>
        <span className={styles.cacheSpoolLabel}>cache</span>
        <span className={styles.cacheSpoolUsed}>
          {formatBytes(cache.spoolBytes)}
          {unlimited ? ' cached · unlimited budget' : ` of ${formatBytes(budget)} budget`}
        </span>
        {!unlimited ? (
          <span className={styles.cacheSpoolPct} data-severity={spoolSeverity}>
            {spoolPct}%
          </span>
        ) : null}
      </div>
      {!unlimited ? (
        <div
          className={styles.cacheTrack}
          data-severity={spoolSeverity}
          data-testid="cache-spool-track"
        >
          <span className={styles.cacheFill} style={{ width: `${spoolPct}%` }} />
        </div>
      ) : null}
      {configured ? (
        <div className={styles.cacheMeta}>
          <span
            title={`${cache.localHits} local hits · ${cache.readThroughs} remote read-throughs · ${cache.rangedRemoteReads} ranged`}
          >
            hit rate {hitRate}%
          </span>
          <span>
            served {formatBytes(cache.bytesServedLocal)} local ·{' '}
            {formatBytes(cache.bytesServedRemote)} remote
          </span>
          {hasEvictions ? (
            <span>
              evicted {cache.evictedBlobs} · {formatBytes(cache.evictedBytes)}
            </span>
          ) : null}
          {hasBackpressure ? (
            <span data-emphasis="warn">backpressure {cache.backpressureEvents}×</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function VaultRow({ vault, now }: { vault: StorageVaultCardDTO; now: number }): JSX.Element {
  const hasBacklog = vault.backlog.count > 0;
  const failing = vault.lastSweep.consecutiveFailures > 0;
  void now; // reserved for a future relative-time render of lastSweep.completedAt
  return (
    <div className={styles.vaultRow} data-testid="storage-vault-row">
      <div className={styles.vaultHead}>
        <span className={styles.vaultName}>{vault.name}</span>
        {!vault.configured ? <span className={styles.localOnlyBadge}>local only</span> : null}
      </div>
      {vault.configured ? (
        <div className={styles.vaultMeta}>
          <span>
            replicated {vault.replicated.count} · {formatBytes(vault.replicated.bytes)}
          </span>
          <span data-emphasis={hasBacklog ? 'warn' : undefined}>
            backlog {vault.backlog.count} · {formatBytes(vault.backlog.bytes)}
          </span>
          <span>
            last sweep{' '}
            {vault.lastSweep.completedAt ? relativeWhen(vault.lastSweep.completedAt) : 'never'}
          </span>
        </div>
      ) : null}
      {failing && vault.lastSweep.error ? (
        <div className={styles.vaultError}>
          {vault.lastSweep.consecutiveFailures}x failing: {vault.lastSweep.error}
        </div>
      ) : null}
      {vault.cache ? <CacheSection cache={vault.cache} configured={vault.configured} /> : null}
    </div>
  );
}

export default function StorageCard({
  now,
  loadStatus,
  onOpenSettings,
}: StorageCardProps): JSX.Element {
  const [status, setStatus] = useState<StorageCardStatusDTO | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mountedRef = useRef(true);

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
    };
  }, [refresh]);

  const hasConnections = (status?.connections.length ?? 0) > 0;

  return (
    <section className={cx(gwStyles.panel, styles.card)}>
      <div className={gwStyles.panelHead}>
        <h2>Storage</h2>
        <button
          type="button"
          className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
          onClick={onOpenSettings}
        >
          <Icon name="Settings" size={13} />
          <span>Manage</span>
        </button>
      </div>

      <div className={styles.body}>
        {loadError ? (
          <div className={styles.loadError}>Couldn’t reach the gateway: {loadError}</div>
        ) : !status ? (
          <div className={gwStyles.panelEmpty}>Checking storage status…</div>
        ) : !hasConnections ? (
          <div className={gwStyles.panelEmpty}>
            No remote storage connected yet. Add a connection in{' '}
            <button type="button" className={styles.inlineLink} onClick={onOpenSettings}>
              Settings → Storage
            </button>{' '}
            to enable offsite backup snapshots or CAS blob replication.
          </div>
        ) : (
          <>
            <div className={styles.connectionList}>
              {status.connections.map((c) => (
                <ConnectionPanel key={c.id} connection={c} />
              ))}
            </div>
            {status.vaults.length > 0 ? (
              <div className={styles.vaultList}>
                {status.vaults.map((v) => (
                  <VaultRow key={v.vaultId} vault={v} now={now} />
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
