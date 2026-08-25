// Notes chrome — geometry only. No app bar, status line, or navigation stem;
// those are the frame's. A null slot renders nothing, not an empty container.
import type { ReactNode } from "react";

import { VaultAccessButton } from "../_shared/VaultAccessButton.tsx";

import styles from "./Chrome.module.css";

export interface ChromeSlots {
  toolbar: ReactNode;
  rail: ReactNode;
  scroll: ReactNode;
  overlays: ReactNode;
  moreSheet: ReactNode;
}

export interface ChromeProps {
  narrow: boolean;
  consent: { message: string } | null;
  slots: ChromeSlots;
}

export function Chrome(props: ChromeProps): ReactNode {
  const shellClass = [
    styles.shell,
    props.narrow ? styles.isNarrow : "",
    props.consent ? styles.denied : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={shellClass}
      data-notes-root
      data-tone="paper"
      data-density="comfortable"
    >
      <main className={styles.main}>
        {props.slots.toolbar ? (
          <div className={styles.toolbar} role="toolbar" aria-label="View">
            {props.slots.toolbar}
          </div>
        ) : null}

        {props.consent ? (
          // `id="consentBanner"` is onFocusRefresh's denied→recovered hook.
          <div id="consentBanner" className={`kit-banner ${styles.banner}`}>
            <strong>No vault access yet.</strong>{" "}
            <span>{props.consent.message}</span>
            <VaultAccessButton />
          </div>
        ) : null}
        {/* Driven by logic.ts; keep out of React reconciliation. */}
        <output
          id="noticeBanner"
          className={`kit-banner notice ${styles.banner}`}
          aria-live="polite"
          hidden
        />

        <div className={styles.content}>
          {props.slots.rail}
          <div className={styles.scroll}>{props.slots.scroll}</div>
        </div>
        {/* Assistant mount: kitAsk is unreachable without this node. */}
        <div className={styles.askMount} data-ask-mount />
      </main>

      {props.slots.overlays}
      {props.slots.moreSheet}
    </div>
  );
}
