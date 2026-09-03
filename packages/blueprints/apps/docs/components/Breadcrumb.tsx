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
  menu?: readonly PlaceMenuItem[];
  onSelectShelf: (shelf: ShelfId) => void;
}): ReactNode {
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
                <button
                  type="button"
                  className={`kit-plain-btn ${styles.here} ${styles.hereBtn}`}
                  aria-current="page"
                  aria-haspopup="menu"
                  onClick={(e) => openMenu(e.currentTarget)}
                >
                  {/* Truncation lives on the label: the button is a flex row. */}
                  <span className={styles.hereLabel}>{label}</span>
                  {/* Catalog chevron, not `⌄` — that hangs below its baseline. */}
                  <span className={styles.caret}>
                    <Icon svg={I.chevDown!} />
                  </span>
                </button>
              ) : last || crumb.shelf === undefined ? (
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
