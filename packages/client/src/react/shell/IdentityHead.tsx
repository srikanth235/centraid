import type { CSSProperties, JSX, RefObject } from "react";

import { ICON_CHIP_TINT, iconChipRadius } from "@centraid/design";
import type { IconName } from "@centraid/design";

import Icon from "../ui/Icon.js";
import { DEFAULT_VAULT_ICON, PROFILE_COLORS } from "./routes/VaultModal.js";

import styles from "./IdentityHead.module.css";

// The vault identity control: it names the active vault and gateway, and the
// WHOLE row is the switcher — click anywhere on it (Slack's workspace header,
// not a 26px target hidden at the trailing edge). The trailing stepper glyph
// stays as the affordance that says "this opens something", but it is
// decoration inside the one button rather than the only place a click lands.
//
// It was the sidebar's head row until #707. The stem holds the launcher and
// nothing else, so the identity moved to the two places it is actually
// consulted — the app bar, beside what you are looking at, and Home, where you
// choose what to look at next. Same component in both, so there is one
// switcher rather than two that can disagree.
//
// Reading order is eyebrow-then-name: the gateway ("This Mac") is the quiet
// context line ABOVE the vault name, which carries the weight because it is
// the thing being selected.
//
// Household is not on this row: it is its own launcher destination, so the row
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
  /** Typed keyboard/action path to the same switcher trigger. */
  switcherButtonRef?: RefObject<HTMLButtonElement | null>;
  /** Which ramp is painting, so the chip tint comes from the design package
   *  (13% light / 20% dark) rather than a literal in the stylesheet. */
  scheme?: "light" | "dark";
}

/** The chip size, and therefore the radius: an identity mark's corner is a
 *  share of its own size (26%), so the silhouette holds at every rung. */
const AVATAR_SIZE = 24;

function Avatar({
  icon,
  color,
  scheme,
}: {
  icon: IconName;
  color: string;
  scheme: "light" | "dark";
}): JSX.Element {
  return (
    <span
      className={styles.avatar}
      aria-hidden="true"
      style={
        {
          "--chip-hue": color,
          "--chip-radius": `${iconChipRadius(AVATAR_SIZE)}px`,
          "--chip-tint": `${ICON_CHIP_TINT[scheme] * 100}%`,
        } as CSSProperties
      }
    >
      <Icon name={icon} size={14} strokeWidth={1.9} />
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
  switcherButtonRef,
  scheme = "dark",
}: IdentityHeadProps): JSX.Element {
  const name = vault?.name ?? "Loading…";
  // The popover anchors to the whole row, so it lines up under the identity it
  // is switching rather than under a glyph at the far edge.
  return (
    <div className={styles.row} data-open={switcherOpen ? "true" : undefined}>
      <button
        ref={switcherButtonRef}
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
          scheme={scheme}
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
