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

export type PanelFact = PanelFactData;

export type PanelFigure = PanelFigureData;

export interface PanelAction extends PanelActionData {
  onClick: () => void;
}

export interface PanelBlockProps {
  eyebrow?: string;
  title?: string;
  body?: string;
  quote?: boolean;
  figure?: PanelFigure;
  facts?: readonly PanelFact[];
  tone?: PanelTone;
  wide?: boolean;
  action?: PanelAction;
  action2?: PanelAction;
  className?: string;
}

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
                {/* The caveat belongs to THIS number. */}
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
