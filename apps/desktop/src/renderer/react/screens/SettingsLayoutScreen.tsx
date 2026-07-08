import { useState, type JSX } from 'react';
import type { SettingsLayoutBridgeProps } from '../bridge.js';
import { DrawerGroup, DrawerRow, Segmented, Switch } from './settings-controls.js';

const DENSITIES = ['compact', 'regular', 'comfy'] as const;
const CARDS = ['flat', 'outlined', 'elevated'] as const;

/**
 * Settings → Layout page, ported to React (issue #325, Phase 3). Density, card
 * surface, and sidebar toggle. Mounted into the settings route's layout page
 * host; each control calls the vanilla-supplied setter. Same classes.
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
    </>
  );
}
