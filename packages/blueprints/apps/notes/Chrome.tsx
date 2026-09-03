import type { ReactNode } from "react";

import {
  AskMount,
  ChromeToolbar,
  ConsentBanner,
  NoticeBanner,
} from "../_shared/AppChrome.tsx";
import { chromeClass } from "../_shared/chrome-kit.ts";

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
  const shellClass = chromeClass(
    styles.shell,
    props.narrow && styles.isNarrow,
    props.consent && styles.denied
  );

  return (
    <div
      className={shellClass}
      data-notes-root
      data-tone="paper"
      data-density="comfortable"
    >
      <main className={styles.main}>
        <ChromeToolbar className={styles.toolbar} label="View">
          {props.slots.toolbar}
        </ChromeToolbar>

        {props.consent ? (
          <ConsentBanner
            message={props.consent.message}
            className={styles.banner}
          />
        ) : null}
        <NoticeBanner className={styles.banner} />

        <div className={styles.content}>
          {props.slots.rail}
          {/* The declared scroll pane (`_shared/VirtualWindow.tsx`
              SCROLL_HOST_ATTR): the library's row arrangement windows against
              this box. */}
          <div className={styles.scroll} data-scroll-host="">
            {props.slots.scroll}
          </div>
        </div>
        <AskMount className={styles.askMount} />
      </main>

      {props.slots.overlays}
      {props.slots.moreSheet}
    </div>
  );
}
