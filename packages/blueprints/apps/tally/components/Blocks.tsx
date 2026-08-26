// The three blocks every Tally screen is built out of, beside the row (§5).
//
//   Section  a label, a count or a meta phrase, one underlined text verb, one
//            quiet verb on a pointer, the rows, and — when there are none — an
//            empty line IN THE SECTION'S OWN WORDS. A shelf is never empty on
//            another shelf's terms.
//   Hero     the display-rung figure, its label, and a sentence that says
//            WHERE THE FIGURE CAME FROM. Balances, a group and a friend each
//            take one; nothing else does, because a hero is an answer to the
//            screen's question and most screens are lists.
//   WindowEnd  a bounded window, saying how bounded. Drawn whether or not
//            there is more behind it: a window that happens to hold everything
//            still states how much that is.
import type { ReactNode } from "react";

import { iconForConcept, iconSvg } from "@centraid/design";

import { displayText } from "../../_shared/untrusted.ts";
import type { FigureTone } from "../format.ts";
import { windowEnd } from "../view-copy.ts";

import styles from "./Ledger.module.css";

/**
 * The back row, labelled with WHERE IT GOES.
 *
 * "Groups", not "Back": a member who descended into a group ledger should be
 * able to read the way out rather than remember it, and a bare chevron is a
 * control with no name. The glyph beside it is the shared registry's `back`
 * concept and is decorative — the word is the accessible name.
 */
export function BackRow({
  label,
  onBack,
}: {
  label: string;
  onBack: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className={`kit-plain-btn ${styles.backVerb}`}
      onClick={onBack}
    >
      <i
        aria-hidden="true"
        className={styles.backGlyph}
        // oxlint-disable-next-line react/no-danger -- registry output is the reviewed shared icon lowering.
        dangerouslySetInnerHTML={{
          __html: iconSvg(iconForConcept("back"), {
            size: 16,
            strokeWidth: 1.75,
          }),
        }}
      />
      {displayText(label)}
    </button>
  );
}

export interface SectionVerb {
  label: string;
  run: () => void;
}

export interface SectionProps {
  label: string;
  /** The count and what it counts, or the phrase that stands in for one. */
  meta?: string;
  /** The section's own verb — underlined, in the annotation rung. */
  verb?: SectionVerb | null;
  /** A second verb, on a pointer only: a phone's row is already carrying one. */
  verb2?: SectionVerb | null;
  narrow?: boolean;
  /** This section's own sentence for having nothing in it. */
  empty?: string;
  children?: ReactNode;
  /** How many rows are actually under it — the empty line's one gate, passed
   *  in rather than counted off `children`, because a caller that has read
   *  nothing yet must not be told the shelf is empty. */
  count: number;
}

export function Section(props: SectionProps): ReactNode {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionLabel}>{displayText(props.label)}</span>
        {props.meta ? (
          <span className={`${styles.sectionMeta} ${styles.num}`}>
            {displayText(props.meta)}
          </span>
        ) : null}
        {props.verb || (props.verb2 && !props.narrow) ? (
          <span className={styles.sectionVerbs}>
            {props.verb ? (
              <button
                type="button"
                className={`kit-plain-btn ${styles.textVerb}`}
                onClick={() => props.verb?.run()}
              >
                {props.verb.label}
              </button>
            ) : null}
            {props.verb2 && !props.narrow ? (
              <button
                type="button"
                className={`kit-plain-btn ${styles.quietVerb}`}
                onClick={() => props.verb2?.run()}
              >
                {props.verb2.label}
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      {props.count === 0 && props.empty ? (
        <p className={styles.empty}>{props.empty}</p>
      ) : (
        props.children
      )}
    </section>
  );
}

export interface HeroAct {
  label: string;
  run: () => void;
  /** Destructive acts are OUTLINED in `--net`, never filled — the
   *  `kit-btn destructive` recipe is exactly that. */
  destructive?: boolean;
}

export interface HeroProps {
  figure: string;
  tone: FigureTone;
  label: string;
  /** Where the figure came from — the sentence that makes it inspectable
   *  rather than an oracle. */
  sub: string;
  acts?: readonly HeroAct[];
}

export function Hero(props: HeroProps): ReactNode {
  return (
    <div className={styles.hero}>
      <span
        className={`${styles.heroFig} ${styles.num}`}
        data-tone={props.tone}
      >
        {props.figure}
      </span>
      <span className={styles.heroLabel}>{displayText(props.label)}</span>
      <p className={styles.heroSub}>{displayText(props.sub)}</p>
      {props.acts && props.acts.length > 0 ? (
        <div className={styles.heroActs}>
          {/* NO FILLED CONTROL HERE. The one filled ink button on a list route
              is the bar's `Add expense`; a second on the hero would be two
              answers to one question. */}
          {props.acts.map((act) => (
            <button
              key={act.label}
              type="button"
              className={act.destructive ? "kit-btn destructive" : "kit-btn"}
              onClick={() => act.run()}
            >
              {act.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function WindowEnd({
  shown,
  total,
  more,
  onShowMore,
  label,
}: {
  shown: number;
  total: number;
  more: boolean;
  onShowMore: () => void;
  label: string;
}): ReactNode {
  return (
    <div className={styles.windowEnd}>
      <span className={`${styles.sectionMeta} ${styles.num}`}>
        {windowEnd(shown, total)}
      </span>
      {more ? (
        <button type="button" className="kit-btn" onClick={onShowMore}>
          {label}
        </button>
      ) : null}
    </div>
  );
}

/** A note under a section: the rule it follows, and where relevant the gap tag
 *  a reviewer reads off the surface itself. */
export function Note({ children }: { children: ReactNode }): ReactNode {
  return <p className={styles.note}>{children}</p>;
}

/** The rows of one section, as a plain list host. */
export function Rows({ children }: { children: ReactNode }): ReactNode {
  return <div>{children}</div>;
}
