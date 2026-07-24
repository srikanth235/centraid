import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { palette } from '@centraid/design-tokens';
import type { IconName } from '@centraid/design-tokens';
import Button from '../../kit/components/Button';
import Icon from '../../kit/components/Icon';
import { radii, t, useTheme, type ThemeColors } from '../../kit/theme';
import {
  GatewayError,
  listVaults,
  resolveGatewayBase,
  updateVault,
  type VaultRow,
} from '../../lib/gateway';
import { getActiveVaultId, subscribeSpaces } from '../../lib/spaces';
import ColorSwatchRow from './ColorSwatchRow';
import SettingsSection from './SettingsSection';

// Settings → Space — a port of desktop's Settings → Space (issue #382), scoped
// to the ACTIVE (gateway, vault) tuple the Spaces switcher has selected (lib/
// spaces). Falls back to the first visible vault when nothing is active yet.
// Edits the vault's presentation only: name, colour, icon, description. Creating
// or deleting a vault is an admin act on the gateway host (#289) with no client
// HTTP surface; the switcher's add/forget act on device-local tuples, not the
// vault itself.

// The vault stores a raw hex colour; these are the shared design-tokens palette
// values — the same set desktop's PROFILE_COLORS offers (they ARE those hexes).
const SPACE_COLORS: readonly string[] = [
  palette.indigo,
  palette.rose,
  palette.violet,
  palette.teal,
  palette.forest,
  palette.amber,
  palette.ochre,
  palette.slate,
];

// The vault stores an icon as a design-tokens IconName key. Mirrors desktop's
// PROFILE_ICONS; every one resolves in the mobile Icon registry.
const SPACE_ICONS: readonly IconName[] = [
  'Home',
  'Bolt',
  'Sparkle',
  'Compass',
  'Book',
  'Music',
  'Gym',
  'Plant',
  'Calendar',
  'Camera',
  'Mood',
  'Gift',
];

const DEFAULT_COLOR = palette.indigo;
const DEFAULT_ICON: IconName = 'Sparkle';

type State =
  | { kind: 'loading' }
  | { kind: 'no-gateway' }
  | { kind: 'no-space' }
  | { kind: 'ready'; vault: VaultRow }
  | { kind: 'error'; message: string };

export default function SpaceSection(): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [icon, setIcon] = useState<IconName>(DEFAULT_ICON);
  const [blurb, setBlurb] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  const seed = (vault: VaultRow): void => {
    setName(vault.name);
    setColor(vault.color ?? DEFAULT_COLOR);
    setIcon(asIcon(vault.icon) ?? DEFAULT_ICON);
    setBlurb(vault.blurb ?? '');
  };

  const load = useCallback(async (): Promise<void> => {
    try {
      const base = await resolveGatewayBase();
      if (!base) {
        setState({ kind: 'no-gateway' });
        return;
      }
      const vaults = await listVaults();
      // Prefer the vault the Spaces switcher has active; fall back to the first
      // visible one (fresh install with nothing selected yet).
      const activeVaultId = getActiveVaultId();
      const active = vaults?.find((v) => v.vaultId === activeVaultId) ?? vaults?.[0];
      if (!active) {
        setState({ kind: 'no-space' });
        return;
      }
      seed(active);
      setState({ kind: 'ready', vault: active });
    } catch (err) {
      const message =
        err instanceof GatewayError || err instanceof Error
          ? err.message
          : 'Could not load your space.';
      setState({ kind: 'error', message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  // Re-load when the active Space changes, so this edits whatever the switcher
  // just selected.
  useEffect(() => subscribeSpaces(() => void load()), [load]);

  if (state.kind !== 'ready') {
    return (
      <SettingsSection label="Space">
        <Text style={styles.hint}>
          {state.kind === 'loading'
            ? 'Loading your space…'
            : state.kind === 'error'
              ? state.message
              : state.kind === 'no-space'
                ? 'No space on this gateway yet.'
                : 'Pair with your desktop to edit your space.'}
        </Text>
      </SettingsSection>
    );
  }

  const vault = state.vault;
  const trimmedName = name.trim();
  const dirty =
    trimmedName !== vault.name ||
    color !== (vault.color ?? DEFAULT_COLOR) ||
    icon !== (asIcon(vault.icon) ?? DEFAULT_ICON) ||
    blurb.trim() !== (vault.blurb ?? '');
  const canSave = trimmedName.length > 0 && dirty && !saving;

  const save = (): void => {
    setSaving(true);
    setSaveError(undefined);
    updateVault(vault.vaultId, { blurb: blurb.trim(), color, icon, name: trimmedName })
      .then((updated) => {
        seed(updated);
        setState({ kind: 'ready', vault: updated });
      })
      .catch((err: unknown) => {
        setSaveError(err instanceof Error ? err.message : 'Could not save your space.');
      })
      .finally(() => setSaving(false));
  };

  return (
    <SettingsSection label="Space">
      <View style={styles.card}>
        <Text style={styles.fieldLabel}>Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Space name"
          placeholderTextColor={colors.ink3}
          style={styles.input}
          returnKeyType="done"
        />

        <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>Colour</Text>
        <ColorSwatchRow value={color} options={SPACE_COLORS} onChange={setColor} />

        <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>Icon</Text>
        <View style={styles.iconGrid}>
          {SPACE_ICONS.map((iconName) => {
            const active = iconName === icon;
            return (
              <Pressable
                key={iconName}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={iconName}
                onPress={() => setIcon(iconName)}
                style={({ pressed }) => [
                  styles.iconTile,
                  active && styles.iconTileActive,
                  pressed && !active && styles.pressed,
                ]}
              >
                <Icon name={iconName} size={18} color={active ? colors.inkInv : colors.ink2} />
              </Pressable>
            );
          })}
        </View>

        <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>Description</Text>
        <TextInput
          value={blurb}
          onChangeText={setBlurb}
          placeholder="A short note — e.g. Focus & planning"
          placeholderTextColor={colors.ink3}
          style={styles.input}
          returnKeyType="done"
        />

        {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
        <View style={styles.actions}>
          <Button
            label={saving ? 'Saving…' : 'Save'}
            icon="Check"
            onPress={save}
            disabled={!canSave}
          />
        </View>
      </View>
    </SettingsSection>
  );
}

function asIcon(value: string | undefined): IconName | undefined {
  return value !== undefined && (SPACE_ICONS as readonly string[]).includes(value)
    ? (value as IconName)
    : undefined;
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    actions: { marginTop: 16 },
    card: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      gap: 8,
      padding: 16,
    },
    error: { ...t('small'), color: colors.danger, marginTop: 8 },
    fieldLabel: { ...t('small'), color: colors.ink2, fontWeight: '500' },
    fieldLabelSpaced: { marginTop: 8 },
    hint: { ...t('small'), color: colors.ink3 },
    iconGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    iconTile: {
      alignItems: 'center',
      backgroundColor: colors.bg,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      height: 40,
      justifyContent: 'center',
      width: 40,
    },
    iconTileActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    input: {
      ...t('body'),
      backgroundColor: colors.bg,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      color: colors.ink,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    pressed: { opacity: 0.6 },
  });
