// The overlays that are not a confirm: quick add and the shortcut sheet
// (spec §3, §7). The band's More sheet is the ONE shared
// `_shared/MoreSheet.tsx` (#883 B9), wired from `app-root.tsx`.
//
// QUICK ADD IS ONE CONTROL AND ONE FILLED BUTTON. Title first, optional chip
// rows under it, and the foot states where it will land. The defaults answer
// what they can, so four words and Add files a task correctly.
//
// A DENIED WRITE SCOPE DISABLES ADD WITH THE REASON, never a dead button; the
// control stops being filled the moment it stops being pressable.
import type { ReactNode } from "react";

import { KitModal } from "../../_shared/KitModal.tsx";
import { displayText } from "../../_shared/untrusted.ts";
import type { ShelfId } from "../shelves.ts";
import {
  CANCEL,
  PRIORITY_CHIPS,
  QUICK_ADD,
  SHORTCUTS,
  landsInFoot,
  shelfCopy,
} from "../view-copy.ts";

import styles from "./Board.module.css";

export interface ScopeChoice {
  id: string;
  label: string;
  canWrite: boolean;
}

export interface QuickAddProps {
  narrow: boolean;
  place: string;
  scopes: readonly ScopeChoice[];
  landsIn: string | null;
  onLandsIn: (scopeId: string) => void;
  priority: number;
  onPriority: (level: number) => void;
  /** The one reason capture cannot fire, or undefined when it can. */
  disabledReason?: string;
  inputRef: (el: HTMLInputElement | null) => void;
  onCancel: () => void;
  onAdd: () => void;
}

export function QuickAdd(props: QuickAddProps): ReactNode {
  // The callback ref comes off `props` FIRST: a ref read from the props object
  // taints every later `props.*` read for the React compiler (#573).
  const { inputRef } = props;
  const chosen =
    props.scopes.find((scope) => scope.id === (props.landsIn ?? "")) ??
    props.scopes[0];
  const disabled = props.disabledReason !== undefined;
  return (
    <div className={styles.panelScrim}>
      {/* A real `<dialog open>`: the panel stands in the flow under its own
          scrim rather than taking the platform's modal layer, because capture
          sits over the board it is filing into and the board must stay
          readable. The tag carries the semantics a `role` would only claim. */}
      <KitModal layer="inline" className={styles.panel} label={QUICK_ADD.add}>
        <input
          ref={inputRef}
          className={`kit-input ${styles.captureField}`}
          data-touch={props.narrow ? "true" : undefined}
          placeholder={
            props.narrow
              ? QUICK_ADD.touchPlaceholder
              : QUICK_ADD.pointerPlaceholder
          }
          aria-label={QUICK_ADD.add}
        />

        <div className={styles.chipRow}>
          {PRIORITY_CHIPS.map((label, level) => (
            <button
              key={label}
              type="button"
              className="kit-chip"
              aria-pressed={props.priority === level}
              onClick={() => props.onPriority(level)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* *Lands in* — a two-chip choice with personal as the default. A
            read-only audience is offered as unpressable WITH its reason, not
            hidden: a member who cannot write to the family vault should see
            that fact where the decision is made. */}
        <div className={styles.chipRow}>
          {props.scopes.map((scope) => (
            <button
              key={scope.id || "own"}
              type="button"
              className="kit-chip"
              aria-pressed={chosen?.id === scope.id}
              disabled={!scope.canWrite}
              onClick={() => props.onLandsIn(scope.id)}
            >
              {displayText(scope.label)}
            </button>
          ))}
        </div>

        <p className={styles.panelNote}>{QUICK_ADD.assistant}</p>

        <div className={styles.panelFoot}>
          <span className={styles.num}>
            {landsInFoot(
              displayText(props.place),
              displayText(chosen?.label ?? "")
            )}
          </span>
          <button type="button" className="kit-btn" onClick={props.onCancel}>
            {CANCEL}
          </button>
          <button
            type="button"
            className={disabled ? "kit-btn" : "kit-btn primary"}
            disabled={disabled}
            title={props.disabledReason}
            onClick={props.onAdd}
          >
            {QUICK_ADD.add}
          </button>
        </div>
        {props.disabledReason ? (
          <p className={styles.panelNote}>{props.disabledReason}</p>
        ) : null}
      </KitModal>
    </div>
  );
}

export function Shortcuts({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <div className={styles.sheetScrim}>
      <KitModal layer="inline" className={styles.sheet} label="Keyboard">
        {SHORTCUTS.map((entry) => (
          <div key={entry.keys} className={styles.sheetRow}>
            <span className={`${styles.num} ${styles.keys}`}>{entry.keys}</span>
            <span className={styles.railLabel}>{entry.act}</span>
          </div>
        ))}
        <button type="button" className="kit-btn" onClick={onClose}>
          {CANCEL}
        </button>
      </KitModal>
    </div>
  );
}

/** The shelf a More row lands on, named for the bar while it is open. */
export function moreRowTitle(shelf: ShelfId): string {
  return shelfCopy(shelf).title;
}
