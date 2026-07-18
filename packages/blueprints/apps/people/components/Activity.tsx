// Activity view (#activityView container, mounted whenever nav.kind ===
// 'activity'). The timeline atoms (`activity*`) and the 640px column (`jWrap`)
// are shared with DetailSections/Journal via shared.module.css; the empty
// state rides kit.css `.kit-empty*` (global strings).
import { daysSinceIso, fmt, hashInt, PALETTE } from '../format.ts';
import { I } from '../icons.ts';
import type { RecentItem } from '../types.ts';
import { Icon, KitAvatar } from './Shared.tsx';
import shared from './shared.module.css';

function ActivityItem({
  a,
  onOpenDetails,
}: {
  a: RecentItem;
  onOpenDetails: (id: string) => void;
}) {
  const color = a.avatar_color || PALETTE[hashInt(a.name) % PALETTE.length]!;
  return (
    <div className={shared.activityItem}>
      <div className={shared.activityRail}>
        <KitAvatar
          style={{ cursor: 'pointer' }}
          name={a.name}
          size="36px"
          color={color}
          onClick={() => a.party_id && onOpenDetails(a.party_id)}
        ></KitAvatar>
        <span className={shared.activityLine}></span>
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingTop: '2px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
          <span style={{ font: 'var(--t-strong)', fontSize: '14px' }}>{a.name}</span>
          <span className={shared.activityKind} style={{ color }}>
            {a.kind}
          </span>
          <span className={shared.activityDate} style={{ marginLeft: 'auto' }}>
            {fmt(daysSinceIso(a.occurred_at))}
          </span>
        </div>
        <p
          style={{
            margin: '4px 0 14px',
            font: 'var(--t-body)',
            color: 'var(--ink-2)',
            lineHeight: 1.5,
          }}
        >
          {a.text || ''}
        </p>
      </div>
    </div>
  );
}

export function Activity({
  recent,
  onOpenDetails,
}: {
  recent: RecentItem[];
  onOpenDetails: (id: string) => void;
}) {
  if (recent.length === 0) {
    return (
      <div className="kit-empty">
        <div className="kit-empty-icon">
          <Icon svg={I.activity} />
        </div>
        <div className="kit-empty-title">Nothing logged yet</div>
        <div className="kit-empty-sub">
          Log a message or call from anyone’s profile and it shows up here.
        </div>
      </div>
    );
  }
  return (
    <div className={shared.jWrap}>
      {recent.map((a, i) => (
        <ActivityItem key={i} a={a} onOpenDetails={onOpenDetails} />
      ))}
    </div>
  );
}
