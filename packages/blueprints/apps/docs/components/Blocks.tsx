// The block vocabulary the app's non-drive screens compose from (Docs spec
// §4.3's `panelBlock` / `rowsBlock` / `sectionBlock` / `noteBlock`).
//
// THE VOCABULARY IS THE SYSTEM'S, NOT THIS APP'S. Every screen the shelf model
// names — capabilities, storage, the ways in, the bulk queue, the picker, the
// Locker boundary — is the same four shapes in a different order, and the
// handoff builds all of them from one kit for that reason. Written once here,
// they cannot drift into six dialects of "a bordered box with a heading", and
// a screen becomes a list of what it has to SAY rather than a page of markup.
//
// Each block is deliberately small and prop-driven: no state, no data access,
// no knowledge of which screen it is standing in. What a screen says is the
// screen's business; how a fact looks is this file's.
import type { ReactNode } from "react";

import type { ACTION_ICONS } from "../icons.ts";
import { ActionBtn } from "./Shared.tsx";

import styles from "./Blocks.module.css";

/** One `key: value` line inside a panel. */
export interface Fact {
  /** The property, in the micro register — "what leaves the device". */
  k: string;
  /** The answer, in the member's own words. */
  v: string;
  /**
   * This fact is the one that costs something — bytes leaving the device, a
   * limit passed, a refusal. It takes `--net`, the product's one "this reaches
   * outside / this cannot be undone" hue, and never more than a line or two of
   * a panel carries it.
   */
  net?: boolean;
}

/** One bounded verb under a panel or on a row. */
export interface Act {
  label: string;
  /** The verb's shape, from the app's one table (`icons.ts` `ACTION_ICONS`).
   *  Optional: these panels also carry verbs that are CONSENTS rather than
   *  actions on a document ("Turn it on"), and there is no honest shape for
   *  those in a table keyed by what the drive does to a file. */
  icon?: keyof typeof ACTION_ICONS;
  onClick?: () => void;
  /** The one commit. At most one per panel — a panel with two filled buttons
   *  is a panel that has not decided what it is asking. */
  filled?: boolean;
  /** Irreversible, or it reaches outside the device. */
  net?: boolean;
  /** Present and unpressable, with the reason, rather than absent: a verb
   *  that vanishes teaches nothing about why it is unavailable. */
  disabledReason?: string;
}

/**
 * The workhorse. An eyebrow (what state this is), a title (the finding), a
 * body (the sentence), facts (the evidence), and up to two verbs.
 *
 * A panel is what a ROW cannot be: a row holds a label, a value and one verb,
 * and the moment a thing needs an actor, an artifact and a consequence stated
 * together it stops fitting on a row honestly.
 */
export function Panel({
  eyebrow,
  title,
  body,
  facts,
  actions,
  net,
  children,
}: {
  eyebrow?: string;
  title: string;
  body?: string;
  facts?: readonly Fact[];
  actions?: readonly Act[];
  /** The whole panel is a refusal or a cost — it takes the `--net` edge. */
  net?: boolean;
  children?: ReactNode;
}): ReactNode {
  return (
    <section className={styles.panel} data-net={String(net === true)}>
      {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
      <h2 className={styles.title}>{title}</h2>
      {body ? <p className={styles.body}>{body}</p> : null}
      {facts && facts.length > 0 ? (
        <dl className={styles.facts}>
          {facts.map((fact) => (
            <div className={styles.fact} key={fact.k}>
              <dt className={styles.factKey}>{fact.k}</dt>
              <dd
                className={styles.factValue}
                data-net={String(fact.net === true)}
              >
                {fact.v}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {children}
      {actions && actions.length > 0 ? (
        <div className={styles.acts}>
          {actions.map((act) => (
            <ActButton act={act} key={act.label} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** A panel's or a row's verb, in the one shape both use. */
function ActButton({ act }: { act: Act }): ReactNode {
  const off = act.disabledReason !== undefined;
  // A filled control that cannot be pressed stops being filled — the fill is
  // the promise that pressing it does something.
  const tone = `${act.filled === true && !off ? "primary" : ""}${
    act.net === true ? " danger" : ""
  }`.trim();
  // Bound once here rather than passing `act.onClick` straight through: the
  // handler naming rule wants a `handle*` identifier at the call site, and one
  // binding serves both branches below.
  const handleClick = (): void => void act.onClick?.();
  if (act.icon)
    return (
      <ActionBtn
        icon={act.icon}
        label={act.label}
        tone={tone}
        onClick={handleClick}
        extra={{ disabled: off, title: act.disabledReason }}
      />
    );
  return (
    <button
      type="button"
      className={`kit-btn${tone ? ` ${tone}` : ""}`}
      disabled={off}
      title={act.disabledReason}
      onClick={handleClick}
    >
      {act.label}
    </button>
  );
}

/** One row: a label, the sentence under it, a reading, and at most one verb. */
export interface Row {
  id: string;
  label: string;
  sub?: string;
  /** The reading at the trailing edge — "on", "1,728", "never". */
  meta?: string;
  action?: Act;
  /** This row names a cost or a refusal. */
  net?: boolean;
}

/** A set of rows, bordered as one object. */
export function Rows({
  rows,
  ariaLabel,
}: {
  rows: readonly Row[];
  ariaLabel: string;
}): ReactNode {
  return (
    /* A real <ul>, not a div wearing role="list". The semantics are the same
       to a reader, but only the element carries them without a second
       attribute to keep in sync — and the a11y profile prefers the element. */
    <ul className={styles.rows} aria-label={ariaLabel}>
      {rows.map((row) => (
        <li
          className={styles.row}
          key={row.id}
          data-net={String(row.net === true)}
        >
          <div className={styles.rowText}>
            <span className={styles.rowLabel}>{row.label}</span>
            {row.sub ? <span className={styles.rowSub}>{row.sub}</span> : null}
          </div>
          {row.meta ? <span className={styles.rowMeta}>{row.meta}</span> : null}
          {row.action ? <ActButton act={row.action} /> : null}
        </li>
      ))}
    </ul>
  );
}

/** A head ABOVE the thing it names, over its own hairline — never a caption
 *  inside the bordered box, which would make it part of the contents. */
export function Section({
  label,
  meta,
}: {
  label: string;
  meta?: string;
}): ReactNode {
  return (
    <div className={styles.section}>
      <h3 className={styles.sectionLabel}>{label}</h3>
      {meta ? <span className={styles.sectionMeta}>{meta}</span> : null}
    </div>
  );
}

/** The closing sentence: what was deliberately NOT built, or the rule behind
 *  what was. Prose, once, under the thing it is about. */
export function Note({ children }: { children: ReactNode }): ReactNode {
  return <p className={styles.note}>{children}</p>;
}

/** Every non-drive screen's outer column, so they share one rhythm. */
export function Screen({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}): ReactNode {
  return (
    <div className={styles.screen} aria-label={label}>
      {children}
    </div>
  );
}
