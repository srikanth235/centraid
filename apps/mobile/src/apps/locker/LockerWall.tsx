// THE TWO WALLS (README-Locker §1, §6; FLOWS.md "Unlock").
//
// A VERB, NOT A FIELD (#996, ruling W6-D2). This screen used to carry a
// passphrase box and three modes, because the app owned the boundary: it
// collected a secret and a gateway checked it. Both halves moved. `K` lives in
// this device's keychain behind `requireAuthentication`, so unlocking is Face
// ID, Touch ID or the device passcode — a thing the OS asks and this app never
// sees. A passphrase box here would be an app collecting a credential it must
// never hold, with nothing on this side to check it against.
//
// FIRST RUN IS GONE with it: "no passphrase yet" was a question for the app
// that stored one. A device receives `K` when it enrols, and there is no gate
// here that could stand in for that.
//
// The boundary is still stated IN WORDS — §7 forbids a lock icon standing in
// for a sentence, so there is no key glyph. NOTHING IS BROWSABLE BEHIND
// EITHER: `LockerScreen.tsx` withdraws the band and every list while one of
// these stands (`shelves.suppressesNavigation`).
//
// THE SECOND WALL IS DENIAL, and it is not a failure: a revoked grant is a
// receipt, a scope, and the fact that nothing was deleted (§4, "Denied vs.
// refused"). It offers no retry, because there is nothing here to retry.

import React, { useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import {
  DENIED_BODY,
  DENIED_SCOPE,
  DENIED_TITLE,
  LOCK_BODY,
  LOCK_FACTS,
} from "@centraid/blueprints/apps/locker/view-copy";

import Button from "../../kit/components/Button";
import { Text } from "../../kit/components/NativeText";
import { TEST_IDS } from "../../kit/test-ids";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { DEVICE_FORGET, DEVICE_NOTE, DEVICE_UNLOCK } from "./locker-seat-copy";

/** The gate's own heading. `Lock.tsx` draws the same word on the web. */
const LOCK_TITLE = "Locked";

export interface LockerWallProps {
  mode: "lock" | "denied";
  /** A request is in flight. The commit says so by being unavailable, never
   *  by a spinner — this app has no spinner anywhere. */
  busy: boolean;
  /** The door's refusal, in its own words. */
  error: string;
  /** Unlock: asks the OS to prove the member is present. */
  onUnlock: () => void;
  /** Forget `K` on this device — the revoke gesture's local half (R13). */
  onForgetKey: () => void;
}

export default function LockerWall({
  mode,
  busy,
  error,
  onUnlock,
  onForgetKey,
}: LockerWallProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

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

  return (
    <ScrollView
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
      testID={TEST_IDS.locker.gate}
    >
      <Text accessibilityRole="header" style={styles.title}>
        {LOCK_TITLE}
      </Text>
      <Text style={styles.body}>{LOCK_BODY}</Text>

      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}

      <View style={styles.acts}>
        <Button
          disabled={busy}
          label={DEVICE_UNLOCK}
          onPress={onUnlock}
          testID={TEST_IDS.locker.gateSubmit}
          variant="primary"
        />
      </View>

      <View style={styles.facts}>
        {LOCK_FACTS.map(([key, value]) => (
          <View key={key} style={styles.fact}>
            <Text style={styles.factKey}>{key}</Text>
            <Text style={styles.factValue}>{value}</Text>
          </View>
        ))}
      </View>
      <View style={styles.deviceRow}>
        <Text style={styles.body}>{DEVICE_NOTE}</Text>
        <Button
          disabled={busy}
          label={DEVICE_FORGET}
          onPress={onForgetKey}
          variant="destructive"
        />
      </View>
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
    page: { gap: spacing[3], padding: spacing[4] },
    title: { ...t("title"), color: colors.text },
  });
