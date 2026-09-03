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
import { WindowedRows } from "./Windowed.tsx";

import styles from "./Rows.module.css";

export interface ReviewScreenProps {
  register: ReviewRegister;
  windowCount: number;
  checkedAtClock: string | null;
  loaded: boolean;
  onShowThem: (key: CheckKey) => void;
  onChange: (row: LockerRow) => void;
}

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
          {/* Windowed (#883 C4): one verdict can hold the entire window — a
              vault of reused passwords is exactly the case this screen is
              for. The two REGISTERS above are not, and for their own reason:
              each is one row per check, and the checks are enumerated. */}
          <WindowedRows className={styles.list} rows={register.items}>
            {(row, position) => (
              <ItemRow
                key={row.item_id}
                position={position}
                row={row}
                verb={{
                  label: REVIEW_CHANGE_IT,
                  run: () => props.onChange(row),
                }}
              />
            )}
          </WindowedRows>
        </Section>
      ) : null}
    </div>
  );
}
