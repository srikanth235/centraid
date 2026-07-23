// Sidebar region: the focus-view nav (with live counts) and the footer
// (today progress meter + the trust line). Chrome owns the shared nav/footer
// containers; this component supplies only their app-specific contents.
import { I } from '../icons.ts';
import { Icon } from './Shared.tsx';
import type { SidebarCountsShape, TodayProgress, View } from '../types.ts';
import styles from './Sidebar.module.css';
import shared from './shared.module.css';

const VIEWS: Array<{ key: View; label: string; icon: string }> = [
  { key: 'today', label: 'Today', icon: I.today },
  { key: 'upcoming', label: 'Upcoming', icon: I.upcoming },
  { key: 'anytime', label: 'Anytime', icon: I.anytime },
  { key: 'all', label: 'All open', icon: I.inbox },
  { key: 'logbook', label: 'Logbook', icon: I.logbook },
];

export function SidebarNav({
  view,
  counts,
  onSelectView,
}: {
  view: View;
  counts: SidebarCountsShape;
  onSelectView: (view: View) => void;
}) {
  return (
    <>
      {VIEWS.map((v) => (
        <button
          key={v.key}
          type="button"
          className={styles.navItem}
          aria-current={view === v.key}
          onClick={() => onSelectView(v.key)}
        >
          <Icon svg={v.icon} />
          <span>{v.label}</span>
          <span className={styles.navCount}>{counts[v.key] ?? 0}</span>
        </button>
      ))}
    </>
  );
}

export function SidebarFoot({ progress }: { progress: TodayProgress }) {
  return (
    <>
      <div className={styles.progress}>
        <div className={styles.progressTop}>
          <span className={shared.eyebrowLabel}>Today</span>
          <span className={styles.progressPct}>{progress.pct}%</span>
        </div>
        <div className={styles.progressTrack}>
          <div className={styles.progressBar} style={{ width: `${progress.pct}%` }} />
        </div>
        <div className={styles.progressLabel}>{progress.label}</div>
      </div>
      <div className={styles.consentLine}>
        <Icon svg={I.shield} />
        <span>Every change is a receipted vault command</span>
      </div>
    </>
  );
}
