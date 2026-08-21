import React from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import HomeKey from "../kit/components/HomeKey";
import PanelBlock from "../kit/components/PanelBlock";
import PlaceHeader from "../kit/components/PlaceHeader";
import TopSafeArea from "../kit/components/TopSafeArea";
import { pageMargin, spacing, useTheme } from "../kit/theme";
import type { SystemOnPhoneScreenProps } from "../navigation";
import { SYSTEM_ON_PHONE } from "./system-on-phone";

export default function SystemOnPhone({
  navigation,
}: SystemOnPhoneScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <TopSafeArea style={[styles.safe, { backgroundColor: colors.bg }]}>
      <View style={styles.header}>
        <HomeKey onPress={() => navigation.goBack()} variant="leave" />
        <View style={styles.headerTitle}>
          <PlaceHeader title={SYSTEM_ON_PHONE.title} />
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <PanelBlock
          eyebrow="On this phone"
          title="System lives with your vault"
          body={SYSTEM_ON_PHONE.body}
          action={{
            label: SYSTEM_ON_PHONE.actionLabel,
            onPress: () => navigation.replace("Insights"),
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
