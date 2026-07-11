// List view: each row (#list root's mapped children), the head row
// (#listHead root) and the truncation footer (#windowFoot root).
import { avatarColor, circleName, daysSince, shortFmt, statusOf } from '../format.js';
import { I } from '../icons.js';
import { Icon, Snippet } from './Shared.jsx';

export function ListRow({ p, data, selectedIds, search, onOpenDetails, onToggleSelect, onOpenMenu }) {
  const color = avatarColor(p);
  const st = statusOf(p);
  const selected = selectedIds.has(p.party_id);
  return (
    <div className="d-row" data-selected={String(selected)}>
      <button
        type="button"
        className="d-check"
        aria-pressed={String(selected)}
        aria-label={`Select ${p.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect(p.party_id);
        }}
      >
        {selected ? <Icon svg={I.check} /> : null}
      </button>
      <kit-avatar
        style={{ cursor: 'pointer' }}
        name={p.name}
        size="34px"
        color={color}
        onClick={(e) => {
          e.stopPropagation();
          onOpenDetails(p.party_id);
        }}
      ></kit-avatar>
      <div className="d-row-main" onClick={() => onOpenDetails(p.party_id)}>
        <div className="d-row-title">
          {p.name}
          {p.starred ? (
            <span className="d-star-ind" aria-label="Favorite">
              ★
            </span>
          ) : null}
        </div>
        <div className="d-row-role">{p.role || ''}</div>
        {search.trim() && p.snippet ? <Snippet snippet={p.snippet} className="d-row-role" /> : null}
      </div>
      <span className="d-cell circle" onClick={() => onOpenDetails(p.party_id)}>
        {circleName(data, p.circle_id ?? null)}
      </span>
      <span className="d-cell last" onClick={() => onOpenDetails(p.party_id)}>
        {shortFmt(daysSince(p))}
      </span>
      <span className="d-cell status">
        <span className="kit-dotmini" style={{ background: st.color }}></span>
        {st.label}
      </span>
      <div className="d-row-end">
        <button
          type="button"
          className="d-kebab"
          aria-label={`Actions for ${p.name}`}
          aria-haspopup="menu"
          onClick={(e) => {
            e.stopPropagation();
            onOpenMenu(e.currentTarget, p);
          }}
        >
          <Icon svg={I.dots} />
        </button>
      </div>
    </div>
  );
}

export function ListHead({ rows, selectedIds, onToggleAll }) {
  const allSel = rows.length > 0 && rows.every((p) => selectedIds.has(p.party_id));
  return (
    <>
      <button
        type="button"
        className="d-check"
        aria-pressed={String(allSel)}
        aria-label={allSel ? 'Deselect all' : 'Select all'}
        onClick={() => onToggleAll(rows, allSel)}
      >
        {allSel ? <Icon svg={I.check} /> : null}
      </button>
      <span style={{ width: '34px' }}></span>
      <span className="d-col name">Name</span>
      <span className="d-col circle">Circle</span>
      <span className="d-col last">Last spoke</span>
      <span className="d-col status">Status</span>
      <span className="d-col end"></span>
    </>
  );
}

export function WindowFoot({ peopleWindow, onShowMore }) {
  return (
    <>
      <span>Showing your first {peopleWindow} people — the rest are a search away.</span>
      <button
        type="button"
        onClick={async (e) => {
          e.currentTarget.disabled = true;
          await onShowMore();
        }}
      >
        Show more
      </button>
    </>
  );
}
