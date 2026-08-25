// Selection bar: handoff's five verbs, outlined, labels only when roomy
// (pane-width data-narrow). Destructive = danger ink + arm-confirm, never fill;
// the view's one fill is the app-bar commit. Tag absent; trash swaps Restore in.
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
  /** Too narrow to carry five words beside five glyphs. */
  narrow: boolean;
  /** Every pick already starred: the verb reverses. Read, never guessed. */
  allStarred: boolean;
  /** Bytes when exactly one is picked; multi-selection stands down — a browser
   *  downloads one file per gesture. */
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
        {/* Not one of the five verbs — it undoes what raised the bar. */}
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
