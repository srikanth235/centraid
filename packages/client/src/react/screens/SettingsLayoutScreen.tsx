import { useEffect, useState, type JSX } from 'react';
import type { SettingsLayoutBridgeProps } from '../screen-contracts.js';
import {
  loadDefaultCronTimeZone,
  saveDefaultCronTimeZone,
} from '../shell/routes/settingsCronTimezoneData.js';
import { DrawerGroup, DrawerRow, Segmented, Switch } from './settings-controls.js';
import sc from './settings-controls.module.css';

const DENSITIES = ['compact', 'regular', 'comfy'] as const;
const CARDS = ['flat', 'outlined', 'elevated'] as const;

/**
 * Settings → Layout page, ported to React (issue #325, Phase 3). Density, card
 * surface, sidebar toggle, and the gateway-wide default cron timezone
 * (issue #570). Mounted into the settings route's layout page host.
 */
export default function SettingsLayoutScreen({
  density,
  cardVariant,
  sidebarOpen,
  onSetDensity,
  onSetCards,
  onSetSidebar,
}: SettingsLayoutBridgeProps): JSX.Element {
  const [curDensity, setCurDensity] = useState(density);
  const [curCards, setCurCards] = useState(cardVariant);
  const [curSidebar, setCurSidebar] = useState(sidebarOpen);
  const [cronTz, setCronTz] = useState('');
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
      <DrawerGroup label="Density">
        <DrawerRow
          label="Spacing"
          hint="Affects row height, type sizes, and spacing across all apps."
        >
          <Segmented
            options={DENSITIES}
            selected={curDensity}
            ariaLabel="Density"
            onSelect={(v) => {
              setCurDensity(v);
              onSetDensity(v);
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
      <DrawerGroup label="Sidebar">
        <DrawerRow label="Show sidebar" hint="Toggle the apps + chats panel.">
          <Switch
            on={curSidebar}
            ariaLabel="Show sidebar"
            onToggle={(next) => {
              setCurSidebar(next);
              onSetSidebar(next);
            }}
          />
        </DrawerRow>
      </DrawerGroup>
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
      <datalist id="centraid-cron-timezones">
        <option value="UTC" />
        <option value="America/New_York" />
        <option value="America/Chicago" />
        <option value="America/Denver" />
        <option value="America/Los_Angeles" />
        <option value="America/Sao_Paulo" />
        <option value="Europe/London" />
        <option value="Europe/Paris" />
        <option value="Europe/Berlin" />
        <option value="Asia/Kolkata" />
        <option value="Asia/Tokyo" />
        <option value="Asia/Shanghai" />
        <option value="Australia/Sydney" />
      </datalist>
    </>
  );
}
