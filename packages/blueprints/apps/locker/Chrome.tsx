// The Locker chrome as JSX (issue #505 inline path). Locker's static index.html
// carried NO chrome markup — the Lit-derived app rendered its whole surface
// (sidebar / list / detail / overlays) into one React root at `#stage`. So this
// "chrome" is just the `.locker` FRAME: the flex row that holds the reused
// LockerSidebar / LockerList / LockerDetail panes, the consent + notice banners
// (kept with their served ids so the reused logic.ts drives them verbatim), the
// display:contents overlay host, and the floating ask mount. app-inline.tsx
// passes the panes/overlays as slots so the whole app is ONE React tree instead
// of app.tsx's imperative `createRoot($('stage'))` + `render()`.
//
// The frame carries the GLOBAL state classes `locker` / `is-narrow` /
// `side-open` / `show-list` / `denied` that the served static #root wore, so the
// reused components/*.module.css `:global(.locker.is-narrow) …` rules key on it
// exactly as they do served. Classes otherwise come from Chrome.module.css
// (scoped frame) + the global kit-* vocabulary (kit.css, loaded once by the
// route host).
import type { ReactNode } from './react-core.min.js';
import styles from './Chrome.module.css';

export interface ChromeProps {
  narrow: boolean;
  sideOpen: boolean;
  showList: boolean;
  denied: boolean;
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
    'locker',
    props.narrow ? 'is-narrow' : '',
    props.narrow && props.sideOpen ? 'side-open' : '',
    props.showList ? 'show-list' : '',
    props.denied ? 'denied' : '',
    // Local (hashed) marker: the drawer slide transition is suppressed until
    // this is present (Chrome.module.css), so the pre-paint narrow snap and
    // remounts don't animate.
    props.ready ? styles.ready : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={frameClass}>
      {/* Consent + notice banners — kept with their served ids so the reused
          logic.ts (applyDenied / notice / readFailed) drives them by
          getElementById verbatim. Rendered once, never reconciled, so those
          imperative DOM writes are never clobbered. */}
      <div id="consentBanner" className={styles.banner} hidden>
        <strong>No vault access yet.</strong>{' '}
        <span id="consentDetail">
          Ask the owner to approve this app’s requested scopes in vault settings.
        </span>
      </div>
      <div
        id="noticeBanner"
        className={`${styles.banner} ${styles.notice}`}
        role="status"
        aria-live="polite"
        hidden
      />

      {props.sidebar}
      {props.list}
      {props.detail}

      {/* Overlay layer — `data-kit-host` is display:contents (kit.css), so the
          lock screen / generator / edit modal overlays participate as if direct
          children of the frame (their absolute/fixed positioning resolves
          against .appRoot). Order matches the served DOM: the generator can be
          opened from inside the edit modal, and the modal paints after it. */}
      <div data-kit-host>{props.overlays}</div>

      <div className={styles.askMount} data-ask-mount />
    </div>
  );
}
