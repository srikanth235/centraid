// One note card in the masonry/list wall. `.card` (was `.nt-card`) stays a
// DIRECT child of the wall (CSS columns) — no wrapper div, matching
// tasks/components/Row.jsx's note about display:contents not being an option
// here either (CSS multi-col breaks on the child it sees, not a wrapper).
import { relTime } from '../kit.ts';
import { checkStats, notebookColorVar, previewText } from '../format.ts';
import { I } from '../icons.ts';
import { Highlighted, Icon } from './Shared.tsx';
import type { Note } from '../types.ts';
import styles from './Card.module.css';
import shared from './shared.module.css';

export function Card({
  note,
  search,
  pending,
  onOpen,
  onTogglePin,
}: {
  note: Note;
  search: string;
  pending: boolean;
  onOpen: (noteId: string) => void;
  onTogglePin: (note: Note) => void;
}) {
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
      className={pending ? `${styles.card} kit-pending` : styles.card}
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
      <div className={styles.cardHead}>
        <div className={styles.cardTitle}>
          <Highlighted text={note.title ?? ''} term={search} />
        </div>
        <button
          type="button"
          className={pinned ? `${styles.pinBtn} ${styles.pinned}` : styles.pinBtn}
          aria-label={pinned ? 'Unpin note' : 'Pin note'}
          aria-pressed={pinned}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin(note);
          }}
        >
          <Icon svg={pinned ? I.pinCardFilled : I.pinCard} />
        </button>
      </div>
      <div className={styles.cardPreview}>
        <Highlighted text={preview} term={search} />
      </div>
      {hasChecks ? (
        <div className={styles.cardProgress}>
          <div className={styles.progressTrack}>
            <div
              className={styles.progressBar}
              style={{
                width: `${stats.total ? Math.round((stats.done / stats.total) * 100) : 0}%`,
              }}
            />
          </div>
          <span className={styles.progressLabel}>
            {stats.done}/{stats.total}
          </span>
        </div>
      ) : null}
      {note.tags?.length ? (
        <div className={styles.cardTags}>
          {note.tags.map((t) => (
            <span className={`${shared.tagChip} ${styles.tagChipStatic}`} key={t.tag_id}>
              #{t.label}
            </span>
          ))}
        </div>
      ) : null}
      <div className={styles.cardMeta}>
        {notebookId ? (
          <span className={styles.cardNotebook}>
            <span className={shared.nbDot} style={{ background: notebookColor ?? undefined }} />
            {notebookName ?? 'Notebook'}
          </span>
        ) : null}
        <span className={styles.cardWhen}>{relTime(note.updated_at ?? '')}</span>
        {pending ? <span className="kit-pending-chip">pending</span> : null}
      </div>
    </article>
  );
}
