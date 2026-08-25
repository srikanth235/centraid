// The decision card (binding layer v11, #815).
//
// A row cannot hold an actor, an artifact, a standing-grant offer and an
// irreversible verb honestly: it has one line of text, one meta and one verb,
// so everything else it is given either truncates or lies about its geometry.
// A decision is therefore its own block.
//
// Collapsed it states who staged what and offers one outlined **Review**; the
// whole title block is the disclosure target, because a chevron beside a
// sentence a member is allowed to read is a second target for one act. Open it
// adds the facts, the preview of what the write would do, the standing-grant
// offer, and at most three verbs.
//
// Presentational only. Every piece of state — open, editing, confirming — is
// the caller's, so a background refresh can never take a decision out of a
// member's hands by re-deriving it here.
import type { JSX } from "react";

import Button from "./Button.js";
import { cx } from "./cx.js";

import styles from "./DecideBlock.module.css";

/**
 * One fact about the decision, on the shared `--w-key-col` grid.
 *
 * `field` is what makes a fact EDITABLE, and it is deliberately per-fact
 * rather than a card-level flag: only a value a member can author becomes an
 * input, and a computed fact — a size, a file count — stays stated, because a
 * computed fact offered as text lets an approved card misdescribe the write it
 * approved.
 */
export interface DecideFact {
  /** The displayed word in the key column. */
  key: string;
  value: string;
  /** Numeric register — ids, sizes, addresses. */
  mono?: boolean;
  /** This value is the part that leaves the device. */
  net?: boolean;
  field?: {
    /** Accessible name for the input — the fact's own human label. */
    label: string;
    multiline?: boolean;
    onChange: (next: string) => void;
  };
}

/**
 * `commit` is the one filled ink verb, `outline` the ordinary one, `net` the
 * OUTLINED destructive one (invariant 3 — a filled destructive button is not
 * part of this grammar, whatever a confirm feels like), and `quiet` the way
 * back out of a confirm.
 */
export type DecideActionKind = "commit" | "outline" | "net" | "quiet";

export interface DecideAction {
  label: string;
  onClick: () => void;
  kind?: DecideActionKind;
  /** Rendered inert, with the reason stated as the card's `note`. */
  disabled?: boolean;
  /** What tells ten identically-labelled verbs apart. */
  hint?: string;
  /** Does this verb WRITE? Defaults to true for `commit` and `net`, which are
   *  the two that do; an override exists for a verb that only navigates. */
  commits?: boolean;
}

/** The standing-grant offer, made where the decision is made — never as a
 *  separate screen — with the one line that says what it costs next time. */
export interface DecideCheck {
  label: string;
  sub: string;
  on: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

export interface DecideBlockProps {
  /** `Staged write · personal`, `Parked command · tier 3` — the kind, in the
   *  micro caps register. */
  eyebrow: string;
  /** How long it has been waiting. Numeric register, trailing the eyebrow. */
  age?: string;
  title: string;
  sub?: string;
  open?: boolean;
  /** Presence turns the title block into the disclosure. */
  onToggle?: () => void;
  facts?: readonly DecideFact[];
  /** "What it would do", behind a 2px leading rule on the sunken ground. */
  preview?: { label: string; body: string };
  check?: DecideCheck;
  /** One line under the facts: the honest limitation, the editing rule, or the
   *  consequence of the verb currently being confirmed. */
  note?: string;
  noteNet?: boolean;
  /** This decision's consequence leaves the device. */
  net?: boolean;
  /** An irreversible verb is being confirmed in place — the card's border
   *  becomes `--net` and the action row is the consequence plus two verbs. */
  confirming?: boolean;
  /** At most three. A fourth verb on a decision is a decision that has not been
   *  reduced to a decision yet. */
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

/** The decision card: eyebrow, title block, and — once open — facts, preview,
 *  the standing-grant offer and its verbs. */
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
        // `aria-label` on the LABEL, not the input: the checkbox takes its
        // accessible name from this element, and the name is the offer's own
        // words rather than the consequence line under them.
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
