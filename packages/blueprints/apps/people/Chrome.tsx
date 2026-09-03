import type { ReactNode } from "react";

import { ConsentBanner, NoticeBanner } from "../_shared/AppChrome.tsx";
import { chromeClass } from "../_shared/chrome-kit.ts";
import { ShelfStrip } from "../_shared/ShelfStrip.tsx";
import { LABELS } from "./people-copy.ts";
import { DESTINATION_SHELVES, originShelf } from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";

import styles from "./Chrome.module.css";

export interface ChromeSlots {
  scroll: ReactNode;
  overlays: ReactNode;
}

export interface ChromeProps {
  shelf: ShelfId;
  narrow: boolean;
  bandOwned: boolean;
  consent: { message: string } | null;
  onSelectShelf: (id: ShelfId) => void;
  rootRef: (el: HTMLDivElement | null) => void;
  slots: ChromeSlots;
}

export function Chrome(props: ChromeProps): ReactNode {
  const { rootRef } = props;
  const current = originShelf(props.shelf);
  const shellClass = chromeClass(
    styles.appRoot,
    props.consent && styles.denied
  );

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
          <ConsentBanner
            message={props.consent.message}
            className={styles.banner}
          />
        ) : null}
        <NoticeBanner className={styles.banner} />

        {/* THE SHARED STRIP (#883). People drew its own until this pass, at
            the 34px `--h-control` rung and the `--t-body` / `--t-label-on`
            held pair the v12 handoff pinned. The shared strip's register wins:
            38px under a pointer, 44px in a narrow pane, `--t-small` /
            `--t-small-strong`. The two were value-identical at rest (13/19,
            400) and differed by four pixels of height and one of leading on
            the selected half — which is less than the cost of a third
            implementation of a row of tabs.

            NOT RENDERED, rather than hidden, in the two cases that have no
            business drawing it: the band already carries the same three
            destinations, and a denied seat collapses to its banner. The
            stylesheet used to hide the denied case; a region that does not
            exist beats one that exists invisibly. */}
        {props.bandOwned || props.consent ? null : (
          <ShelfStrip
            shelves={DESTINATION_SHELVES}
            current={current}
            onSelect={props.onSelectShelf}
            narrow={props.narrow}
            label={LABELS.destinations}
          />
        )}

        {/* The declared scroll pane (`_shared/VirtualWindow.tsx`
            SCROLL_HOST_ATTR): a windowed list resolves its scroller by
            `closest()` rather than by walking ancestors through
            `getComputedStyle`. One scroller for the whole app, so one stamp. */}
        <div className={styles.scroll} data-scroll-host="">
          <div className={styles.column}>{props.slots.scroll}</div>
        </div>
      </div>
      {props.slots.overlays}
    </div>
  );
}
