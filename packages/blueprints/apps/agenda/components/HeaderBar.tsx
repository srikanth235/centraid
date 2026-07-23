// The canvas header's dynamic half: Today + prev/next + the current range
// label + the Month/Week/Schedule segmented switch. The search box and the
// light/dark toggle are static HTML wired once in chrome.ts (kit.ts owns
// their behavior already — no per-render data to bind).
import { I } from '../icons.ts';
import { Icon } from './Shared.tsx';
import type { ViewKind } from '../types.ts';
import styles from './HeaderBar.module.css';

const VIEWS: { key: ViewKind; label: string }[] = [
  { key: 'month', label: 'Month' },
  { key: 'week', label: 'Week' },
  { key: 'schedule', label: 'Schedule' },
];

export function HeaderBar({
  view,
  rangeLabel,
  onToday,
  onPrev,
  onNext,
  onSetView,
}: {
  view: ViewKind;
  rangeLabel: string;
  onToday: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSetView: (v: ViewKind) => void;
}) {
  return (
    <>
      <button type="button" className={`kit-btn ${styles.today}`} onClick={onToday}>
        Today
      </button>
      <div className={styles.navArrows}>
        <button type="button" className="kit-icon-btn" onClick={onPrev} aria-label="Previous">
          <Icon svg={I.chevronLeft} />
        </button>
        <button type="button" className="kit-icon-btn" onClick={onNext} aria-label="Next">
          <Icon svg={I.chevronRight} />
        </button>
      </div>
      <div className={styles.rangeLabel}>{rangeLabel}</div>
      <div className={`kit-seg ${styles.viewSeg}`} role="group" aria-label="View">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            className={view === v.key ? 'on' : ''}
            aria-pressed={view === v.key}
            onClick={() => onSetView(v.key)}
          >
            {v.label}
          </button>
        ))}
      </div>
    </>
  );
}
