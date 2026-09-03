import type { CSSProperties, JSX } from "react";

import type { InlineBandClaim } from "@centraid/blueprints/apps/inline-types";
import { isIconName, metrics } from "@centraid/design";

import Icon from "../ui/Icon.js";
import Logo from "../ui/Logo.js";

import chrome from "./chrome.module.css";

export const BAND_CAPSULE_SIZE = metrics.bandCapsule;

export const BAND_MAX_DESTINATIONS = 5;

export interface AppBandProps {
  claim: InlineBandClaim;
  appName: string;
  onHome: () => void;
}

export default function AppBand({
  claim,
  appName,
  onHome,
}: AppBandProps): JSX.Element {
  const destinations = claim.destinations.slice(0, BAND_MAX_DESTINATIONS);

  return (
    <nav className={chrome.appBand} data-band="app" aria-label={appName}>
      {/* Outside the group, first in reading order. */}
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
      {/* Real grouping element, not a styled span — the seam must tell screen
          readers what it tells sighted readers (`fieldset` behind role=group). */}
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
              {/* Narrowed, never cast: unknown icon names render NOTHING. */}
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
