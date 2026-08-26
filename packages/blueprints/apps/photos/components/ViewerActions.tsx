// Viewer actions (v4 §7.1, §D). Labels follow bar width (`labelled` prop).
// `reason` on the control, not a tooltip (§6). Trash is outlined `--net` (§18).
import type { FC, ReactElement } from "react";

import type { PhoneActionId, ViewerActionId } from "../viewer.ts";
import { ACTION_LABELS } from "../viewer.ts";

import styles from "./Lightbox.module.css";

export interface ViewerActionSpec {
  id: ViewerActionId | PhoneActionId;
  icon: FC<{ size?: number; filled?: boolean }>;
  label?: string;
  filled?: boolean;
  onRun?: () => void;
  href?: string;
  download?: string;
  scope?: string;
  disabled?: boolean;
  reason?: string;
  pressed?: boolean;
  destructive?: boolean;
}

function nameOf(spec: ViewerActionSpec): string {
  return spec.label ?? ACTION_LABELS[spec.id];
}

function Mark({ spec }: { spec: ViewerActionSpec }): ReactElement {
  const Glyph = spec.icon;
  return <Glyph size={18} filled={spec.filled ?? false} />;
}

export function ViewerBarActions({
  specs,
  labelled,
}: {
  specs: readonly ViewerActionSpec[];
  labelled: boolean;
}) {
  return (
    <div className={styles.actions}>
      {specs.map((spec) => {
        const name = nameOf(spec);
        const className = `${styles.action} ${spec.destructive ? styles.destructive : ""}`;
        const label = labelled ? (
          <span className={styles.actionLabel}>{name}</span>
        ) : null;
        // Icon-only: `aria-label` + `title`. Labelled, `title` is only the disable reason.
        const title = spec.reason ?? (labelled ? undefined : name);
        const handleRun = spec.onRun;
        if (spec.href !== undefined) {
          return (
            <a
              key={spec.id}
              className={className}
              href={spec.href}
              download={spec.download}
              data-scope={spec.scope}
              aria-label={name}
              title={title}
            >
              <Mark spec={spec} />
              {label}
            </a>
          );
        }
        return (
          <button
            key={spec.id}
            type="button"
            className={className}
            disabled={spec.disabled ?? false}
            aria-pressed={spec.pressed}
            aria-label={name}
            title={title}
            onClick={handleRun}
          >
            <Mark spec={spec} />
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** Never labelled — name lives on the element. */
export function ViewerBottomBar({
  specs,
}: {
  specs: readonly ViewerActionSpec[];
}) {
  return (
    <div
      className={styles.bottomBar}
      role="toolbar"
      aria-label="Photograph actions"
    >
      {specs.map((spec) => {
        const name = nameOf(spec);
        const handleRun = spec.onRun;
        return (
          <button
            key={spec.id}
            type="button"
            className={`${styles.bottomAction} ${spec.destructive ? styles.destructive : ""}`}
            disabled={spec.disabled ?? false}
            aria-pressed={spec.pressed}
            aria-label={name}
            title={spec.reason ?? name}
            onClick={handleRun}
          >
            <Mark spec={spec} />
          </button>
        );
      })}
    </div>
  );
}
