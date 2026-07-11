// Grid view card (#grid root's mapped children).
import { avatarColor, metaLine, statusOf } from '../format.js';
import { I } from '../icons.js';
import { Icon } from './Shared.jsx';

export function GridCard({ p, selectedIds, onOpenDetails, onToggleSelect, onToggleStar }) {
  const color = avatarColor(p);
  const st = statusOf(p);
  const selected = selectedIds.has(p.party_id);
  return (
    <div className="d-card" data-selected={String(selected)}>
      <div
        className="d-card-top"
        style={{ background: `color-mix(in oklab, ${color} 12%, transparent)` }}
        onClick={() => onOpenDetails(p.party_id)}
      >
        <kit-avatar name={p.name} size="58px" color={color}></kit-avatar>
      </div>
      <button
        type="button"
        className="d-card-select"
        aria-pressed={String(selected)}
        aria-label={`Select ${p.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect(p.party_id);
        }}
      >
        {selected ? <Icon svg={I.check} /> : null}
      </button>
      <button
        type="button"
        className={p.starred ? 'd-card-star on' : 'd-card-star'}
        aria-label="Favorite"
        onClick={(e) => {
          e.stopPropagation();
          onToggleStar(p);
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill={p.starred ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m12 3 2.6 5.6 6 .7-4.5 4.2 1.2 6-5.3-3-5.3 3 1.2-6L3.4 9.3l6-.7z"></path>
        </svg>
      </button>
      <div className="d-card-body" onClick={() => onOpenDetails(p.party_id)}>
        <div className="d-card-title">{p.name}</div>
        <div className="d-card-role">{p.role || ''}</div>
        <div className="d-card-meta">
          <span className="kit-dotmini" style={{ background: st.color }}></span>
          {metaLine(p)}
        </div>
      </div>
    </div>
  );
}
