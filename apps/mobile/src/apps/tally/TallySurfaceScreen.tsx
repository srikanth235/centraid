import React, { useEffect } from "react";
import { ScrollView, StyleSheet } from "react-native";

import {
  EXPORT_FOOT,
  EXPORT_HEAD,
  EXPORT_LEDE,
  EXPORT_NOTE,
  EXPORT_NO_GROUP,
  FIELD_KEYS,
  exportWindow,
} from "@centraid/blueprints/apps/tally/compose-copy";
import { EXPORT } from "@centraid/blueprints/apps/tally/shelves";

import { Text } from "../../kit/components/NativeText";
import { spacing, t, useTheme } from "../../kit/theme";
import type { TallyScreenProps } from "../../navigation";
import {
  CUSTODIAN_SEAT_NOTE,
  EXPORT_GROUP_ROW,
  EXPORT_WHAT_ROW,
  EXPORT_WHERE_ROW,
} from "./tally-seat-copy";
import { forgetTally, loadTallyExport } from "./tally-store";
import { FieldRow } from "./TallyParts";
import TallyScreen from "./TallyScreen";
import { useTallyVault } from "./useTallyVault";

export default function TallySurfaceScreen({
  navigation,
  route,
}: TallyScreenProps<"TallySurface">): React.JSX.Element {
  const { colors } = useTheme();
  const vault = useTallyVault();
  const groupId = route.params.groupId ?? "";

  useEffect(() => {
    if (groupId) void loadTallyExport(groupId);
    return () => forgetTally("export");
  }, [groupId]);

  const data = vault.exported;

  return (
    <TallyScreen
      current="more"
      shelf={EXPORT}
      hideBand
      onBack={() => navigation.goBack()}
    >
      <ScrollView contentContainerStyle={styles.page}>
        <Text style={[styles.title, { color: colors.text }]}>
          {EXPORT_HEAD}
        </Text>
        <Text style={[styles.lede, { color: colors.textSoft }]}>
          {EXPORT_LEDE}
        </Text>

        <FieldRow
          label={EXPORT_GROUP_ROW}
          value={data?.group?.name ?? EXPORT_NO_GROUP}
        />
        <FieldRow
          label={EXPORT_WHAT_ROW}
          value={
            data
              ? exportWindow(
                  data.expenses.length,
                  data.settlements.length,
                  data.truncated
                )
              : ""
          }
          note={EXPORT_NOTE}
        />
        <FieldRow label={FIELD_KEYS.format} value={FIELD_KEYS.format} />
        <FieldRow label={EXPORT_WHERE_ROW} note={CUSTODIAN_SEAT_NOTE} />

        {/* §6's foot, in the `--net` register: the file leaves the vault. */}
        <Text style={[styles.foot, { color: colors.net }]}>{EXPORT_FOOT}</Text>
      </ScrollView>
    </TallyScreen>
  );
}

const styles = StyleSheet.create({
  foot: {
    ...t("small"),
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
  },
  lede: {
    ...t("small"),
    paddingBottom: spacing[2],
    paddingHorizontal: spacing[4],
  },
  page: { paddingBottom: spacing[6], paddingTop: spacing[4] },
  title: { ...t("title"), paddingHorizontal: spacing[4] },
});
