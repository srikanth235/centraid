// The compact band's sixth slot — the app's own overflow sheet, holding the
// rail's calendar filters where there is no rail. A filter is not a
// destination; Search is one, and owns its own tab and `SearchField`.
import type { ReactNode } from "react";

import type { Calendar } from "../types.ts";
import { CLOSE, RAIL_CALENDARS } from "../view-copy.ts";
import { CalendarList } from "./Rail.tsx";

import styles from "./MoreSheet.module.css";

export interface MoreSheetProps {
  calendars: readonly Calendar[];
  hidden: ReadonlySet<string>;
  hueFor: (calendarId: string | null | undefined) => string | null;
  onToggleCalendar: (calendarId: string) => void;
  onClose: () => void;
}

export function MoreSheet(props: MoreSheetProps): ReactNode {
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
