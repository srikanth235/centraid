import { Fragment } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";

import {
  ICON_CHIP_TINT,
  iconChipRadius,
  identityColor,
  identityInitials,
  isIconName,
} from "@centraid/design";
import type { IconName } from "@centraid/design";

import Icon from "../ui/Icon.js";
import Logo from "../ui/Logo.js";
import { CAPABILITIES_ON } from "./capabilities.js";
import type { ShellCapabilities } from "./capabilities.js";
import { bandDestinations, pinnedDestinations } from "./launcherModel.js";
import type {
  LauncherDestination,
  PinSet,
  ShellPage,
} from "./launcherModel.js";

import chrome from "./chrome.module.css";

// The navigation stem (issue #707, invariant 1).
//
// A reserved band, `--w-stem` on the leading edge on desktop and the bottom
// band on compact. It is never themed by an app, never scrolls away, and never
// changes width — the invariant is the RESERVATION, not any particular number,
// and the number lives in one place (`metrics.stem`) so the frame, the docs and
// the native surfaces cannot disagree about it.
//
// It carries, top to bottom: which vault you are in and on which gateway (the
// switcher head), the Search control, the launcher of pinned destinations, and
// a foot with All apps and Settings. The three things the pre-#707 sidebar
// carried that did NOT come back are the conversation ledger (it lives on the
// assistant surface), the gateway alarm and the update pill (they live on the
// one status line). Vault identity is here rather than in the app bar because
// it is true on every route, and a fact that is true everywhere belongs in the
// band that is present everywhere.
//
// "Always the same distance from the reading edge" is the promise, NOT "from
// the left" — every rule in chrome.module.css that positions the stem is
// written in logical properties so it mirrors under RTL for free.
//
// The launcher scrolls vertically on desktop, so the desktop stem has no cap.
// The compact band does: five slots plus More, because a sixth tab puts every
// target under 44px, and 44px is a hard constraint rather than a preference.

/** The launcher chip, per the brief's size table: 26px in the desktop stem,
 *  30px in the compact band. One rung apart because the two forms read at
 *  different distances — the band's chip carries the tab on its own, while the
 *  stem's stands beside a full-size label. Both radii are emitted here because
 *  the 26%-of-size corner cannot be written as one CSS length. */
const MARK_SIZE_STEM = 26;
const MARK_SIZE_BAND = 30;
/** The head's vault chip. Its corner is a share of its own size (26%), so the
 *  silhouette holds at every rung — see `iconChipRadius`. It is the LARGEST
 *  chip in the band on purpose: the vault is the one identity that outranks
 *  every destination under it, and at 24px it read as one more launcher row. */
const AVATAR_SIZE = 30;
/** A vault that has chosen no mark of its own. */
const DEFAULT_VAULT_ICON: IconName = "Sparkle";
/** The glyph inside the chip. The chip is the identity; the mark is the verb. */
const GLYPH_SIZE = 18;

/**
 * The vault the frame is scoped to, and the gateway holding it.
 *
 * Optional because the stem must render before the scopes resolve — a head
 * that pops in is better than a frame that waits for a read to paint.
 */
export interface StemIdentity {
  vault: string;
  gateway: string;
  /** The vault's own mark and hue. The head wears the VAULT's identity, not the
   *  product's — two vaults that looked identical in the one place that names
   *  which one you are in was the whole point of having per-vault identity. */
  icon?: string;
  color?: string;
  /** Opens the vault/gateway switcher, anchored to the head. */
  onActivate: (anchor: DOMRect) => void;
  open?: boolean;
  /** So ⌘⇧G can anchor the same menu without a synthetic click. A ref
   *  CALLBACK, not a `RefObject`: a ref object reachable through a plain props
   *  object makes react-compiler treat every read of that object as a
   *  during-render ref access, and `StemHead` bails out of compilation
   *  entirely. A callback carries no `current` to read. */
  anchorRef?: (el: HTMLButtonElement | null) => void;
}

export interface StemAccount {
  name: string;
  /** Avatar fill. Omitted derives one from the name. */
  color?: string;
  /** Opens the account menu, anchored to the row. */
  onMenu: (anchor: DOMRect) => void;
}

export interface StemProps {
  pins: PinSet;
  /** Head. Absent renders the bare product mark, which is what tests and the
   *  pre-scope first paint see. */
  identity?: StemIdentity;
  /** The route-highlight key for the current screen. */
  activePage?: ShellPage;
  onSelect: (destination: LauncherDestination) => void;
  /** Opens cross-app search. ALWAYS rendered — the PWA cannot rely on ⌘K
   *  because the browser claims it, so the control is the guarantee and the
   *  hint is the extra. */
  onSearch: () => void;
  /**
   * Starts a conversation. The one ACTION in a band of places, which is why it
   * leads and why it is the only filled thing here: the assistant is not a
   * destination (#707 settled it as a pinned app, so it has no launcher row),
   * but starting a turn is something you do from anywhere, and burying it
   * inside the app you have to be in first is what made it feel missing.
   * Absent renders nothing — a compact band has no room for it.
   */
  onNewConversation?: () => void;
  /** Whether this host actually delivers ⌘K. False hides the hint, never the
   *  control. */
  hasCommandKey?: boolean;
  /** Opens the All-apps sheet — the band's "More", and the only way to reach
   *  an unpinned destination without the palette. */
  onAllApps: () => void;
  /**
   * The foot's account row: who you are, not what you can configure.
   *
   * Settings, Pair device, What's new and Log out live in its menu, as they did
   * before #707 — each is something you do a handful of times, while your own
   * name is the thing worth standing there. The menu is built by the caller so
   * the stem stays layout, not policy.
   */
  account?: StemAccount;
  /**
   * A route's own list, below the launcher — today only the assistant's
   * conversation ledger.
   *
   * #707 moved that ledger onto the assistant surface, which gave the Assistant
   * route a SECOND sidebar standing beside this one: two columns of navigation
   * for one window. One band holds the places you can go, and while you are in
   * the assistant, its conversations are places you can go. Passed as a node so
   * the stem stays chrome — it never imports a route's stylesheet.
   */
  ledger?: ReactNode;
  /** Bottom band instead of a leading column. */
  compact?: boolean;
  /** Which ramp is painting, so the icon chip's tint comes from the design
   *  package (13% light / 20% dark) rather than a literal in the stylesheet. */
  scheme?: "light" | "dark";
  /** What this gateway offers (C1). A destination behind a gate this gateway
   *  does not advertise is not dimmed or disabled — it is not a place, so it
   *  does not stand in the band. Defaulted so a stem rendered outside the
   *  shell root (tests, harnesses) shows the full launcher. */
  capabilities?: ShellCapabilities;
}

/**
 * One launcher item.
 *
 * The chip's container styling is CONSTANT — same ground, same radius, selected
 * or not, following the iOS convention: a chip that changes shape when selected
 * reads as a different destination rather than the same one, here. Selection is
 * the label weight plus the 2px bar, and nothing else.
 *
 * There is no hue on this chip and no tinted ground under it. Every destination
 * in the launcher is a place in the FRAME, and invariant 3 reserves the eight
 * identity hues for APPS — see the header of `launcherModel.ts` for why a
 * shell that spends them retires the rule rather than extending it. The glyph
 * is plain ink, one rung down while the destination is not current.
 */
function LauncherItem({
  destination,
  active,
  compact,
  onSelect,
}: {
  destination: LauncherDestination;
  active: boolean;
  compact: boolean;
  onSelect: () => void;
}): JSX.Element {
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
            "--chip-radius": `${iconChipRadius(compact ? MARK_SIZE_BAND : MARK_SIZE_STEM)}px`,
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
      <span className={chrome.launchBar} aria-hidden="true" />
    </button>
  );
}

/** The head: the product mark, and — once the scopes resolve — which vault you
 *  are in, on which gateway, as the control that changes it. */
function StemHead({
  identity,
  tint,
}: {
  identity?: StemIdentity;
  tint: number;
}): JSX.Element {
  const mark = (
    <span className={chrome.stemMark} aria-label="Centraid">
      <Logo size={22} />
    </span>
  );
  if (!identity) return mark;
  // Destructured, never read as `identity.x` in the JSX below: handing a member
  // expression to `ref=` marks its whole owning object as a ref for
  // react-compiler, and every other read of that object then trips the
  // "no refs during render" rule and bails the component out of compilation.
  const { anchorRef, color, gateway, icon, onActivate, open, vault } = identity;
  const hue = color ?? identityColor(vault);
  return (
    <button
      ref={anchorRef}
      className={chrome.stemIdentity}
      type="button"
      aria-haspopup="menu"
      aria-expanded={open ? "true" : "false"}
      aria-label={`${vault} on ${gateway}. Switch vault.`}
      data-open={open ? "true" : undefined}
      onClick={(event) =>
        onActivate(event.currentTarget.getBoundingClientRect())
      }
    >
      <span
        className={chrome.stemAvatarChip}
        aria-hidden="true"
        style={
          {
            "--chip-hue": hue,
            "--chip-radius": `${iconChipRadius(AVATAR_SIZE)}px`,
            "--chip-tint": `${tint * 100}%`,
          } as CSSProperties
        }
      >
        {/* Narrowed, never cast: a stored icon key the registry does not have
            renders NOTHING, and an empty chip reads as a broken vault rather
            than as a vault that chose no mark. */}
        <Icon
          name={icon && isIconName(icon) ? icon : DEFAULT_VAULT_ICON}
          size={14}
          strokeWidth={1.9}
        />
      </span>
      <span className={chrome.stemIdentityText}>
        <span className={chrome.stemVault}>{vault}</span>
        {/* The gateway is machine identity, so it takes the numeric register —
            the same face the status line and every meta line use. */}
        <span className={chrome.stemGateway}>{gateway}</span>
      </span>
      <Icon name="ChevronDown" size={15} strokeWidth={2.2} />
    </button>
  );
}

export default function Stem({
  pins,
  identity,
  activePage,
  onSelect,
  onSearch,
  onNewConversation,
  hasCommandKey = true,
  onAllApps,
  account,
  ledger,
  compact = false,
  scheme = "dark",
  capabilities = CAPABILITIES_ON,
}: StemProps): JSX.Element {
  const tint = ICON_CHIP_TINT[scheme];
  const band = bandDestinations(pins, capabilities);
  const items = compact ? band.items : pinnedDestinations(pins, capabilities);

  return (
    <nav
      className={chrome.stem}
      data-compact={compact ? "true" : undefined}
      // The frame's OWN band, on compact (Photos v4, CHANGELOG F). A route that
      // claims the band replaces this element entirely — `ShellFrame` renders
      // one or the other — so `[data-band]` never matches twice in a document.
      data-band={compact ? "host" : undefined}
      aria-label="Apps"
    >
      {compact ? null : (
        <>
          <StemHead identity={identity} tint={tint} />
          {onNewConversation ? (
            <button
              className={chrome.stemNew}
              type="button"
              onClick={onNewConversation}
            >
              <Icon name="Plus" size={GLYPH_SIZE} strokeWidth={2.2} />
              <span className={chrome.stemNewLabel}>New chat</span>
            </button>
          ) : null}
          {/* The control is unconditional; only the hint is conditional. */}
          <button
            className={chrome.stemSearch}
            type="button"
            onClick={onSearch}
          >
            {/* THE MAGNIFIER IS THE CONTROL'S ONLY UNCONDITIONAL AFFORDANCE.
                `⌘K` below it is a hint that the web deliberately withholds —
                an installed PWA cannot claim the chord, so `hasCommandKey` is
                false there — which left this control with a bordered box and
                a line of grey text and nothing at all saying "search". The
                mark restores what the hint cannot promise. */}
            <Icon name="Search" size={16} strokeWidth={1.8} />
            {/* "Search everything", not "Search": this control reaches OBJECTS
                across every app, and the shorter label reads as a filter over
                whatever is on screen. The copy is the design's, verbatim. */}
            <span className={chrome.stemSearchGlyph}>Search everything</span>
            {/* Pushes the chord to the trailing edge, so the mark and the label
                stay a pair on the reading edge whether or not the hint is
                rendered — `justify-content: space-between` alone put the label
                in the middle of the control the moment the chord disappeared. */}
            <span className={chrome.stemSearchSpacer} />
            {hasCommandKey ? (
              <span className={chrome.stemSearchKbd}>⌘K</span>
            ) : null}
          </button>
        </>
      )}
      <div className={chrome.launchList}>
        {items.map((destination, index) => (
          <Fragment key={destination.id}>
            <LauncherItem
              destination={destination}
              active={destination.page === activePage}
              compact={compact}
              onSelect={() => onSelect(destination)}
            />
            {/* HOME IS ITS OWN GROUP. Everything below it is a place inside the
                vault; Home is the view OF the vault, and the design separates
                the two with a hairline rather than by ordering alone. Keyed off
                the destination id, not the index, because a member who unpins
                Home should not hand the seam to whatever row inherited slot 0.
                Suppressed when Home is last (nothing to separate it from) and
                on compact, where the band is a row of tabs with no stack for a
                horizontal rule to divide. */}
            {!compact &&
            destination.id === "home" &&
            index < items.length - 1 ? (
              <span className={chrome.launchSeam} aria-hidden="true" />
            ) : null}
          </Fragment>
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
      {/* Never on compact: the band is a row of tabs, with nowhere to put a
          list. The assistant keeps its own disclosure there instead. */}
      {ledger && !compact ? (
        <div className={chrome.stemLedger}>{ledger}</div>
      ) : null}
      {compact ? null : (
        <div className={chrome.stemFoot}>
          {/* The way into every unpinned destination, standing rather than
              hidden behind a gesture. On compact this is the band's "More". */}
          <button
            className={chrome.stemAllApps}
            type="button"
            onClick={onAllApps}
          >
            <Icon name="MoreHoriz" size={GLYPH_SIZE} />
            <span className={chrome.stemFootLabel}>All apps</span>
          </button>
          {account ? (
            <button
              className={chrome.stemAccount}
              type="button"
              aria-haspopup="menu"
              aria-label={`${account.name}. Account menu.`}
              onClick={(event) =>
                account.onMenu(event.currentTarget.getBoundingClientRect())
              }
            >
              <span
                className={chrome.stemAvatar}
                style={{
                  background: account.color ?? identityColor(account.name),
                }}
                aria-hidden="true"
              >
                {identityInitials(account.name)}
              </span>
              <span className={chrome.stemFootLabel}>{account.name}</span>
              <span className={chrome.stemAccountMeta}>⌘,</span>
            </button>
          ) : null}
        </div>
      )}
    </nav>
  );
}
