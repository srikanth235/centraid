// TRASH — `locker/trash` (README-Locker §6; FLOWS.md "Trash and purge").
//
// THIRTY DAYS, WITH ITS STAR AND ITS TAGS, so a restore brings it back whole.
// Each row states its own purge countdown rather than a date nobody can
// subtract in their head (`format.purgeCountdown`), and there is no Empty
// button: purging is per item, confirmed, and irreversible.
//
// A PURGE ASKED FOR OFF-OWNER PARKS AND SAYS SO. The vault decides that, not
// this screen — which is why the outcome is read from the write's own status
// (`surfaceWriteOutcome` publishes the parked reason on the one status line)
// rather than announced before the answer comes back.

import React, { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

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

  const body =
    vault.reading && rows.length === 0 ? (
      <SkeletonRows accessibilityLabel="Reading the trash" />
    ) : rows.length === 0 ? (
      <EmptyBlock body={TRASH_CONFIRM_BODY} routine title={TRASH_EMPTY} />
    ) : (
      rows.map((row: LockerRowData) => (
        <View key={row.item_id} style={styles.row}>
          <View style={styles.text}>
            <Text numberOfLines={1} style={styles.title}>
              {row.title}
            </Text>
            <Text style={styles.meta}>{purgeCountdown(row.purge_at)}</Text>
          </View>
          <Button
            label={TRASH_RESTORE}
            onPress={() => {
              void restoreLockerItem(replica.session, row.item_id).then(after);
            }}
          />
          <Button
            label={TRASH_PURGE}
            onPress={() => setConfirming(row.item_id)}
            variant="destructive"
          />
        </View>
      ))
    );

  return (
    <LockerScreen
      current="more"
      hideBand
      onBack={() => navigation.popTo("LockerHome", { destination: "items" })}
      route="trash"
    >
      <ScrollView contentContainerStyle={styles.scroll}>
        <SectionBlock label={TRASH_HEAD} meta={TRASH_META} />
        {body}

        {confirming ? (
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
        ) : null}
      </ScrollView>
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
