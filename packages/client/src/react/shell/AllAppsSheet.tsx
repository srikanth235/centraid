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

const ROW_ICON = 28;
const GLYPH_SIZE = 16;

export interface AllAppsSheetProps {
  pins: PinSet;
  onTogglePin: (id: ShellPage) => void;
  onSelect: (destination: LauncherDestination) => void;
  onClose: () => void;
  compact?: boolean;
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
