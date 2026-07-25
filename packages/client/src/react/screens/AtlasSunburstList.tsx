import type { CSSProperties, JSX } from 'react';
import { cx } from '../ui/cx.js';
import type { PackHues, RingItem } from './atlasSunburstGeometry.js';
import styles from './AtlasRelationsTab.module.css';

// The Map's text index (issue #519 follow-on) — the same rung the ring draws,
// as a plain list. This is NOT a decorative legend: it is the second half of a
// single selection model, and it exists because a wedge is a poor target for a
// screen reader, a keyboard, or anyone reading a name longer than its arc. Ring
// and list share `hot` and `selected`, so hovering either lights both, and
// every wedge is reachable by Tab without aiming at a pie slice.

/** Same paint vars the ring uses, so a row's dot is the exact colour of its
 *  wedge — including its position along the domain's tonal sweep. */
const paintOf = (p: PackHues & { mix?: string }): CSSProperties =>
  ({ '--hue': p.hue, '--hue2': p.hue2, '--mix': p.mix ?? '100%' }) as CSSProperties;

const fmt = (n: number): string => n.toLocaleString('en-US');

export interface AtlasSunburstListProps {
  heading: string;
  items: readonly RingItem[];
  hot: string | null;
  selected: string | null;
  onActivate: (id: string) => void;
  onHot: (id: string | null) => void;
}

export default function AtlasSunburstList({
  heading,
  items,
  hot,
  selected,
  onActivate,
  onHot,
}: AtlasSunburstListProps): JSX.Element {
  return (
    <div className={styles.index}>
      <p className={styles.indexHead}>{heading}</p>
      <div className={styles.rows} role="list" data-testid="atlas-index">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="listitem"
            className={cx(
              styles.row,
              item.empty && styles.rowEmpty,
              hot === item.id && styles.rowHot,
              selected === item.id && styles.rowSel,
            )}
            style={paintOf(item)}
            data-testid="atlas-index-row"
            data-id={item.id}
            data-empty={item.empty ? 'true' : 'false'}
            onClick={() => onActivate(item.id)}
            onMouseOver={() => onHot(item.id)}
            onMouseOut={() => onHot(null)}
            onFocus={() => onHot(item.id)}
            onBlur={() => onHot(null)}
          >
            <span className={styles.rowDot} />
            <span className={styles.rowName}>{item.name}</span>
            {/* An empty kind reads as an em dash, not a 0 — "none yet" is a
                different statement from "counted, and it was zero". */}
            <span className={styles.rowNum}>{item.empty ? '—' : fmt(item.rows)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
