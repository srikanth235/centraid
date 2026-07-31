import type { JSX } from "react";

import { tileFinish } from "@centraid/design-tokens";
import type { IconName } from "@centraid/design-tokens";

import Icon from "../ui/Icon.js";
import { DEFAULT_VAULT_ICON, PROFILE_COLORS } from "./routes/VaultModal.js";

import styles from "./IdentityHead.module.css";

// The sidebar's identity row names the active vault and gateway, and the WHOLE
// row is the switcher — click anywhere on it (Slack's workspace header, not a
// 26px target hidden at the right edge). The trailing stepper glyph stays as
// the affordance that says "this opens something", but it is decoration inside
// the one button rather than the only place a click lands.
//
// Reading order is eyebrow-then-name: the gateway ("This Mac") is the quiet
// context line ABOVE the vault name, which carries the weight because it is
// the thing being selected. That is the compact-selector idiom (Linear's
// workspace switcher) and it puts the bold token on the row's optical centre.
//
// Household is not on this row: it has its own sidebar nav entry, so the row
// spending its whole hit area on a duplicate link was the worse trade. Where a
// host registers no switcher at all, the row falls back to opening Household
// rather than becoming a dead control.

export interface IdentityHeadProps {
  /** The member's own vault — the identity this row names. Undefined until the
   *  scope registry resolves (first paint), which renders a quiet placeholder
   *  rather than blocking the sidebar. */
  vault?: { name: string; color?: string; icon?: string };
  /** The gateway this client addresses, in the member's words ("This Mac"). */
  gatewayLabel: string;
  /** Opens Household — the fallback when no switcher is wired. */
  onOpenHousehold: () => void;
  /** Opens the vault switcher (vaults only since #665; gateway management
   *  lives in Settings → Gateways). */
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

/**
 * The ⌃/⌄ stepper a native `<select>` wears — two stacked chevrons, not the ⇅
 * arrows this row used to carry. Composed from the shared `ChevronDown` glyph
 * (one flipped) rather than a new icon, so it stays on the one path source in
 * the design-tokens package. Decoration inside the row button: `aria-hidden`,
 * no hit area of its own.
 */
function Stepper(): JSX.Element {
  return (
    <span className={styles.stepper} aria-hidden="true">
      <span className={styles.stepUp}>
        <Icon name="ChevronDown" size={11} strokeWidth={2.4} />
      </span>
      <Icon name="ChevronDown" size={11} strokeWidth={2.4} />
    </span>
  );
}

export default function IdentityHead({
  vault,
  gatewayLabel,
  onOpenHousehold,
  onSwitchGateway,
  switcherOpen,
}: IdentityHeadProps): JSX.Element {
  const name = vault?.name ?? "Loading…";
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
              "aria-label": `${name} on ${gatewayLabel}. Switch vault or gateway.`,
              title: "Switch vault or gateway (⌘⇧G)",
            }
          : { "aria-label": `${name}. Open Household.` })}
        disabled={!vault}
        onClick={(e) => {
          if (!onSwitchGateway) {
            onOpenHousehold();
            return;
          }
          onSwitchGateway(e.currentTarget.getBoundingClientRect());
        }}
      >
        <Avatar
          icon={(vault?.icon as IconName) || DEFAULT_VAULT_ICON}
          color={vault?.color ?? PROFILE_COLORS[0]!}
        />
        <span className={styles.text}>
          <span className={styles.eyebrow}>{gatewayLabel}</span>
          <span className={styles.name} title={name}>
            {name}
          </span>
        </span>
        {onSwitchGateway ? <Stepper /> : null}
      </button>
    </div>
  );
}
