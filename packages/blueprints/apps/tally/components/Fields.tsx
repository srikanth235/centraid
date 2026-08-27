// The composing surfaces' building blocks: the field row, the chip set, the
// two things a member types, the allocation table and the foot.
//
// ONE EDITOR SHAPE for Add expense, Settle up and Export (design reference's
// `eCfg`): a head, a lede, the typed fields, chips for everything else, and a
// foot that says WHERE THE WRITE WILL LAND before the commit rather than after
// it. Three separately-drawn editors would be three chances for the key column
// to start on a different edge.
//
// A CHIP IS A BUTTON WITH `aria-pressed`, which is what makes a chip set a set
// rather than a row of unrelated controls — the shared `kit-chip` recipe reads
// that attribute for its selected state, so nothing here restyles it.
//
// THE COMMIT CARRIES ITS OWN REFUSAL. Where a surface cannot write — a
// division the vault does not back, an expense with no group, an export that
// is an engineering ask — the button is disabled and the REASON is on the page
// beside it, not discovered by pressing. A disabled commit never takes the
// fill: `primary` is for a control that will actually do the thing.
import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";

import styles from "./Compose.module.css";

export interface ChipOption {
  id: string;
  label: string;
}

export function ChipSet({
  options,
  value,
  label,
  onPick,
}: {
  options: readonly ChipOption[];
  /** Which one is chosen, or `null` where none is. */
  value: string | null;
  /** The set's own accessible name — a group of chips is one control. */
  label: string;
  onPick: (id: string) => void;
}): ReactNode {
  return (
    // A chip set is ONE control, so it is a real `fieldset` with a name —
    // not a div wearing `role="group"`, which is the same claim made in a way
    // the platform cannot check.
    <fieldset className={styles.chips} aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className="kit-chip"
          aria-pressed={value === option.id}
          onClick={() => onPick(option.id)}
        >
          {displayText(option.label)}
        </button>
      ))}
    </fieldset>
  );
}

/** One field row (§5): a key column, a value or a chip set, and the note that
 *  carries the rule. A note may be SEVERAL lines, because some rules are
 *  genuinely two claims and each of them is its own sentence. */
export function FieldRow({
  label,
  note,
  children,
}: {
  label: string;
  note?: string | readonly string[];
  children: ReactNode;
}): ReactNode {
  const notes = note === undefined ? [] : [note].flat();
  return (
    <div className={styles.field}>
      <span className={styles.key}>{label}</span>
      <div className={styles.body}>
        {children}
        {notes.map((line) => (
          <span key={line} className={styles.note}>
            {line}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A field row whose value is a fact rather than a control. */
export function ValueRow({
  label,
  value,
  note,
  num,
}: {
  label: string;
  value: string;
  note?: string | readonly string[];
  /** Is the value a number? Then it is tabular and bidi-isolated. */
  num?: boolean;
}): ReactNode {
  return (
    <FieldRow label={label} {...(note ? { note } : {})}>
      <span className={num ? `${styles.value} ${styles.num}` : styles.value}>
        {displayText(value)}
      </span>
    </FieldRow>
  );
}

/** One of the two things a member types. The label is a real `<label>`: a key
 *  column that only looked like one would leave the input unnamed. */
export function TypedRow({
  id,
  label,
  value,
  placeholder,
  num,
  type,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  num?: boolean;
  type?: "text" | "date";
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <div className={styles.typedRow}>
      <label className={styles.typedKey} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type={type ?? "text"}
        className={num ? styles.typedNum : styles.typed}
        value={value}
        {...(placeholder ? { placeholder } : {})}
        {...(num ? { inputMode: "decimal" as const } : {})}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/** A short typed value INSIDE a field row — a currency code, a rate, a date. */
export function InlineInput({
  id,
  label,
  value,
  placeholder,
  type,
  onChange,
}: {
  id: string;
  /** Visually hidden: the field row's key column is the visible name, and this
   *  is what a screen reader reads when there are three of them in one row. */
  label: string;
  value: string;
  placeholder?: string;
  type?: "text" | "date";
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <input
      id={id}
      type={type ?? "text"}
      aria-label={label}
      className={`kit-input ${styles.inline}`}
      value={value}
      {...(placeholder ? { placeholder } : {})}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export interface AllocRow {
  partyId: string;
  name: string;
  /** The resolved share, always — even under a division the vault will not
   *  take, because the table is the review surface. */
  figure: string;
  /** What the member types beside them, where this division has them type. */
  typed?: { value: string; label: string; onChange: (value: string) => void };
  note?: string;
}

/** The allocation table, and the reconcile line under it. */
export function AllocTable({
  head,
  rows,
  reconcile,
  balanced,
}: {
  head: string;
  rows: readonly AllocRow[];
  reconcile: string;
  balanced: boolean;
}): ReactNode {
  return (
    <div>
      <div className={styles.tableHead}>{head}</div>
      {rows.map((row) => (
        <div key={row.partyId} className={styles.allocRow}>
          <span className={styles.allocName}>{displayText(row.name)}</span>
          {row.typed ? (
            <input
              type="text"
              inputMode="decimal"
              aria-label={row.typed.label}
              className={`kit-input ${styles.allocInput} ${styles.num}`}
              value={row.typed.value}
              onChange={(event) => row.typed?.onChange(event.target.value)}
            />
          ) : null}
          <span className={`${styles.allocValue} ${styles.num}`}>
            {row.figure}
          </span>
          <span className={styles.allocNote}>{row.note ?? ""}</span>
        </div>
      ))}
      <p className={styles.reconcile} data-off={balanced ? undefined : "true"}>
        {reconcile}
      </p>
    </div>
  );
}

export interface CommitState {
  label: string;
  /** Why it cannot fire, when it cannot. Present means disabled, and the
   *  reason travels with the control rather than being found by pressing it. */
  refusal?: string;
  run: () => void;
}

/** The editor's foot: where the write lands, then Cancel and the one commit. */
export function EditorFoot({
  copy,
  net,
  cancelLabel,
  onCancel,
  commit,
}: {
  copy: string;
  /** Does this foot read in the `--net` register — bytes leaving the device? */
  net?: boolean;
  cancelLabel: string;
  onCancel: () => void;
  commit: CommitState;
}): ReactNode {
  const blocked = commit.refusal !== undefined;
  return (
    <>
      {blocked ? <p className={styles.note}>{commit.refusal}</p> : null}
      <div className={styles.foot}>
        <span className={styles.footCopy} data-net={net ? "true" : undefined}>
          {copy}
        </span>
        <span className={styles.footActs}>
          <button type="button" className="kit-btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={blocked ? "kit-btn" : "kit-btn primary"}
            disabled={blocked}
            onClick={() => commit.run()}
          >
            {commit.label}
          </button>
        </span>
      </div>
    </>
  );
}

/** The head and lede every composing surface opens with. */
export function EditorHead({
  head,
  lede,
}: {
  head: string;
  lede: string;
}): ReactNode {
  return (
    <>
      <h2 className={styles.head}>{head}</h2>
      <p className={styles.lede}>{lede}</p>
    </>
  );
}

/** The editor's own frame. */
export function Editor({ children }: { children: ReactNode }): ReactNode {
  return <div className={styles.editor}>{children}</div>;
}
