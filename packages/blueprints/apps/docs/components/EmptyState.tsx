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

import type { ACTION_ICONS } from "../icons.ts";
import type { EmptyStateView } from "../view-state.ts";
import { ActionBtn } from "./Shared.tsx";

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
  // The word and its shape travel together out of the copy table, so a copy
  // edit can never silently drop the mark (`view-copy.ts` `actionIcon`).
  const offered: { label: string; icon?: keyof typeof ACTION_ICONS }[] = [];
  if (view.action)
    offered.push({
      label: view.action,
      ...(view.actionIcon ? { icon: view.actionIcon } : {}),
    });
  if (view.action2)
    offered.push({
      label: view.action2,
      ...(view.action2Icon ? { icon: view.action2Icon } : {}),
    });
  const actions = offered.flatMap((a) => {
    const run = runFor(a.label);
    return run ? [{ ...a, run }] : [];
  });
  return (
    <div className={styles.empty} data-variant={view.variant}>
      <h2 className={styles.title} data-display={String(view.display)}>
        {view.title}
      </h2>
      <p className={styles.body}>{view.body}</p>
      {actions.length > 0 ? (
        <div className={styles.actions}>
          {actions.map((action, index) => {
            // One filled control per view, and only where the empty block IS
            // the view — the four in-screen variants leave the fill to the app
            // bar's own verb (§3.1 `emptyBlock`).
            const tone = view.display && index === 0 ? "primary" : "";
            return action.icon ? (
              <ActionBtn
                key={action.label}
                icon={action.icon}
                label={action.label}
                tone={tone}
                onClick={() => action.run()}
              />
            ) : (
              <button
                key={action.label}
                type="button"
                className={`kit-btn${tone ? ` ${tone}` : ""}`}
                onClick={() => action.run()}
              >
                {action.label}
              </button>
            );
          })}
        </div>
      ) : null}
      {/* §4.6's five-empty-states note used to render here. It described the
          MODEL to a member standing in one of the five, which is a spec note
          on a screen; it lives in `view-copy.ts`'s comment instead. */}
    </div>
  );
}
