import type { JSX } from "react";

import { tileFinish } from "@centraid/design-tokens";
import type { IconName } from "@centraid/design-tokens";

import Icon from "../ui/Icon.js";
import { DEFAULT_SPACE_ICON, PROFILE_COLORS } from "./routes/SpaceModal.js";

import styles from "./IdentityHead.module.css";

// The sidebar's identity row names the active space and gateway, and the WHOLE
// row is the switcher — click anywhere on it (Slack's workspace header, not a
// 26px target hidden at the right edge). The trailing ⇅ glyph stays as the
// affordance that says "this opens something", but it is decoration inside the
// one button rather than the only place a click lands.
//
// Household is not on this row: it has its own sidebar nav entry, so the row
// spending its whole hit area on a duplicate link was the worse trade. Where a
// host registers no switcher at all, the row falls back to opening Household
// rather than becoming a dead control.

export interface IdentityHeadProps {
  /** The member's own space — the identity this row names. Undefined until the
   *  scope registry resolves (first paint), which renders a quiet placeholder
   *  rather than blocking the sidebar. */
  space?: { name: string; color?: string; icon?: string };
  /** The gateway this client addresses, in the member's words ("This Mac"). */
  gatewayLabel: string;
  /** Opens Household — the fallback when no switcher is wired. */
  onOpenHousehold: () => void;
  /** Opens the combined space and gateway switcher. */
  onSwitchGateway?: (anchor: DOMRect) => void;
  /** Whether the gateway popover is open — a styling hook (`data-open`). */
  switcherOpen?: boolean;
}

function Avatar({
  icon,
  color,
}: {
  icon: IconName;
  color: string;
}): JSX.Element {
  const finish = tileFinish(color, "gradient");
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
  const name = space?.name ?? "Loading…";
  // The popover anchors to the whole row, so it lines up under the identity it
  // is switching rather than under a glyph at the far edge.
  return (
    <div className={styles.row} data-open={switcherOpen ? "true" : undefined}>
      <button
        type="button"
        className={styles.head}
        {...(onSwitchGateway
          ? {
              "aria-haspopup": "menu" as const,
              "aria-expanded": switcherOpen
                ? ("true" as const)
                : ("false" as const),
              "aria-label": `${name} on ${gatewayLabel}. Switch space or gateway.`,
              title: "Switch space or gateway (⌘⇧G)",
            }
          : { "aria-label": `${name}. Open Household.` })}
        disabled={!space}
        onClick={(e) => {
          if (!onSwitchGateway) {
            onOpenHousehold();
            return;
          }
          onSwitchGateway(e.currentTarget.getBoundingClientRect());
        }}
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
        {onSwitchGateway ? (
          <span className={styles.switch} aria-hidden="true">
            <Icon name="SwitchVert" size={14} />
          </span>
        ) : null}
      </button>
    </div>
  );
}
