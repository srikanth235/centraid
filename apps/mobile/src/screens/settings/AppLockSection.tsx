import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";

import { useAppLock } from "../../kit/security/AppLock";
import { radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import SettingsSection from "./SettingsSection";

export default function AppLockSection(): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const appLock = useAppLock();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const handleLockNow = appLock.lockNow;

  const change = async (next: boolean): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      if (next) await appLock.enable();
      else await appLock.disable();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "The app lock could not be changed."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection label="Device security">
      <View style={styles.row}>
        <View style={styles.copy}>
          <Text style={styles.title}>Biometric app lock</Text>
          <Text style={styles.help}>
            Protect the local vault replica and gateway key whenever Centraid
            leaves the foreground.
          </Text>
        </View>
        <Switch
          accessibilityLabel="Biometric app lock"
          accessibilityState={{ disabled: busy || !appLock.supported }}
          disabled={busy || !appLock.supported}
          onValueChange={(next) => void change(next)}
          trackColor={{ false: colors.lineStrong, true: colors.accent }}
          value={appLock.enabled}
        />
      </View>
      {appLock.supported ? null : (
        <Text style={styles.note}>
          Set up Face ID, Touch ID, or fingerprint authentication in system
          settings to enable this option.
        </Text>
      )}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {appLock.enabled ? (
        <Pressable
          accessibilityRole="button"
          onPress={handleLockNow}
          style={styles.lockButton}
        >
          <Text style={styles.lockButtonText}>Lock now</Text>
        </Pressable>
      ) : null}
    </SettingsSection>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    copy: { flex: 1, paddingRight: spacing[3] },
    error: { ...t("small"), color: colors.danger, marginTop: spacing[3] },
    help: { ...t("small"), color: colors.ink3, marginTop: 3 },
    lockButton: {
      alignItems: "center",
      borderColor: colors.lineStrong,
      borderRadius: radii.md,
      borderWidth: 1,
      marginTop: spacing[3],
      paddingVertical: spacing[3],
    },
    lockButtonText: { ...t("bodyStrong"), color: colors.ink2 },
    note: { ...t("small"), color: colors.ink3, marginTop: spacing[3] },
    row: {
      alignItems: "center",
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      flexDirection: "row",
      padding: spacing[4],
    },
    title: { ...t("bodyStrong"), color: colors.ink },
  });
