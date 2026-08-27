// ACCESS HISTORY (README-Locker §1 `locker/access`, §2 "Receipts").
//
// An audit surface never invents a row: every line comes out of
// `consent.receipt`. No VALUE is shown — a reveal names the columns it opened
// and stops. No REFUSAL is hidden — a denial lists like an allowance. Receipts
// live in the journal, which the browser replica does not carry, so this read
// is online-only and the screen names the fact it is missing.
import type { ReactNode } from "react";

import {
  accessAt,
  accessMeta,
  accessVerb,
  accessWindowCopy,
} from "../access-model.ts";
import {
  ACCESS_ALL_ITEMS,
  ACCESS_EMPTY,
  ACCESS_EMPTY_BODY,
  ACCESS_ENTRIES,
  ACCESS_ENTRIES_META,
  ACCESS_HEAD,
  ACCESS_LEDE,
  ACCESS_NARROW,
  ACCESS_NO_VALUES,
  ACCESS_OFFLINE,
  ACCESS_REGISTER,
  ACCESS_WHERE,
} from "../route-copy.ts";
import type { LockerAccessEntry } from "../types.ts";
import { Section } from "./Rows.tsx";

import styles from "./Rows.module.css";

export interface AccessScreenProps {
  /** `null` before a read has landed — nothing is empty until one has. */
  entries: readonly LockerAccessEntry[] | null;
  window: { window: number; truncated: boolean } | null;
  itemId: string | null;
  titles: ReadonlyMap<string, string>;
  offline: boolean;
  onNarrow: (itemId: string | null) => void;
}

export function AccessScreen(props: AccessScreenProps): ReactNode {
  const entries = props.entries ?? [];
  return (
    <section className={styles.item}>
      <header className={styles.itemHead}>
        <h2 className={styles.screenTitle}>{ACCESS_HEAD}</h2>
        <p className={styles.lede}>{ACCESS_LEDE}</p>
      </header>

      <dl className={styles.facts}>
        {ACCESS_REGISTER.map(([kind, holds]) => (
          <div key={kind} className={styles.fact}>
            <dt className={styles.factKey}>{kind}</dt>
            <dd className={styles.factValue}>{holds}</dd>
          </div>
        ))}
      </dl>

      <p className={styles.fieldNote}>{ACCESS_NO_VALUES}</p>

      {props.offline ? (
        <p className={styles.fieldNote}>{ACCESS_OFFLINE}</p>
      ) : (
        <>
          {/* Narrowing is the query's own `item_id`, never a client filter
              over the drawn window. */}
          <div className={styles.lenses}>
            <button
              type="button"
              className="kit-chip quiet"
              aria-pressed={props.itemId === null}
              onClick={() => props.onNarrow(null)}
            >
              {ACCESS_ALL_ITEMS}
            </button>
            {props.itemId ? (
              <button
                type="button"
                className="kit-chip quiet"
                aria-pressed={true}
                onClick={() => props.onNarrow(props.itemId)}
              >
                {`${ACCESS_NARROW} · ${props.titles.get(props.itemId) ?? props.itemId}`}
              </button>
            ) : null}
          </div>

          <Section
            label={ACCESS_ENTRIES}
            meta={ACCESS_ENTRIES_META}
            count={entries.length}
            loaded={props.entries !== null}
            empty={
              <div className="kit-empty" data-variant="day-one">
                <div className="kit-empty-card">
                  <div className="kit-empty-title">{ACCESS_EMPTY}</div>
                  <div className="kit-empty-sub">{ACCESS_EMPTY_BODY}</div>
                </div>
              </div>
            }
          >
            {entries.map((entry) => (
              <div key={entry.receipt_id} className={styles.rowWrap}>
                <div className={styles.row}>
                  <span className={styles.open}>
                    <span className={styles.title}>{accessVerb(entry)}</span>
                    <span className={styles.meta}>
                      {accessMeta(
                        entry,
                        entry.item_id
                          ? (props.titles.get(entry.item_id) ?? entry.item_id)
                          : null
                      )}
                    </span>
                  </span>
                  {entry.decision === "deny" ? (
                    <span className={styles.status} data-tone="net">
                      REFUSED
                    </span>
                  ) : null}
                  <span className={`${styles.meta} ${styles.num}`}>
                    {accessAt(entry.occurred_at)}
                  </span>
                </div>
              </div>
            ))}
          </Section>

          {props.window && entries.length > 0 ? (
            <div className={styles.windowEnd}>
              <span className={styles.num}>
                {accessWindowCopy(entries.length, props.window.truncated)}
              </span>
            </div>
          ) : null}
        </>
      )}

      <p className={styles.fieldNote}>{ACCESS_WHERE}</p>
    </section>
  );
}
