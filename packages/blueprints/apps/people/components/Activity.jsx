// Activity view (#activityView container, mounted whenever nav.kind ===
// 'activity').
import { daysSinceIso, fmt, hashInt, PALETTE } from '../format.js';
import { I } from '../icons.js';
import { Icon } from './Shared.jsx';

function ActivityItem({ a, onOpenDetails }) {
  const color = a.avatar_color || PALETTE[hashInt(a.name) % PALETTE.length];
  return (
    <div className="d-activity-item">
      <div className="d-activity-rail">
        <kit-avatar
          style={{ cursor: 'pointer' }}
          name={a.name}
          size="36px"
          color={color}
          onClick={() => a.party_id && onOpenDetails(a.party_id)}
        ></kit-avatar>
        <span className="d-activity-line"></span>
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingTop: '2px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
          <span style={{ font: 'var(--t-strong)', fontSize: '14px' }}>{a.name}</span>
          <span className="d-activity-kind" style={{ color }}>
            {a.kind}
          </span>
          <span className="d-activity-date" style={{ marginLeft: 'auto' }}>
            {fmt(daysSinceIso(a.occurred_at))}
          </span>
        </div>
        <p style={{ margin: '4px 0 14px', font: 'var(--t-body)', color: 'var(--ink-2)', lineHeight: 1.5 }}>
          {a.text || ''}
        </p>
      </div>
    </div>
  );
}

export function Activity({ recent, onOpenDetails }) {
  if (recent.length === 0) {
    return (
      <div className="kit-empty">
        <div className="kit-empty-icon">
          <Icon svg={I.activity} />
        </div>
        <div className="kit-empty-title">Nothing logged yet</div>
        <div className="kit-empty-sub">Log a message or call from anyone’s profile and it shows up here.</div>
      </div>
    );
  }
  return (
    <div className="j-wrap">
      {recent.map((a, i) => (
        <ActivityItem key={i} a={a} onOpenDetails={onOpenDetails} />
      ))}
    </div>
  );
}
