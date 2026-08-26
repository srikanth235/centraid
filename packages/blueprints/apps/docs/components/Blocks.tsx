// The four shapes every non-drive screen composes from (Docs spec §4.3). Keep
// each prop-driven: no state, no data access, no knowledge of its screen.
import type { ReactNode } from "react";

import type { ACTION_ICONS } from "../icons.ts";
import { ActionBtn } from "./Shared.tsx";

import styles from "./Blocks.module.css";

export interface Fact {
  k: string;
  v: string;
  /** Egress, a limit passed, a refusal. At most a line or two per panel. */
  net?: boolean;
}

export interface Act {
  label: string;
  /** Optional: consent verbs have no shape in a file-action table. */
  icon?: keyof typeof ACTION_ICONS;
  onClick?: () => void;
  /** At most one per panel. */
  filled?: boolean;
  /** Irreversible, or it reaches outside the device. */
  net?: boolean;
  /** Set this rather than dropping the verb, which teaches nothing. */
  disabledReason?: string;
}

/** Use this, not `Row`, once an actor, an artifact and a consequence must be
 *  stated together. */
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

function ActButton({ act }: { act: Act }): ReactNode {
  const off = act.disabledReason !== undefined;
  // The fill promises that pressing does something; never fill a dead one.
  const tone = `${act.filled === true && !off ? "primary" : ""}${
    act.net === true ? " danger" : ""
  }`.trim();
  // The handler naming rule wants a `handle*` identifier at the call site.
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

/** At most one verb; more belongs in a `Panel`. */
export interface Row {
  id: string;
  label: string;
  sub?: string;
  meta?: string;
  action?: Act;
  net?: boolean;
}

export function Rows({
  rows,
  ariaLabel,
}: {
  rows: readonly Row[];
  ariaLabel: string;
}): ReactNode {
  return (
    /* A real <ul>, never a div wearing role="list". */
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

/** A head ABOVE the box it names, never a caption inside it. */
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

/** The closing sentence: a non-goal, or the rule behind what is there. */
export function Note({ children }: { children: ReactNode }): ReactNode {
  return <p className={styles.note}>{children}</p>;
}

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
