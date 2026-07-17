import type { JSX } from 'react';
import type { AtlasFkEdge, AtlasGraphNode } from '../../gateway-client.js';
import Icon from '../ui/Icon.js';
import { cx } from '../ui/cx.js';
import type { RelationChip } from './atlasOrreryGeometry.js';
import type { Readout } from './AtlasOrreryChart.js';
import styles from './AtlasRelationsTab.module.css';

// The orrery's fixed side panel (issue #441 B2) — a presentational leaf of
// AtlasRelationsTab. It holds the centred-on breadcrumb, the hover/focus readout
// (a fixed panel, never a floating tooltip), the relation-vocabulary chips (the
// SEPARATE authored-link mechanism), and the static legend. Stateless: all
// interaction is prop-drilled up to the parent.

const fmt = (n: number): string => n.toLocaleString('en-US');

export interface AtlasOrreryPanelProps {
  center: string;
  rootCenter: string;
  isRoot: boolean;
  trail: readonly string[];
  readout: Readout;
  edges: readonly AtlasFkEdge[];
  rows: Map<string, number>;
  relChips: readonly RelationChip[];
  activeRels: Set<string>;
  onRecenter: (physical: string) => void;
  onBackToRoot: () => void;
  onToggleRel: (key: string) => void;
}

export default function AtlasOrreryPanel({
  center,
  rootCenter,
  isRoot,
  trail,
  readout,
  edges,
  rows,
  relChips,
  activeRels,
  onRecenter,
  onBackToRoot,
  onToggleRel,
}: AtlasOrreryPanelProps): JSX.Element {
  return (
    <aside className={styles.readout} aria-label="Relations readout">
      {/* centred-on + breadcrumb */}
      <section className={styles.roSec}>
        <p className={styles.roLabel}>Centred on</p>
        <div className={styles.crumbs}>
          {trail.map((t, i) => (
            <span key={t} className={styles.crumbWrap}>
              {i > 0 ? <span className={styles.crumbSep}>›</span> : null}
              <button
                type="button"
                className={cx(styles.crumb, t === center && styles.crumbCurrent)}
                aria-current={t === center ? 'true' : undefined}
                disabled={t === center}
                onClick={() => onRecenter(t)}
              >
                {t}
              </button>
            </span>
          ))}
        </div>
        <button
          type="button"
          className={styles.backBtn}
          disabled={isRoot}
          onClick={onBackToRoot}
          data-testid="atlas-recenter"
        >
          <Icon name="ArrowLeft" size={13} />
          Back to {rootCenter}
        </button>
      </section>

      {/* hover / focus readout — a fixed panel, never a floating tooltip */}
      <section className={styles.roSec}>
        <p className={styles.roLabel}>Readout</p>
        <div className={styles.detail} data-testid="atlas-readout">
          {readout.kind === 'edge' ? (
            <EdgeReadout edge={readout.edge} />
          ) : readout.kind === 'node' ? (
            <NodeReadout
              node={readout.node}
              hop={readout.hop}
              center={center}
              edges={edges}
              rows={rows.get(readout.node.physical)}
            />
          ) : (
            <p className={styles.dEmpty}>
              Hover an arc to read the reference it carries. Click any kind — or focus it and press
              Enter — to re-centre; the rings recompute by hop distance from wherever you stand.
            </p>
          )}
        </div>
      </section>

      {/* relation vocabulary — the SEPARATE authored-link mechanism */}
      <section className={styles.roSec}>
        <p className={styles.roLabel}>Relation vocabulary</p>
        {relChips.length === 0 ? (
          <p className={styles.dEmpty}>No authored links in this vault yet.</p>
        ) : (
          <div className={styles.chips}>
            {relChips.map((chip) => {
              const on = activeRels.has(chip.key);
              return (
                <button
                  key={chip.key}
                  type="button"
                  className={styles.chip}
                  aria-pressed={on}
                  data-testid="atlas-relation-chip"
                  data-relation={chip.key}
                  onClick={() => onToggleRel(chip.key)}
                >
                  <span className={styles.chipDot} />
                  {chip.label}
                  <span className={styles.chipCount}>{fmt(chip.count)}</span>
                </button>
              );
            })}
          </div>
        )}
        <p className={styles.roFoot}>
          These <b>authored links</b> (<b>core_link</b>) are a separate mechanism from the
          structural foreign keys above: user- and agent-created relations between rows, typed by a
          vocabulary that is itself ordinary data. An FK is never “unused” merely because no
          authored link names that pair.
        </p>
      </section>

      {/* legend */}
      <section className={styles.roSec}>
        <p className={styles.roLabel}>Legend</p>
        <ul className={styles.legend}>
          <li className={styles.lgRow}>
            <span className={cx(styles.lgSwatch, styles.lgLive)} />
            <span className={styles.lgText}>
              <b>Structural reference</b> a schema-enforced FK column; thickness is fill
            </span>
          </li>
          <li className={styles.lgRow}>
            <span className={cx(styles.lgSwatch, styles.lgGhost)} />
            <span className={styles.lgText}>
              <b>Ghost edge</b> fill is zero — empty child, or an optional column nothing sets
            </span>
          </li>
          <li className={styles.lgRow}>
            <span className={cx(styles.lgSwatch, styles.lgAuthored)} />
            <span className={styles.lgText}>
              <b>Authored link</b> a core_link overlay — a separate mechanism, toggled by chip
            </span>
          </li>
          <li className={styles.lgRow}>
            <span className={cx(styles.lgSwatch, styles.lgSelf)} />
            <span className={styles.lgText}>
              <b>Self-reference</b> a hierarchy — drawn as a curl, not a loop
            </span>
          </li>
        </ul>
      </section>
    </aside>
  );
}

function EdgeReadout({ edge }: { edge: AtlasFkEdge }): JSX.Element {
  const pct = edge.childRows > 0 ? Math.round((edge.fill / edge.childRows) * 100) : 0;
  return (
    <>
      <h3 className={styles.dKind}>
        {edge.fromTable}
        <span className={styles.dKindCol}>.{edge.col}</span>
      </h3>
      <p className={styles.dSig}>
        <span className={styles.dArrow}>→</span>
        {edge.toTable} · <b>{edge.notnull ? 'NOT NULL' : 'nullable'}</b>
      </p>
      <div className={styles.dFigs}>
        <span className={styles.dFig}>
          <span className={cx(styles.dFigN, edge.ghost && styles.dFigNGhost)}>
            {fmt(edge.fill)}
          </span>
          <span className={styles.dFigK}>of {fmt(edge.childRows)} rows fill this</span>
        </span>
      </div>
      {edge.ghost ? (
        <p className={cx(styles.dNote, styles.dNoteGhost)}>
          {edge.childRows === 0 ? (
            <>
              <b>Ghost — the child table is empty.</b> {edge.fromTable} has never been written, so
              this column cannot be filled.
            </>
          ) : (
            <>
              <b>Ghost — an optional column nothing sets.</b> All {fmt(edge.childRows)} rows of{' '}
              {edge.fromTable} leave {edge.col} null.
            </>
          )}
        </p>
      ) : (
        <p className={styles.dNote}>
          {edge.notnull ? (
            <>
              <b>NOT NULL:</b> the schema guarantees every row fills it — it could only ghost if{' '}
              {edge.fromTable} were empty.
            </>
          ) : (
            <>
              Nullable: {pct}% of {edge.fromTable} rows fill it; the rest leave it null.
            </>
          )}
        </p>
      )}
    </>
  );
}

function NodeReadout({
  node,
  hop,
  center,
  edges,
  rows,
}: {
  node: AtlasGraphNode;
  hop: number | null;
  center: string;
  edges: readonly AtlasFkEdge[];
  rows: number | undefined;
}): JSX.Element {
  const incident = edges.filter(
    (e) => !e.selfRef && (e.fromTable === node.physical || e.toTable === node.physical),
  );
  const inDeg = edges.filter((e) => e.toTable === node.physical && !e.selfRef).length;
  const carrying = incident.filter((e) => !e.ghost).length;
  const hopTxt =
    hop === 0
      ? 'the centre'
      : hop === null
        ? 'unreached — no FK path from here'
        : `${hop} hop${hop > 1 ? 's' : ''} from ${center}`;
  return (
    <>
      <h3 className={styles.dKind}>{node.physical}</h3>
      <p className={styles.dSig}>
        pack <b>{node.packLabel}</b> · {hopTxt}
      </p>
      <div className={styles.dFigs}>
        <span className={styles.dFig}>
          <span className={styles.dFigN}>{rows === undefined ? '—' : fmt(rows)}</span>
          <span className={styles.dFigK}>rows</span>
        </span>
        <span className={styles.dFig}>
          <span className={styles.dFigN}>{fmt(inDeg)}</span>
          <span className={styles.dFigK}>FKs point here</span>
        </span>
      </div>
      <p className={styles.dNote}>
        <b>{carrying}</b> of <b>{incident.length}</b>{' '}
        {incident.length === 1 ? 'reference' : 'references'} carry rows.
        {node.selfRef ? ` Self-referencing: ${node.table} is a hierarchy, not a loop.` : ''}
      </p>
    </>
  );
}
