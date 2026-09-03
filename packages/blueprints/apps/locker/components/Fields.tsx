import type { ReactNode } from "react";

import { Meter } from "../../_shared/Meter.tsx";
import { displayText } from "../../_shared/untrusted.ts";
import { SEALED_RUN } from "../item-fields.ts";
import { concealsInSeconds, revealedForSeconds } from "../permits.ts";
import { strength, useTotp } from "../totp.ts";
import {
  CONCEAL,
  COPY,
  REVEAL,
  SEALED_NOTE,
  SHOW_CODE,
  revealedNote,
} from "../view-copy.ts";

import styles from "./Rows.module.css";

export interface FieldAct {
  label: string;
  run: () => void;
}

export interface FieldRowProps {
  label: string;
  value?: string | null;
  note?: string;
  numeric?: boolean;
  acts?: readonly FieldAct[];
  children?: ReactNode;
}

export function FieldRow(props: FieldRowProps): ReactNode {
  return (
    <div className={styles.fieldRow}>
      <span className={styles.fieldKey}>{props.label}</span>
      <div className={styles.fieldBody}>
        {props.children ??
          (props.value == null ? null : (
            <span
              className={styles.fieldValue}
              {...(props.numeric ? { "data-numeric": "true" } : {})}
            >
              {displayText(props.value)}
            </span>
          ))}
        {props.note ? (
          <span
            className={styles.fieldNote}
            {...(props.numeric ? { "data-numeric": "true" } : {})}
          >
            {props.note}
          </span>
        ) : null}
      </div>
      {props.acts && props.acts.length > 0 ? (
        <div className={styles.fieldActs}>
          {props.acts.map((act, index) => (
            <button
              key={act.label}
              type="button"
              className={index === 0 ? "kit-btn" : "kit-btn quiet"}
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

export interface SealedFieldProps {
  label: string;
  field: string;
  revealed: string | null;
  revealedAt: number | null;
  now: number;
  note?: string;
  onReveal: (field: string) => void;
  onCopy: (field: string) => void;
  onConceal: (field: string) => void;
}

export function SealedField(props: SealedFieldProps): ReactNode {
  const open = props.revealed !== null && props.revealedAt !== null;
  const note = open
    ? revealedNote(
        revealedForSeconds(props.revealedAt ?? props.now, props.now),
        concealsInSeconds(props.revealedAt ?? props.now, props.now)
      )
    : (props.note ?? SEALED_NOTE);
  return (
    <div className={styles.fieldRow}>
      <span className={styles.fieldKey}>{props.label}</span>
      <div className={styles.fieldBody}>
        <span
          className={styles.fieldValue}
          {...(open
            ? { "data-revealed": "true" }
            : { "data-sealed": "true", "aria-label": "Sealed" })}
        >
          {open ? props.revealed : SEALED_RUN}
        </span>
        <span
          className={styles.fieldNote}
          {...(open ? { "data-numeric": "true" } : {})}
        >
          {note}
        </span>
      </div>
      <div className={styles.fieldActs}>
        {open ? (
          <>
            <button
              type="button"
              className="kit-btn"
              onClick={() => props.onCopy(props.field)}
            >
              {COPY}
            </button>
            <button
              type="button"
              className="kit-btn quiet"
              onClick={() => props.onConceal(props.field)}
            >
              {CONCEAL}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="kit-btn"
              onClick={() => props.onReveal(props.field)}
            >
              {REVEAL}
            </button>
            <button
              type="button"
              className="kit-btn quiet"
              onClick={() => props.onReveal(props.field)}
            >
              {COPY}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function StrengthField({
  password,
  onGenerate,
}: {
  password: string;
  onGenerate: () => void;
}): ReactNode {
  const score = strength(password);
  return (
    <FieldRow
      label="Strength"
      note="The same rule Review scores against, so the two can never disagree."
      {...(score.tone === "danger"
        ? { acts: [{ label: "Generate a new one", run: onGenerate }] }
        : {})}
    >
      <span className={styles.strength}>
        <span className={styles.meter}>
          <Meter ratio={score.ratio} tone={score.tone} />
        </span>
        <span className={styles.num}>
          {score.label} · {password.length} characters
        </span>
      </span>
    </FieldRow>
  );
}

export function TotpField({
  seed,
  now,
  revealedAt,
  onReveal,
  onCopy,
  onConceal,
}: {
  seed: string | null;
  now: number;
  revealedAt: number | null;
  onReveal: (field: string) => void;
  onCopy: (code: string) => void;
  onConceal: (field: string) => void;
}): ReactNode {
  const { code } = useTotp(seed);
  const rolls = 30 - (Math.floor(now / 1000) % 30);
  if (!seed || revealedAt === null) {
    return (
      <FieldRow
        label="One-time code"
        note="The seed is a secret; the six digits are a reveal of their own."
        numeric
        acts={[{ label: SHOW_CODE, run: () => onReveal("otp_seed") }]}
      >
        <span
          className={styles.fieldValue}
          data-sealed="true"
          aria-label="Sealed"
        >
          ••• •••
        </span>
      </FieldRow>
    );
  }
  return (
    <FieldRow
      label="One-time code"
      note={`Rolls in ${rolls} seconds · copying takes the code, never the seed.`}
      numeric
      acts={[
        { label: COPY, run: () => onCopy(code ?? "") },
        { label: CONCEAL, run: () => onConceal("otp_seed") },
      ]}
    >
      <span className={styles.fieldValue} data-numeric="true">
        {code ?? "••• •••"}
      </span>
    </FieldRow>
  );
}
