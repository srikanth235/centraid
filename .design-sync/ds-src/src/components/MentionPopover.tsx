import type { CSSProperties } from 'react';

export interface MentionRow {
  /** Kind label shown on the left. */
  kind: string;
  /** Entity title. */
  title: string;
}

export interface MentionPopoverProps {
  /** The matching entities to list. */
  items: MentionRow[];
  /** Index of the highlighted row. */
  selectedIndex?: number;
  /** Footer note. */
  note?: string;
  /** Shown when nothing matches. */
  emptyText?: string;
  /**
   * Style passthrough on the root. In the app this popover is caret-anchored
   * (`position: fixed`); override positioning here when embedding it in flow.
   */
  style?: CSSProperties;
}

/**
 * The @-mention picker — a caret-anchored listbox of vault entities. This is
 * the static presentation; the live version fetches and filters as you type.
 */
export function MentionPopover({
  items,
  selectedIndex = 0,
  note = 'Picking links only the picked item — receipted.',
  emptyText = 'Nothing in your vault matches that.',
  style,
}: MentionPopoverProps) {
  return (
    <div
      className="kit-mention-pop"
      role="listbox"
      aria-label="Mention an entity from your vault"
      style={style}
    >
      <div className="kit-mention-list">
        {items.length ? (
          items.map((it, i) => (
            <button
              key={i}
              type="button"
              className="kit-mention-row"
              role="option"
              aria-selected={i === selectedIndex}
            >
              <span className="kit-mention-kind">{it.kind}</span>
              <span className="kit-mention-title">{it.title}</span>
            </button>
          ))
        ) : (
          <p className="kit-mention-empty">{emptyText}</p>
        )}
      </div>
      <p className="kit-mention-note">{note}</p>
    </div>
  );
}
