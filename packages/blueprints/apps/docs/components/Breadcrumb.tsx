// The breadcrumb (Docs spec §1.6, `breadBlock`) — the row every drive-ish
// shelf opens with.
//
// "The trailing crumb owns the place, so it carries the place's menu — Drive's
// 'My Drive ▾'. Every crumb before it is a link and nothing else." (§1.6,
// verbatim.) That sentence is the whole component: the leading crumbs are
// buttons that navigate and carry nothing else, and the last one is not a link
// at all, because it is where the member already is.
//
// The chain itself is NOT computed here — `crumbsFor` (view-copy.ts) owns it,
// for the same reason the shelf table does: the strip, the band, the app bar
// and this row all have to agree about where a folder sits, and four surfaces
// deriving that independently is four chances to disagree.
//
// THE TRAILING MENU IS NOT DRAWN THIS WAVE. §1.6 gives it four entries (New
// document / New folder / Upload files / Storage); two of those routes do not
// exist yet, and a menu that is half dead ends is worse than the sidebar's
// existing "+ New", which already reaches the two that work. It lands with the
// `newdoc` route.
import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";
import type { Crumb } from "../drive-copy.ts";
import type { ShelfId } from "../shelves.ts";

import styles from "./Breadcrumb.module.css";

export function Breadcrumb({
  crumbs,
  onSelectShelf,
}: {
  crumbs: readonly Crumb[];
  onSelectShelf: (shelf: ShelfId) => void;
}): ReactNode {
  return (
    <nav className={styles.bread} aria-label="Breadcrumb">
      <ol className={styles.list}>
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          const label = displayText(crumb.label);
          return (
            <li key={label} className={styles.item}>
              {index > 0 ? (
                <span className={styles.sep} aria-hidden="true">
                  ›
                </span>
              ) : null}
              {last || crumb.shelf === undefined ? (
                // `aria-current="page"` rather than a disabled link: the place
                // is not unavailable, it is the one you are on.
                <span className={styles.here} aria-current="page">
                  {label}
                </span>
              ) : (
                <button
                  type="button"
                  className={`kit-plain-btn ${styles.link}`}
                  onClick={() => onSelectShelf(crumb.shelf ?? null)}
                >
                  {label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
