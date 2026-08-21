// The block vocabulary's section head (v9 §8, issue #765).
//
// One label and one count, over a hairline. Every ops screen hand-rolled this
// (`.groupHead`, `.sectionHead`, `.panelHead`…); the shapes had drifted by a
// rung or a gap each. This is the single implementation.
import type { JSX } from "react";

import type { SectionActionData, SectionCopy } from "@centraid/design/blocks";

import Button from "./Button.js";
import { cx } from "./cx.js";

import styles from "./SectionBlock.module.css";

/** A section's trailing verb: the shared data plus this kit's click handler. */
export interface SectionAction extends SectionActionData {
  onClick: () => void;
}

export interface SectionBlockProps extends SectionCopy {
  /**
   * The head's trailing verb (#775) — "Refresh", "Rows/Bytes", "Sort".
   *
   * Quiet, always: the app bar owns the route's verbs and the view's one
   * filled control, so a verb about ONE SECTION goes here rather than being
   * promoted into the bar, where it would lose the subject that makes it mean
   * anything. It never commits, so `commit={false}` is stated rather than
   * inferred from the variant.
   */
  action?: SectionAction;
  /**
   * Is the section's body currently hidden? CONTROLLED — the parent owns the
   * state and, when this is true, does not render the body at all. The block
   * draws the head and the toggle and nothing else, because a section that
   * kept its rows in the DOM under `display: none` would still be found by
   * find-in-page and still be tabbed into.
   *
   * Meaningless without `onToggle`: a disclosure nothing can open is a fact,
   * and a fact is stated in `meta`.
   */
  collapsed?: boolean;
  /**
   * Turn the head into a disclosure. Presence is what draws the toggle — a
   * quiet Show/Hide verb at the touch floor, which on a phone is the only way
   * these sections open.
   *
   * It is separate from `action` rather than a variant of it: a section can
   * carry a verb about its contents ("Refresh") AND still open and close, and
   * folding the two into one slot would make a section choose.
   */
  onToggle?: () => void;
  className?: string;
}

/** Section head — uppercase label, truncating numeric meta and an optional
 *  trailing verb, over a hairline. */
export default function SectionBlock({
  label,
  meta,
  action,
  collapsed,
  onToggle,
  className,
}: SectionBlockProps): JSX.Element {
  return (
    <div
      className={cx(styles.section, className)}
      data-collapsed={onToggle && collapsed ? "true" : undefined}
    >
      <h2 className={styles.label}>{label}</h2>
      {meta ? <span className={styles.meta}>{meta}</span> : null}
      {action ? (
        <Button
          className={styles.action}
          commit={false}
          disabled={action.off}
          label={action.label}
          onClick={() => action.onClick()}
          size="sm"
          title={action.hint}
          variant="quiet"
        />
      ) : null}
      {onToggle ? (
        <Button
          className={styles.toggle}
          commit={false}
          ariaExpanded={!collapsed}
          label={collapsed ? "Show" : "Hide"}
          onClick={() => onToggle()}
          size="sm"
          variant="quiet"
        />
      ) : null}
    </div>
  );
}
