// The decision card (#815). A decision is its own block, not a row: a row's
// one line, one meta and one verb cannot hold actor, artifact, grant offer and
// irreversible verb honestly. The whole title block is the disclosure target.
// Presentational only — open, editing and confirming are the caller's state,
// so a background refresh can never re-derive a decision out of a member's
// hands.
import type { JSX } from "react";

import Button from "./Button.js";
import { cx } from "./cx.js";

import styles from "./DecideBlock.module.css";

/**
 * One fact, on the shared `--w-key-col` grid. `field` is per-fact, never a
 * card-level flag: a computed fact offered as an input lets an approved card
 * misdescribe the write it approved.
 */
export interface DecideFact {
  key: string;
  value: string;
  /** Numeric register — ids, sizes, addresses. */
  mono?: boolean;
  /** This value is the part that leaves the device. */
  net?: boolean;
  field?: {
    label: string;
    multiline?: boolean;
    onChange: (next: string) => void;
  };
}

/** `net` is the OUTLINED destructive verb: a filled destructive button is not
 *  part of this grammar, whatever a confirm feels like (invariant 3). */
export type DecideActionKind = "commit" | "outline" | "net" | "quiet";

export interface DecideAction {
  label: string;
  onClick: () => void;
  kind?: DecideActionKind;
  /** Inert, with the reason stated as the card's `note`. */
  disabled?: boolean;
  hint?: string;
  /** Does this verb WRITE? Defaults true for `commit` and `net`. */
  commits?: boolean;
}

/** The standing-grant offer, made here — never as a separate screen. */
export interface DecideCheck {
  label: string;
  sub: string;
  on: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

export interface DecideBlockProps {
  /** The kind, in the micro caps register: `Staged write · personal`. */
  eyebrow: string;
  age?: string;
  title: string;
  sub?: string;
  open?: boolean;
  /** Presence turns the title block into the disclosure. */
  onToggle?: () => void;
  facts?: readonly DecideFact[];
  preview?: { label: string; body: string };
  check?: DecideCheck;
  /** One line under the facts: limitation, editing rule, or consequence. */
  note?: string;
  noteNet?: boolean;
  /** This decision's consequence leaves the device. */
  net?: boolean;
  /** Confirming in place: border goes `--net`, row is consequence + two verbs. */
  confirming?: boolean;
  /** At most three — a fourth verb means the decision is not reduced yet. */
  actions?: readonly DecideAction[];
  className?: string;
}

const VARIANT: Record<
  DecideActionKind,
  "primary" | "secondary" | "destructive" | "quiet"
> = {
  commit: "primary",
  net: "destructive",
  outline: "secondary",
  quiet: "quiet",
};

export default function DecideBlock({
  eyebrow,
  age,
  title,
  sub,
  open,
  onToggle,
  facts,
  preview,
  check,
  note,
  noteNet,
  net,
  confirming,
  actions,
  className,
}: DecideBlockProps): JSX.Element {
  const titleBlock = (
    <>
      <span className={styles.title}>{title}</span>
      {sub ? <span className={styles.sub}>{sub}</span> : null}
    </>
  );
  return (
    <section
      className={cx(styles.card, className)}
      data-confirm={confirming ? "true" : undefined}
      data-net={net ? "true" : undefined}
      data-open={open ? "true" : undefined}
    >
      <div className={styles.head}>
        <p className={styles.eyebrow}>{eyebrow}</p>
        {age ? <span className={styles.age}>{age}</span> : null}
      </div>
      {onToggle ? (
        <button
          aria-expanded={open === true}
          className={styles.titleBtn}
          onClick={() => onToggle()}
          type="button"
        >
          {titleBlock}
        </button>
      ) : (
        <div className={styles.titleBtn}>{titleBlock}</div>
      )}
      {facts && facts.length > 0 ? (
        <dl className={styles.facts}>
          {facts.map((fact) => (
            <div className={styles.fact} key={fact.key}>
              <dt className={styles.factKey}>{fact.key}</dt>
              <dd className={styles.factValue}>
                {fact.field ? (
                  fact.field.multiline ? (
                    <textarea
                      aria-label={fact.field.label}
                      className={styles.textarea}
                      onChange={(e) => fact.field?.onChange(e.target.value)}
                      value={fact.value}
                    />
                  ) : (
                    <input
                      aria-label={fact.field.label}
                      className={styles.input}
                      onChange={(e) => fact.field?.onChange(e.target.value)}
                      type="text"
                      value={fact.value}
                    />
                  )
                ) : (
                  <span
                    className={styles.factText}
                    data-mono={fact.mono ? "true" : undefined}
                    data-net={fact.net ? "true" : undefined}
                  >
                    {fact.value}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {preview ? (
        <div className={styles.preview}>
          <p className={styles.previewLabel}>{preview.label}</p>
          <p className={styles.previewBody}>{preview.body}</p>
        </div>
      ) : null}
      {check ? (
        // `aria-label` on the LABEL: the name is the offer's own words, not
        // the consequence line under them.
        <label aria-label={check.label} className={styles.check}>
          <input
            checked={check.on}
            className={styles.checkBox}
            disabled={check.disabled}
            onChange={(e) => check.onChange(e.target.checked)}
            type="checkbox"
          />
          <span className={styles.checkText}>
            <span className={styles.checkLabel}>{check.label}</span>
            <span className={styles.checkSub}>{check.sub}</span>
          </span>
        </label>
      ) : null}
      {note ? (
        <p className={styles.note} data-net={noteNet ? "true" : undefined}>
          {note}
        </p>
      ) : null}
      {actions && actions.length > 0 ? (
        <div className={styles.actions}>
          {actions.map((action) => {
            const kind = action.kind ?? "outline";
            return (
              <Button
                className={styles.action}
                commit={action.commits ?? (kind === "commit" || kind === "net")}
                disabled={action.disabled}
                key={action.label}
                label={action.label}
                onClick={() => action.onClick()}
                size="sm"
                title={action.hint}
                variant={VARIANT[kind]}
              />
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
