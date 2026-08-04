import { useId } from "react";
import type { JSX, MouseEvent, ReactNode } from "react";

import type { IconName } from "@centraid/design";

import { useCommitAvailability } from "../shell/commitAvailability.js";
import { cx } from "./cx.js";
import Icon from "./Icon.js";

import styles from "./Button.module.css";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "quiet"
  | "destructive"
  | "destructiveFilled";
export type ButtonSize = "md" | "sm" | "chrome";

export interface ButtonProps {
  label?: string;
  /** Arbitrary content — takes precedence over `label` when both are given. */
  children?: ReactNode;
  /**
   * DOM idiom — the mobile twin names this `onPress`. The prop *name* differs
   * on purpose (click vs. press are genuinely different runtime events); the
   * rest of the API (label/variant/icon/disabled) mirrors mobile 1:1.
   */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  variant?: ButtonVariant;
  /** `md` (default) · `sm` (compact page button) · `chrome` (26px titlebar scale). */
  size?: ButtonSize;
  icon?: IconName;
  disabled?: boolean;
  className?: string;
  title?: string;
  ariaLabel?: string;
  /**
   * Is this the control that COMMITS — the one that writes data (issue #708,
   * C7)? Defaults to `variant === "primary"`, because the filled ink IS the
   * commit control in this grammar. Set it explicitly on a commit that is not
   * the view's one filled element, or `false` on a primary that only navigates
   * (a wizard's "Next" over local state commits nothing).
   *
   * A commit control disables itself while the shell cannot commit, and
   * carries the reason as its accessible description — no screen reimplements
   * the check.
   */
  commit?: boolean;
}

const VARIANT_CLASS: Record<ButtonVariant, string | undefined> = {
  destructive: styles.destructive,
  destructiveFilled: styles.destructiveFilled,
  primary: styles.primary,
  quiet: styles.quiet,
  secondary: styles.secondary,
};

/**
 * Button, mirroring the mobile `<Button>` API. Styled by the co-located
 * `Button.module.css` — the single button system for the shell. `secondary` is
 * the default raised action; `primary` is the one accent-filled CTA.
 */
export default function Button({
  label,
  children,
  onClick,
  variant = "secondary",
  size = "md",
  icon,
  disabled,
  className,
  title,
  ariaLabel,
  commit,
}: ButtonProps): JSX.Element {
  const availability = useCommitAvailability();
  const isCommit = commit ?? variant === "primary";
  const refused = isCommit && availability.blocked && !disabled;
  const reasonId = useId();
  return (
    <>
      <button
        type="button"
        // `.btn` is the base on EVERY size, including chrome. It used to be
        // swapped out for `.chrome`, which meant a titlebar button silently
        // lost the shared hover, press and focus-ring rules keyed on `.btn` —
        // a control with no visible focus ring is a keyboard dead end.
        className={cx(
          styles.btn,
          size === "chrome" && styles.chrome,
          size === "sm" && styles.sm,
          VARIANT_CLASS[variant],
          className
        )}
        disabled={disabled}
        // A refused commit stays FOCUSABLE (`aria-disabled`, not `disabled`),
        // so a keyboard reader can land on it and hear why. The recessive
        // look is a colour token on this leaf — never a container opacity,
        // which would composite every descendant and void the contrast the
        // token guarantees. The reason itself renders as visible inline text
        // right after the button (`.reason`), never a `title` tooltip — the
        // brief is explicit that a disabled commit states its reason inline,
        // never only on hover.
        aria-disabled={refused ? true : undefined}
        aria-describedby={refused ? reasonId : undefined}
        title={title}
        aria-label={ariaLabel}
        onClick={disabled || refused ? undefined : onClick}
      >
        {icon ? (
          <Icon
            name={icon}
            size={14}
            strokeWidth={
              variant === "primary" || variant === "destructiveFilled"
                ? 2
                : 1.75
            }
          />
        ) : null}
        {children ?? label}
      </button>
      {refused ? (
        <span className={styles.reason} id={reasonId}>
          {availability.reason}
        </span>
      ) : null}
    </>
  );
}

/** Standalone target-min icon-only button. */
export function IconButton(props: {
  icon?: IconName;
  children?: ReactNode;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  ariaLabel: string;
  title?: string;
  disabled?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className={cx(styles.icon, props.className)}
      aria-label={props.ariaLabel}
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.icon ? (
        <Icon name={props.icon} size={16} strokeWidth={1.7} />
      ) : (
        props.children
      )}
    </button>
  );
}
