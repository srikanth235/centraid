import type { CSSProperties, ReactNode } from "react";

import { PendingWriteActions } from "../../_shared/PendingWriteActions.tsx";
import { displayText } from "../../_shared/untrusted.ts";
import { personHue } from "../format.ts";
import type { FigureTone } from "../format.ts";

import styles from "./Ledger.module.css";

export interface RowAct {
  label: string;
  run: () => void;
}

export type StatusTone = "none" | "seam" | "net";

export interface LedgerRowProps {
  chip?: { partyId: string; initials: string } | null;
  title: string;
  meta?: string;
  proportion?: number | null;
  status?: { label: string; tone?: StatusTone } | null;
  figure?: { text: string; tone: FigureTone; sub?: string } | null;
  acts?: readonly RowAct[];
  narrow?: boolean;
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
