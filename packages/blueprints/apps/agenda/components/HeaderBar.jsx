// The canvas header's dynamic half: Today + prev/next + the current range
// label + the Month/Week/Schedule segmented switch. The search box and the
// light/dark toggle are static HTML wired once in chrome.js (kit.js owns
// their behavior already — no per-render data to bind).
import { I } from '../icons.js';
import { Icon } from './Shared.jsx';

const VIEWS = [
  { key: 'month', label: 'Month' },
  { key: 'week', label: 'Week' },
  { key: 'schedule', label: 'Schedule' },
];

export function HeaderBar({ view, rangeLabel, onToday, onPrev, onNext, onSetView }) {
  return (
    <>
      <button type="button" className="kit-btn ag-today" onClick={onToday}>
        Today
      </button>
      <div className="ag-nav-arrows">
        <button type="button" className="kit-icon-btn" onClick={onPrev} aria-label="Previous">
          <Icon svg={I.chevronLeft} />
        </button>
        <button type="button" className="kit-icon-btn" onClick={onNext} aria-label="Next">
          <Icon svg={I.chevronRight} />
        </button>
      </div>
      <div className="ag-range-label">{rangeLabel}</div>
      <div className="kit-seg ag-view-seg" role="group" aria-label="View">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            className={view === v.key ? 'on' : ''}
            aria-pressed={String(view === v.key)}
            onClick={() => onSetView(v.key)}
          >
            {v.label}
          </button>
        ))}
      </div>
    </>
  );
}
