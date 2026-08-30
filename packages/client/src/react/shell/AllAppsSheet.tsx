import { useEffect, useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";

import { iconChipRadius } from "@centraid/design";

import Icon from "../ui/Icon.js";
import ShellModal from "../ui/ShellModal.js";
import { CAPABILITIES_ON } from "./capabilities.js";
import type { ShellCapabilities } from "./capabilities.js";
import { isPinned, searchDestinations } from "./launcherModel.js";
import type {
  LauncherDestination,
  PinSet,
  ShellPage,
} from "./launcherModel.js";

import chrome from "./chrome.module.css";

// Tier 2 — All apps (#707).
//
// A searchable sheet listing EVERY destination the shell has, each as a 44px
// row with its icon and a pin switch. Pinning adds the destination to the
// stem (and to the compact band); unpinning removes it. Nothing here is
// hidden or unavailable — the sheet is what lets the stem stay short.
//
// An unpinned row reads as a LIGHTER name, never a dimmed one: container
// `opacity` composites every descendant and silently invalidates token-level
// contrast, so the recessive state is a colour token on the leaf.
//
// Desktop gets a centred dialog, compact gets a bottom sheet. One scrim, one
// Esc handler, and the panel is the shared kit modal with a labelled title.

const ROW_ICON = 28;
const GLYPH_SIZE = 16;

export interface AllAppsSheetProps {
  pins: PinSet;
  onTogglePin: (id: ShellPage) => void;
  onSelect: (destination: LauncherDestination) => void;
  onClose: () => void;
  compact?: boolean;
  /** What this gateway offers (C1). The sheet is the complete index of the
   *  places the shell can go, so a gated-off feature has to leave it too —
   *  a stem that hid Automations while the sheet still listed it would be two
   *  answers to one question. */
  capabilities?: ShellCapabilities;
}

export default function AllAppsSheet({
  pins,
  onTogglePin,
  onSelect,
  onClose,
  compact = false,
  capabilities = CAPABILITIES_ON,
}: AllAppsSheetProps): JSX.Element {
  const [query, setQuery] = useState("");
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const rows = searchDestinations(query, capabilities);
  const pinnedCount = rows.length
    ? Object.values(pins).filter(Boolean).length
    : 0;

  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className={chrome.sheetOverlay}
      data-compact={compact ? "true" : undefined}
    >
      {/* The scrim is the dismiss target, and it is a button so it is
          reachable without a pointer. Its label is its only content, so
          `aria-label` is a replacement rather than an addition. */}
      <button
        className={chrome.sheetScrim}
        type="button"
        aria-label="Close all apps"
        onClick={onClose}
      />
      {/* The kit's one modal, `inline`: the panel stands in the shell's own
          flow under the scrim above it, which is what makes it modal in
          practice — the element carries the dialog semantics natively. */}
      <ShellModal layer="inline" className={chrome.sheetPanel} label="All apps">
        <div className={chrome.sheetHead}>
          <span className={chrome.sheetTitle}>All apps</span>
          <button
            className={chrome.sheetClose}
            type="button"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="X" size={14} />
          </button>
        </div>
        <div className={chrome.sheetField}>
          <input
            ref={fieldRef}
            type="search"
            value={query}
            placeholder="Filter apps"
            aria-label="Filter apps"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className={chrome.sheetList}>
          {rows.length === 0 ? (
            <p className={chrome.sheetEmpty}>No app matches that.</p>
          ) : null}
          {rows.map((destination) => {
            const pinned = isPinned(pins, destination.id);
            return (
              <div key={destination.id} className={chrome.sheetRow}>
                <button
                  className={chrome.sheetRowOpen}
                  type="button"
                  data-pinned={pinned ? "true" : undefined}
                  onClick={() => onSelect(destination)}
                >
                  <span
                    className={chrome.sheetRowChip}
                    /* No hue and no tint: this sheet lists FRAME destinations,
                       and the identity wheel belongs to the apps. See the
                       header of `launcherModel.ts`. */
                    style={
                      {
                        "--chip-radius": `${iconChipRadius(ROW_ICON)}px`,
                      } as CSSProperties
                    }
                    aria-hidden="true"
                  >
                    <Icon name={destination.icon} size={GLYPH_SIZE} />
                  </span>
                  <span className={chrome.sheetRowName}>
                    {destination.label}
                  </span>
                </button>
                {/* Home is in the launcher by law, so it has no switch to
                    offer rather than a switch that refuses. */}
                {destination.id === "home" ? (
                  <span className={chrome.sheetRowFixed}>Always</span>
                ) : (
                  <button
                    className={chrome.sheetSwitch}
                    type="button"
                    role="switch"
                    aria-checked={pinned}
                    aria-label={`Pin ${destination.label} to the launcher`}
                    onClick={() => onTogglePin(destination.id)}
                  >
                    <span
                      className={chrome.sheetSwitchKnob}
                      aria-hidden="true"
                    />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <p className={chrome.sheetFoot}>
          {pinnedCount} pinned · pinned apps stand in the stem
        </p>
      </ShellModal>
    </div>
  );
}
