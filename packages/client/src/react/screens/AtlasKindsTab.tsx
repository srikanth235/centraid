import { Fragment, useState, type JSX } from 'react';
import type {
  AtlasCensusPack,
  AtlasCensusPayload,
  AtlasCensusTable,
  AtlasPulsePayload,
  AtlasPulseSeries,
} from '../../gateway-client.js';
import { formatBytes, relativeWhen } from '../../format.js';
import Icon from '../ui/Icon.js';
import { cx } from '../ui/cx.js';
import styles from './AtlasKindsTab.module.css';

// Kinds tab — the periodic table of the ontology (issue #441 B1). Every kind
// the schema defines gets a permanent cell, grouped by pack; populated cells
// carry a row/byte count + a 30-day write-pulse sparkline, empty ones render as
// dashed "never written" ghosts so the negative space is legible. Machinery
// packs (consent/agent/blob/enrich/sync/journal bands) live behind a collapsed
// shelf — life data vs plumbing as a visual statement. A card click hands its
// logical name up to the screen, which switches to Browse preselected to it.

export interface AtlasKindsTabProps {
  /** The `/_vault/atlas/stats` census — the source of every cell + the header. */
  stats: AtlasCensusPayload;
  /** The `/_vault/atlas/pulse` payload for sparklines/dormancy, or `null` when
   *  that (enhancement-only) fetch hasn't landed / failed — cards still render. */
  pulse: AtlasPulsePayload | null;
  /** A census refresh is in flight — disables the refresh button. */
  refreshing: boolean;
  onRefresh: () => void;
  /** Open Browse preselected to a kind's logical `schema.table` name. */
  onOpenBrowse: (logical: string) => void;
}

type Metric = 'rows' | 'bytes';

/** Naive lower-case pluralization for the census sentence's ontology vocabulary
 *  (kind labels are singular, e.g. "Party" → "parties"). */
function pluralize(label: string): string {
  const w = label.toLowerCase();
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(w)) return `${w}es`;
  return `${w}s`;
}

/** Expand a pulse series' sparse day buckets into a dense per-day count array
 *  over the whole window, so every sparkline spans the same axis. */
function denseDays(
  series: AtlasPulseSeries | undefined,
  since: string,
  windowDays: number,
): number[] {
  const byDay = new Map<string, number>();
  for (const d of series?.days ?? []) byDay.set(d.day, d.count);
  const base = new Date(since);
  const out: number[] = [];
  for (let i = 0; i < windowDays; i += 1) {
    const day = new Date(base.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    out.push(byDay.get(day) ?? 0);
  }
  return out;
}

/** A dependency-free write-pulse sparkline — one bar per day, zero-days drawn
 *  as a faint tick so the rhythm (and the gaps) read at a glance. */
function Sparkline({ counts }: { counts: number[] }): JSX.Element {
  const max = Math.max(1, ...counts);
  const n = counts.length;
  const w = 100;
  const h = 22;
  const gap = 0.6;
  const bw = (w - gap * (n - 1)) / n;
  return (
    <svg
      className={styles.spark}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {counts.map((c, i) => {
        const bh = c === 0 ? 0.75 : Math.max(1.5, (c / max) * h);
        return (
          <rect
            // eslint-disable-next-line react/no-array-index-key -- (#441) fixed-length day axis; index IS the day
            key={i}
            x={i * (bw + gap)}
            y={h - bh}
            width={bw}
            height={bh}
            className={c === 0 ? styles.sparkZero : styles.sparkBar}
          />
        );
      })}
    </svg>
  );
}

function KindCard({
  table,
  metric,
  counts,
  quiet,
  onOpen,
}: {
  table: AtlasCensusTable;
  metric: Metric;
  /** Dense per-day pulse when this kind saw writes in the window, else null. */
  counts: number[] | null;
  /** Rows exist but the window is silent (pulse known and all-zero). */
  quiet: boolean;
  onOpen: () => void;
}): JSX.Element {
  const empty = table.rows === 0;
  const value =
    metric === 'bytes'
      ? table.bytes === null
        ? '—'
        : formatBytes(table.bytes)
      : table.rows.toLocaleString();

  return (
    <button
      type="button"
      className={cx(styles.card, empty && styles.cardGhost)}
      onClick={onOpen}
      title={table.logical}
      data-testid="atlas-kind-card"
      data-logical={table.logical}
      data-empty={empty ? 'true' : undefined}
    >
      <span className={styles.cardLabel}>{table.label}</span>
      {empty ? (
        <span className={styles.cardGhostNote}>never written</span>
      ) : (
        <>
          <span className={styles.cardValue} data-testid="atlas-kind-value">
            {value}
          </span>
          {counts ? (
            <Sparkline counts={counts} />
          ) : quiet ? (
            <span className={styles.cardQuiet}>quiet</span>
          ) : (
            <span className={styles.cardSparkPad} />
          )}
        </>
      )}
    </button>
  );
}

function OntologyPack({
  pack,
  metric,
  pulseBy,
  since,
  windowDays,
  onOpenBrowse,
}: {
  pack: AtlasCensusPack;
  metric: Metric;
  pulseBy: Map<string, AtlasPulseSeries> | null;
  since: string;
  windowDays: number;
  onOpenBrowse: (logical: string) => void;
}): JSX.Element {
  return (
    <section className={styles.pack}>
      <header className={styles.packHead}>
        <h2 className={styles.packLabel}>{pack.packLabel}</h2>
        <span className={styles.packMeta}>
          {pack.rows.toLocaleString()} rows
          {pack.bytes !== null ? ` · ${formatBytes(pack.bytes)}` : ''}
        </span>
      </header>
      <div className={styles.grid}>
        {pack.tables.map((table) => {
          const series = pulseBy?.get(table.logical);
          const wrote = series !== undefined && series.total > 0;
          const counts = wrote ? denseDays(series, since, windowDays) : null;
          const quiet = pulseBy !== null && table.rows > 0 && !wrote;
          return (
            <KindCard
              key={table.logical}
              table={table}
              metric={metric}
              counts={counts}
              quiet={quiet}
              onOpen={() => onOpenBrowse(table.logical)}
            />
          );
        })}
      </div>
    </section>
  );
}

/** The collapsed-by-default plumbing shelf — a deliberately plain rows/bytes
 *  table for the machinery packs (no periodic-table treatment). */
function MachineryShelf({
  packs,
  onOpenBrowse,
}: {
  packs: AtlasCensusPack[];
  onOpenBrowse: (logical: string) => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (packs.length === 0) return null;
  const kindCount = packs.reduce((sum, p) => sum + p.tables.length, 0);
  const rowCount = packs.reduce((sum, p) => sum + p.rows, 0);

  return (
    <section className={styles.machinery}>
      <button
        type="button"
        className={styles.machineryToggle}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="atlas-machinery-toggle"
      >
        <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={14} />
        <span className={styles.machineryTitle}>Machinery</span>
        <span className={styles.machineryMeta}>
          {kindCount} kinds · {rowCount.toLocaleString()} rows
        </span>
      </button>
      {open ? (
        <table className={styles.machineryTable} data-testid="atlas-machinery-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Pack</th>
              <th className={styles.numCol}>Rows</th>
              <th className={styles.numCol}>Bytes</th>
            </tr>
          </thead>
          <tbody>
            {packs.flatMap((pack) =>
              pack.tables.map((table) => (
                <tr
                  key={table.logical}
                  className={styles.machineryRow}
                  onClick={() => onOpenBrowse(table.logical)}
                >
                  <td>{table.label}</td>
                  <td className={styles.machineryPack}>{pack.packLabel}</td>
                  <td className={styles.numCol}>{table.rows.toLocaleString()}</td>
                  <td className={styles.numCol}>
                    {table.bytes === null ? '—' : formatBytes(table.bytes)}
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

export default function AtlasKindsTab({
  stats,
  pulse,
  refreshing,
  onRefresh,
  onOpenBrowse,
}: AtlasKindsTabProps): JSX.Element {
  const [metric, setMetric] = useState<Metric>('rows');

  const ontologyPacks = stats.packs.filter((p) => p.packKind === 'ontology');
  const machineryPacks = stats.packs.filter((p) => p.packKind === 'machinery');
  const bytesUnknown = stats.totals.bytes === null;

  // Pulse indexed by logical `schema.table` (matches census `table.logical`).
  // `null` (not an empty map) when the pulse is unknown, so cards can tell
  // "no writes" apart from "we didn't measure" — only the former is "quiet".
  const pulseBy = pulse ? new Map(pulse.series.map((s) => [s.entityType, s])) : null;

  // Lead the census sentence with the fullest kinds, in ontology vocabulary.
  const leadKinds = ontologyPacks
    .flatMap((p) => p.tables)
    .filter((t) => t.rows > 0)
    .sort((a, b) => b.rows - a.rows)
    .slice(0, 3);
  const sizeLabel = formatBytes(stats.totals.bytes ?? stats.fileBytesTotal);

  const num = (v: string, key: string): JSX.Element => (
    <span key={key} className={styles.num}>
      {v}
    </span>
  );

  return (
    <div className={styles.tab}>
      <header className={styles.census}>
        <p className={styles.censusSentence}>
          {leadKinds.length === 0 ? (
            <>
              Your vault is empty — {num('0', 'z')} of {num(String(stats.totals.kinds), 'k')} kinds
              written.
            </>
          ) : (
            <>
              Your vault knows{' '}
              {leadKinds.map((t, i) => (
                <Fragment key={t.logical}>
                  {i > 0 ? (i === leadKinds.length - 1 ? ', and ' : ', ') : ''}
                  {num(t.rows.toLocaleString(), `n-${t.logical}`)} {pluralize(t.label)}
                </Fragment>
              ))}
              {' · '}
              {num(sizeLabel, 'sz')} across {num(String(stats.totals.populatedKinds), 'pk')} of{' '}
              {num(String(stats.totals.kinds), 'tk')} kinds.
            </>
          )}
        </p>
        <div className={styles.censusControls}>
          <div className={styles.metricToggle} role="radiogroup" aria-label="Show rows or bytes">
            <button
              type="button"
              role="radio"
              aria-checked={metric === 'rows'}
              className={styles.metricOption}
              data-active={String(metric === 'rows')}
              onClick={() => setMetric('rows')}
            >
              Rows
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={metric === 'bytes'}
              className={styles.metricOption}
              data-active={String(metric === 'bytes')}
              disabled={bytesUnknown}
              title={bytesUnknown ? 'Byte sizes need the dbstat measure' : undefined}
              onClick={() => setMetric('bytes')}
            >
              Bytes
            </button>
          </div>
          <button
            type="button"
            className={styles.refresh}
            disabled={refreshing}
            onClick={onRefresh}
            aria-label="Refresh census"
          >
            <Icon name="Refresh" size={13} />
            <span className={styles.refreshStamp}>{relativeWhen(stats.generatedAt)}</span>
          </button>
        </div>
      </header>

      {ontologyPacks.map((pack) => (
        <OntologyPack
          key={pack.pack}
          pack={pack}
          metric={metric}
          pulseBy={pulseBy}
          since={pulse?.since ?? stats.generatedAt}
          windowDays={pulse?.windowDays ?? 30}
          onOpenBrowse={onOpenBrowse}
        />
      ))}

      <MachineryShelf packs={machineryPacks} onOpenBrowse={onOpenBrowse} />
    </div>
  );
}
