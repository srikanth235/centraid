import type { CSSProperties, JSX } from 'react';
import Icon from '../ui/Icon.js';
import type { SunburstDomain, SunburstKind } from './atlasSunburstGeometry.js';
import { pickSampleDisplay, type SampleResult } from './atlasSampleRows.js';
import styles from './AtlasRelationsTab.module.css';

// The Map's detail rail (issue #519 follow-on) — what one kind IS, in the place
// where you are already looking at it.
//
// This is where the FK graph finally lives. The old orrery drew every reference
// as an arc at once, which is a picture of the schema rather than an answer to
// a question; here the same edges are a short list of named neighbours you can
// walk one hop at a time. Nothing is aggregated and nothing is invented: a
// neighbour appears only because an FK column genuinely joins the two kinds.

const paintOf = (d: SunburstDomain): CSSProperties =>
  ({ '--hue': d.hue, '--hue2': d.hue2 }) as CSSProperties;

const fmt = (n: number): string => n.toLocaleString('en-US');

export interface AtlasKindDetailProps {
  domain: SunburstDomain;
  kind: SunburstKind;
  /** FK neighbours, fullest first. Empty when the graph payload never landed —
   *  the section then simply does not render, rather than claiming none exist. */
  neighbours: readonly SunburstKind[];
  /** True once the graph payload is known, so "no connections" can be stated
   *  honestly instead of being confused with "not loaded". */
  graphKnown: boolean;
  /** A few real rows of this kind, or `undefined` while in flight. */
  sample: SampleResult | undefined;
  onClose: () => void;
  onGoto: (logical: string) => void;
  onOpenBrowse: (logical: string) => void;
}

export default function AtlasKindDetail({
  domain,
  kind,
  neighbours,
  graphKnown,
  sample,
  onClose,
  onGoto,
  onOpenBrowse,
}: AtlasKindDetailProps): JSX.Element {
  const empty = kind.rows === 0;
  const shown = sample?.status === 'ready' ? sample.rows.map(pickSampleDisplay) : [];
  const more = Math.max(0, kind.rows - shown.length);

  return (
    <aside
      className={styles.detail}
      aria-label={`${kind.name} details`}
      data-testid="atlas-detail"
      data-logical={kind.logical}
      style={paintOf(domain)}
    >
      <div className={styles.detailTop}>
        <div>
          <h2 className={styles.detailName}>{kind.name}</h2>
          {/* the machine truth, demoted — never conflated with the human name */}
          <p className={styles.detailPhys}>{kind.logical}</p>
        </div>
        <button
          type="button"
          className={styles.detailClose}
          aria-label="Close details"
          data-testid="atlas-detail-close"
          onClick={onClose}
        >
          <Icon name="X" size={14} />
        </button>
      </div>

      {kind.blurb ? <p className={styles.detailBlurb}>{kind.blurb}</p> : null}

      <p className={styles.detailStat} data-testid="atlas-detail-count">
        {empty ? (
          <>
            <b>0</b>
            <span>records — this kind is ready, nothing has been added yet</span>
          </>
        ) : (
          <>
            <b>{fmt(kind.rows)}</b>
            <span>records</span>
          </>
        )}
      </p>

      {/* A few of yours — real rows, never a placeholder. An errored or
          in-flight fetch renders nothing at all rather than a spinner. */}
      {shown.length > 0 ? (
        <section className={styles.detailSect}>
          <p className={styles.detailSectHead}>A few of yours</p>
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
        </section>
      ) : null}

      {graphKnown ? (
        <section className={styles.detailSect}>
          <p className={styles.detailSectHead}>Connects to</p>
          {neighbours.length === 0 ? (
            <p className={styles.detailNote} data-testid="atlas-no-neighbours">
              Nothing in the schema joins this kind to another.
            </p>
          ) : (
            <div className={styles.hops}>
              {neighbours.map((n) => (
                <button
                  key={n.logical}
                  type="button"
                  className={styles.hop}
                  data-testid="atlas-hop"
                  data-logical={n.logical}
                  onClick={() => onGoto(n.logical)}
                >
                  <span className={styles.hopDot} />
                  {n.name}
                  <span className={styles.hopNum}>{n.rows === 0 ? '—' : fmt(n.rows)}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      ) : null}

      <button
        type="button"
        className={styles.detailBtn}
        data-testid="atlas-open-browse"
        onClick={() => onOpenBrowse(kind.logical)}
      >
        {empty ? `Add the first ${kind.name.toLowerCase()}` : `Open ${kind.name} in Browse`}
      </button>
    </aside>
  );
}
