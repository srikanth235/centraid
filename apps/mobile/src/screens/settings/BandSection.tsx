import React, { useMemo } from "react";
import { StyleSheet, Switch, View } from "react-native";

import { BAND_CLAIMING_APPS, useBandOwner } from "../../kit/band/band-owner";
import type { BandClaimingApp } from "../../kit/band/band-owner";
import { Text } from "../../kit/components/NativeText";
import { radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import SettingsSection from "./SettingsSection";

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
