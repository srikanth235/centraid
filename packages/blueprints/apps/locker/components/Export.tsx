import type { ReactNode } from "react";

import {
  EXPORT_COMMIT,
  EXPORT_COMMIT_NOTE,
  EXPORT_COMMIT_ROW,
  EXPORT_FORMAT_NOTE,
  EXPORT_FORMAT_ROW,
  EXPORT_FORMAT_VALUE,
  EXPORT_HEAD,
  EXPORT_HISTORY,
  EXPORT_LEDE_TAIL,
  EXPORT_OFFLINE,
  EXPORT_OPTIONS_NOTE,
  EXPORT_OPTIONS_ROW,
  EXPORT_TRASHED,
  EXPORT_WHAT_ROW,
  EXPORT_WHERE_NOTE,
  EXPORT_WHERE_ROW,
  EXPORT_WHERE_VALUE,
  exportWhat,
} from "../route-copy.ts";
import { EXPORT_LEDE } from "../view-copy.ts";
import { FieldRow } from "./Fields.tsx";

import styles from "./Rows.module.css";

export interface ExportScreenProps {
  items: number;
  offline: boolean;
  busy: boolean;
  includeTrashed: boolean;
  includeHistory: boolean;
  onOption: (option: "trashed" | "history", on: boolean) => void;
  onAsk: () => void;
}

export function ExportScreen(props: ExportScreenProps): ReactNode {
  return (
    <section className={styles.item}>
      <header className={styles.itemHead}>
        <h2 className={styles.screenTitle}>{EXPORT_HEAD}</h2>
        <p className={styles.ledeNet}>
          {EXPORT_LEDE} {EXPORT_LEDE_TAIL}
        </p>
      </header>

      <FieldRow
        label={EXPORT_WHAT_ROW}
        value={exportWhat(props.items)}
        numeric
      />
      <FieldRow
        label={EXPORT_FORMAT_ROW}
        value={EXPORT_FORMAT_VALUE}
        note={EXPORT_FORMAT_NOTE}
      />
      <FieldRow
        label={EXPORT_WHERE_ROW}
        value={EXPORT_WHERE_VALUE}
        note={EXPORT_WHERE_NOTE}
      />

      <FieldRow label={EXPORT_OPTIONS_ROW} note={EXPORT_OPTIONS_NOTE}>
        <span className={styles.chipRow}>
          <button
            type="button"
            className="kit-chip quiet"
            aria-pressed={props.includeTrashed}
            onClick={() => props.onOption("trashed", !props.includeTrashed)}
          >
            {EXPORT_TRASHED}
          </button>
          <button
            type="button"
            className="kit-chip quiet"
            aria-pressed={props.includeHistory}
            onClick={() => props.onOption("history", !props.includeHistory)}
          >
            {EXPORT_HISTORY}
          </button>
        </span>
      </FieldRow>

      {/* Withheld offline, never disabled: the reason stands where the
          control would be. */}
      <FieldRow
        label={EXPORT_COMMIT_ROW}
        note={props.offline ? EXPORT_OFFLINE : EXPORT_COMMIT_NOTE}
        {...(props.offline || props.busy
          ? {}
          : { acts: [{ label: EXPORT_COMMIT, run: props.onAsk }] })}
      />
    </section>
  );
}
