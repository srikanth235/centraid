// The consent / explanation panel (v9 §8–9, #765).
//
// Eyebrow, title, body (optionally rule-quoted), a fact list on a fixed key
// column, and at most two actions — one filled and one outlined. `tone="net"`
// is the error state on every one of the six ops routes: a net BORDER, never
// a net fill.
import type { JSX } from "react";

import type {
  PanelActionData,
  PanelFactData,
  PanelFigureData,
  PanelTone,
} from "@centraid/design/blocks";

import Button from "./Button.js";
import { cx } from "./cx.js";

import styles from "./PanelBlock.module.css";

/** A fact is `key` (the displayed word, in the fixed column) + `value`; the
 *  `mono` and `net` registers are documented in the shared contract. */
export type PanelFact = PanelFactData;

/** The one promoted fact — display type over a qualifier line. */
export type PanelFigure = PanelFigureData;

/** The panel's own verb: the shared data plus this kit's click handler. */
export interface PanelAction extends PanelActionData {
  onClick: () => void;
}

export interface PanelBlockProps {
  eyebrow?: string;
  title?: string;
  body?: string;
  /** Draw the body as a quotation — indented behind a rule. Staged writes are
   *  quoted because the words are somebody else's. */
  quote?: boolean;
  /**
   * Promote ONE fact to display type. A page whose whole question is "did this
   * cost $2 or $200" answers it in the type scale or it does not answer it.
   * At most one per view, on the same grounds as the one filled commit.
   */
  figure?: PanelFigure;
  facts?: readonly PanelFact[];
  /** Edge tone. `net` and `seam` colour the border and the eyebrow, never a
   *  fill — see `PanelTone` for what each one means. */
  tone?: PanelTone;
  /** Drop the 62ch reading cap — a panel that is the whole view. */
  wide?: boolean;
  /** The panel's own action. Filled ONLY when this panel carries the view's
   *  one commit; outlined otherwise, and outlined in `--net` when dangerous. */
  action?: PanelAction;
  action2?: PanelAction;
  className?: string;
}

/** Bordered explanation panel with an optional fact list. */
export default function PanelBlock({
  eyebrow,
  title,
  body,
  quote,
  figure,
  facts,
  tone,
  wide,
  action,
  action2,
  className,
}: PanelBlockProps): JSX.Element {
  return (
    <section
      className={cx(styles.panel, className)}
      data-tone={tone}
      data-wide={wide ? "true" : undefined}
    >
      {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
      {title ? <h3 className={styles.title}>{title}</h3> : null}
      {body ? (
        <p className={styles.body} data-quote={quote ? "true" : undefined}>
          {body}
        </p>
      ) : null}
      {figure ? (
        <div
          className={styles.figure}
          data-net={figure.net ? "true" : undefined}
        >
          <p className={styles.figureLabel}>{figure.label}</p>
          <p className={styles.figureValue}>{figure.value}</p>
          {figure.qualifier ? (
            <p className={styles.figureQualifier}>{figure.qualifier}</p>
          ) : null}
        </div>
      ) : null}
      {facts && facts.length > 0 ? (
        <dl className={styles.facts}>
          {facts.map((fact) => (
            <div className={styles.fact} key={fact.key}>
              <dt className={styles.factKey}>{fact.key}</dt>
              <dd
                className={styles.factValue}
                data-mono={fact.mono ? "true" : undefined}
                data-net={fact.net ? "true" : undefined}
              >
                {fact.value}
                {/* The caveat belongs to THIS number, so it sits under it — a
                    footnote at the foot of the panel is a caveat the reader has
                    to match back up to the figure it qualifies. It leaves the
                    numeric register: a caveat is a sentence, not a value. */}
                {fact.note ? (
                  <span className={styles.factNote}>{fact.note}</span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {(action ?? action2) ? (
        <div className={styles.actions}>
          {action ? (
            <Button
              label={action.label}
              onClick={() => action.onClick()}
              variant={
                action.filled
                  ? "primary"
                  : action.dangerous
                    ? "destructive"
                    : "secondary"
              }
            />
          ) : null}
          {action2 ? (
            <Button
              commit={false}
              label={action2.label}
              onClick={() => action2.onClick()}
              variant="secondary"
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
