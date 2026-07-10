// The scrolling wall: the quick-add card, a "pending approval" strip for
// parked creates (no note_id exists yet, so these render as ghost cards),
// the pinned/others card groups (CSS-columns masonry, or a single narrow
// column in list view), the empty state and the bounded-window "Show more"
// footer. Mirrors tasks/components/Board.jsx's shape.
import { QuickAdd } from './QuickAdd.jsx';
import { Card } from './Card.jsx';
import { I } from '../icons.js';
import { Icon } from './Shared.jsx';

function PendingCreateCard({ item }) {
  return (
    <article className="nt-card kit-pending">
      <div className="nt-card-head">
        <div className="nt-card-title">{item.title || 'Untitled'}</div>
        <span className="kit-pending-chip">pending</span>
      </div>
    </article>
  );
}

export function Wall({
  view,
  showQuickAdd,
  quickAddProps,
  pendingCreates,
  pinned,
  others,
  showPinnedGroup,
  isEmpty,
  emptyTitle,
  emptySub,
  search,
  pendingNoteIds,
  footer,
  onShowMore,
  onOpenNote,
  onTogglePin,
}) {
  const wallClass = view === 'list' ? 'nt-wall list' : 'nt-wall';

  return (
    <div className="nt-scroll-inner">
      {showQuickAdd ? <QuickAdd {...quickAddProps} /> : null}

      {pendingCreates.length > 0 ? (
        <div className="nt-pending-strip">
          <div className="nt-eyebrow">
            <Icon svg={I.receipt} /> Pending approval
          </div>
          <div className={wallClass}>
            {pendingCreates.map((item) => (
              <PendingCreateCard key={item.key} item={item} />
            ))}
          </div>
        </div>
      ) : null}

      {showPinnedGroup ? (
        <>
          <div className="nt-eyebrow">
            <Icon svg={I.pinCard} /> Pinned
          </div>
          <div className={wallClass}>
            {pinned.map((note) => (
              <Card
                key={note.note_id}
                note={note}
                search={search}
                pending={pendingNoteIds.has(note.note_id)}
                onOpen={onOpenNote}
                onTogglePin={onTogglePin}
              />
            ))}
          </div>
          {others.length > 0 ? <div className="nt-eyebrow nt-eyebrow-others">Others</div> : null}
        </>
      ) : null}

      <div className={wallClass}>
        {others.map((note) => (
          <Card
            key={note.note_id}
            note={note}
            search={search}
            pending={pendingNoteIds.has(note.note_id)}
            onOpen={onOpenNote}
            onTogglePin={onTogglePin}
          />
        ))}
      </div>

      {isEmpty ? (
        <div className="kit-empty">
          <div className="kit-empty-icon">
            <Icon svg={I.empty} />
          </div>
          <div className="kit-empty-title">{emptyTitle}</div>
          <div className="kit-empty-sub">{emptySub}</div>
        </div>
      ) : null}

      {footer ? (
        <div className="kit-foot">
          <span>Showing your latest {footer.windowSize} notes — older ones are a search away.</span>
          <button type="button" className="kit-btn" onClick={onShowMore}>
            Show more
          </button>
        </div>
      ) : null}
    </div>
  );
}
