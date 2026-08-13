// The five empty states (Docs spec §4.6), as one block.
//
// "Five empty states: a new drive (this one), an empty folder, an empty shelf,
// a filter with no matches, a search with no matches. Only this one gets a
// display serif." (§4.6 `noteBlock`, verbatim.)
//
// That note is the model, and this component is the model made visible: the
// variant arrives from `emptyStateView` (view-state.ts) already decided, the
// copy arrives from `emptyCopy` (view-copy.ts), and the ONLY thing decided
// here is which rung the title takes — display for the first-run drive,
// title for the other four, because those are one state of a screen that
// normally has rows.
//
// This replaces the app's old `emptyStateFor` + kit-empty pair. `.kit-empty`
// is a centred notice card with no node for a paragraph, so the truth about
// where a member's bytes go had nowhere to stand; Photos hit the same wall and
// drew its own block for the same reason (state-honesty.test.ts).
//
// AN ACTION IS RENDERED ONLY WHERE THE APP CAN PERFORM IT. `runFor` returns a
// handler or nothing, so a variant whose way forward is a route that has not
// landed (§4.6's "Scan a document") states its case and offers what exists,
// rather than drawing a button into a dead end.
import type { ReactNode } from "react";

import { EMPTY_MODEL_NOTE } from "../view-copy.ts";
import type { EmptyStateView } from "../view-state.ts";

import styles from "./EmptyState.module.css";

export function EmptyState({
  view,
  runFor,
}: {
  view: EmptyStateView;
  /** The handler for one of this variant's action labels, or nothing. */
  runFor: (label: string) => (() => void) | undefined;
}): ReactNode {
  if (!view.visible) return null;
  const labels = [view.action, view.action2].filter(
    (label): label is string => typeof label === "string"
  );
  const actions = labels.flatMap((label) => {
    const run = runFor(label);
    return run ? [{ label, run }] : [];
  });
  return (
    <div className={styles.empty} data-variant={view.variant}>
      <h2 className={styles.title} data-display={String(view.display)}>
        {view.title}
      </h2>
      <p className={styles.body}>{view.body}</p>
      {actions.length > 0 ? (
        <div className={styles.actions}>
          {actions.map((action, index) => (
            <button
              key={action.label}
              type="button"
              // One filled control per view, and only where the empty block IS
              // the view — the four in-screen variants leave the fill to the
              // app bar's own verb (§3.1 `emptyBlock`).
              className={
                view.display && index === 0 ? "kit-btn primary" : "kit-btn"
              }
              onClick={() => action.run()}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
      {/* The model, said where it is true rather than only in a spec. It rides
          the first-run state alone, which is the one that owns the display
          rung and therefore the one the sentence is about. */}
      {view.display ? <p className={styles.note}>{EMPTY_MODEL_NOTE}</p> : null}
    </div>
  );
}
