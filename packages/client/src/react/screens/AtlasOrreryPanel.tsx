import type { CSSProperties, JSX } from 'react';
import type { AtlasFkEdge, AtlasGraphNode } from '../../gateway-client.js';
import Icon from '../ui/Icon.js';
import { cx } from '../ui/cx.js';
import { packHueVar, type RelationChip } from './atlasOrreryGeometry.js';
import { pickSampleDisplay, type SampleResult } from './atlasSampleRows.js';
import type { Readout } from './AtlasOrreryChart.js';
import styles from './AtlasRelationsTab.module.css';

// The orrery's fixed side panel (issue #441 B2) — a presentational leaf of
// AtlasRelationsTab. It holds the centred-on breadcrumb, the hover/focus readout
// (a fixed panel, never a floating tooltip), a few real sample rows of the
// current centre, the relation-vocabulary chips (the SEPARATE authored-link
// mechanism), and the static legend. The page speaks human first — friendly
// names ("People") lead, the SQL name is demoted to a mono subtitle — so every
// readout resolves its display name through `nodeByPhysical`. Stateless: all
// interaction is prop-drilled up to the parent.

const fmt = (n: number): string => n.toLocaleString('en-US');

/** The human display name for a physical table — its curated `friendly` name,
 *  falling back to the humanized `label`, then the physical name itself. Never
 *  fabricated: the friendly name is server-emitted, the label is derived. */
function friendlyOf(nodeByPhysical: ReadonlyMap<string, AtlasGraphNode>, physical: string): string {
  const n = nodeByPhysical.get(physical);
  return n?.friendly ?? n?.label ?? physical;
}

export interface AtlasOrreryPanelProps {
  center: string;
  rootCenter: string;
  isRoot: boolean;
  trail: readonly string[];
  readout: Readout;
  edges: readonly AtlasFkEdge[];
  rows: Map<string, number>;
  /** Canonical sorted pack list — the hue-assignment order shared with the
   *  chart, so the node readout's pack dot matches its compass sector. */
  packs: readonly string[];
  /** physical → node, so breadcrumb/back/readout can show the friendly name
   *  ("People") over the SQL name the trail state actually holds. */
  nodeByPhysical: ReadonlyMap<string, AtlasGraphNode>;
  /** The current centre's sample rows, or `undefined` while in flight. Fetched
   *  by the parent for the centre only (never per-hover). */
  sample: SampleResult | undefined;
  /** The centre's total row count (from `rowsByTable`), for "+ N more". */
  centerRows: number | undefined;
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
  packs,
  nodeByPhysical,
  sample,
  centerRows,
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
                data-physical={t}
                disabled={t === center}
                onClick={() => onRecenter(t)}
              >
                {friendlyOf(nodeByPhysical, t)}
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
          Back to {friendlyOf(nodeByPhysical, rootCenter)}
        </button>
      </section>

      {/* A few of yours — up to three REAL rows of the current centre, each
          reduced to one display string. Only appears once the fetch settles
          (never a spinner); an errored fetch omits the section entirely. */}
      {sample?.status === 'ready' ? (
        <SampleSection rows={sample.rows} centerRows={centerRows} />
      ) : null}

      {/* hover / focus readout — a fixed panel, never a floating tooltip */}
      <section className={styles.roSec}>
        <p className={styles.roLabel}>Readout</p>
        <div className={styles.detail} data-testid="atlas-readout">
          {readout.kind === 'edge' ? (
            <EdgeReadout edge={readout.edge} nodeByPhysical={nodeByPhysical} />
          ) : readout.kind === 'node' ? (
            <NodeReadout
              node={readout.node}
              hop={readout.hop}
              centerFriendly={friendlyOf(nodeByPhysical, center)}
              edges={edges}
              rows={rows.get(readout.node.physical)}
              packs={packs}
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
              <b>Structural reference</b> a built-in connection; thicker = more filled in
            </span>
          </li>
          <li className={styles.lgRow}>
            <span className={cx(styles.lgSwatch, styles.lgGhost)} />
            <span className={styles.lgText}>
              <b>Ghost edge</b> a connection nothing fills yet — an empty kind, or a field left
              blank
            </span>
          </li>
          <li className={styles.lgRow}>
            <span className={cx(styles.lgSwatch, styles.lgAuthored)} />
            <span className={styles.lgText}>
              <b>Authored link</b> a link you or an agent made by hand — a separate thing, toggled
              by chip
            </span>
          </li>
          <li className={styles.lgRow}>
            <span className={cx(styles.lgSwatch, styles.lgSelf)} />
            <span className={styles.lgText}>
              <b>Self-reference</b> points back at its own kind — a hierarchy, drawn as a curl
            </span>
          </li>
          <li className={styles.lgRow}>
            <span className={cx(styles.lgSwatch, styles.lgRing)} />
            <span className={styles.lgText}>
              <b>Rings</b> steps away from the centre
            </span>
          </li>
        </ul>
      </section>
    </aside>
  );
}

function EdgeReadout({
  edge,
  nodeByPhysical,
}: {
  edge: AtlasFkEdge;
  nodeByPhysical: ReadonlyMap<string, AtlasGraphNode>;
}): JSX.Element {
  const fromName = friendlyOf(nodeByPhysical, edge.fromTable);
  const toName = friendlyOf(nodeByPhysical, edge.toTable);
  const pct = edge.childRows > 0 ? Math.round((edge.fill / edge.childRows) * 100) : 0;

  // The plain-language headline — real numbers, friendly names, leading the
  // readout. A ghost leads with what's missing; a live edge states how many rows
  // carry the reference. The SQL detail is demoted to the mono subtitle below.
  const headline = edge.ghost ? (
    edge.childRows === 0 ? (
      <>
        Nothing fills this yet — <b>{fromName}</b> is empty.
      </>
    ) : (
      <>
        An optional link nothing uses yet — all {fmt(edge.childRows)} <b>{fromName}</b> rows leave
        it blank.
      </>
    )
  ) : (
    <>
      <b>{fmt(edge.fill)}</b> of {fmt(edge.childRows)} <b>{fromName}</b> point to <b>{toName}</b>.
    </>
  );

  return (
    <>
      <p className={styles.dLede} data-testid="atlas-edge-lede">
        {headline}
      </p>
      {/* the mechanical truth, demoted — both physical table names + the column
          stay visible for power users and tests */}
      <p className={styles.dSig}>
        {edge.fromTable}
        <span className={styles.dKindCol}>.{edge.col}</span>
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
      {edge.ghost ? null : (
        <p className={styles.dNote}>
          {edge.notnull ? (
            <>
              <b>Always filled in:</b> the schema guarantees every row sets it — it could only fall
              empty if {fromName} had no rows.
            </>
          ) : (
            <>
              Optional: {pct}% of {fromName} fill it; the rest leave it blank.
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
  centerFriendly,
  edges,
  rows,
  packs,
}: {
  node: AtlasGraphNode;
  hop: number | null;
  centerFriendly: string;
  edges: readonly AtlasFkEdge[];
  rows: number | undefined;
  packs: readonly string[];
}): JSX.Element {
  const incident = edges.filter(
    (e) => !e.selfRef && (e.fromTable === node.physical || e.toTable === node.physical),
  );
  const inDeg = edges.filter((e) => e.toTable === node.physical && !e.selfRef).length;
  const carrying = incident.filter((e) => !e.ghost).length;
  const friendly = node.friendly ?? node.label;
  const hopTxt =
    hop === 0
      ? 'the centre'
      : hop === null
        ? 'not reachable from here'
        : `${hop} step${hop > 1 ? 's' : ''} from ${centerFriendly}`;
  return (
    <>
      <h3 className={styles.dKind}>{friendly}</h3>
      {/* the SQL name + pack + hop, demoted to the mono subtitle */}
      <p className={styles.dSig}>
        <span
          className={styles.dPackDot}
          style={{ '--pack-c': packHueVar(node.pack, packs) } as CSSProperties}
        />
        {node.physical} · {node.packLabel} · {hopTxt}
      </p>
      {node.blurb ? (
        <p className={styles.dLede} data-testid="atlas-node-blurb">
          {node.blurb}
        </p>
      ) : null}
      <div className={styles.dFigs}>
        <span className={styles.dFig}>
          <span className={styles.dFigN}>{rows === undefined ? '—' : fmt(rows)}</span>
          <span className={styles.dFigK}>rows</span>
        </span>
        <span className={styles.dFig}>
          <span className={styles.dFigN}>{fmt(inDeg)}</span>
          <span className={styles.dFigK}>point here</span>
        </span>
      </div>
      <p className={styles.dNote}>
        <b>{carrying}</b> of <b>{incident.length}</b>{' '}
        {incident.length === 1 ? 'connection carries' : 'connections carry'} rows.
        {node.selfRef ? ` Self-referencing: ${friendly} is a hierarchy, not a loop.` : ''}
      </p>
    </>
  );
}

function SampleSection({
  rows,
  centerRows,
}: {
  rows: Record<string, unknown>[];
  centerRows: number | undefined;
}): JSX.Element {
  // Reduce each real row to one display string, then note how many rows the
  // centre holds beyond the handful shown (only when that total is known).
  const shown = rows.map(pickSampleDisplay);
  const more = centerRows !== undefined ? Math.max(0, centerRows - shown.length) : 0;
  return (
    <section className={styles.roSec}>
      <p className={styles.roLabel}>A few of yours</p>
      {shown.length === 0 ? (
        <p className={styles.dEmpty} data-testid="atlas-samples-empty">
          Nothing here yet.
        </p>
      ) : (
        <ul className={styles.samples} data-testid="atlas-samples">
          {shown.map((text, i) => (
            <li key={`${i}:${text}`} className={styles.sampleRow}>
              {text}
            </li>
          ))}
          {more > 0 ? (
            <li className={styles.sampleMore} data-testid="atlas-samples-more">
              + {fmt(more)} more
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}
