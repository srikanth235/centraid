import { useId } from "react";
import type { JSX, MouseEvent, ReactNode } from "react";

import type { ButtonVariant, IconName } from "@centraid/design";
import type { ButtonData } from "@centraid/design/blocks";

import { useCommitAvailability } from "../shell/commitAvailability.js";
import { cx } from "./cx.js";
import Icon from "./Icon.js";

import styles from "./Button.module.css";

export type { ButtonVariant } from "@centraid/design";

/** Shell-only: mobile's 44px touch floor is its one size. */
export type ButtonSize = "md" | "sm" | "chrome";

export interface ButtonProps extends ButtonData {
  children?: ReactNode;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  title?: string;
  ariaLabel?: string;
  ariaExpanded?: boolean;
  /** Writes data (#708, C7). Defaults to primary; set `false` on a primary
   *  that only navigates. Disables itself while the shell cannot commit. */
  commit?: boolean;
}

const VARIANT_CLASS: Record<ButtonVariant, string | undefined> = {
  destructive: styles.destructive,
  primary: styles.primary,
  quiet: styles.quiet,
  secondary: styles.secondary,
};

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
  ariaExpanded,
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
        // `.chrome`/`.sm` add to `.btn`, never replace it.
        className={cx(
          styles.btn,
          size === "chrome" && styles.chrome,
          size === "sm" && styles.sm,
          VARIANT_CLASS[variant],
          className
        )}
        // The design-gallery gate reads this attribute (#799).
        data-variant={variant}
        disabled={disabled}
        // Refused commit stays focusable; its reason renders inline.
        aria-disabled={refused ? true : undefined}
        aria-describedby={refused ? reasonId : undefined}
        title={title}
        aria-label={ariaLabel}
        aria-expanded={ariaExpanded}
        onClick={disabled || refused ? undefined : onClick}
      >
        {icon ? (
          <Icon
            name={icon}
            size={14}
            strokeWidth={variant === "primary" ? 2 : 1.75}
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
