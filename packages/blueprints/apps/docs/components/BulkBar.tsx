// The selection bar — the five verbs the handoff puts under a picked set
// (`selDefs`), each an OUTLINED button with its glyph.
//
// GLYPH ALWAYS, LABEL WHEN THERE IS ROOM. The handoff draws the words only at
// `contentW >= 840` and hides them below it (`labelCss: selLabels ? '' :
// 'display:none'`), keeping the glyph and moving the word into the `title` so
// nothing is lost — five labelled buttons do not fit a narrow pane, and five
// unlabelled ones on a wide one are a puzzle. This carries the same rule on
// the pane's own width rather than the viewport's, the way every other Docs
// component measures (`data-narrow`).
//
// ONE FILLED CONTROL, AND IT IS NOT HERE. Every button in this bar is an
// outline, Trash included — a destructive verb takes the danger INK and the
// arm-then-confirm gesture, never a filled ground, and the view's one fill
// belongs to the shelf's own commit in the app bar.
//
// TWO OF THE HANDOFF'S FIVE ARE NOT DRAWN:
//   * `Tag` — there is no bulk tag flow behind it. `Details` tags one document
//     at a time (`Tags.tsx`); a bar button that opened nothing would be the
//     dead control this app keeps deleting.
//   * In trash, `Star`, `Move` and `Download` stand down and `Restore` takes
//     the row — the handoff swaps the last verb the same way, and the other
//     three have nothing to act on until the documents are back.
import { armConfirm } from "@centraid/design/elements";

import { BULK_ICONS } from "../icons.ts";
import { Icon } from "./Shared.tsx";

import styles from "./BulkBar.module.css";

export function BulkBar({
  n,
  inTrash,
  narrow,
  allStarred,
  downloadHref,
  onStar,
  onRestore,
  onMoveTo,
  onTrashSelected,
  onClear,
}: {
  n: number;
  inTrash: boolean;
  /** The pane is too narrow to carry five words beside five glyphs. */
  narrow: boolean;
  /** Every picked document already carries a star, so the verb is the reverse
   *  one. Read from the selection, never guessed. */
  allStarred: boolean;
  /** The one picked document's bytes, when exactly one is picked. A browser
   *  downloads one file per gesture, so a multi-selection has nothing honest
   *  to offer here and the button stands down rather than fetching the first
   *  row and calling it "the download". */
  downloadHref?: { href: string; name: string };
  onStar: () => void;
  onRestore: () => void;
  onMoveTo: (anchor: HTMLElement) => void;
  onTrashSelected: () => void;
  onClear: () => void;
}) {
  const starLabel = allStarred ? "Remove star" : "Star";
  return (
    <>
      <span className={styles.bulkCount}>
        <span className={styles.bulkNum}>{n}</span>
        <span className={styles.bulkWord}>selected</span>
      </span>
      <div className={styles.bulkActions} data-narrow={String(narrow)}>
        {inTrash ? (
          <button
            type="button"
            className={`kit-btn ${styles.act}`}
            title="Restore"
            onClick={onRestore}
          >
            <Icon svg={BULK_ICONS.restore} />
            <span className={styles.actLabel}>Restore</span>
          </button>
        ) : (
          <>
            <button
              type="button"
              className={`kit-btn ${styles.act}`}
              title={starLabel}
              onClick={onStar}
            >
              <Icon svg={BULK_ICONS.star} />
              <span className={styles.actLabel}>{starLabel}</span>
            </button>
            <button
              type="button"
              className={`kit-btn ${styles.act}`}
              title="Move"
              onClick={(e) => onMoveTo(e.currentTarget)}
            >
              <Icon svg={BULK_ICONS.move} />
              <span className={styles.actLabel}>Move</span>
            </button>
            {downloadHref ? (
              <a
                className={`kit-btn ${styles.act}`}
                title="Download"
                href={downloadHref.href}
                download={downloadHref.name}
              >
                <Icon svg={BULK_ICONS.download} />
                <span className={styles.actLabel}>Download</span>
              </a>
            ) : null}
            <button
              type="button"
              className={`kit-btn destructive danger ${styles.act}`}
              title="Trash"
              onClick={(e) => {
                if (
                  !armConfirm(e.currentTarget, {
                    armedLabel: `Trash ${n} — sure?`,
                  })
                )
                  return;
                onTrashSelected();
              }}
            >
              <Icon svg={BULK_ICONS.trash} />
              <span className={styles.actLabel}>Trash</span>
            </button>
          </>
        )}
        {/* Leaving the selection is not one of the five verbs — it undoes the
            thing that raised the bar — so it stays a word and never takes a
            glyph beside them. */}
        <button
          type="button"
          className={`kit-btn ${styles.done}`}
          onClick={onClear}
        >
          Done
        </button>
      </div>
    </>
  );
}
