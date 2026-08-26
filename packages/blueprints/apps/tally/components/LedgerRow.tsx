// ONE ROW, drawn once, used by every list in this app (spec §5's ledger row).
//
// Balances draws it twice — once per person, once per group. Activity draws it
// for an expense and for a settlement. A group's ledger, a friend's shared
// expenses, Spending's categories, Trash and Search all draw the same one.
// Eight lists, one component, because a row re-drawn per screen is eight
// chances for a figure to end up left-aligned, or for "you owe" to read as
// "you are owed" on the one screen nobody checked.
//
// THE FIGURE IS THE ROW'S POINT, and it is the only thing on it that carries a
// colour: `--net` where the amount means YOU OWE, plain ink where it means you
// are owed, the recessive rung where the balance is level. Never a green.
//
// NOTHING COUNTS AT THE MEMBER. There is no badge, no dot and no red: a debt
// that has stood for a month is a phrase in the meta sentence, and a held
// write is a 2px ink rule on the leading edge plus the words for it.
//
// EVERY STRING FROM THE VAULT GOES THROUGH `displayText`. A description, a
// group name and a person's name can all arrive from an import, a share or
// another member, and React escaping alone leaves invisible control characters
// able to spoof a label (apps/_shared/untrusted.ts).
import type { CSSProperties, ReactNode } from "react";

import { PendingWriteActions } from "../../_shared/PendingWriteActions.tsx";
import { displayText } from "../../_shared/untrusted.ts";
import { personHue } from "../format.ts";
import type { FigureTone } from "../format.ts";

import styles from "./Ledger.module.css";

/** One quiet trailing verb. Two on a pointer, one where a finger lands. */
export interface RowAct {
  label: string;
  run: () => void;
}

/** The status chip's tone. `seam` is "not yet, and not wrong"; `net` is ended
 *  — expired or refused — and is an OUTLINE, never a fill. */
export type StatusTone = "none" | "seam" | "net";

export interface LedgerRowProps {
  /** The person this row is about, if it is about one. The chip takes their
   *  point on the shared identity wheel, keyed by the stable party id. */
  chip?: { partyId: string; initials: string } | null;
  title: string;
  /** ONE sentence, clamped to one line: when, who paid, where, how divided. */
  meta?: string;
  /** A share of the largest row in this list, 0–100. Spending's only chart. */
  proportion?: number | null;
  status?: { label: string; tone?: StatusTone } | null;
  /** The right-aligned figure and the sub-label under it. */
  figure?: { text: string; tone: FigureTone; sub?: string } | null;
  acts?: readonly RowAct[];
  /** One act on touch, two on a pointer (§5). */
  narrow?: boolean;
  /** The row as the query handed it over, so the shared overlay engine can
   *  read the pending fields off it. A settled row passes nothing. */
  pendingRow?: Readonly<Record<string, unknown>> | null;
  onOpen?: () => void;
}

export function LedgerRow(props: LedgerRowProps): ReactNode {
  const pending = props.pendingRow?.pending === true;
  const acts = (props.acts ?? []).slice(0, props.narrow ? 1 : 2);
  const figure = props.figure;
  const body = (
    <>
      <span className={styles.title}>{displayText(props.title)}</span>
      {props.meta ? (
        <span className={`${styles.meta} ${styles.num}`}>
          {displayText(props.meta)}
        </span>
      ) : null}
    </>
  );

  return (
    <div
      className={styles.rowWrap}
      data-pending={pending ? "true" : undefined}
      data-row-title={props.title}
    >
      <div className={styles.row}>
        {props.chip ? (
          <span
            aria-hidden="true"
            className={styles.chip}
            style={
              { "--chip-hue": personHue(props.chip.partyId) } as CSSProperties
            }
          >
            {displayText(props.chip.initials)}
          </span>
        ) : null}

        {props.onOpen ? (
          <button type="button" className={styles.body} onClick={props.onOpen}>
            {body}
          </button>
        ) : (
          // A row with nowhere to go is TEXT. A button that did nothing would
          // still take a tab stop and still announce itself as pressable.
          <span className={styles.bodyStatic}>{body}</span>
        )}

        {typeof props.proportion === "number" ? (
          <span className={styles.bar} aria-hidden="true">
            <span
              className={styles.barFill}
              style={{ inlineSize: `${props.proportion}%` }}
            />
          </span>
        ) : null}

        {props.status ? (
          <span
            className={styles.status}
            data-tone={props.status.tone ?? "none"}
          >
            {props.status.label}
          </span>
        ) : null}

        {figure ? (
          <span className={styles.figWrap}>
            <span
              className={`${styles.fig} ${styles.num}`}
              data-tone={figure.tone}
            >
              {figure.text}
            </span>
            {figure.sub ? (
              <span className={styles.subFig}>{figure.sub}</span>
            ) : null}
          </span>
        ) : null}

        {acts.length > 0 ? (
          <span className={styles.acts}>
            {acts.map((act) => (
              <button
                key={act.label}
                type="button"
                className={`kit-plain-btn ${styles.quietVerb}`}
                onClick={() => act.run()}
              >
                {act.label}
              </button>
            ))}
          </span>
        ) : null}
      </div>

      {/* A held write speaks ON THE ROW THAT CARRIES IT, through the one
          shared overlay component every app uses — so parked, queued and
          conflict read identically in Tally and in Tasks. */}
      {pending && props.pendingRow ? (
        <div className={styles.pendingActions}>
          <PendingWriteActions row={props.pendingRow} />
        </div>
      ) : null}
    </div>
  );
}
