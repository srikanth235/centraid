// Sidebar region: the focus-view nav (with live counts) and the footer
// (today progress meter + the trust line) — two React roots, #sidebarNav and
// #sidebarFoot. The brand row and "New task" button around them are static
// HTML in index.html (stable, no per-render data), wired once in chrome.js.
import { I } from '../icons.js';
import { Icon } from './Shared.jsx';

const VIEWS = [
  { key: 'today', label: 'Today', icon: I.today },
  { key: 'upcoming', label: 'Upcoming', icon: I.upcoming },
  { key: 'anytime', label: 'Anytime', icon: I.anytime },
  { key: 'all', label: 'All open', icon: I.inbox },
  { key: 'logbook', label: 'Logbook', icon: I.logbook },
];

export function SidebarNav({ view, counts, onSelectView }) {
  return (
    <nav className="tk-nav" aria-label="Focus views">
      {VIEWS.map((v) => (
        <button
          key={v.key}
          type="button"
          className="tk-nav-item"
          aria-current={String(view === v.key)}
          onClick={() => onSelectView(v.key)}
        >
          <Icon svg={v.icon} />
          <span>{v.label}</span>
          <span className="tk-nav-count">{counts[v.key] ?? 0}</span>
        </button>
      ))}
    </nav>
  );
}

export function SidebarFoot({ progress }) {
  return (
    <div className="tk-side-foot">
      <div className="tk-progress">
        <div className="tk-progress-top">
          <span className="tk-eyebrow-label">Today</span>
          <span className="tk-progress-pct">{progress.pct}%</span>
        </div>
        <div className="tk-progress-track">
          <div className="tk-progress-bar" style={{ width: `${progress.pct}%` }} />
        </div>
        <div className="tk-progress-label">{progress.label}</div>
      </div>
      <div className="tk-consent-line">
        <Icon svg={I.shield} />
        <span>Every change is a receipted vault command</span>
      </div>
    </div>
  );
}
