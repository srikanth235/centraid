import type { ReactNode } from "react";

import {
  FILL_GET,
  FILL_GET_ROW,
  FILL_HEAD,
  FILL_LEDE,
  FILL_NOT_OFFERED,
  FILL_NOT_OFFERED_META,
  FILL_OFFERS,
  FILL_OFFERS_ROW,
  FILL_WHERE,
  FILL_WHERE_ROW,
} from "../route-copy.ts";
import { NOT_OFFERED } from "../view-copy.ts";
import { FieldRow } from "./Fields.tsx";
import { Section } from "./Rows.tsx";

import styles from "./Rows.module.css";

export function FillScreen(): ReactNode {
  const reasons: ReadonlyArray<readonly [string, string]> = [
    ["policy", NOT_OFFERED.policy],
    ["http", NOT_OFFERED.http],
    ["nomatch", NOT_OFFERED.nomatch],
  ];
  return (
    <section className={styles.item}>
      <header className={styles.itemHead}>
        <h2 className={styles.screenTitle}>{FILL_HEAD}</h2>
        <p className={styles.lede}>{FILL_LEDE}</p>
      </header>

      <FieldRow label={FILL_WHERE_ROW} note={FILL_WHERE} />
      <FieldRow label={FILL_GET_ROW} note={FILL_GET} />
      <FieldRow label={FILL_OFFERS_ROW} note={FILL_OFFERS} />

      <Section
        label={FILL_NOT_OFFERED}
        meta={FILL_NOT_OFFERED_META}
        count={reasons.length}
      >
        {reasons.map(([key, sentence]) => (
          <div key={key} className={styles.rowWrap}>
            <div className={styles.row}>
              <span className={styles.checkWhy}>{sentence}</span>
            </div>
          </div>
        ))}
      </Section>
    </section>
  );
}
