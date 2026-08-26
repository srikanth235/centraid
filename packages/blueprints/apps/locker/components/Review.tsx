// REVIEW — TWO REGISTERS AND THE ITEMS BEHIND THEM (README-Locker §5;
// FLOWS.md "Review triage").
//
// A VERDICT LIST, NOT A SCORE. The first register is what this product checks
// and what it found; the second is every check that could not run, with the
// reason — a check whose source does not exist, and a check whose source
// exists but whose data no read carries here, are both "nothing was checked"
// to a member, and both say so rather than reporting a zero they did not earn.
//
// ALL CLEAR IS A DESIGNED STATE. It says WHAT was checked and WHEN, because
// "nothing here" and "nothing was checked" are different facts and only one of
// them is reassuring.
import type { ReactNode } from "react";

import type { ReviewRegister } from "../review-model.ts";
import {
  ALL_CLEAR,
  CHECK_LABEL,
  NO_ANSWER,
  REVIEW_ATTENTION,
  REVIEW_CHANGE_IT,
  REVIEW_ITEMS,
  REVIEW_ITEMS_META,
  REVIEW_NOTHING,
  REVIEW_NOTHING_BODY,
  REVIEW_SHOW_THEM,
  REVIEW_UNRUNNABLE,
  REVIEW_UNRUNNABLE_META,
  allClearBody,
  checkedAt,
  verdictMeta,
} from "../route-copy.ts";
import type { CheckKey, LockerRow } from "../types.ts";
import { ItemRow, Section } from "./Rows.tsx";

import styles from "./Rows.module.css";

export interface ReviewScreenProps {
  register: ReviewRegister;
  /** How many items were read at all — the all-clear's own denominator. */
  windowCount: number;
  /** Wall clock of the read the verdicts were scored against. Absent until
   *  one has landed: a check time nobody measured is not a fact. */
  checkedAtClock: string | null;
  /** Has a read landed? Nothing is empty until one has. */
  loaded: boolean;
  /** Show the items behind one verdict, in the list. */
  onShowThem: (key: CheckKey) => void;
  /** Open the item that would fix it — the change, not the diagnosis. */
  onChange: (row: LockerRow) => void;
}

/** One check, as a row: its label, its reason, and the count as the status. */
function CheckRow({
  label,
  why,
  status,
  tone,
  verb,
}: {
  label: string;
  why: string;
  status: string;
  tone: "net" | "seam" | null;
  verb?: { label: string; run: () => void };
}): ReactNode {
  return (
    <div className={styles.rowWrap}>
      <div className={styles.row}>
        <span className={styles.checkBody}>
          <span className={styles.title}>{label}</span>
          <span className={styles.checkWhy}>{why}</span>
        </span>
        <span
          className={styles.status}
          {...(tone ? { "data-tone": tone } : {})}
        >
          {status}
        </span>
        {verb ? (
          <button
            type="button"
            className="kit-btn quiet"
            onClick={() => verb.run()}
          >
            {verb.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ReviewScreen(props: ReviewScreenProps): ReactNode {
  const { register } = props;
  if (!props.loaded) return null;

  return (
    <div className={styles.sections}>
      {register.allClear ? (
        <div className={styles.hero}>
          <p className={styles.heroFig}>{ALL_CLEAR}</p>
          {props.checkedAtClock ? (
            <p className={`${styles.heroLabel} ${styles.num}`}>
              {checkedAt(props.checkedAtClock)}
            </p>
          ) : null}
          <p className={styles.heroSub}>
            {props.windowCount === 0
              ? REVIEW_NOTHING_BODY
              : allClearBody(props.windowCount, register.ran.length)}
          </p>
          {props.windowCount === 0 ? (
            <p className={styles.heroSub}>{REVIEW_NOTHING}</p>
          ) : null}
        </div>
      ) : (
        <Section
          label={REVIEW_ATTENTION}
          meta={verdictMeta(register.verdicts, register.attention.length)}
          count={register.attention.length}
        >
          {register.attention.map((verdict) => (
            <CheckRow
              key={verdict.key}
              label={verdict.label}
              why={verdict.why}
              status={String(verdict.count)}
              tone={verdict.tone}
              verb={{
                label: REVIEW_SHOW_THEM,
                run: () => props.onShowThem(verdict.key),
              }}
            />
          ))}
        </Section>
      )}

      <Section
        label={REVIEW_UNRUNNABLE}
        meta={REVIEW_UNRUNNABLE_META}
        count={register.unrunnable.length}
      >
        {register.unrunnable.map((check) => (
          <CheckRow
            key={check.key}
            label={check.label ?? CHECK_LABEL[check.key] ?? check.key}
            why={check.why}
            status={NO_ANSWER}
            tone={null}
          />
        ))}
      </Section>

      {register.items.length > 0 ? (
        <Section
          label={REVIEW_ITEMS}
          meta={REVIEW_ITEMS_META}
          count={register.items.length}
        >
          {register.items.map((row) => (
            <ItemRow
              key={row.item_id}
              row={row}
              verb={{
                label: REVIEW_CHANGE_IT,
                run: () => props.onChange(row),
              }}
            />
          ))}
        </Section>
      ) : null}
    </div>
  );
}
