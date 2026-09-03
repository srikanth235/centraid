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

const MARK_SIZE_STEM = 26;
const MARK_SIZE_BAND = 30;
const AVATAR_SIZE = 30;
const DEFAULT_VAULT_ICON: IconName = "Sparkle";
const GLYPH_SIZE = 18;
const STEM_GLYPH_SIZE = 17;
const STEM_GLYPH_STROKE = 1.6;

export interface StemIdentity {
  vault: string;
  gateway: string;
  icon?: string;
  color?: string;
  onActivate: (anchor: DOMRect) => void;
  open?: boolean;
  anchorRef?: (el: HTMLButtonElement | null) => void;
}

export interface StemAccount {
  name: string;
  color?: string;
  onMenu: (anchor: DOMRect) => void;
}

export interface StemProps {
  pins: PinSet;
  identity?: StemIdentity;
  activePage?: ShellPage;
  onSelect: (destination: LauncherDestination) => void;
  onSearch: () => void;
  onNewConversation?: () => void;
  hasCommandKey?: boolean;
  onAllApps: () => void;
  account?: StemAccount;
  ledger?: ReactNode;
  compact?: boolean;
  scheme?: "light" | "dark";
  capabilities?: ShellCapabilities;
}

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
        <Icon
          name={destination.icon}
          size={compact ? GLYPH_SIZE : STEM_GLYPH_SIZE}
          strokeWidth={compact ? undefined : STEM_GLYPH_STROKE}
        />
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
        {/* Narrowed, never cast: an unknown key would render an empty chip,
            which reads as a broken vault. */}
        <Icon
          name={icon && isIconName(icon) ? icon : DEFAULT_VAULT_ICON}
          size={14}
          strokeWidth={1.9}
        />
      </span>
      <span className={chrome.stemIdentityText}>
        <span className={chrome.stemVault}>{vault}</span>
        {/* Numeric register: machine identity. */}
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
          {/* The control is unconditional; only the hint is not. */}
          <button
            className={chrome.stemSearch}
            type="button"
            onClick={onSearch}
          >
            {/* The only unconditional affordance: `⌘K` is a hint. */}
            <Icon name="Search" size={16} strokeWidth={1.8} />
            {/* "Search everything": the shorter label reads as a filter. */}
            <span className={chrome.stemSearchGlyph}>Search everything</span>
            {/* Keeps mark and label paired without the chord. */}
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
            {/* HOME IS ITS OWN GROUP. Keyed off the destination id, never the
                index, so unpinning Home does not hand the seam to whatever row
                inherited slot 0. */}
            {!compact &&
            destination.id === "home" &&
            index < items.length - 1 ? (
              <span className={chrome.launchSeam} aria-hidden="true" />
            ) : null}
          </Fragment>
        ))}
        {compact ? (
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
      {/* Never on compact: a row of tabs has nowhere to put a list. */}
      {ledger && !compact ? (
        <div className={chrome.stemLedger}>{ledger}</div>
      ) : null}
      {compact ? null : (
        <div className={chrome.stemFoot}>
          {/* The way into every unpinned destination. */}
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
