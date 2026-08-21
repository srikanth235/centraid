// The task editor (`tasks/task`) — a 720px measure, one field row per fact
// (spec §1, §5).
//
// THE ANCHOR CONTROL IS THE POINT OF THIS SCREEN. Two cards, each a sentence:
// *Every Monday, whether or not I did it. Rent.* against *3 days after I last
// finished it. Watering.* That single choice is the difference between a bill
// and a houseplant, and it is the place every recurring-task product in the
// category has failed by never asking. It writes through `organize-task`, the
// ONLY door for `recurrence_anchor`/`recurrence_tz`, which also requires the
// row's `sort_order` — preserved, never reset, or a member's manual order would
// quietly collapse every time they changed an anchor.
//
// The bar's second verb is Release. It is outlined secondary, because a task
// that will not be done is an outcome; Delete is the one outlined `net` control
// in this room.
import type { ReactNode } from "react";

import { PendingWriteActions } from "../../_shared/PendingWriteActions.tsx";
import { displayText } from "../../_shared/untrusted.ts";
import { dueLabel, isDateOnly } from "../format.ts";
import type { Project, Task } from "../types.ts";
import {
  ANCHOR_CARDS,
  ANCHOR_NOTE,
  DATE_ONLY_REMINDER,
  DELETE_CONFIRM,
  EFFORT_CHIPS,
  EFFORT_NOTE_A,
  EFFORT_NOTE_B,
  FIELDS,
  HOME_VAULT_NOTE_A,
  HOME_VAULT_NOTE_B,
  MISSED_NOTE_A,
  MISSED_NOTE_B,
  PRIORITY_CHIPS,
  PRIORITY_NOTE_A,
  PRIORITY_NOTE_B,
  PROMOTION_A,
  PROMOTION_B,
  PROMOTION_VERB,
  RELEASE_CONFIRM,
  REMINDER_NOTE_A,
  REMINDER_NOTE_B,
  SUBTASK_CAP,
  TAGS_NOTE_A,
  TAGS_NOTE_B,
  familyProgress,
  homeVault,
} from "../view-copy.ts";

import styles from "./Board.module.css";

/** At five children the editor states what the task has become and offers the
 *  promotion. The cap is a discipline, not an apology (§3). */
const PROMOTION_AT = 5;

function FieldRow({
  label,
  note,
  children,
}: {
  label: string;
  note?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <div className={styles.fieldRow}>
      <div className={styles.fieldKey}>{label}</div>
      <div className={styles.fieldBody}>
        {children}
        {note ? <div className={styles.fieldNote}>{note}</div> : null}
      </div>
    </div>
  );
}

export interface EditorProps {
  task: Task;
  now: string;
  projects: readonly Project[];
  /** The vault this task was born in and who else can see it, or null when it
   *  is the member's own — personal is silence. */
  home?: { vault: string; who: string } | null;
  onTitle: (title: string) => void;
  onPriority: (priority: number) => void;
  onEffort: (minutes: number) => void;
  onAnchor: (anchor: "scheduled" | "completion") => void;
  onProject: (projectId: string | null) => void;
  onAddTag: (label: string) => void;
  onRemoveTag: (tagId: string) => void;
  onAttach: () => void;
  onDetach: (attachmentId: string) => void;
  onPromote: () => void;
  onRelease: () => void;
  onDelete: () => void;
}

export function Editor(props: EditorProps): ReactNode {
  const { task } = props;
  const children = task.children ?? [];
  const anchor = task.recurrence_anchor ?? "scheduled";
  const due = task.next_due ?? task.due_at;

  return (
    <div className={styles.editor}>
      <input
        className={`kit-input ${styles.editorTitle}`}
        defaultValue={displayText(task.title)}
        aria-label={FIELDS.notes}
        onBlur={(event) => props.onTitle(event.currentTarget.value)}
      />

      <PendingWriteActions row={task as unknown as Record<string, unknown>} />

      <FieldRow
        label={FIELDS.when}
        note={isDateOnly(due) ? DATE_ONLY_REMINDER : null}
      >
        <span className={styles.num}>{dueLabel(due, props.now) ?? "—"}</span>
      </FieldRow>

      {task.recurrence_summary ? (
        <FieldRow
          label={FIELDS.repeats}
          note={
            <>
              <span>{MISSED_NOTE_A}</span> <span>{MISSED_NOTE_B}</span>
            </>
          }
        >
          <span>{displayText(task.recurrence_summary)}</span>
        </FieldRow>
      ) : null}

      {/* The two-card anchor control. Selected takes the raised surface and an
          ink border — no hue, because a control never carries the app's. */}
      {task.rrule ? (
        <FieldRow label={FIELDS.anchor} note={ANCHOR_NOTE}>
          <div className={styles.cards}>
            {ANCHOR_CARDS.map((card) => (
              <button
                key={card.value}
                type="button"
                className={styles.card}
                aria-pressed={anchor === card.value}
                onClick={() => props.onAnchor(card.value)}
              >
                <span className={styles.cardHead}>{card.head}</span>
                <span className={styles.cardBody}>{card.body}</span>
                <span className={styles.cardBody}>{card.tag}</span>
              </button>
            ))}
          </div>
        </FieldRow>
      ) : null}

      <FieldRow label={FIELDS.project}>
        <div className={styles.chipRow}>
          <button
            type="button"
            className="kit-chip"
            aria-pressed={!task.project_id}
            onClick={() => props.onProject(null)}
          >
            {FIELDS.landsIn}
          </button>
          {props.projects.map((project) => (
            <button
              key={project.project_id}
              type="button"
              className="kit-chip"
              aria-pressed={task.project_id === project.project_id}
              onClick={() => props.onProject(project.project_id)}
            >
              {displayText(project.name)}
            </button>
          ))}
        </div>
      </FieldRow>

      <FieldRow
        label={FIELDS.priority}
        note={
          <>
            <span>{PRIORITY_NOTE_A}</span> <span>{PRIORITY_NOTE_B}</span>
          </>
        }
      >
        <div className={styles.chipRow}>
          {PRIORITY_CHIPS.map((label, level) => (
            <button
              key={label}
              type="button"
              className="kit-chip"
              aria-pressed={(task.priority ?? 0) === level}
              onClick={() => props.onPriority(level)}
            >
              {label}
            </button>
          ))}
        </div>
      </FieldRow>

      <FieldRow
        label={FIELDS.effort}
        note={
          <>
            <span>{EFFORT_NOTE_A}</span> <span>{EFFORT_NOTE_B}</span>
          </>
        }
      >
        <div className={styles.chipRow}>
          {EFFORT_CHIPS.map((label, index) => (
            <button
              key={label}
              type="button"
              className="kit-chip"
              aria-pressed={(task.effort_min ?? 0) === [0, 5, 15, 25, 60][index]}
              onClick={() => props.onEffort([0, 5, 15, 25, 60][index] ?? 0)}
            >
              {label}
            </button>
          ))}
        </div>
      </FieldRow>

      <FieldRow
        label={FIELDS.reminder}
        note={
          <>
            <span>{REMINDER_NOTE_A}</span> <span>{REMINDER_NOTE_B}</span>
          </>
        }
      >
        <span className={styles.num}>
          {typeof task.remind_before_min === "number"
            ? `${task.remind_before_min} min`
            : "—"}
        </span>
      </FieldRow>

      <FieldRow
        label={FIELDS.tags}
        note={
          <>
            <span>{TAGS_NOTE_A}</span> <span>{TAGS_NOTE_B}</span>
          </>
        }
      >
        <div className={styles.chipRow}>
          {(task.tags ?? []).map((tag) => (
            <button
              key={tag.tag_id}
              type="button"
              className="kit-chip"
              onClick={() => props.onRemoveTag(tag.tag_id)}
            >
              {displayText(tag.label)}
            </button>
          ))}
          <input
            className={`kit-input ${styles.tagField}`}
            aria-label={FIELDS.tags}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              const value = event.currentTarget.value.trim();
              if (!value) return;
              props.onAddTag(value);
              event.currentTarget.value = "";
            }}
          />
        </div>
      </FieldRow>

      <FieldRow
        label={FIELDS.subtasks}
        note={
          children.length >= PROMOTION_AT ? (
            <>
              <span>{PROMOTION_A}</span> <span>{PROMOTION_B}</span>
            </>
          ) : (
            SUBTASK_CAP
          )
        }
      >
        <span className={styles.num}>
          {familyProgress(task.done_children ?? 0, children.length)}
        </span>
        {children.length >= PROMOTION_AT ? (
          <button type="button" className="kit-btn" onClick={props.onPromote}>
            {PROMOTION_VERB}
          </button>
        ) : null}
      </FieldRow>

      <FieldRow label={FIELDS.where}>
        <div className={styles.chipRow}>
          {(task.attachments ?? []).map((attachment) => (
            <button
              key={String(attachment.attachment_id)}
              type="button"
              className="kit-chip"
              onClick={() => props.onDetach(String(attachment.attachment_id))}
            >
              {displayText(attachment.title ?? "")}
            </button>
          ))}
          <button type="button" className="kit-btn" onClick={props.onAttach}>
            {FIELDS.where}
          </button>
        </div>
      </FieldRow>

      {props.home ? (
        <FieldRow
          label={FIELDS.landsIn}
          note={
            <>
              <span>{HOME_VAULT_NOTE_A}</span>{" "}
              <span>{HOME_VAULT_NOTE_B}</span>
            </>
          }
        >
          <span>
            {homeVault(
              displayText(props.home.vault),
              displayText(props.home.who)
            )}
          </span>
        </FieldRow>
      ) : null}

      <div className={styles.editorFoot}>
        <button type="button" className="kit-btn" onClick={props.onRelease}>
          {RELEASE_CONFIRM.verb}
        </button>
        <button
          type="button"
          className="kit-btn"
          data-net="true"
          onClick={props.onDelete}
        >
          {DELETE_CONFIRM.verb}
        </button>
      </div>
    </div>
  );
}
