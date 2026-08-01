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
import { DrawerGroup, DrawerRow, Segmented } from "./settings-controls.js";

import sc from "./settings-controls.module.css";

const THEME_MODES: readonly SettingsThemeMode[] = ["light", "dark", "system"];

const THEME_MODE_LABELS: Record<SettingsThemeMode, string> = {
  dark: "Dark",
  light: "Light",
  system: "Match system",
};

const CARDS = ["flat", "outlined", "elevated"] as const;

/**
 * Settings → Appearance — the one visual-treatment page (issue #325 Phase 3;
 * consolidated in #608).
 *
 * Theme is a three-position segment, not a preview grid: the registry offers
 * exactly Centraid Light and Centraid Dark, and at that size a grid of
 * live-preview cards is the wrong control (#608 group O). `Match system` is one
 * of the three positions rather than a button that fires a one-shot snap — it
 * is a standing mode the shell keeps tracking.
 *
 * Cards were moved from the former Layout page when its density control was
 * removed. Spacing is now a product decision, not a preference that leaves
 * different layouts to support and test.
 *
 * Four controls were cut rather than moved: accent swatches, app-tile
 * treatment, the dark ramp's surface temperature, and the sidebar switch. The
 * first two keep their prefs (a stored accent still paints, tiles keep their
 * treatment) and simply have no control. Surface temperature was removed
 * outright for parity — the light theme has no temperature. The sidebar switch
 * was a duplicate of the toggle already in the chrome.
 */
export default function SettingsAppearanceScreen({
  themeMode,
  cardVariant,
  onSetThemeMode,
  onSetCards,
}: SettingsAppearanceBridgeProps): JSX.Element {
  const [curMode, setCurMode] = useState(themeMode);
  const [curCards, setCurCards] = useState(cardVariant);
  const [cronTz, setCronTz] = useState("");
  const [cronTzError, setCronTzError] = useState<string | null>(null);
  const [cronTzLoaded, setCronTzLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadDefaultCronTimeZone()
      .then((value) => {
        if (!cancelled) {
          setCronTz(value);
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
      <DrawerGroup label="Theme">
        <DrawerRow
          label="Appearance"
          hint="Centraid Light, Centraid Dark, or whatever your OS is using. Apps stay in their own light/dark palette."
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
        </DrawerRow>
      </DrawerGroup>
      <DrawerGroup label="Cards">
        <DrawerRow
          label="Surface"
          hint="Affects every card-shaped surface — app tiles, message rows, settings groups."
        >
          <Segmented
            options={CARDS}
            selected={curCards}
            ariaLabel="Cards"
            onSelect={(v) => {
              setCurCards(v);
              onSetCards(v);
            }}
          />
        </DrawerRow>
      </DrawerGroup>
      {/* Not appearance, and it knows it. This rode along when Layout was
          folded in (#608) because it had nowhere else to live — it is a
          gateway-wide automation default, and the Automations surface is the
          right home for it. Move it there rather than growing this group. */}
      <DrawerGroup label="Automations">
        <DrawerRow
          label="Default cron timezone"
          hint="IANA zone used when a schedule omits its own timezone. Empty keeps the host clock (pre-#570 behavior)."
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
              void saveDefaultCronTimeZone(cronTz).then((err) => {
                setCronTzError(err);
                if (!err) setCronTz(cronTz.trim());
              });
            }}
          />
        </DrawerRow>
        {cronTzError ? (
          <p role="alert" data-testid="settings-default-cron-timezone-error">
            {cronTzError}
          </p>
        ) : null}
      </DrawerGroup>
      {/* Each suggestion carries its zone as text, not just as `value`: a
          value-only <option> has no accessible name, so a screen reader
          announces an unlabelled list. Label and value are identical, which
          is what the picker already showed. */}
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
  );
}
