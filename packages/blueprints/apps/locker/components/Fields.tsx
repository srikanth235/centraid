// THE FIELD ROW WITH VERBS (README-Locker §5).
//
// Key column · value · a note carrying the rule · a trailing act group. The
// row is the product's existing field row; the two things Locker added are a
// SEALED value (a letter-spaced dot run in the soft ink rung) and per-field
// verbs at the row's end. Both are variants of what already existed, which is
// why neither introduces a size, a weight or a colour.
//
// EVERY ROW CARRIES ITS OWN RULE. A metadata row says it never needed a
// permit; a sealed row says what revealing costs; a revealed row says how long
// it has left AND that the receipt is already written — past tense, because it
// is. That last sentence is the one that keeps a reveal from feeling free.
import type { ReactNode } from "react";

import { Meter } from "../../_shared/Meter.tsx";
import { displayText } from "../../_shared/untrusted.ts";
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

/** The dot run a sealed value wears. Fourteen, so no run's length leaks the
 *  secret's — a shorter password must not draw a shorter placeholder. */
const SEALED_RUN = "••••••••••••••";

export interface FieldAct {
  label: string;
  run: () => void;
}

export interface FieldRowProps {
  label: string;
  /** A metadata value, shown plainly. */
  value?: string | null;
  note?: string;
  /** Read in the numeric register — an expiry, a code, a count. */
  numeric?: boolean;
  /** The row's verbs, at its end. The first is the plain control, the rest
   *  quiet: a row with two equally weighted acts asks a question. */
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
  /** The permit's identity — a permit is minted for exactly this field. */
  field: string;
  /** The plaintext, present ONLY while a reveal is live. */
  revealed: string | null;
  /** When the reveal landed, for the countdown. */
  revealedAt: number | null;
  /** The clock this screen reads — one value per tick, so the note and the
   *  field it sits under cannot disagree by a second. */
  now: number;
  /** The rule this field carries while sealed. Defaults to §6's sentence. */
  note?: string;
  onReveal: (field: string) => void;
  onCopy: (field: string) => void;
  onConceal: (field: string) => void;
}

/**
 * A SEALED FIELD. Sealed it offers `Reveal` and `Copy`, and BOTH open the
 * permit gate — copying a secret without seeing it is still taking it, and
 * costs the same permit and the same receipt.
 */
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

/**
 * THE STRENGTH ROW. Scored by the same rule Review scores against
 * (`totp.ts` `strength`, which mirrors the vault's own `strengthScore`), so
 * the item view and the verdict list can never disagree — which is the whole
 * reason the meter is worth drawing at all.
 *
 * It reads the REVEALED password, so it appears only while one is on screen:
 * a meter over a sealed value would be a claim derived from something this
 * seat has not been given.
 */
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

/**
 * THE ONE-TIME CODE. The SEED is a secret; the six digits are a reveal of
 * their own, and copying takes the CODE, never the seed. The code is computed
 * on this device from the seed the permit bought — real RFC-6238, never a
 * round trip that would put the seed on a wire.
 */
export function TotpField({
  seed,
  now,
  revealedAt,
  onReveal,
  onCopy,
  onConceal,
}: {
  /** Present only while the seed's reveal is live. */
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
