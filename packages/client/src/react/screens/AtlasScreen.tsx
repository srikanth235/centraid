import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  browseRows,
  type AtlasCensusPayload,
  type AtlasGraphPayload,
  type AtlasPulsePayload,
} from '../../gateway-client.js';
import Icon from '../ui/Icon.js';
import { cx } from '../ui/cx.js';
import AtlasBrowseTab from './AtlasBrowseTab.js';
import AtlasKindsTab from './AtlasKindsTab.js';
import AtlasRelationsTab from './AtlasRelationsTab.js';
import styles from './AtlasScreen.module.css';

// The Vault Atlas (issue #441 Part B) — ontology at a glance in Operations.
// Owns its own head + tab strip (Kinds / Relations / Browse) and the census/
// graph/pulse fetches, handing each tab its slice. Kinds is implemented here
// (B1); Relations (B2) and Browse (B3) are typed placeholders a later agent
// fills against the prop seams documented on their components. The one piece of
// cross-tab wiring is `openBrowse`: a Kinds card click switches to Browse with
// that kind's logical name preselected.

export interface AtlasScreenProps {
  /** GET /_vault/atlas/stats — the Kinds census (rows/bytes per pack). */
  loadStats: () => Promise<AtlasCensusPayload>;
  /** GET /_vault/atlas/pulse — 30-day write pulse for the Kinds sparklines. */
  loadPulse: () => Promise<AtlasPulsePayload>;
  /** GET /_vault/atlas/graph — the Relations orrery payload (B2, filled later). */
  loadGraph: () => Promise<AtlasGraphPayload>;
}

type TabId = 'kinds' | 'relations' | 'browse';

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'kinds', label: 'Kinds' },
  { id: 'relations', label: 'Map' },
  { id: 'browse', label: 'Browse' },
];

export default function AtlasScreen({
  loadStats,
  loadPulse,
  loadGraph,
}: AtlasScreenProps): JSX.Element {
  const [tab, setTab] = useState<TabId>('kinds');
  const [browseTable, setBrowseTable] = useState<string | undefined>(undefined);

  const [stats, setStats] = useState<AtlasCensusPayload | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [pulse, setPulse] = useState<AtlasPulsePayload | null>(null);
  const [graph, setGraph] = useState<AtlasGraphPayload | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const mountedRef = useRef(true);

  // Census + pulse travel together (both feed Kinds). Pulse is enhancement-only
  // — a failure leaves sparklines/dormancy off but never blocks the census, so
  // only a stats failure surfaces as an error state.
  const loadCensus = useCallback(() => {
    setRefreshing(true);
    setStatsError(null);
    void Promise.allSettled([loadStats(), loadPulse()]).then(([s, p]) => {
      if (!mountedRef.current) return;
      if (s.status === 'fulfilled') setStats(s.value);
      else setStatsError(s.reason instanceof Error ? s.reason.message : String(s.reason));
      if (p.status === 'fulfilled') setPulse(p.value);
      setRefreshing(false);
    });
  }, [loadStats, loadPulse]);

  useEffect(() => {
    mountedRef.current = true;
    loadCensus();
    // The graph feeds Relations — fetched once up front so that tab paints
    // instantly when selected. Its failure is silent; the tab renders its own
    // empty state from a null payload.
    void loadGraph()
      .then((g) => {
        if (mountedRef.current) setGraph(g);
      })
      .catch(() => {});
    return () => {
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#441) mount-once, keyed to loader identities
  }, [loadStats, loadPulse, loadGraph]);

  const openBrowse = useCallback((logical: string) => {
    setBrowseTable(logical);
    setTab('browse');
  }, []);

  // The Map tab's "A few of yours" fetcher — the Browse rows endpoint, capped at
  // three, reusing the same journalled read path (zero new plumbing).
  const fetchSampleRows = useCallback(
    (logical: string) => browseRows({ table: logical, limit: 3 }).then((r) => r.rows),
    [],
  );

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div className={styles.title}>
          <span className={styles.titleIcon}>
            <Icon name="Globe" size={16} />
          </span>
          <h1>Vault Atlas</h1>
        </div>
        <div className={styles.headMeta}>
          What your vault knows, where it lives, and how it connects.
        </div>
      </div>

      <nav className={styles.tabs} role="tablist" aria-label="Vault Atlas">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={cx(styles.tab, tab === t.id && styles.tabActive)}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'kinds' ? (
        statsError && !stats ? (
          <div className={styles.error} data-testid="atlas-census-error">
            Couldn’t read the census: {statsError}
          </div>
        ) : !stats ? (
          <div className={styles.loading}>Reading your vault’s census…</div>
        ) : (
          <AtlasKindsTab
            stats={stats}
            pulse={pulse}
            refreshing={refreshing}
            onRefresh={loadCensus}
            onOpenBrowse={openBrowse}
          />
        )
      ) : null}

      {tab === 'relations' ? (
        <AtlasRelationsTab graph={graph} fetchSampleRows={fetchSampleRows} />
      ) : null}
      {tab === 'browse' ? <AtlasBrowseTab initialTable={browseTable} /> : null}
    </div>
  );
}
