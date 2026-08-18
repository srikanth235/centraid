// The search field — drawn in the SHELF'S OWN BODY, not in a header this app
// keeps above every screen.
//
// THIS IS THE PHOTOS MOVE. `photos/Chrome.tsx` retired "the in-pane search
// field" for the same reason: a field pinned above every shelf asks "what are
// you looking for?" on screens that are not searches, and it asks it in the
// widest, most permanent region the app owns. The way IN is now the app bar's
// Search control (`frame.tsx`'s `SearchBarButton`, beside Select) and the
// compact band's Search tab; both land on the Search shelf, and the field is
// drawn once, here, on the one shelf that searches.
//
// The v11 handoff agrees: its docs `search` scene opens with
// `fieldBlock('right of way', 'Search titles and contents', true)` — a BLOCK,
// the first thing the shelf's content pushes, capped at 520px. Not chrome.
//
// UNCONTROLLED ON PURPOSE. `app-root.tsx`'s `applySearch` is a 150ms debounce
// that reads `#searchInput` out of the document and races its own sequence
// number against the vault's answer. Making the value a React prop would put
// a render between every keystroke and that debounce for no gain, so the id
// and the read-the-DOM contract are kept exactly as they were — this component
// moved the field, it did not rewire what typing in it does.
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
  /** The query as the app knows it — read only to decide whether there is
   *  anything to clear. The input itself is uncontrolled (see above). */
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
        // A WORD, not an icon button (handoff `clearCss`: underlined text in
        // the annotation register). The same affordance Photos' shelf carries,
        // in the same place — beside the field, inside its border.
        <button type="button" className={styles.clearBtn} onClick={onClear}>
          {SEARCH_CLEAR}
        </button>
      ) : null}
    </search>
  );
}
