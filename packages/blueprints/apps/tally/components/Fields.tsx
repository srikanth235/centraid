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
  value: string | null;
  label: string;
  onPick: (id: string) => void;
}): ReactNode {
  return (
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

export function ValueRow({
  label,
  value,
  note,
  num,
}: {
  label: string;
  value: string;
  note?: string | readonly string[];
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

export function InlineInput({
  id,
  label,
  value,
  placeholder,
  type,
  onChange,
}: {
  id: string;
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
  figure: string;
  typed?: { value: string; label: string; onChange: (value: string) => void };
  note?: string;
}

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
  refusal?: string;
  run: () => void;
}

export function EditorFoot({
  copy,
  net,
  cancelLabel,
  onCancel,
  commit,
}: {
  copy: string;
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

export function Editor({ children }: { children: ReactNode }): ReactNode {
  return <div className={styles.editor}>{children}</div>;
}
