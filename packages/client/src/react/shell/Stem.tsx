import type { CSSProperties, JSX } from "react";

import { ICON_CHIP_TINT, iconChipRadius } from "@centraid/design";

import Icon from "../ui/Icon.js";
import Logo from "../ui/Logo.js";
import { bandDestinations, pinnedDestinations } from "./launcherModel.js";
import type {
  LauncherDestination,
  PinSet,
  ShellPage,
} from "./launcherModel.js";

import chrome from "./chrome.module.css";

// The navigation stem (issue #707, invariant 1).
//
// A reserved band, 92px on the leading edge on desktop and the bottom band on
// compact. It holds the product mark, the Search control, and the launcher —
// and NOTHING else. It is never themed by an app, never scrolls away, and
// never changes width. Everything the old three-zone sidebar carried moved
// out: the conversation ledger to the assistant surface, vault identity to
// Home and the app bar, the gateway alarm and the update pill to the status
// line, and the account to Settings.
//
// "Always the same distance from the reading edge" is the promise, NOT "from
// the left" — every rule in chrome.module.css that positions the stem is
// written in logical properties so it mirrors under RTL for free.
//
// The launcher scrolls vertically on desktop, so the desktop stem has no cap.
// The compact band does: five slots plus More, because a sixth tab puts every
// target under 44px, and 44px is a hard constraint rather than a preference.

/** Icon size in both the stem and the band, per the brief's size table. */
const MARK_SIZE = 30;
/** The glyph inside the chip. The chip is the identity; the mark is the verb. */
const GLYPH_SIZE = 18;

export interface StemProps {
  pins: PinSet;
  /** The route-highlight key for the current screen. */
  activePage?: ShellPage;
  onSelect: (destination: LauncherDestination) => void;
  /** Opens cross-app search. ALWAYS rendered — the PWA cannot rely on ⌘K
   *  because the browser claims it, so the control is the guarantee and the
   *  hint is the extra. */
  onSearch: () => void;
  /** Whether this host actually delivers ⌘K. False hides the hint, never the
   *  control. */
  hasCommandKey?: boolean;
  /** Opens the All-apps sheet — the band's "More", and the only way to reach
   *  an unpinned destination without the palette. */
  onAllApps: () => void;
  /** Bottom band instead of a leading column. */
  compact?: boolean;
  /** Which ramp is painting, so the icon chip's tint comes from the design
   *  package (13% light / 20% dark) rather than a literal in the stylesheet. */
  scheme?: "light" | "dark";
}

/**
 * One launcher item.
 *
 * The chip's container styling is CONSTANT — same tint, same radius, selected
 * or not. Selection is carried by the label weight plus a 2px bar in the app's
 * own hue, following the iOS convention: a chip that changes shape when
 * selected reads as a different app rather than the same app, here.
 */
function LauncherItem({
  destination,
  active,
  compact,
  tint,
  onSelect,
}: {
  destination: LauncherDestination;
  active: boolean;
  compact: boolean;
  tint: number;
  onSelect: () => void;
}): JSX.Element {
  const hue = destination.colorKey
    ? `var(--c-${destination.colorKey})`
    : "var(--text-soft)";
  return (
    <button
      className={chrome.launchItem}
      type="button"
      data-active={active ? "true" : undefined}
      aria-current={active ? "page" : undefined}
      onClick={onSelect}
    >
      <span
        className={chrome.launchChip}
        style={
          {
            "--chip-hue": hue,
            "--chip-radius": `${iconChipRadius(MARK_SIZE)}px`,
            "--chip-tint": `${tint * 100}%`,
          } as CSSProperties
        }
        aria-hidden="true"
      >
        <Icon name={destination.icon} size={GLYPH_SIZE} />
      </span>
      <span className={chrome.launchLabel}>
        {compact
          ? (destination.shortLabel ?? destination.label)
          : destination.label}
      </span>
      <span
        className={chrome.launchBar}
        style={{ "--chip-hue": hue } as CSSProperties}
        aria-hidden="true"
      />
    </button>
  );
}

export default function Stem({
  pins,
  activePage,
  onSelect,
  onSearch,
  hasCommandKey = true,
  onAllApps,
  compact = false,
  scheme = "dark",
}: StemProps): JSX.Element {
  const tint = ICON_CHIP_TINT[scheme];
  const band = bandDestinations(pins);
  const items = compact ? band.items : pinnedDestinations(pins);

  return (
    <nav
      className={chrome.stem}
      data-compact={compact ? "true" : undefined}
      aria-label="Apps"
    >
      {compact ? null : (
        <>
          <span className={chrome.stemMark} aria-label="Centraid">
            <Logo size={22} />
          </span>
          {/* The control is unconditional; only the hint is conditional. */}
          <button
            className={chrome.stemSearch}
            type="button"
            onClick={onSearch}
          >
            <span className={chrome.stemSearchGlyph}>Search</span>
            {hasCommandKey ? (
              <span className={chrome.stemSearchKbd}>⌘K</span>
            ) : null}
          </button>
        </>
      )}
      <div className={chrome.launchList}>
        {items.map((destination) => (
          <LauncherItem
            key={destination.id}
            destination={destination}
            active={destination.page === activePage}
            compact={compact}
            tint={tint}
            onSelect={() => onSelect(destination)}
          />
        ))}
        {compact && band.overflow > 0 ? (
          <button
            className={chrome.launchItem}
            type="button"
            onClick={onAllApps}
          >
            <span className={chrome.launchMoreChip} aria-hidden="true">
              <Icon name="MoreHoriz" size={GLYPH_SIZE} />
            </span>
            <span className={chrome.launchLabel}>More</span>
            <span className={chrome.launchBar} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {compact ? null : (
        <button
          className={chrome.stemAllApps}
          type="button"
          onClick={onAllApps}
        >
          All apps
        </button>
      )}
    </nav>
  );
}
