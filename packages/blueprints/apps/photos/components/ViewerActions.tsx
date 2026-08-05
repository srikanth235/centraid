// The viewer's actions, in both of the two places they appear (v4 handoff
// §7.1, §D).
//
// ONE SET, TWO ARRANGEMENTS. The desktop bar and the phone's bottom bar carry
// the same names and the same marks; what differs is which five/six are in
// reach and where the row sits. So the caller describes each action ONCE, as
// data, and this file lays it out — rather than two components drifting apart
// on what `Copy to Sharing` is called.
//
// LABELS ARE A FUNCTION OF WIDTH, NOT OF SURFACE (viewer.ts's
// LABEL_BREAKPOINT). Below 840px OF BAR the actions go icon-only with the
// label carried as `aria-label` and `title` — which is why `labelled` is a
// prop here and not a `@media` query in the stylesheet: the same 1420px window
// crosses the threshold when the info rail opens.
//
// Every control is labelled either way (§18), and every mark is `aria-hidden`
// — the registry adapter in icons.tsx sets that on the element it renders.
import type { FC, ReactElement } from "react";

import type { PhoneActionId, ViewerActionId } from "../viewer.ts";
import { ACTION_LABELS } from "../viewer.ts";

import styles from "./Lightbox.module.css";

/** One action, described once. `href` makes it an anchor (Download is a real
 *  link, so it keeps the browser's own save behaviour and its context menu). */
export interface ViewerActionSpec {
  id: ViewerActionId | PhoneActionId;
  icon: FC<{ size?: number; filled?: boolean }>;
  /** Set where the mark itself carries state — the favourite heart fills. */
  filled?: boolean;
  onRun?: () => void;
  href?: string;
  download?: string;
  scope?: string;
  disabled?: boolean;
  /** Why it is disabled. A read-only vault states the reason on the control
   *  rather than in a tooltip that never appears on a touch surface (§6). */
  reason?: string;
  /** A toggle that is currently on — `Info`, and `Favorite`. */
  pressed?: boolean;
  /** Trash. An outlined `--net` button, never a filled one (§18). */
  destructive?: boolean;
}

/** The accessible name, which is the label whether or not it is drawn. */
function nameOf(spec: ViewerActionSpec): string {
  return ACTION_LABELS[spec.id];
}

function Mark({ spec }: { spec: ViewerActionSpec }): ReactElement {
  const Glyph = spec.icon;
  return <Glyph size={18} filled={spec.filled ?? false} />;
}

/**
 * The top bar's action row: outlined stage buttons. An action with an `href`
 * renders as an anchor so the browser owns the download; everything else is a
 * button, and a button that cannot fire is DISABLED rather than firing and
 * apologising.
 */
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
        // An icon-only control names itself twice on purpose: `aria-label` for
        // a screen reader, `title` for a pointer that hovers and wonders.
        // Labelled, the visible text IS the name, so `title` only carries the
        // reason a disabled control cannot fire.
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
            aria-pressed={spec.pressed === undefined ? undefined : spec.pressed}
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

/**
 * The phone's bottom bar (§D): five 56px targets where a thumb is. Never
 * labelled — at 390px there is no width for six words — so every one of them
 * carries its name on the element instead.
 */
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
            aria-pressed={spec.pressed === undefined ? undefined : spec.pressed}
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
