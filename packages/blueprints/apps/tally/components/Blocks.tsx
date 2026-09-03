import type { ReactNode } from "react";

import { iconForConcept, iconSvg } from "@centraid/design";

import { displayText } from "../../_shared/untrusted.ts";
import type { FigureTone } from "../format.ts";
import { windowEnd } from "../view-copy.ts";

import styles from "./Ledger.module.css";

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
  meta?: string;
  verb?: SectionVerb | null;
  verb2?: SectionVerb | null;
  narrow?: boolean;
  empty?: string;
  children?: ReactNode;
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
  destructive?: boolean;
}

export interface HeroProps {
  figure: string;
  tone: FigureTone;
  label: string;
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

export function Note({ children }: { children: ReactNode }): ReactNode {
  return <p className={styles.note}>{children}</p>;
}

export function Rows({ children }: { children: ReactNode }): ReactNode {
  return <div>{children}</div>;
}
