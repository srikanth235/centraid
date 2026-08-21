// The reading room: the card, the row, and the two arrangements of them
// (Notes spec §5).
//
// ONE SHAPE FOR THE TITLED AND THE UNTITLED CASE. Every surface reads
// `promote()` — the first line stands in the title slot at the reading rung
// and the preview picks up below it — so a card, a row, a result and a chip
// cannot disagree about what a note is called.
//
// Nothing here notifies, counts unread or keeps a streak. A pile of 2,704
// unfiled notes is a fact the member can look at.
import type { ReactNode } from "react";

import { PendingWriteActions } from "../../_shared/PendingWriteActions.tsx";
import { displayText } from "../../_shared/untrusted.ts";
import {
  ageLabel,
  placeholderLabel,
  placeholderOf,
  promote,
  tallyLabel,
} from "../format.ts";
import type { LibraryView, Note } from "../types.ts";

import styles from "./Library.module.css";

/** Everything a card and a row both need. */
interface NoteProps {
  note: Note;
  onOpen: (noteId: string) => void;
  onTogglePin: (note: Note) => void;
  /** The term to say what a result matched, on the Search route. */
  search?: string;
}

/** The pin. A star is a 44px target on touch and 30 on pointer — the
 *  stylesheet reads the surface's own `--target-min`, never a media query. */
function Pin({ note, onTogglePin }: Pick<NoteProps, "note" | "onTogglePin">) {
  const pinned = note.pinned === 1;
  return (
    <button
      type="button"
      className={`kit-plain-btn ${styles.pin}`}
      aria-pressed={pinned}
      aria-label={pinned ? "Unpin this note" : "Pin this note"}
      onClick={(event) => {
        event.stopPropagation();
        onTogglePin(note);
      }}
    >
      <span aria-hidden="true">{pinned ? "★" : "☆"}</span>
    </button>
  );
}

/** The striped block a note with nothing to preview shows instead. The
 *  content type is STATED, so a screenshot, a pasted link and a voice memo
 *  are three different facts rather than three identical empty cards. */
function Placeholder({ kind }: { kind: "screenshot" | "link-only" | "audio" }) {
  return (
    <div className={styles.placeholder} data-kind={kind}>
      <span>{placeholderLabel(kind)}</span>
    </div>
  );
}

/** The foot every card and row carries: age · notebook · marks, all in
 *  annotation ink. The age is a fact, never a reprimand. */
function Foot({ note }: { note: Note }): ReactNode {
  const tally = tallyLabel(note.check);
  const notebook = (note.notebook_names ?? [])[0];
  const links = (note.references ?? []).length;
  return (
    <div className={styles.foot}>
      <span className={styles.num}>{ageLabel(note.updated_at)}</span>
      {notebook ? <span>{displayText(notebook)}</span> : null}
      {tally ? <span className={styles.num}>{tally}</span> : null}
      {links > 0 ? <span className={styles.num}>{links} links</span> : null}
    </div>
  );
}

export function NoteCard({ note, onOpen, onTogglePin, search }: NoteProps) {
  const shown = promote(note);
  const placeholder = placeholderOf(note);
  const preview = search && note.snippet ? note.snippet : shown.preview;
  return (
    <article className={styles.card}>
      <button
        type="button"
        className={`kit-plain-btn ${styles.open}`}
        onClick={() => onOpen(note.note_id)}
      >
        <span
          className={styles.title}
          data-untitled={String(shown.untitled)}
          // The heading is member text, and a note can arrive from an import,
          // a share target or another member — so it is sanitised at the
          // render boundary like every other vault string.
        >
          {displayText(shown.heading)}
        </span>
        {placeholder ? (
          <Placeholder kind={placeholder} />
        ) : (
          <span className={styles.preview}>{displayText(preview)}</span>
        )}
      </button>
      <Foot note={note} />
      <div className={styles.marks}>
        <Pin note={note} onTogglePin={onTogglePin} />
        <PendingWriteActions row={note} onEdit={() => onOpen(note.note_id)} />
      </div>
    </article>
  );
}

export function NoteRow({ note, onOpen, onTogglePin, search }: NoteProps) {
  const shown = promote(note);
  const meta = search && note.snippet ? note.snippet : shown.preview;
  return (
    <div className={styles.row}>
      <button
        type="button"
        className={`kit-plain-btn ${styles.rowOpen}`}
        onClick={() => onOpen(note.note_id)}
      >
        <span className={styles.title} data-untitled={String(shown.untitled)}>
          {displayText(shown.heading)}
        </span>
        <span className={styles.rowMeta}>{displayText(meta)}</span>
      </button>
      <span className={`${styles.num} ${styles.rowAge}`}>
        {ageLabel(note.updated_at)}
      </span>
      <Pin note={note} onTogglePin={onTogglePin} />
      <PendingWriteActions row={note} onEdit={() => onOpen(note.note_id)} />
    </div>
  );
}

export interface NoteSetProps {
  notes: readonly Note[];
  view: LibraryView;
  onOpen: (noteId: string) => void;
  onTogglePin: (note: Note) => void;
  search?: string;
  /** What stands in the set's place when it is empty and a read HAS landed. */
  empty?: ReactNode;
  /** The window-end line, when the projection said there is more behind it. */
  foot?: ReactNode;
}

/** One set of notes, in whichever arrangement the member chose. Both
 *  arrangements say the same things about the same notes; the width changes
 *  the column count and the measure, never the type size. */
export function NoteSet({
  notes,
  view,
  onOpen,
  onTogglePin,
  search,
  empty,
  foot,
}: NoteSetProps): ReactNode {
  if (notes.length === 0) return <>{empty}</>;
  return (
    <>
      <div className={view === "cards" ? styles.cards : styles.rows}>
        {notes.map((note) =>
          view === "cards" ? (
            <NoteCard
              key={note.note_id}
              note={note}
              onOpen={onOpen}
              onTogglePin={onTogglePin}
              {...(search ? { search } : {})}
            />
          ) : (
            <NoteRow
              key={note.note_id}
              note={note}
              onOpen={onOpen}
              onTogglePin={onTogglePin}
              {...(search ? { search } : {})}
            />
          )
        )}
      </div>
      {foot}
    </>
  );
}
