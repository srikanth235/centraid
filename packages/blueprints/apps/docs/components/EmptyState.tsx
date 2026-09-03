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
  runFor: (label: string) => (() => void) | undefined;
}): ReactNode {
  if (!view.visible) return null;
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
      {/* §4.6's note lives in view-copy.ts now. */}
    </div>
  );
}
