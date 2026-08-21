import React, { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { palette } from "@centraid/design";
import type { IconName } from "@centraid/design";

import Button from "../../kit/components/Button";
import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import { radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import {
  GatewayError,
  listVaults,
  resolveGatewayBase,
  updateVault,
} from "../../lib/gateway";
import type { VaultRow } from "../../lib/gateway";
import { getActiveVaultId, subscribeVaultLinks } from "../../lib/vault-links";
import ColorSwatchRow from "./ColorSwatchRow";
import SettingsSection from "./SettingsSection";

// Settings → Vault — a port of desktop's Settings → Vault (issue #382), scoped
// to the ACTIVE (gateway, vault) tuple the Vaults switcher has selected (lib/
// vaults). Falls back to the first visible vault when nothing is active yet.
// Edits the vault's presentation only: name, colour, icon, description. Creating
// or deleting a vault is an admin act on the gateway host (#289) with no client
// HTTP surface; the switcher's add/forget act on device-local tuples, not the
// vault itself.

// The vault stores a raw hex colour; these are the shared design-tokens palette
// values — the same set desktop's PROFILE_COLORS offers (they ARE those hexes).
const VAULT_COLORS: readonly string[] = [
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
const VAULT_ICONS: readonly IconName[] = [
  "Home",
  "Bolt",
  "Sparkle",
  "Compass",
  "Book",
  "Music",
  "Gym",
  "Plant",
  "Calendar",
  "Camera",
  "Mood",
  "Gift",
];

const DEFAULT_COLOR = palette.indigo;
const DEFAULT_ICON: IconName = "Sparkle";

type State =
  | { kind: "loading" }
  | { kind: "no-gateway" }
  | { kind: "no-vault" }
  | { kind: "ready"; vault: VaultRow }
  | { kind: "error"; message: string };

type VaultFormSetters = {
  setState: (next: State) => void;
  setName: (next: string) => void;
  setColor: (next: string) => void;
  setIcon: (next: IconName) => void;
  setBlurb: (next: string) => void;
};

/** Push a vault's presentation into the edit form's fields. */
function seedForm(setters: VaultFormSetters, vault: VaultRow): void {
  setters.setName(vault.name);
  setters.setColor(vault.color ?? DEFAULT_COLOR);
  setters.setIcon(asIcon(vault.icon) ?? DEFAULT_ICON);
  setters.setBlurb(vault.blurb ?? "");
}

// The loader lives outside the component: it closes over nothing but the
// (stable) state setters, so it needs no `useCallback` identity dance and the
// effects below read as plain async kick-offs.
async function loadVault(setters: VaultFormSetters): Promise<void> {
  try {
    const base = await resolveGatewayBase();
    if (!base) {
      setters.setState({ kind: "no-gateway" });
      return;
    }
    const vaults = await listVaults();
    // Prefer the vault the Vaults switcher has active; fall back to the first
    // visible one (fresh install with nothing selected yet).
    const activeVaultId = getActiveVaultId();
    const active =
      vaults?.find((v) => v.vaultId === activeVaultId) ?? vaults?.[0];
    if (!active) {
      setters.setState({ kind: "no-vault" });
      return;
    }
    seedForm(setters, active);
    setters.setState({ kind: "ready", vault: active });
  } catch (error) {
    const message =
      error instanceof GatewayError || error instanceof Error
        ? error.message
        : "Could not load your vault.";
    setters.setState({ kind: "error", message });
  }
}

export default function VaultSection(): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [icon, setIcon] = useState<IconName>(DEFAULT_ICON);
  const [blurb, setBlurb] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  // Every member is a `useState` setter, so the bundle is stable for the
  // component's lifetime — memoized once so the effects below can depend on it.
  const setters = useMemo<VaultFormSetters>(
    () => ({ setState, setName, setColor, setIcon, setBlurb }),
    []
  );

  useEffect(() => {
    void loadVault(setters);
  }, [setters]);
  // Re-load when the active Vault changes, so this edits whatever the switcher
  // just selected.
  useEffect(
    () => subscribeVaultLinks(() => void loadVault(setters)),
    [setters]
  );

  if (state.kind !== "ready") {
    return (
      <SettingsSection label="Vault">
        <Text style={styles.hint}>
          {state.kind === "loading"
            ? "Loading your vault…"
            : state.kind === "error"
              ? state.message
              : state.kind === "no-vault"
                ? "No vault on this gateway yet."
                : "Pair with your desktop to edit your vault."}
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
    blurb.trim() !== (vault.blurb ?? "");
  const canSave = trimmedName.length > 0 && dirty && !saving;

  const save = (): void => {
    setSaving(true);
    setSaveError(undefined);
    updateVault(vault.vaultId, {
      blurb: blurb.trim(),
      color,
      icon,
      name: trimmedName,
    })
      .then((updated) => {
        seedForm(setters, updated);
        setState({ kind: "ready", vault: updated });
      })
      .catch((error: unknown) => {
        setSaveError(
          error instanceof Error ? error.message : "Could not save your vault."
        );
      })
      .finally(() => setSaving(false));
  };

  return (
    <SettingsSection label="Vault">
      <View style={styles.card}>
        <Text style={styles.fieldLabel}>Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Vault name"
          placeholderTextColor={colors.textFaint}
          style={styles.input}
          returnKeyType="done"
        />

        <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>Colour</Text>
        <ColorSwatchRow
          value={color}
          options={VAULT_COLORS}
          onChange={setColor}
        />

        <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>Icon</Text>
        <View style={styles.iconGrid}>
          {VAULT_ICONS.map((iconName) => {
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
                <Icon
                  name={iconName}
                  size={18}
                  color={active ? colors.textInv : colors.textSoft}
                />
              </Pressable>
            );
          })}
        </View>

        <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>
          Description
        </Text>
        <TextInput
          value={blurb}
          onChangeText={setBlurb}
          placeholder="A short note — e.g. Focus & planning"
          placeholderTextColor={colors.textFaint}
          style={styles.input}
          returnKeyType="done"
        />

        {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
        <View style={styles.actions}>
          <Button
            label={saving ? "Saving…" : "Save"}
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
  return value !== undefined &&
    (VAULT_ICONS as readonly string[]).includes(value)
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
    error: { ...t("small"), color: colors.danger, marginTop: 8 },
    fieldLabel: { ...t("smallStrong"), color: colors.textSoft },
    fieldLabelSpaced: { marginTop: 8 },
    hint: { ...t("small"), color: colors.textFaint },
    iconGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    iconTile: {
      alignItems: "center",
      backgroundColor: colors.bg,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      height: 40,
      justifyContent: "center",
      width: 40,
    },
    iconTileActive: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
    input: {
      ...t("body"),
      backgroundColor: colors.bg,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      color: colors.text,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    pressed: { opacity: 0.6 },
  });
