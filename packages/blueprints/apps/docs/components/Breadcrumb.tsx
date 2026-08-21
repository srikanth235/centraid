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
// THE TRAILING MENU IS THE PLACE'S MENU, and it is now the only way a pointer
// surface reaches the destinations that are off the shelf strip — Add, Scan,
// Storage, what Docs may read, proposed filing, who a document names, and the
// Locker boundary. The compact band reaches them through its More sheet; the
// strip has six tabs and is not growing to fourteen, so without this menu
// those seven routes would exist and be unreachable at a desk.
//
// Every entry goes somewhere. That was the condition this menu was waiting on
// — "a menu that is half dead ends is worse than no menu" — and it is met now
// that the routes are drawn.
import type { ReactNode } from "react";

import {
  closePopover,
  h,
  openPopover,
  popItem,
} from "@centraid/design/elements";

import { displayText } from "../../_shared/untrusted.ts";
import type { Crumb, PlaceMenuItem } from "../drive-copy.ts";
import { I, PLACE_ICONS } from "../icons.ts";
import type { ShelfId } from "../shelves.ts";
import { Icon } from "./Shared.tsx";

import styles from "./Breadcrumb.module.css";

export function Breadcrumb({
  crumbs,
  menu,
  onSelectShelf,
}: {
  crumbs: readonly Crumb[];
  /** The place's own menu, hung off the trailing crumb. Absent where the
   *  place has nothing else to offer. The rows are `drive-copy.ts`'s
   *  `PLACE_MENU`, which owns the words, the shapes and the grouping. */
  menu?: readonly PlaceMenuItem[];
  onSelectShelf: (shelf: ShelfId) => void;
}): ReactNode {
  // EVERY ROW CARRIES ITS SHAPE, AND THE GROUPS CARRY A RULE. This was seven
  // bare words in one undifferentiated column — the same seven destinations,
  // but a member had to read all of them to find any of them, and nothing said
  // that "Storage" answers a different question from "Docs and Locker". The
  // glyphs come from `PLACE_ICONS` at the row menu's own 15/1.6, so the two
  // popovers in this app draw their rows at one weight.
  const openMenu = (anchor: HTMLElement): void => {
    openPopover(anchor, (box) => {
      for (const item of menu ?? []) {
        if (item.group) box.append(h("div", { class: "kit-popover-sep" }));
        box.append(
          popItem(
            item.label,
            () => {
              closePopover();
              onSelectShelf(item.shelf);
            },
            { iconHtml: PLACE_ICONS[item.icon] }
          )
        );
      }
    });
  };
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
                  /
                </span>
              ) : null}
              {last && menu && menu.length > 0 ? (
                // The trailing crumb OWNS the place, so it carries the place's
                // menu. It stays `aria-current` — pressing it does not navigate
                // away, it opens what else this place can do.
                <button
                  type="button"
                  className={`kit-plain-btn ${styles.here} ${styles.hereBtn}`}
                  aria-current="page"
                  aria-haspopup="menu"
                  onClick={(e) => openMenu(e.currentTarget)}
                >
                  {/* The label carries the truncation, not the button: the
                      button is a flex row now, and `text-overflow` has nothing
                      to act on once the label becomes an anonymous flex item. */}
                  <span className={styles.hereLabel}>{label}</span>
                  {/* The catalog's chevron rather than the `⌄` character,
                      which hangs below its own baseline (FilterRow.tsx). */}
                  <span className={styles.caret}>
                    <Icon svg={I.chevDown!} />
                  </span>
                </button>
              ) : last || crumb.shelf === undefined ? (
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
