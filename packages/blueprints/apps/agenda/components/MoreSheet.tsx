// The compact band's sixth slot — the app's own overflow sheet.
//
// On the phone the rail is gone, so the two things it carried that are not
// navigation have to live somewhere: the search field, and which calendars
// are showing. They live here rather than in a fifth band tab, because the
// band's cap is five including More and a filter is not a destination.
import type { ChangeEvent, ReactNode } from "react";

import type { Calendar } from "../types.ts";
import { CLOSE, RAIL_CALENDARS, SEARCH_LABEL } from "../view-copy.ts";
import { CalendarList } from "./Rail.tsx";

import styles from "./MoreSheet.module.css";

export interface MoreSheetProps {
  calendars: readonly Calendar[];
  hidden: ReadonlySet<string>;
  hueFor: (calendarId: string | null | undefined) => string | null;
  search: string;
  onToggleCalendar: (calendarId: string) => void;
  onSearch: (value: string) => void;
  onClose: () => void;
}

export function MoreSheet(props: MoreSheetProps): ReactNode {
  return (
    <div className={styles.sheet} role="dialog" aria-label={RAIL_CALENDARS}>
      <div className={styles.head}>
        <label className={styles.searchField}>
          <span className="kit-sr-only">{SEARCH_LABEL}</span>
          <input
            id="searchInput"
            type="search"
            className="kit-input"
            placeholder={SEARCH_LABEL}
            value={props.search}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              props.onSearch(event.target.value)
            }
          />
        </label>
        <button
          type="button"
          className="kit-icon-btn"
          aria-label={CLOSE}
          onClick={props.onClose}
        >
          ×
        </button>
      </div>
      <h2 className={styles.label}>{RAIL_CALENDARS}</h2>
      <CalendarList
        calendars={props.calendars}
        hidden={props.hidden}
        hueFor={props.hueFor}
        onToggle={props.onToggleCalendar}
      />
    </div>
  );
}
