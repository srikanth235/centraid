import React, { useMemo } from "react";
import { StyleSheet, Switch, View } from "react-native";

import { BAND_CLAIMING_APPS, useBandOwner } from "../../kit/band/band-owner";
import type { BandClaimingApp } from "../../kit/band/band-owner";
import { Text } from "../../kit/components/NativeText";
import { radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import SettingsSection from "./SettingsSection";

// HANDING THE BAND BACK, ON THE PHONE (issue #712 E3).
//
// `useBandOwner` shipped on both clients with a `setBandOwner` nothing called:
// a first-party route could CLAIM the phone's bottom band and the member had
// no way to take it back. This is the writer.
//
// WHY FRAME SETTINGS HERE, WHEN WEB PUTS IT IN THE APP BAR. The two surfaces
// are not the same shape, and the honest answer differs with them:
//
//   * On web the frame keeps an app bar above every inline app, with the
//     frame's own affordances already in it, so a per-app toggle sits exactly
//     where the member is looking and costs nothing.
//   * On the phone the claimed band IS the chrome. Its only frame-owned slot
//     is the 52pt capsule, and the tab group beside it is already at the
//     five-destination cap that exists precisely because a sixth target goes
//     under 44pt (`BAND_MAX_DESTINATIONS`). There is no slot to put this in
//     that does not either take a target below the floor or hide the control
//     behind a gesture nobody discovers.
//
// So the phone takes the alternative the brief names: one frame-Settings list
// of the apps that can claim a band. It stays PER APP — one row per app, one
// stored answer per app — because that is what `useBandOwner` is: a member who
// wants the frame's band back in Photos has said nothing about the next app
// that claims. The list is a list of rows, not a global switch.

function BandRow({ app }: { app: BandClaimingApp }): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { bandOwner, setBandOwner } = useBandOwner(app.id);
  return (
    <View style={styles.row}>
      <View style={styles.copy}>
        <Text style={styles.title}>{app.name}</Text>
        <Text style={styles.help}>
          {bandOwner === "app"
            ? `${app.name} shows its own tabs at the bottom of the screen. Home stays one tap away.`
            : `${app.name} shows Centraid's band. Its own sections move into the app.`}
        </Text>
      </View>
      <Switch
        accessibilityLabel={`${app.name}'s own band`}
        onValueChange={(next) => setBandOwner(next ? "app" : "host")}
        trackColor={{ false: colors.lineStrong, true: colors.accent }}
        value={bandOwner === "app"}
      />
    </View>
  );
}

export default function BandSection(): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <SettingsSection label="Bottom band">
      {BAND_CLAIMING_APPS.map((app) => (
        <BandRow key={app.id} app={app} />
      ))}
      <Text style={styles.note}>
        Turn one off and Centraid&apos;s band comes back for that app only.
      </Text>
    </SettingsSection>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    copy: { flex: 1, paddingRight: spacing[3] },
    help: { ...t("small"), color: colors.textFaint, marginTop: 3 },
    note: { ...t("small"), color: colors.textFaint, marginTop: spacing[3] },
    row: {
      alignItems: "center",
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      flexDirection: "row",
      padding: spacing[4],
    },
    title: { ...t("bodyStrong"), color: colors.text },
  });
