import type { JSX } from 'react';
import { tileFinish } from '@centraid/design-tokens';
import type { IconName } from '@centraid/design-tokens';
import Icon from '../ui/Icon.js';
import { DEFAULT_SPACE_ICON, PROFILE_COLORS } from './routes/SpaceModal.js';
import styles from './ProfileSwitcherHead.module.css';

// Sidebar-head vault switcher button — `[avatar] Name / N apps  ⇅`. Ported
// from the vanilla profiles.ts `buildSwitcherHeader` (a space IS a vault,
// #280). Rendered above "Build new" as the Sidebar `headSlot`; opening the
// quick-switch popover is delegated to the imperative `vaultSwitcher.ts`
// (body-portalled, mirrors `contextMenu.ts`) rather than owned here, so this
// stays a small presentational button.

export interface ProfileSwitcherVault {
  id: string;
  name: string;
  color: string;
  icon: IconName;
}

export interface ProfileSwitcherHeadProps {
  /** Undefined until the vault registry resolves (first paint) or if the
   *  gateway mounts no vault plane — renders a quiet placeholder instead of
   *  blocking or crashing the sidebar. */
  active?: ProfileSwitcherVault;
  /** "N apps" once known, else a quiet fallback ("—") while loading. */
  subtitle: string;
  /** Whether the vaultSwitcher popover this button opens is currently shown
   *  — purely a styling hook (`data-open`), mirrors the vanilla's own state. */
  open?: boolean;
  onToggle: (anchor: DOMRect) => void;
}

function Avatar({ icon, color }: { icon: IconName; color: string }): JSX.Element {
  const finish = tileFinish(color, 'gradient');
  return (
    <span
      className={styles.avatar}
      aria-hidden="true"
      style={{
        background: finish.background,
        boxShadow: finish.boxShadow,
        color: finish.glyphColor,
      }}
    >
      <Icon name={icon} size={16} strokeWidth={1.9} />
    </span>
  );
}

export default function ProfileSwitcherHead({
  active,
  subtitle,
  open,
  onToggle,
}: ProfileSwitcherHeadProps): JSX.Element {
  const name = active?.name ?? 'Loading…';
  return (
    <button
      type="button"
      className={styles.head}
      aria-haspopup="menu"
      aria-expanded={open ? 'true' : 'false'}
      data-open={open ? 'true' : undefined}
      aria-label={`Active space: ${name}. Click to switch.`}
      disabled={!active}
      onClick={(e) => onToggle(e.currentTarget.getBoundingClientRect())}
    >
      <Avatar icon={active?.icon ?? DEFAULT_SPACE_ICON} color={active?.color ?? PROFILE_COLORS[0]!} />
      <span className={styles.text}>
        <span className={styles.name} title={name}>
          {name}
        </span>
        <span className={styles.sub}>{subtitle}</span>
      </span>
      <span className={styles.chev}>
        <Icon name="SwitchVert" size={14} />
      </span>
    </button>
  );
}
