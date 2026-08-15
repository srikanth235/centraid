import React, { useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import HomeKey from "../kit/components/HomeKey";
import PanelBlock from "../kit/components/PanelBlock";
import PlaceHeader from "../kit/components/PlaceHeader";
import TopSafeArea from "../kit/components/TopSafeArea";
import { pageMargin, spacing, useTheme } from "../kit/theme";
import type { SignalNotificationScreenProps } from "../navigation";
import { signalNotificationCopy } from "./signal-notification";

export default function SignalNotification({
  navigation,
  route,
}: SignalNotificationScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const copy = useMemo(
    () => signalNotificationCopy(route.params.cause, route.params.detail),
    [route.params]
  );
  return (
    <TopSafeArea style={[styles.safe, { backgroundColor: colors.bg }]}>
      <View style={styles.header}>
        <HomeKey onPress={() => navigation.goBack()} variant="leave" />
        <View style={styles.headerTitle}>
          <PlaceHeader title="Notifications" />
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <PanelBlock
          eyebrow={copy.eyebrow}
          title={copy.title}
          body={copy.body}
          tone="net"
          facts={[
            { key: "Cause", value: copy.cause },
            { key: "If ignored", value: copy.consequence, net: true },
          ]}
          action={{
            label: copy.actionLabel,
            onPress: () =>
              navigation.replace("Settings", {
                screen: copy.destination,
                params: copy.destinationParams,
              }),
          }}
        />
      </ScrollView>
    </TopSafeArea>
  );
}

const styles = StyleSheet.create({
  body: { padding: pageMargin },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
    paddingHorizontal: pageMargin,
  },
  headerTitle: { flex: 1 },
  safe: { flex: 1 },
});
