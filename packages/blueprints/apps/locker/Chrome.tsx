// The Locker chrome as JSX (#505 inline path). This "chrome" is only the
// `.locker` FRAME: the flex row that holds the LockerSidebar / LockerList /
// LockerDetail panes, the consent + notice banners (carrying the ids logic.ts
// drives them by), the display:contents overlay host, and the floating ask
// mount. app-inline.tsx passes the panes/overlays as slots so the whole app is
// ONE React tree rather than an imperative root per region.
//
// The frame carries the GLOBAL state classes `locker` / `is-narrow` /
// `side-open` / `show-list` / `denied`, because the components/*.module.css
// `:global(.locker.is-narrow) …` rules key on them. Classes otherwise come
// from Chrome.module.css (scoped frame) + the global kit-* vocabulary
// (kit.css, loaded once by the route host).
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
  /** Stamped one frame after mount; ungates the drawer's slide transition. */
  ready: boolean;
  sidebar: ReactNode;
  list: ReactNode;
  detail: ReactNode;
  overlays: ReactNode;
}

export function Chrome(props: ChromeProps): ReactNode {
  const frameClass = [
    styles.appRoot,
    // Global state classes the reused component modules' `:global(.locker.…)`
    // rules key on — mirror the served static #root's classList (app.tsx's
    // render() toggled these on #root; inline they live on this frame instead).
    "locker",
    props.narrow ? "is-narrow" : "",
    props.narrow && props.sideOpen ? "side-open" : "",
    props.showList ? "show-list" : "",
    props.denied ? "denied" : "",
    // Local (hashed) marker: the drawer slide transition is suppressed until
    // this is present (Chrome.module.css), so the pre-paint narrow snap and
    // remounts don't animate.
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
        {/* Consent + notice banners — kept with their served ids so the reused
          logic.ts (applyDenied / notice / readFailed) drives them by
          getElementById verbatim. Rendered once, never reconciled, so those
          imperative DOM writes are never clobbered. */}
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

      {/* Overlay layer — `data-kit-host` is display:contents (kit.css), so the
          lock screen / generator / edit modal overlays participate as if direct
          children of the frame (their absolute/fixed positioning resolves
          against .appRoot). This is the marker's only remaining caller: #799
          retired the `KitElement` base that used to stamp it. Order is
          deliberate — the generator can be opened from inside the edit modal,
          and the modal paints after it. */}
      <div data-kit-host>{props.overlays}</div>
    </div>
  );
}
