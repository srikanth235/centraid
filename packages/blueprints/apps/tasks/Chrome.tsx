// Tasks chrome — a route inside the frame (spec §1). Geometry only:
// 232px rail + scroll host. No token, rung, colour, or control recipe.
// No global tk-prefixed shell/side/topbar trio (trap #5, shared-css.test.ts);
// banned selectors are not even spelled in comments. Variable UI arrives as
// slots, same shape as docs/photos Chrome.
import type { ReactNode } from "react";

import {
  AskMount,
  ChromeToolbar,
  ConsentBanner,
  ScrollHost,
} from "../_shared/AppChrome.tsx";
import { chromeClass } from "../_shared/chrome-kit.ts";
import { LoadingSkeleton } from "../_shared/LoadingSkeleton.tsx";

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
  const shellClass = chromeClass(
    styles.shell,
    props.narrow && styles.isNarrow,
    props.consent && styles.denied
  );

  return (
    <div className={shellClass} data-tasks-root data-density="comfortable">
      {props.slots.rail ? (
        <nav className={styles.rail} aria-label="Tasks navigation">
          {props.slots.rail}
        </nav>
      ) : null}

      <main className={styles.main}>
        {props.consent ? (
          <ConsentBanner
            message={props.consent.message}
            className={styles.banner}
          />
        ) : null}

        {props.slots.notices}

        <ChromeToolbar className={styles.toolbar} label="Tasks view">
          {props.slots.toolbar}
        </ChromeToolbar>

        <ScrollHost
          className={styles.scroll}
          loading={props.loading}
          skeletonClassName={styles.skeleton}
          skeleton={<LoadingSkeleton rows={6} />}
        >
          {props.slots.scroll}
        </ScrollHost>
        <AskMount className={styles.askMount} />
      </main>

      {props.slots.overlays}
      {props.slots.moreSheet}
    </div>
  );
}
