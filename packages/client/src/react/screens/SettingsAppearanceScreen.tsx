import { useEffect, useState } from "react";
import type { JSX } from "react";

import type {
  SettingsAppearanceBridgeProps,
  SettingsThemeMode,
} from "../screen-contracts.js";
import {
  loadDefaultCronTimeZone,
  saveDefaultCronTimeZone,
} from "../shell/routes/settingsCronTimezoneData.js";
import NoteBlock from "../ui/NoteBlock.js";
import { DrawerGroup, DrawerRow, Segmented } from "./settings-controls.js";

import sc from "./settings-controls.module.css";

const THEME_MODES: readonly SettingsThemeMode[] = ["light", "dark", "system"];

const THEME_MODE_LABELS: Record<SettingsThemeMode, string> = {
  dark: "Dark",
  light: "Light",
  system: "Match system",
};

export default function SettingsAppearanceScreen({
  themeMode,
  onSetThemeMode,
  automations = true,
}: SettingsAppearanceBridgeProps): JSX.Element {
  const [curMode, setCurMode] = useState(themeMode);
  const [cronTz, setCronTz] = useState("");
  const [lastGood, setLastGood] = useState("");
  const [cronTzError, setCronTzError] = useState<string | null>(null);
  const [cronTzLoaded, setCronTzLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadDefaultCronTimeZone()
      .then((value) => {
        if (!cancelled) {
          setCronTz(value);
          setLastGood(value);
          setCronTzLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setCronTzLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      {/* THIS DEVICE, not the household: the theme is what this browser paints
          and the zone is what a schedule with none of its own fires in. The
          name and colour above are what everyone else sees. */}
      <DrawerGroup label="This device" meta="theme and time">
        <DrawerRow
          label="Theme"
          hint="Centraid Light, Centraid Dark, or your OS setting."
        >
          <Segmented
            ariaLabel="Appearance"
            labels={THEME_MODE_LABELS}
            options={THEME_MODES}
            selected={curMode}
            onSelect={(next) => {
              setCurMode(next);
              onSetThemeMode(next);
            }}
          />
          {/* Match is a standing MODE, not a one-shot snap to whatever the OS
              says right now, and the caption is where that difference is
              stated — the segment alone reads as a third theme. */}
          {curMode === "system" ? (
            <p className={sc.rowHint}>Follows the system as it changes</p>
          ) : null}
        </DrawerRow>
        {/* The time zone belongs to YOU: it is the zone a schedule with none of
          its own fires in, which is a fact about the member's day rather than
          about the automation. It stays gated on the same capability the
          Automations route is — a default for a feature this gateway does not
          run is a setting whose effect the owner can never see. */}
        {automations ? (
          <>
            <DrawerRow
              label="Time zone for automations"
              hint="For crons with no zone of their own; empty keeps the host clock."
            >
              <input
                className={sc.input}
                type="text"
                value={cronTz}
                disabled={!cronTzLoaded}
                placeholder="Host local"
                list="centraid-cron-timezones"
                spellCheck={false}
                aria-label="Default cron timezone"
                data-testid="settings-default-cron-timezone"
                onChange={(event) => {
                  setCronTz(event.target.value);
                  setCronTzError(null);
                }}
                onBlur={() => {
                  void saveDefaultCronTimeZone(cronTz, lastGood).then((err) => {
                    setCronTzError(err);
                    if (err) setCronTz(lastGood);
                    else {
                      setCronTz(cronTz.trim());
                      setLastGood(cronTz.trim());
                    }
                  });
                }}
              />
            </DrawerRow>
            {cronTzError ? (
              <p
                role="alert"
                data-testid="settings-default-cron-timezone-error"
              >
                {cronTzError}
              </p>
            ) : null}
            {/* Each suggestion carries its zone as text, not just as `value`: a
              value-only <option> has no accessible name, so a screen reader
              announces an unlabelled list. Label and value are identical, which
              is what the picker already showed. Inside the gate with its input
              — a datalist no field lists is markup nothing can reach. */}
            <datalist id="centraid-cron-timezones">
              <option value="UTC">UTC</option>
              <option value="America/New_York">America/New_York</option>
              <option value="America/Chicago">America/Chicago</option>
              <option value="America/Denver">America/Denver</option>
              <option value="America/Los_Angeles">America/Los_Angeles</option>
              <option value="America/Sao_Paulo">America/Sao_Paulo</option>
              <option value="Europe/London">Europe/London</option>
              <option value="Europe/Paris">Europe/Paris</option>
              <option value="Europe/Berlin">Europe/Berlin</option>
              <option value="Asia/Kolkata">Asia/Kolkata</option>
              <option value="Asia/Tokyo">Asia/Tokyo</option>
              <option value="Asia/Shanghai">Asia/Shanghai</option>
              <option value="Australia/Sydney">Australia/Sydney</option>
            </datalist>
          </>
        ) : null}
      </DrawerGroup>
      {/* Where the two acts that are NOT settings live. Both were pages on this
          rail once, and both are things you do rather than things you set. */}
      <NoteBlock>
        Pairing a phone is in the account menu. Gateway health is on System.
      </NoteBlock>
    </>
  );
}
