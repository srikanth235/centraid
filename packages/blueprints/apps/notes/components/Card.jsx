// One note card in the masonry/list wall. `.nt-card` stays a DIRECT child of
// `.nt-wall` (CSS columns) — no wrapper div, matching tasks/components/Row.jsx's
// note about display:contents not being an option here either (CSS multi-col
// breaks on the child it sees, not a wrapper).
import { relTime } from '../kit.js';
import { checkStats, notebookColorVar, previewText } from '../format.js';
import { I } from '../icons.js';
import { Highlighted, Icon } from './Shared.jsx';

export function Card({ note, search, pending, onOpen, onTogglePin }) {
  const pinned = note.pinned === 1;
  // The list projection ships a `preview` + `check` tally (issue #404); older
  // payloads carried the full `body` — fall back to deriving from it so the
  // card renders either shape.
  const stats = note.check ?? checkStats(note.body);
  const preview = note.preview ?? previewText(note.body);
  const hasChecks = stats.total > 0;
  const notebookId = note.notebook_ids?.[0];
  const notebookName = note.notebook_names?.[0];
  const notebookColor = notebookId ? notebookColorVar(notebookId) : null;

  return (
    <article
      className={pending ? 'nt-card kit-pending' : 'nt-card'}
      tabIndex={0}
      role="button"
      onClick={() => onOpen(note.note_id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(note.note_id);
        }
      }}
    >
      <div className="nt-card-head">
        <div className="nt-card-title">
          <Highlighted text={note.title ?? ''} term={search} />
        </div>
        <button
          type="button"
          className={pinned ? 'nt-pin-btn pinned' : 'nt-pin-btn'}
          aria-label={pinned ? 'Unpin note' : 'Pin note'}
          aria-pressed={String(pinned)}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin(note);
          }}
        >
          <Icon svg={pinned ? I.pinCardFilled : I.pinCard} />
        </button>
      </div>
      <div className="nt-card-preview">
        <Highlighted text={preview} term={search} />
      </div>
      {hasChecks ? (
        <div className="nt-card-progress">
          <div className="nt-progress-track">
            <div
              className="nt-progress-bar"
              style={{
                width: `${stats.total ? Math.round((stats.done / stats.total) * 100) : 0}%`,
              }}
            />
          </div>
          <span className="nt-progress-label">
            {stats.done}/{stats.total}
          </span>
        </div>
      ) : null}
      {note.tags?.length ? (
        <div className="nt-card-tags">
          {note.tags.map((t) => (
            <span className="nt-tag-chip nt-tag-chip-static" key={t.tag_id}>
              #{t.label}
            </span>
          ))}
        </div>
      ) : null}
      <div className="nt-card-meta">
        {notebookId ? (
          <span className="nt-card-notebook">
            <span className="nt-nb-dot" style={{ background: notebookColor }} />
            {notebookName ?? 'Notebook'}
          </span>
        ) : null}
        <span className="nt-card-when">{relTime(note.updated_at)}</span>
        {pending ? <span className="kit-pending-chip">pending</span> : null}
      </div>
    </article>
  );
}
