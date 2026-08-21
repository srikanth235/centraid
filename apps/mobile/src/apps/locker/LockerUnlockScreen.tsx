// The Locker unlock gate: the primary-passphrase prompt, its first-run
// "protect Locker" variant, and the biometric shortcut.
//
// Its own file because it is the one screen state with real input handling, and
// because keeping it beside the list made the Locker screen the file where every
// unrelated change had to be reviewed against a passphrase field.

import React from "react";
import { Pressable, View } from "react-native";

import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import type { useTheme } from "../../kit/theme";
import type { makeLockerStyles } from "./LockerHome.styles";

export function LockerUnlockScreen({
  colors,
  styles,
  configured,
  message,
  passphrase,
  onChangePassphrase,
  onUnlock,
  onBiometricUnlock,
  biometricsAvailable,
  working,
}: {
  colors: ReturnType<typeof useTheme>["colors"];
  styles: ReturnType<typeof makeLockerStyles>;
  configured: boolean;
  message?: string;
  passphrase: string;
  onChangePassphrase: (next: string) => void;
  onUnlock: () => void;
  onBiometricUnlock: () => void;
  biometricsAvailable: boolean;
  working: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.locked}>
      <Icon name="Key" size={32} color={colors.textSoft} />
      <Text style={styles.stateTitle}>
        {configured ? "Locker is locked" : "Protect Locker"}
      </Text>
      <Text style={styles.stateCopy}>
        {configured
          ? "Each secret asks for user presence again before reveal."
          : "Create a primary passphrase of at least 12 characters. It never leaves this online authentication request."}
      </Text>
      <TextInput
        accessibilityLabel={
          configured ? "Locker passphrase" : "Create Locker passphrase"
        }
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={onChangePassphrase}
        onSubmitEditing={onUnlock}
        placeholder={configured ? "Primary passphrase" : "New passphrase"}
        placeholderTextColor={colors.textFaint}
        secureTextEntry
        style={styles.input}
        value={passphrase}
      />
      {message ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {message}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={working || passphrase.length < 12}
        onPress={onUnlock}
        style={[styles.primary, working && styles.disabledPrimary]}
      >
        <Text
          style={[styles.primaryText, working && styles.disabledPrimaryText]}
        >
          {configured ? "Unlock" : "Create passphrase"}
        </Text>
      </Pressable>
      {configured && biometricsAvailable ? (
        <Pressable
          accessibilityRole="button"
          disabled={working}
          onPress={onBiometricUnlock}
          style={styles.secondary}
        >
          <Text style={styles.secondaryText}>Unlock with biometrics</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
