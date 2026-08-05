import type { CSSProperties, JSX } from "react";

import type { InlineBandClaim } from "@centraid/blueprints/apps/inline-types";
import { isIconName } from "@centraid/design";

import Icon from "../ui/Icon.js";
import Logo from "../ui/Logo.js";

import chrome from "./chrome.module.css";

// The claimed compact band (Photos v4, §3.1 — CHANGELOG F amends invariant 1).
//
// On the compact surface a FIRST-PARTY route may claim the phone's bottom
// band. When it does, this band renders INSTEAD of the frame's stem band —
// exactly one band exists at any moment, never two, and `ShellFrame` enforces
// that by rendering one or the other rather than by hiding one of a pair.
//
// The frame is still represented, by a capsule: a home button at the LEADING
// edge, OUTSIDE the app's tab group. The group boundary is the whole
// explanation of why it is not a sixth tab, which is why the tabs sit in a real
// grouping element rather than merely a differently-styled span — a screen
// reader is told the same thing the seam tells a sighted reader.
//
// The capsule is a FRAME control, not the app's: fixed position, the host's own
// page colour, no app theming, always present, and never under 44px. The band
// itself floats (12px inset, `--r-lg`, hairline `--line`) on OPAQUE paper — no
// blur, no translucency, no shadow, because the bar sits over unpredictable
// photographs and label contrast must not depend on what the member
// photographed. Every positional property in the stylesheet is logical, so the
// capsule mirrors to the other edge under RTL with no second rule.

/** The capsule's target. The brief's number is 52; 44 is the floor no target
 *  in this product may go under, and it is asserted rather than commented. */
export const BAND_CAPSULE_SIZE = 52;

/** Five destinations plus More, exactly as the frame's own band is capped: a
 *  sixth tab puts every target under 44px. */
export const BAND_MAX_DESTINATIONS = 5;

export interface AppBandProps {
  claim: InlineBandClaim;
  /** What the tab group announces — "Photos", not "Tabs". */
  appName: string;
  /** The capsule: Home in one tap. */
  onHome: () => void;
}

export default function AppBand({
  claim,
  appName,
  onHome,
}: AppBandProps): JSX.Element {
  // Capped by the FRAME, not by the app's good behaviour: an app that offers
  // six destinations gets five, and its own More is where the sixth belongs.
  const destinations = claim.destinations.slice(0, BAND_MAX_DESTINATIONS);

  return (
    <nav className={chrome.appBand} data-band="app" aria-label={appName}>
      {/* Outside the group, before it in reading order: the way out of an app
          is no harder to reach than the app's own tabs. */}
      <button
        className={chrome.bandCapsule}
        type="button"
        aria-label="Home"
        style={{ "--band-capsule": `${BAND_CAPSULE_SIZE}px` } as CSSProperties}
        onClick={onHome}
      >
        <span className={chrome.bandCapsuleMark} aria-hidden="true">
          <Logo size={20} />
        </span>
      </button>
      {/* A REAL group, not a differently-styled span: the seam that tells a
          sighted reader the capsule is not a sixth tab has to tell a screen
          reader the same thing. `<fieldset>` is the native element behind
          `role="group"` (the a11y profile prefers the element to the role);
          its UA box is reset in styles.css. */}
      <fieldset
        className={chrome.appBandGroup}
        aria-label={`${appName} sections`}
      >
        {destinations.map((destination) => (
          <button
            key={destination.id}
            className={chrome.launchItem}
            type="button"
            data-active={destination.id === claim.activeId ? "true" : undefined}
            aria-current={
              destination.id === claim.activeId ? "page" : undefined
            }
            onClick={() => claim.onSelect(destination.id)}
          >
            <span className={chrome.launchChip} aria-hidden="true">
              {/* Narrowed, never cast: an icon key the registry does not have
                  renders NOTHING rather than a broken glyph. The label is the
                  name either way — no target here is icon-only. */}
              {destination.icon && isIconName(destination.icon) ? (
                <Icon name={destination.icon} size={18} />
              ) : null}
            </span>
            <span className={chrome.launchLabel}>{destination.label}</span>
            <span className={chrome.launchBar} aria-hidden="true" />
          </button>
        ))}
        {claim.onMore ? (
          <button
            className={chrome.launchItem}
            type="button"
            onClick={() => claim.onMore?.()}
          >
            <span className={chrome.launchMoreChip} aria-hidden="true">
              <Icon name="MoreHoriz" size={18} />
            </span>
            <span className={chrome.launchLabel}>More</span>
            <span className={chrome.launchBar} aria-hidden="true" />
          </button>
        ) : null}
      </fieldset>
    </nav>
  );
}
