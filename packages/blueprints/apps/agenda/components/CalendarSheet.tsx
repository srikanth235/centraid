// The band's sixth slot where there is no rail: calendar FILTERS, not
// destinations — the destination overflow is `_shared/MoreSheet.tsx`.
import type { ReactNode } from "react";

import type { Calendar } from "../types.ts";
import { CLOSE, RAIL_CALENDARS } from "../view-copy.ts";
import { CalendarList } from "./Rail.tsx";

import styles from "./CalendarSheet.module.css";

export interface CalendarSheetProps {
  calendars: readonly Calendar[];
  hidden: ReadonlySet<string>;
  hueFor: (calendarId: string | null | undefined) => string | null;
  onToggleCalendar: (calendarId: string) => void;
  onClose: () => void;
}

export function CalendarSheet(props: CalendarSheetProps): ReactNode {
  return (
    <section className={styles.sheet} aria-label={RAIL_CALENDARS}>
      <div className={styles.head}>
        <h2 className={styles.label}>{RAIL_CALENDARS}</h2>
        <button
          type="button"
          className="kit-icon-btn"
          aria-label={CLOSE}
          onClick={props.onClose}
        >
          ×
        </button>
      </div>
      <CalendarList
        calendars={props.calendars}
        hidden={props.hidden}
        hueFor={props.hueFor}
        onToggle={props.onToggleCalendar}
      />
    </section>
  );
}
