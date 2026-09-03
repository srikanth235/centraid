import type { ReactNode } from "react";

import {
  AskMount,
  ConsentBanner,
  NoticeBanner,
} from "../_shared/AppChrome.tsx";
import { chromeClass } from "../_shared/chrome-kit.ts";
import { RAIL_CALENDARS, RAIL_DAY_CONTEXT } from "./view-copy.ts";

import styles from "./Chrome.module.css";

export interface ChromeSlots {
  miniMonth: ReactNode;
  calendars: ReactNode;
  dayContext: ReactNode;
  searchField: ReactNode;
  stateRow: ReactNode;
  canvas: ReactNode;
  detail: ReactNode;
  overlays: ReactNode;
  moreSheet: ReactNode;
}

export interface ChromeProps {
  narrow: boolean;
  ready: boolean;
  consent: { message: string } | null;
  slots: ChromeSlots;
}

export function Chrome(props: ChromeProps): ReactNode {
  const shellClass = chromeClass(
    styles.shell,
    props.narrow && styles.isNarrow,
    props.ready && styles.ready,
    props.consent && styles.denied
  );

  return (
    <div
      className={shellClass}
      data-agenda-root
      data-tone="paper"
      data-density="comfortable"
    >
      {/* Rail is the app's column (232px), not a second nav; absent on compact. */}
      {props.narrow ? null : (
        <aside className={styles.rail} aria-label="Agenda rail">
          <section className={styles.railSection}>
            {props.slots.miniMonth}
          </section>
          <section className={styles.railSection} aria-label={RAIL_CALENDARS}>
            <h2 className={styles.railLabel}>{RAIL_CALENDARS}</h2>
            {props.slots.calendars}
          </section>
          {/* Day-context seam: labelled so the section keeps its place. */}
          <section className={styles.railSection} aria-label={RAIL_DAY_CONTEXT}>
            <h2 className={styles.railLabel}>{RAIL_DAY_CONTEXT}</h2>
            <div className={styles.dayContext}>{props.slots.dayContext}</div>
          </section>
        </aside>
      )}

      <main className={styles.main}>
        {props.consent ? (
          <ConsentBanner
            message={props.consent.message}
            className={styles.banner}
          />
        ) : null}
        <NoticeBanner className={styles.banner} />

        {props.slots.searchField}

        {props.slots.stateRow ? (
          <div className={styles.stateRow}>{props.slots.stateRow}</div>
        ) : null}

        <div className={styles.content}>
          <div className={styles.canvas}>{props.slots.canvas}</div>
          {props.slots.detail}
        </div>
        <AskMount className={styles.askMount} />
      </main>

      {props.slots.overlays}
      {props.slots.moreSheet}
    </div>
  );
}
