import React, { useEffect, useMemo, useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import type { ListRenderItemInfo } from "react-native";

import { purgeCountdown } from "@centraid/blueprints/apps/locker/format";
import {
  PURGE_CONFIRM_LABEL,
  PURGE_CONFIRM_TITLE,
  TRASH_EMPTY,
  TRASH_HEAD,
  TRASH_META,
  TRASH_RESTORE,
  TRASH_PURGE,
} from "@centraid/blueprints/apps/locker/route-copy";
import type { LockerRow as LockerRowData } from "@centraid/blueprints/apps/locker/types";
import {
  PURGE_PARKED_BODY,
  TRASH_CONFIRM_BODY,
} from "@centraid/blueprints/apps/locker/view-copy";

import Button from "../../kit/components/Button";
import EmptyBlock from "../../kit/components/EmptyBlock";
import { Text } from "../../kit/components/NativeText";
import SectionBlock from "../../kit/components/SectionBlock";
import SkeletonRows from "../../kit/components/SkeletonRows";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { LockerScreenProps } from "../../navigation";
import { loadLockerTrash } from "./locker-store";
import { purgeLockerItem, restoreLockerItem } from "./locker-writes";
import LockerScreen from "./LockerScreen";
import { useLockerVault } from "./useLockerVault";

export default function LockerTrashScreen({
  navigation,
}: LockerScreenProps<"LockerTrash">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const replica = useReplica();
  const vault = useLockerVault();
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    void loadLockerTrash();
  }, []);

  const rows = vault.bag.trashRows;
  const after = (): void => {
    setConfirming(null);
    void loadLockerTrash();
  };

  const renderItem = ({
    item,
  }: ListRenderItemInfo<LockerRowData>): React.JSX.Element => (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text numberOfLines={1} style={styles.title}>
          {item.title}
        </Text>
        <Text style={styles.meta}>{purgeCountdown(item.purge_at)}</Text>
      </View>
      <Button
        label={TRASH_RESTORE}
        onPress={() => {
          void restoreLockerItem(replica.session, item.item_id).then(after);
        }}
      />
      <Button
        label={TRASH_PURGE}
        onPress={() => setConfirming(item.item_id)}
        variant="destructive"
      />
    </View>
  );

  const foot = confirming ? (
    <View style={styles.confirm}>
      <Text accessibilityRole="header" style={styles.confirmTitle}>
        {PURGE_CONFIRM_TITLE}
      </Text>
      {/* Off-owner it PARKS, and the confirm says so before the act, not
          after it appears to have happened. */}
      <Text style={styles.meta}>{PURGE_PARKED_BODY}</Text>
      <View style={styles.confirmActs}>
        <Button label="Cancel" onPress={() => setConfirming(null)} />
        <Button
          label={PURGE_CONFIRM_LABEL}
          onPress={() => {
            void purgeLockerItem(replica.session, confirming).then(after);
          }}
          variant="destructive"
        />
      </View>
    </View>
  ) : null;

  return (
    <LockerScreen
      current="more"
      hideBand
      onBack={() => navigation.popTo("LockerHome", { destination: "items" })}
      route="trash"
    >
      <FlatList
        contentContainerStyle={styles.scroll}
        data={rows}
        keyExtractor={(row: LockerRowData) => row.item_id}
        ListEmptyComponent={
          vault.reading ? (
            <SkeletonRows accessibilityLabel="Reading the trash" />
          ) : (
            <EmptyBlock body={TRASH_CONFIRM_BODY} routine title={TRASH_EMPTY} />
          )
        }
        ListFooterComponent={foot}
        ListHeaderComponent={
          <SectionBlock label={TRASH_HEAD} meta={TRASH_META} />
        }
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        renderItem={renderItem}
        windowSize={7}
      />
    </LockerScreen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    confirm: {
      borderColor: colors.net,
      borderWidth: borders.hairline,
      gap: spacing[2],
      margin: spacing[4],
      padding: spacing[3],
    },
    confirmActs: { flexDirection: "row", gap: spacing[2] },
    confirmTitle: { ...t("smallStrong"), color: colors.text },
    meta: { ...t("mono"), color: colors.textFaint },
    row: {
      alignItems: "center",
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[2],
      minHeight: 56,
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[2],
    },
    scroll: { paddingBottom: spacing[6] },
    text: { flex: 1, gap: 2, minWidth: 0 },
    title: { ...t("small"), color: colors.text },
  });
