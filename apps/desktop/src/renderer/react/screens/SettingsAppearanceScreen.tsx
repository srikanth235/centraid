import { useState, type JSX } from 'react';
import { THEME_PRESETS, themes, tileFinish } from '@centraid/design-tokens';
import type { IconName, ThemeName } from '@centraid/design-tokens';
import { Icon } from '../ui/index.js';
import type { SettingsAppearanceBridgeProps, SettingsTileVariant } from '../bridge.js';
import { DrawerGroup, DrawerRow, Switch } from './settings-controls.js';

// Accent options — mirrors ACCENT_PALETTE (app-shell-context.ts) + the names
// from makeSwatches. Kept inline so the React bundle stays decoupled.
const ACCENTS: ReadonlyArray<{ key: string; name: string; color: string }> = [
  { key: 'teal', name: 'Teal', color: '#3EC8B4' },
  { key: 'blue', name: 'Electric', color: '#4950F6' },
  { key: 'violet', name: 'Violet', color: '#7C5BD9' },
  { key: 'ochre', name: 'Ochre', color: '#B47B3F' },
  { key: 'rose', name: 'Rose', color: '#E55772' },
];

const TILE_VARIANTS: readonly SettingsTileVariant[] = ['solid', 'gradient', 'glassy', 'flat'];

const PREVIEW_SEEDS: ReadonlyArray<{ color: string; icon: IconName; name: string }> = [
  { color: '#4E68DD', icon: 'Todo', name: 'Tasks' },
  { color: '#7C5BD9', icon: 'Journal', name: 'Journal' },
  { color: '#E55772', icon: 'Pencil', name: 'Notes' },
  { color: '#2EA098', icon: 'Habit', name: 'Weekly' },
];

function themePreview(name: ThemeName): { bg: string; elev: string; accent: string } {
  const theme = themes[name];
  const bgL = (theme as { bgL?: string }).bgL;
  const bg = bgL ? `hsl(222 11% ${bgL.replace('%', '')}%)` : theme.bg;
  const elev = bgL ? `hsl(222 11% calc(${bgL.replace('%', '')}% + 4.5%))` : theme.bgElev;
  return { bg, elev, accent: theme.accent };
}

/**
 * Settings → Appearance page, ported to React (issue #325, Phase 3). Theme
 * preset picker (live-preview cards), accent swatches, cool-blue-cast switch,
 * app-tile treatment, and the live tile preview. Mounted into the settings
 * route's appearance page host (the vanilla shell owns the inner-sidebar nav +
 * the still-vanilla profiles/providers pages). Each control calls the
 * vanilla-supplied setter, which re-themes the running app. Same classes.
 */
export default function SettingsAppearanceScreen({
  theme,
  coolBlueCast,
  accent,
  tileVariant,
  onSetTheme,
  onSetCoolCast,
  onSetAccent,
  onSetTile,
  onMatchSystem,
}: SettingsAppearanceBridgeProps): JSX.Element {
  const [curTheme, setCurTheme] = useState(theme);
  const [curCast, setCurCast] = useState(coolBlueCast);
  const [curAccent, setCurAccent] = useState(accent);
  const [curTile, setCurTile] = useState<SettingsTileVariant>(tileVariant);

  const pickTheme = (name: string): void => {
    setCurTheme(name);
    onSetTheme(name);
  };

  return (
    <>
      <DrawerGroup label="Theme">
        <DrawerRow
          label="Color theme"
          hint="Pick a preset for the Centraid shell. Apps stay in their own light/dark palette."
          full
        >
          <div className="cd-theme-picker" role="radiogroup" aria-label="Color theme">
            {THEME_PRESETS.map((preset) => {
              const p = themePreview(preset.name);
              const active = preset.name === curTheme;
              return (
                <button
                  key={preset.name}
                  type="button"
                  className="cd-theme-card"
                  data-name={preset.name}
                  data-active={String(active)}
                  aria-checked={active}
                  aria-label={preset.label}
                  role="radio"
                  onClick={() => pickTheme(preset.name)}
                >
                  <div className="cd-theme-card-preview" style={{ background: p.bg }}>
                    <span className="cd-theme-card-bar" style={{ background: p.elev }} />
                    <span className="cd-theme-card-dot" style={{ background: p.accent }} />
                  </div>
                  <div className="cd-theme-card-foot">
                    <span className="cd-theme-card-label">{preset.label}</span>
                    <span className="cd-theme-card-kind">{preset.kind}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </DrawerRow>
        <DrawerRow label="Match system" hint="Snap the theme to your OS appearance right now.">
          <button
            type="button"
            className="cd-link-btn"
            onClick={() => setCurTheme(onMatchSystem())}
          >
            Match system
          </button>
        </DrawerRow>
        <DrawerRow
          label="Cool blue cast"
          hint="Tint dark surfaces toward blue. Off = neutral graphite. Centraid Dark only."
        >
          <Switch
            on={curCast}
            ariaLabel="Cool blue cast"
            onToggle={(next) => {
              setCurCast(next);
              onSetCoolCast(next);
            }}
          />
        </DrawerRow>
      </DrawerGroup>

      <DrawerGroup label="Accent">
        <DrawerRow
          label="Color"
          hint="Used for the build button, sparkle, focus rings, and version badges."
        >
          <div className="cd-swatches" role="radiogroup" aria-label="Accent">
            {ACCENTS.map((a) => (
              <button
                key={a.key}
                type="button"
                className="cd-swatch"
                role="radio"
                aria-checked={a.key === curAccent}
                aria-label={a.name}
                data-active={String(a.key === curAccent)}
                onClick={() => {
                  setCurAccent(a.key);
                  onSetAccent(a.key);
                }}
              >
                <span className="cd-swatch-chip" style={{ background: a.color }} />
                <span className="cd-swatch-name">{a.name}</span>
              </button>
            ))}
          </div>
        </DrawerRow>
      </DrawerGroup>

      <DrawerGroup label="App tiles">
        <DrawerRow label="Treatment" hint="How icon tiles on the home grid look.">
          <div className="seg" role="tablist" aria-label="Treatment">
            {TILE_VARIANTS.map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={v === curTile}
                data-active={String(v === curTile)}
                onClick={() => {
                  setCurTile(v);
                  onSetTile(v);
                }}
              >
                {v}
              </button>
            ))}
          </div>
        </DrawerRow>
        <DrawerRow label="Preview" hint="How the home grid looks with your current choices." full>
          <div className="ap-preview-host">
            <div className="ap-preview">
              {PREVIEW_SEEDS.map((s) => {
                const finish = tileFinish(s.color, curTile);
                return (
                  <div key={s.name} className="ap-preview-tile">
                    <div
                      className="ap-preview-tile-icon"
                      style={{
                        background: finish.background,
                        boxShadow: finish.boxShadow,
                        color: finish.glyphColor,
                      }}
                    >
                      <Icon name={s.icon} size={18} strokeWidth={1.85} />
                    </div>
                    <span className="ap-preview-tile-name">{s.name}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </DrawerRow>
      </DrawerGroup>
    </>
  );
}
