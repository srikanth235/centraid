// THE THREE WALLS (README-Locker §1, §6; FLOWS.md "First run", "Unlock").
//
// One field, one verb, and a sentence about what a session is. Both gates are
// the same shape because they are the same question asked at two moments, and
// both state the boundary IN WORDS — §7 forbids a lock icon standing in for a
// sentence, so there is no key glyph on either.
//
// NOTHING IS BROWSABLE BEHIND ANY OF THEM. `LockerScreen.tsx` withdraws the
// band and every list while one of these stands (`shelves.suppressesNavigation`),
// and this is what stands in their place.
//
// THE THIRD WALL IS DENIAL, and it is not a failure: a revoked grant is a
// receipt, a scope, and the fact that nothing was deleted (§4, "Denied vs.
// refused"). It offers no retry, because there is nothing here to retry.
import React, { useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import {
  CREATE_PASSPHRASE,
  DENIED_BODY,
  DENIED_SCOPE,
  DENIED_TITLE,
  LOCK_BODY,
  LOCK_FACTS,
  LOCK_PLACEHOLDER,
  PASSPHRASE_MINIMUM,
  PASSPHRASE_TOO_SHORT,
  SETUP_BODY,
  SETUP_PLACEHOLDER,
  UNLOCK,
} from "@centraid/blueprints/apps/locker/view-copy";

import Button from "../../kit/components/Button";
import { Text, TextInput } from "../../kit/components/NativeText";
import { TEST_IDS } from "../../kit/test-ids";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { DEVICE_NOTE, DEVICE_REVOKE, DEVICE_UNLOCK } from "./locker-seat-copy";

const SETUP_TITLE = "Choose a passphrase";
const LOCK_TITLE = "Locked";

export interface LockerWallProps {
  mode: "setup" | "lock" | "denied";
  /** A request is in flight. The commit says so by being unavailable, never
   *  by a spinner — this app has no spinner anywhere. */
  busy: boolean;
  error: string;
  /** A device credential is enrolled, so there is a second way in. */
  deviceEnrolled: boolean;
  onSubmit: (secret: string) => void;
  onDeviceUnlock: () => void;
  onRevokeDevice: () => void;
}

export default function LockerWall({
  mode,
  busy,
  error,
  deviceEnrolled,
  onSubmit,
  onDeviceUnlock,
  onRevokeDevice,
}: LockerWallProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [secret, setSecret] = useState("");

  if (mode === "denied") {
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <Text accessibilityRole="header" style={styles.title}>
          {DENIED_TITLE}
        </Text>
        <Text style={styles.body}>{DENIED_BODY}</Text>
        <View style={styles.facts}>
          <View style={styles.fact}>
            <Text style={styles.factKey}>Scope</Text>
            <Text style={styles.factValue}>{DENIED_SCOPE}</Text>
          </View>
        </View>
      </ScrollView>
    );
  }

  const setup = mode === "setup";
  const tooShort =
    setup && secret.length > 0 && secret.length < PASSPHRASE_MINIMUM;
  const ready =
    !busy && (setup ? secret.length >= PASSPHRASE_MINIMUM : secret.length > 0);

  const submit = (): void => {
    if (!ready) return;
    onSubmit(secret);
    setSecret("");
  };

  return (
    <ScrollView
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
      testID={TEST_IDS.locker.gate}
    >
      <Text accessibilityRole="header" style={styles.title}>
        {setup ? SETUP_TITLE : LOCK_TITLE}
      </Text>
      <Text style={styles.body}>{setup ? SETUP_BODY : LOCK_BODY}</Text>

      <TextInput
        accessibilityLabel={setup ? SETUP_PLACEHOLDER : LOCK_PLACEHOLDER}
        // An RN TextInput's accessibilityLabel never reaches the iOS a11y tree
        // (README "Known caveats"), so this field had NO selector at all — the
        // reason the passphrase-floor journey is still an unowned gap.
        testID={TEST_IDS.locker.gateField}
        autoCapitalize="none"
        autoComplete={setup ? "new-password" : "current-password"}
        autoCorrect={false}
        onChangeText={setSecret}
        onSubmitEditing={submit}
        placeholder={setup ? SETUP_PLACEHOLDER : LOCK_PLACEHOLDER}
        placeholderTextColor={colors.textFaint}
        secureTextEntry
        style={styles.input}
        value={secret}
      />

      {tooShort ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {PASSPHRASE_TOO_SHORT}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}

      <View style={styles.acts}>
        <Button
          disabled={!ready}
          label={setup ? CREATE_PASSPHRASE : UNLOCK}
          onPress={submit}
          testID={TEST_IDS.locker.gateSubmit}
          variant="primary"
        />
        {!setup && deviceEnrolled ? (
          <Button
            disabled={busy}
            label={DEVICE_UNLOCK}
            onPress={onDeviceUnlock}
          />
        ) : null}
      </View>

      {setup ? null : (
        <>
          <View style={styles.facts}>
            {LOCK_FACTS.map(([key, value]) => (
              <View key={key} style={styles.fact}>
                <Text style={styles.factKey}>{key}</Text>
                <Text style={styles.factValue}>{value}</Text>
              </View>
            ))}
          </View>
          {deviceEnrolled ? (
            <View style={styles.deviceRow}>
              <Text style={styles.body}>{DEVICE_NOTE}</Text>
              <Button
                disabled={busy}
                label={DEVICE_REVOKE}
                onPress={onRevokeDevice}
                variant="destructive"
              />
            </View>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    acts: { flexDirection: "row", gap: spacing[2], marginTop: spacing[4] },
    body: { ...t("small"), color: colors.textSoft },
    deviceRow: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      gap: spacing[3],
      paddingTop: spacing[4],
    },
    error: { ...t("small"), color: colors.net },
    fact: { flexDirection: "row", gap: spacing[3] },
    factKey: { ...t("eyebrow"), color: colors.textFaint, width: 96 },
    factValue: { ...t("small"), color: colors.text, flex: 1 },
    facts: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      gap: spacing[2],
      marginTop: spacing[5],
      paddingTop: spacing[4],
    },
    input: {
      ...t("body"),
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      color: colors.text,
      marginTop: spacing[5],
      minHeight: 44,
      paddingHorizontal: spacing[3],
    },
    page: { gap: spacing[3], padding: spacing[4] },
    title: { ...t("title"), color: colors.text },
  });
