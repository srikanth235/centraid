// Lives IN THE SHELF BODY, never chrome (photos move; entry via app-bar Search
// control / band tab). UNCONTROLLED ON PURPOSE: applySearch debounces by reading
// #searchInput from the DOM against a sequence number; a prop value adds a
// render per keystroke.
import type { KeyboardEvent, ReactNode } from "react";

import {
  SEARCH_CLEAR,
  SEARCH_LABEL,
  SEARCH_PLACEHOLDER,
} from "../drive-copy.ts";

import styles from "./SearchField.module.css";

export function SearchField({
  query,
  inputRef,
  onInput,
  onKeyDown,
  onClear,
}: {
  /** Read only to decide whether anything is clearable; input uncontrolled. */
  query: string;
  inputRef: (el: HTMLInputElement | null) => void;
  onInput: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onClear: () => void;
}): ReactNode {
  return (
    <search className={`kit-search ${styles.field}`}>
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z" />
        <path d="m16.5 16.5 4 4" />
      </svg>
      <label className="kit-sr-only" htmlFor="searchInput">
        {SEARCH_LABEL}
      </label>
      <input
        ref={inputRef}
        id="searchInput"
        type="search"
        className={styles.input}
        placeholder={SEARCH_PLACEHOLDER}
        autoComplete="off"
        onInput={onInput}
        onKeyDown={onKeyDown}
      />
      {query ? (
        // A WORD, not an icon button (handoff clearCss).
        <button type="button" className={styles.clearBtn} onClick={onClear}>
          {SEARCH_CLEAR}
        </button>
      ) : null}
    </search>
  );
}
