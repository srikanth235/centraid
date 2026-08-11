import type { PendingRowState } from "../../_shared/pending-overlay.ts";
import { I } from "../icons.ts";
import type { Note } from "../types.ts";
import { Card } from "./Card.tsx";
// The scrolling wall: the quick-add card, the pinned/others card groups
// (CSS-columns masonry, or a single narrow column in list view), the empty
// state and the bounded-window "Show more" footer. A pending create arrives
// as a normal card inside `pinned`/`others` (the replica composes it from the
// durable outbox — issue #738); `pendingByRowId` decorates it (and any
// pending mutation on an existing note) with the chip, same as every other
// card. Mirrors tasks/components/Board.tsx's shape.
import { QuickAdd } from "./QuickAdd.tsx";
import type { QuickAddProps } from "./QuickAdd.tsx";
import { Icon } from "./Shared.tsx";

import styles from "./Wall.module.css";

export function Wall({
  view,
  showQuickAdd,
  quickAddProps,
  pinned,
  others,
  showPinnedGroup,
  isEmpty,
  emptyTitle,
  emptySub,
  search,
  pendingByRowId,
  footer,
  onShowMore,
  onEmptyAction,
  onOpenNote,
  onTogglePin,
}: {
  view: "masonry" | "list";
  showQuickAdd: boolean;
  quickAddProps: QuickAddProps;
  pinned: Note[];
  others: Note[];
  showPinnedGroup: boolean;
  isEmpty: boolean;
  emptyTitle: string;
  emptySub: string;
  search: string;
  pendingByRowId: Map<string, PendingRowState>;
  footer: { windowSize: number } | null;
  onShowMore: () => void;
  onEmptyAction: () => void;
  onOpenNote: (noteId: string) => void;
  onTogglePin: (note: Note) => void;
}) {
  const wallClass =
    view === "list" ? `${styles.wall} ${styles.list}` : styles.wall;

  return (
    <div className={styles.scrollInner}>
      {showQuickAdd ? <QuickAdd {...quickAddProps} /> : null}

      {showPinnedGroup ? (
        <>
          <div className={styles.eyebrow}>
            <Icon svg={I.pinCard} /> Pinned
          </div>
          <div className={wallClass}>
            {pinned.map((note) => (
              <Card
                key={note.note_id}
                note={note}
                search={search}
                pending={pendingByRowId.get(note.note_id)}
                onOpen={onOpenNote}
                onTogglePin={onTogglePin}
              />
            ))}
          </div>
          {others.length > 0 ? (
            <div className={`${styles.eyebrow} ${styles.eyebrowOthers}`}>
              Others
            </div>
          ) : null}
        </>
      ) : null}

      <div className={wallClass}>
        {others.map((note) => (
          <Card
            key={note.note_id}
            note={note}
            search={search}
            pending={pendingByRowId.get(note.note_id)}
            onOpen={onOpenNote}
            onTogglePin={onTogglePin}
          />
        ))}
      </div>

      {isEmpty ? (
        <div className="kit-empty">
          <div className="kit-empty-icon">
            <Icon svg={I.empty} />
          </div>
          <div className="kit-empty-title">{emptyTitle}</div>
          <div className="kit-empty-sub">{emptySub}</div>
          <button type="button" className="kit-btn" onClick={onEmptyAction}>
            {search.trim() ? "Clear search" : "New note"}
          </button>
        </div>
      ) : null}

      {footer ? (
        <div className="kit-foot">
          <span>
            Showing your latest {footer.windowSize} notes — older ones are a
            search away.
          </span>
          <button type="button" className="kit-btn" onClick={onShowMore}>
            Show more
          </button>
        </div>
      ) : null}
    </div>
  );
}
