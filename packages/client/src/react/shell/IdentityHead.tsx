import type { JSX } from 'react';
import { tileFinish } from '@centraid/design-tokens';
import type { IconName } from '@centraid/design-tokens';
import Icon from '../ui/Icon.js';
import { DEFAULT_SPACE_ICON, PROFILE_COLORS } from './routes/SpaceModal.js';
import styles from './IdentityHead.module.css';

// The sidebar's identity row (issue #599, Decision 14). It stands where the
// space switcher used to, but it is not a switcher: a member is not "in" one
// space any more, so the row simply says who you are and where you live, and
// opens Household — the page that lists the people, devices and spaces behind
// that identity.
//
// The one switch that survives is the GATEWAY switch, and only when this client
// knows more than one gateway. It is a separate trailing button rather than a
// second meaning for the row, so "open Household" and "talk to a different
// gateway" can never be confused for one another.

export interface IdentityHeadProps {
  /** The member's own space — the identity this row names. Undefined until the
   *  scope registry resolves (first paint), which renders a quiet placeholder
   *  rather than blocking the sidebar. */
  space?: { name: string; color?: string; icon?: string };
  /** The gateway this client addresses, in the member's words ("This Mac"). */
  gatewayLabel: string;
  /** Opens Household. */
  onOpenHousehold: () => void;
  /** Present only when more than one gateway is registered — omitted hides the
   *  switch button entirely (a single-gateway household never sees it). */
  onSwitchGateway?: (anchor: DOMRect) => void;
  /** Whether the gateway popover is open — a styling hook (`data-open`). */
  switcherOpen?: boolean;
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

export default function IdentityHead({
  space,
  gatewayLabel,
  onOpenHousehold,
  onSwitchGateway,
  switcherOpen,
}: IdentityHeadProps): JSX.Element {
  const name = space?.name ?? 'Loading…';
  return (
    <div className={styles.row}>
      <button
        type="button"
        className={styles.head}
        aria-label={`${name}. Open Household.`}
        disabled={!space}
        onClick={onOpenHousehold}
      >
        <Avatar
          icon={(space?.icon as IconName) || DEFAULT_SPACE_ICON}
          color={space?.color ?? PROFILE_COLORS[0]!}
        />
        <span className={styles.text}>
          <span className={styles.name} title={name}>
            {name}
          </span>
          <span className={styles.sub}>{gatewayLabel}</span>
        </span>
      </button>
      {onSwitchGateway ? (
        <button
          type="button"
          className={styles.switch}
          aria-haspopup="menu"
          aria-expanded={switcherOpen ? 'true' : 'false'}
          data-open={switcherOpen ? 'true' : undefined}
          aria-label="Switch gateway"
          title="Switch gateway"
          onClick={(e) => onSwitchGateway(e.currentTarget.getBoundingClientRect())}
        >
          <Icon name="SwitchVert" size={14} />
        </button>
      ) : null}
    </div>
  );
}
