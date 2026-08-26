// Locker chrome FRAME (#505); carries the :global state classes.
import type { ReactNode } from "react";

import { LoadingSkeleton } from "../_shared/LoadingSkeleton.tsx";
import { VaultAccessButton } from "../_shared/VaultAccessButton.tsx";

import styles from "./Chrome.module.css";

export interface ChromeProps {
  narrow: boolean;
  loading: boolean;
  sideOpen: boolean;
  showList: boolean;
  denied: boolean;
  locked: boolean;
  ready: boolean;
  sidebar: ReactNode;
  list: ReactNode;
  detail: ReactNode;
  overlays: ReactNode;
}

export function Chrome(props: ChromeProps): ReactNode {
  const frameClass = [
    styles.appRoot,
    "locker",
    props.narrow ? "is-narrow" : "",
    props.narrow && props.sideOpen ? "side-open" : "",
    props.showList ? "show-list" : "",
    props.denied ? "denied" : "",
    props.ready ? styles.ready : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={frameClass} data-tone="neutral" data-density="compact">
      <div
        className={styles.lockable}
        inert={props.locked ? true : undefined}
        aria-hidden={props.locked ? true : undefined}
      >
        {/* Served ids kept: logic.ts drives these banners via getElementById;
          rendered once, never reconciled. */}
        <div id="consentBanner" className={styles.banner} hidden>
          <strong>No vault access yet.</strong>{" "}
          <span id="consentDetail">
            Ask the owner to approve this app’s requested scopes in vault
            settings.
          </span>
          <VaultAccessButton />
        </div>
        <output
          id="noticeBanner"
          className={`${styles.banner} ${styles.notice}`}
          aria-live="polite"
          hidden
        />

        {props.loading ? (
          <LoadingSkeleton />
        ) : (
          <>
            {props.sidebar}
            {props.list}
            {props.detail}
          </>
        )}

        <div className={styles.askMount} data-ask-mount />
      </div>

      {/* display:contents (kit.css): overlays position against .appRoot; last
        marker caller (#799). */}
      <div data-kit-host>{props.overlays}</div>
    </div>
  );
}
