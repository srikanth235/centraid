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
  backRow: ReactNode;
  notices: ReactNode;
  toolbar: ReactNode;
  scroll: ReactNode;
  overlays: ReactNode;
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
    <div className={shellClass} data-tally-root data-density="comfortable">
      {/* The rail is `_shared/NavRail.tsx`, which draws its own labelled
          `nav`, its own 232px column and its own divider. Wrapping it in a
          second `nav` here would announce "navigation" twice on one screen
          and fork the column's width into app CSS. */}
      {props.slots.rail}

      <main className={styles.main}>
        {props.consent ? (
          <ConsentBanner
            message={props.consent.message}
            className={styles.banner}
          />
        ) : null}

        {props.slots.backRow ? (
          <div className={styles.backRow}>{props.slots.backRow}</div>
        ) : null}

        {props.slots.notices}

        <ChromeToolbar className={styles.toolbar} label="Tally view">
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

        {/* THE ASSISTANT'S VERBS stream a turn under this app's id, and the
            verbs ARE this app's manifest — `add-expense`, `settle-up`,
            `add-friend` and the six queries. The panel mounts only where the
            app gives it a mount point, which is why the seam is here. */}
        <AskMount className={styles.askMount} />
      </main>

      {props.slots.overlays}
    </div>
  );
}
