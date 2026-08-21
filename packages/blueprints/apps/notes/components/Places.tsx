// The spine and the lens: the rail, the Notebooks route, the Tags route, the
// Trash and the version chain (Notes spec §5, §6).
//
// THE RAIL STATES THE DIVISION IN WORDS — *Notebooks · where a note lives*
// over *Tags · how a note is seen* — because the paralysis two filing systems
// create is a copy problem before it is a structure problem. A note lives in
// one notebook or in none; a tag never decides where anything lives.
import { useState } from "react";
import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";
import { ageLabel, daysLeft, promote } from "../format.ts";
import { BOOKS, JOURNAL, TAGS, notebookShelf } from "../shelves.ts";
import type { ShelfId } from "../shelves.ts";
import type { Note, NoteVersion, Notebook } from "../types.ts";
import {
  JOURNAL_ROW,
  RAIL_NOTEBOOKS,
  RAIL_TAGS,
  UNFILED_NOTE,
  UNFILED_ROW,
} from "../view-copy.ts";

import styles from "./Places.module.css";

export interface RailProps {
  shelf: ShelfId;
  notebooks: readonly Notebook[];
  counts: Map<string, number>;
  unfiled: number;
  tags: ReadonlyArray<{ concept_id: string; label: string }>;
  tagCounts: Map<string, number>;
  conceptId: string | null;
  unfiledOnly: boolean;
  onSelect: (shelf: ShelfId) => void;
  onSelectTag: (conceptId: string | null) => void;
  onToggleUnfiled: () => void;
}

function Count({ n }: { n: number }): ReactNode {
  return <span className={styles.count}>{n}</span>;
}

/** One tree row. 34 under a pointer, 44 on touch — the surface's own
 *  `--target-min`, never a breakpoint. */
function TreeRow({
  label,
  note,
  current,
  count,
  onSelect,
}: {
  label: string;
  note?: string;
  current: boolean;
  count?: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`kit-plain-btn ${styles.tree}`}
      aria-current={current ? "page" : undefined}
      onClick={onSelect}
    >
      <span className={styles.treeLabel}>{displayText(label)}</span>
      {note ? <span className={styles.treeNote}>{note}</span> : null}
      {count === undefined ? null : <Count n={count} />}
    </button>
  );
}

export function Rail(props: RailProps): ReactNode {
  return (
    <nav className={styles.rail} aria-label="Notebooks and tags">
      <p className={styles.head}>{RAIL_NOTEBOOKS}</p>
      <TreeRow
        label="Library"
        current={props.shelf === null}
        onSelect={() => props.onSelect(null)}
      />
      {/* Unfiled is a PLACE with no guilt copy: a note that was never filed
          still opens, and the row says exactly that. */}
      <TreeRow
        label={UNFILED_ROW}
        note={UNFILED_NOTE}
        current={props.unfiledOnly}
        count={props.unfiled}
        onSelect={props.onToggleUnfiled}
      />
      {/* Journal is a place, never an interleave — its own destination, and
          filtered out of every other view by the queries themselves. */}
      <TreeRow
        label={JOURNAL_ROW}
        current={props.shelf === JOURNAL}
        onSelect={() => props.onSelect(JOURNAL)}
      />
      {props.notebooks.map((book) => (
        <TreeRow
          key={book.notebook_id}
          label={book.name ?? "Notebook"}
          current={props.shelf === notebookShelf(book.notebook_id)}
          count={props.counts.get(book.notebook_id) ?? 0}
          onSelect={() => props.onSelect(notebookShelf(book.notebook_id))}
        />
      ))}
      <TreeRow
        label="All notebooks"
        current={props.shelf === BOOKS}
        onSelect={() => props.onSelect(BOOKS)}
      />

      <p className={styles.head}>{RAIL_TAGS}</p>
      {props.tags.map((tag) => (
        <TreeRow
          key={tag.concept_id}
          label={tag.label}
          current={props.conceptId === tag.concept_id}
          count={props.tagCounts.get(tag.concept_id) ?? 0}
          onSelect={() =>
            props.onSelectTag(
              props.conceptId === tag.concept_id ? null : tag.concept_id
            )
          }
        />
      ))}
      <TreeRow
        label="All tags"
        current={props.shelf === TAGS}
        onSelect={() => props.onSelect(TAGS)}
      />
    </nav>
  );
}

export interface NotebooksRouteProps {
  notebooks: readonly Notebook[];
  counts: Map<string, number>;
  unfiled: number;
  creating: boolean;
  renamingId: string | null;
  onOpen: (shelf: ShelfId) => void;
  onCreate: (name: string) => void;
  onStartCreate: () => void;
  onRename: (notebookId: string, name: string) => void;
  onStartRename: (notebookId: string | null) => void;
  onDelete: (book: Notebook) => void;
}

/** An inline name editor — the create and the rename are the same control,
 *  because they are the same act at two moments. */
function NameField({
  initial,
  label,
  onCommit,
  onCancel,
}: {
  initial: string;
  label: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className={styles.nameRow}>
      <input
        className={styles.nameInput}
        aria-label={label}
        value={value}
        autoFocus
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onCommit(value);
          if (event.key === "Escape") onCancel();
        }}
      />
      <button type="button" className="kit-btn" onClick={() => onCommit(value)}>
        Save
      </button>
      <button type="button" className="kit-btn" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

export function NotebooksRoute(props: NotebooksRouteProps): ReactNode {
  return (
    <div className={styles.list}>
      {props.creating ? (
        <NameField
          initial=""
          label="Notebook name"
          onCommit={props.onCreate}
          onCancel={() => props.onStartRename(null)}
        />
      ) : (
        <button
          type="button"
          className={`kit-btn ${styles.add}`}
          onClick={props.onStartCreate}
        >
          New notebook
        </button>
      )}
      <div className={styles.row} key="unfiled">
        <span className={styles.rowName}>{UNFILED_ROW}</span>
        <Count n={props.unfiled} />
      </div>
      {props.notebooks.map((book) =>
        props.renamingId === book.notebook_id ? (
          <NameField
            key={book.notebook_id}
            initial={book.name ?? ""}
            label="Notebook name"
            onCommit={(name) => props.onRename(book.notebook_id, name)}
            onCancel={() => props.onStartRename(null)}
          />
        ) : (
          <div className={styles.row} key={book.notebook_id}>
            <button
              type="button"
              className={`kit-plain-btn ${styles.rowOpen}`}
              onClick={() => props.onOpen(notebookShelf(book.notebook_id))}
            >
              <span className={styles.rowName}>
                {displayText(book.name ?? "Notebook")}
              </span>
            </button>
            <Count n={props.counts.get(book.notebook_id) ?? 0} />
            <button
              type="button"
              className="kit-btn"
              onClick={() => props.onStartRename(book.notebook_id)}
            >
              Rename
            </button>
            {/* Destructive, and therefore OUTLINED in `--net` — the danger
                tone is never a fill. */}
            <button
              type="button"
              className={`kit-btn ${styles.destructive}`}
              onClick={() => props.onDelete(book)}
            >
              Delete
            </button>
          </div>
        )
      )}
    </div>
  );
}

export interface TagsRouteProps {
  tags: ReadonlyArray<{ concept_id: string; label: string }>;
  counts: Map<string, number>;
  conceptId: string | null;
  onSelectTag: (conceptId: string | null) => void;
}

/** Tags are a LENS, so this route's rows narrow the library rather than
 *  standing as a place a note could be moved into. */
export function TagsRoute(props: TagsRouteProps): ReactNode {
  return (
    <div className={styles.list}>
      {props.tags.map((tag) => (
        <div className={styles.row} key={tag.concept_id}>
          <button
            type="button"
            className={`kit-plain-btn ${styles.rowOpen}`}
            aria-pressed={props.conceptId === tag.concept_id}
            onClick={() =>
              props.onSelectTag(
                props.conceptId === tag.concept_id ? null : tag.concept_id
              )
            }
          >
            <span className={styles.rowName}>{displayText(tag.label)}</span>
          </button>
          <Count n={props.counts.get(tag.concept_id) ?? 0} />
        </div>
      ))}
    </div>
  );
}

export interface TrashRouteProps {
  notes: readonly Note[];
  onRestore: (noteId: string) => void;
}

/** The trash row: the note's own heading, its notebook, its days left in
 *  tabular numerals, and Restore — which puts it back in place with its
 *  links, its tags and its files. */
export function TrashRoute(props: TrashRouteProps): ReactNode {
  return (
    <div className={styles.list}>
      {props.notes.map((note) => {
        const shown = promote(note);
        const left = daysLeft(note.purge_at);
        return (
          <div className={styles.row} key={note.note_id}>
            <span className={styles.rowName}>{displayText(shown.heading)}</span>
            <span className={styles.rowMeta}>
              {displayText((note.notebook_names ?? [])[0] ?? UNFILED_ROW)}
            </span>
            {left === null ? null : (
              <span className={styles.count}>{left} days left</span>
            )}
            <button
              type="button"
              className="kit-btn"
              onClick={() => props.onRestore(note.note_id)}
            >
              Restore
            </button>
          </div>
        );
      })}
    </div>
  );
}

export interface HistoryRouteProps {
  versions: readonly NoteVersion[];
  onRestore: (contentId: string) => void;
}

/**
 * The version chain, newest first. RESTORING APPENDS: the row's control puts
 * an earlier body back at the head of the chain and nothing between is lost,
 * which is why the status line under this route says so in as many words.
 */
export function HistoryRoute(props: HistoryRouteProps): ReactNode {
  return (
    <div className={styles.list}>
      {props.versions.map((version) => (
        <div className={styles.row} key={version.content_id}>
          <span className={`${styles.rowName} ${styles.when}`}>
            {ageLabel(version.asserted_at)}
          </span>
          <span className={styles.rowMeta}>
            {displayText(version.body.slice(0, 90))}
          </span>
          {version.current ? (
            <span className={styles.count}>current</span>
          ) : (
            <button
              type="button"
              className="kit-btn"
              onClick={() => props.onRestore(version.content_id)}
            >
              Restore
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
