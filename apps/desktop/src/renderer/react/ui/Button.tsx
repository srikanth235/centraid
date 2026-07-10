import type { JSX, MouseEvent, ReactNode } from 'react';
import { cx } from './cx.js';
import type { IconName } from '@centraid/design-tokens';
import Icon from './Icon.js';
import styles from './Button.module.css';

export type ButtonVariant = 'solid' | 'primary' | 'soft' | 'ghost';
export type ButtonSize = 'md' | 'sm' | 'chrome';

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
}

const VARIANT_CLASS: Record<ButtonVariant, string | undefined> = {
  ghost: styles.ghost,
  primary: styles.primary,
  soft: styles.soft,
  solid: undefined,
};

/**
 * Button, mirroring the mobile `<Button>` API. Styled by the co-located
 * `Button.module.css` — the single button system for the shell. `solid` is
 * the ink-filled default look; `primary` is the accent CTA.
 */
export default function Button({
  label,
  children,
  onClick,
  variant = 'primary',
  size = 'md',
  icon,
  disabled,
  className,
  title,
  ariaLabel,
}: ButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={cx(
        size === 'chrome' ? styles.chrome : styles.btn,
        size === 'sm' && styles.sm,
        VARIANT_CLASS[variant],
        className,
      )}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      onClick={disabled ? undefined : onClick}
    >
      {icon ? <Icon name={icon} size={14} strokeWidth={variant === 'primary' ? 2 : 1.75} /> : null}
      {children ?? label}
    </button>
  );
}

/** Standalone 36px icon-only square button (the old `.btn-icon`). */
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
      {props.icon ? <Icon name={props.icon} size={16} strokeWidth={1.7} /> : props.children}
    </button>
  );
}
