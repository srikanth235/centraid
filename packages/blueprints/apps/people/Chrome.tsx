// People's chrome (#505): owns frame geometry; contents arrive as slots.
// Nav is band/strip, never sidebar/topbar.
import type { ReactNode } from "react";

import { VaultAccessButton } from "../_shared/VaultAccessButton.tsx";
import { CONSENT_TITLE, LABELS } from "./people-copy.ts";
import { DESTINATION_SHELVES, originShelf } from "./shelves.ts";
import type { Shelf, ShelfId } from "./shelves.ts";

import styles from "./Chrome.module.css";

export interface ChromeSlots {
  scroll: ReactNode;
  overlays: ReactNode;
}

export interface ChromeProps {
  shelf: ShelfId;
  narrow: boolean;
  /** Strip would duplicate the band's destinations. */
  bandOwned: boolean;
  consent: { message: string } | null;
  onSelectShelf: (id: ShelfId) => void;
  rootRef: (el: HTMLDivElement | null) => void;
  slots: ChromeSlots;
}

export function Chrome(props: ChromeProps): ReactNode {
  // A callback ref off `props` taints React-compiler reads (#573).
  const { rootRef } = props;
  const current = originShelf(props.shelf);
  const shellClass = [styles.appRoot, props.consent ? styles.denied : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={shellClass}
      ref={rootRef}
      data-people-root
      data-tone="paper"
      data-density="comfortable"
      data-narrow={props.narrow ? "true" : "false"}
    >
      <div className={styles.main}>
        {props.consent ? (
          // onFocusRefresh reads id="consentBanner" past its throttle.
          <div id="consentBanner" className={`kit-banner ${styles.banner}`}>
            <strong>{CONSENT_TITLE}</strong>{" "}
            <span>{props.consent.message}</span>
            <VaultAccessButton />
          </div>
        ) : null}
        {/* Driven imperatively by logic.ts (`notice`/`readFailed`); rendered once, never reconciled. */}
        <output
          id="noticeBanner"
          className={`kit-banner notice ${styles.banner}`}
          aria-live="polite"
          hidden
        />

        {props.bandOwned ? null : (
          <div
            className={styles.strip}
            role="tablist"
            aria-label={LABELS.destinations}
          >
            {DESTINATION_SHELVES.map((entry: Shelf) => {
              const on = entry.id === current;
              return (
                <button
                  key={entry.label}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  className={styles.tab}
                  data-current={on ? "true" : "false"}
                  onClick={() => props.onSelectShelf(entry.id)}
                >
                  {entry.label}
                </button>
              );
            })}
          </div>
        )}

        <div className={styles.scroll}>
          <div className={styles.column}>{props.slots.scroll}</div>
        </div>
      </div>
      {props.slots.overlays}
    </div>
  );
}
