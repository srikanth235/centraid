// Tasks chrome — a route inside the frame (spec §1). Geometry only:
// 232px rail + scroll host. No token, rung, colour, or control recipe.
// No global tk-prefixed shell/side/topbar trio (trap #5, shared-css.test.ts);
// banned selectors are not even spelled in comments. Variable UI arrives as
// slots, same shape as docs/photos Chrome.
import type { ReactNode } from "react";

import { LoadingSkeleton } from "../_shared/LoadingSkeleton.tsx";
import { VaultAccessButton } from "../_shared/VaultAccessButton.tsx";

import styles from "./Chrome.module.css";

export interface ChromeSlots {
  rail: ReactNode;
  toolbar: ReactNode;
  notices: ReactNode;
  scroll: ReactNode;
  overlays: ReactNode;
  moreSheet: ReactNode;
}

export interface ChromeProps {
  narrow: boolean;
  loading: boolean;
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
    <div className={shellClass} data-tasks-root data-density="comfortable">
      {props.slots.rail ? (
        <nav className={styles.rail} aria-label="Tasks navigation">
          {props.slots.rail}
        </nav>
      ) : null}

      <main className={styles.main}>
        {props.consent ? (
          // `id="consentBanner"` is the onFocusRefresh hook for a denied→recovered
          // flip; without it a refocus after a grant is throttled and never retried (#505).
          <div id="consentBanner" className={`kit-banner ${styles.banner}`}>
            <strong>No vault access yet.</strong>{" "}
            <span>{props.consent.message}</span>
            <VaultAccessButton />
          </div>
        ) : null}

        {props.slots.notices}

        {props.slots.toolbar ? (
          <div
            className={styles.toolbar}
            role="toolbar"
            aria-label="Tasks view"
          >
            {props.slots.toolbar}
          </div>
        ) : null}

        <div className={styles.scroll}>
          {props.loading ? (
            <div className={styles.skeleton} aria-hidden="true">
              <LoadingSkeleton rows={6} />
            </div>
          ) : (
            props.slots.scroll
          )}
        </div>
        {/* kitAsk mount (#834): without this node the descriptor's kitAsk
            config is real and unreachable. */}
        <div className={styles.askMount} data-ask-mount />
      </main>

      {props.slots.overlays}
      {props.slots.moreSheet}
    </div>
  );
}
