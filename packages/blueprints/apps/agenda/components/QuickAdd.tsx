// Quick add on a slot: a title and nothing else, then Edit for the rest.
//
// This is the spec's flow exactly — "title, then Edit opens the full editor;
// the draft paints immediately and carries the pending marker". The draft here
// is a LOCAL one: it has not been sent, so it carries the words rather than a
// held-write chip, which is reserved for a write the vault has actually been
// asked to make.
import { useEffect, useRef } from "react";
import type { ChangeEvent, KeyboardEvent, ReactNode } from "react";

import { fmtTime } from "../format.ts";
import type { QuickDraft } from "../types.ts";
import {
  QUICK_ADD,
  QUICK_DISCARD,
  QUICK_EDIT,
  QUICK_PLACEHOLDER,
  QUICK_TITLE,
} from "../view-copy.ts";
import { Num } from "./Shared.tsx";

import styles from "./QuickAdd.module.css";

export interface QuickAddProps {
  draft: QuickDraft;
  onTitle: (title: string) => void;
  onAdd: () => void;
  onEdit: () => void;
  onDiscard: () => void;
}

export function QuickAdd(props: QuickAddProps): ReactNode {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      props.onAdd();
    } else if (event.key === "Escape") {
      event.preventDefault();
      props.onDiscard();
    }
  };

  return (
    <fieldset className={styles.quick} aria-label={QUICK_TITLE}>
      <span className={styles.when}>
        <Num>{fmtTime(props.draft.start)}</Num>
      </span>
      <input
        ref={inputRef}
        type="text"
        className={`kit-input ${styles.title}`}
        aria-label={QUICK_TITLE}
        placeholder={QUICK_PLACEHOLDER}
        value={props.draft.title}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          props.onTitle(event.target.value)
        }
        onKeyDown={onKeyDown}
      />
      <button type="button" className="kit-btn" onClick={props.onEdit}>
        {QUICK_EDIT}
      </button>
      <button type="button" className="kit-btn" onClick={props.onDiscard}>
        {QUICK_DISCARD}
      </button>
      {/* The quick add's one filled control — and the view's, while it is
          open: the app bar's own New event is the same commit and the two
          never stand together, because opening this is what New event does. */}
      <button
        type="button"
        className="kit-btn primary"
        disabled={props.draft.title.trim() === ""}
        onClick={props.onAdd}
      >
        {QUICK_ADD}
      </button>
    </fieldset>
  );
}
