// The reading room (Notes spec §5): the card, the row, and their two arrangements.
// Every surface reads `promote()`, so none can disagree what a note is called.
// Nothing here notifies, counts unread, or keeps a streak.
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
  search?: string;
}

/** Sized by the surface's own `--target-min`, never a media query. */
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

/** Content type is STATED per kind, not three identical empty cards. */
function Placeholder({ kind }: { kind: "screenshot" | "link-only" | "audio" }) {
  return (
    <div className={styles.placeholder} data-kind={kind}>
      <span>{placeholderLabel(kind)}</span>
    </div>
  );
}

/** Age · notebook · marks. */
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
          // Member text (imports, share targets) — sanitised at the render boundary.
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
  /** Empty-set stand-in once the read has landed. */
  empty?: ReactNode;
  /** Window-end line when the projection has more. */
  foot?: ReactNode;
}

/** Both arrangements say the same things; width changes columns and measure, never type size. */
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
