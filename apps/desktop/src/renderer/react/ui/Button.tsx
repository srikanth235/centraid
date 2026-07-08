import type { JSX } from 'react';
import { cx } from './cx.js';
import type { IconName } from '@centraid/design-tokens';
import Icon from './Icon.js';

export type ButtonVariant = 'primary' | 'soft' | 'ghost';

export interface ButtonProps {
  label: string;
  /**
   * DOM idiom — the mobile twin names this `onPress`. The prop *name* differs
   * on purpose (click vs. press are genuinely different runtime events); the
   * rest of the API (label/variant/icon/disabled) mirrors mobile 1:1.
   */
  onClick?: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  disabled?: boolean;
  className?: string;
}

/**
 * Button, mirroring the mobile `<Button>` API. Emits the vanilla renderer's
 * `cd-btn cd-btn-<variant>` classes so it is styled by the desktop's global
 * `styles.css` and renders pixel-identically to leftover vanilla buttons
 * during the migration.
 */
export default function Button({
  label,
  onClick,
  variant = 'primary',
  icon,
  disabled,
  className,
}: ButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={cx('cd-btn', `cd-btn-${variant}`, className)}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
    >
      {icon ? <Icon name={icon} size={14} strokeWidth={variant === 'primary' ? 2 : 1.75} /> : null}
      {label}
    </button>
  );
}
