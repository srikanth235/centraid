// People's chrome as JSX — a ROUTE INSIDE THE FRAME (issue #505 inline path).
//
// The chrome owns GEOMETRY: the destination strip, the two trust banners, the
// one scroll host and the content column the handoff caps at 760px. What
// stands inside each region is the orchestrator's decision and arrives as a
// slot, the same shape `docs/Chrome.tsx` uses — so the box and the screens can
// be reasoned about independently.
//
// THERE IS NO SIDEBAR AND NO TOPBAR. Navigation belongs to the band (compact)
// or to the strip in this row (pointer), and the title, the count and the
// app's two verbs are the FRAME's app bar — an app that drew its own header
// would be a second chrome inside the first.
import type { ReactNode } from "react";

import { VaultAccessButton } from "../_shared/VaultAccessButton.tsx";
import { CONSENT_TITLE, LABELS } from "./people-copy.ts";
import { DESTINATION_SHELVES, originShelf } from "./shelves.ts";
import type { Shelf, ShelfId } from "./shelves.ts";

import styles from "./Chrome.module.css";

export interface ChromeSlots {
  /** The current screen's body. One route at a time; the chrome never stacks
   *  two. */
  scroll: ReactNode;
  /** Modal confirms and any other overlay the route opened. */
  overlays: ReactNode;
}

export interface ChromeProps {
  shelf: ShelfId;
  /** The compact form factor, measured on this pane's own width. */
  narrow: boolean;
  /** The band claim was honoured, so the strip would be a second copy of the
   *  same three destinations and is not drawn. */
  bandOwned: boolean;
  consent: { message: string } | null;
  onSelectShelf: (id: ShelfId) => void;
  rootRef: (el: HTMLDivElement | null) => void;
  slots: ChromeSlots;
}

export function Chrome(props: ChromeProps): ReactNode {
  // A callback ref read off `props` taints every later `props.*` read for the
  // React compiler, so it comes off first as a plain local (#573).
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
          // `id="consentBanner"` is the hook `onFocusRefresh` reads to detect a
          // denied→recovered state and bypass its 30s focus throttle. Without
          // it a refocus after a grant would be throttled and never retry.
          <div id="consentBanner" className={`kit-banner ${styles.banner}`}>
            <strong>{CONSENT_TITLE}</strong>{" "}
            <span>{props.consent.message}</span>
            <VaultAccessButton />
          </div>
        ) : null}
        {/* Driven imperatively by logic.ts (`notice` / `readFailed`) — rendered
            once and never reconciled, so those DOM writes are never clobbered. */}
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
