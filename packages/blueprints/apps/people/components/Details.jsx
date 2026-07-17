// The profile drawer shell (#detailsRoot root) — a dumb projection: `person`
// is the freshly-read PERSON (or null while the shell shows), `adders` is a
// snapshot of which "+ add" affordances are open. Every write flows out
// through the `on*` callback props into app.jsx's `drawerAct`/`toggleStar`/
// `logInteraction`; this component never calls the vault itself. Body
// sections live in DetailSections.jsx (kept separate to stay under the
// file-size cap); the "+ add" mini-forms live in AddRows.jsx.
import { I } from '../icons.js';
import { Icon } from './Shared.jsx';
import { Sections } from './DetailSections.jsx';

export function Details({
  person,
  nameGuess,
  color,
  adders,
  onClose,
  onMove,
  onMessage,
  onCall,
  onToggleStar,
  onToggleAdder,
  onAddRelationship,
  onAddDate,
  onToggleReminder,
  onAddTask,
  onToggleTask,
  onAddNote,
  onAddGift,
  onToggleGift,
  onAddDebt,
  onSettleDebt,
}) {
  const dp = person;
  return (
    <>
      <div className="d-details-backdrop" onClick={onClose}></div>
      <aside className="d-details" role="dialog" aria-modal="true" aria-label="Profile">
        <div className="d-details-head">
          <span className="lbl">Profile</span>
          <button type="button" className="d-details-x" aria-label="Close" onClick={onClose}>
            <Icon svg={I.close} />
          </button>
        </div>
        <div className="d-details-body">
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span
              style={{
                display: 'inline-flex',
                borderRadius: '999px',
                boxShadow: `0 8px 22px -6px color-mix(in oklab, ${color} 60%, transparent)`,
              }}
            >
              <kit-avatar name={nameGuess} size="72px" color={color}></kit-avatar>
            </span>
          </div>
          <div className="d-detail-name">{nameGuess}</div>
          <div className="d-detail-ext">{dp?.role || ''}</div>
          {dp ? (
            <Sections
              dp={dp}
              color={color}
              adders={adders}
              onMessage={onMessage}
              onCall={onCall}
              onToggleStar={onToggleStar}
              onToggleAdder={onToggleAdder}
              onAddRelationship={onAddRelationship}
              onAddDate={onAddDate}
              onToggleReminder={onToggleReminder}
              onAddTask={onAddTask}
              onToggleTask={onToggleTask}
              onAddNote={onAddNote}
              onAddGift={onAddGift}
              onToggleGift={onToggleGift}
              onAddDebt={onAddDebt}
              onSettleDebt={onSettleDebt}
            />
          ) : null}
        </div>
        <div className="d-details-foot">
          {dp ? (
            <button
              type="button"
              className="kit-btn d-detail-btn"
              onClick={(e) => onMove(e.currentTarget)}
            >
              Move to list
            </button>
          ) : null}
        </div>
      </aside>
    </>
  );
}
