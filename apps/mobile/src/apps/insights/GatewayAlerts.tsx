import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";

import Button from "../../kit/components/Button";
import HomeKey from "../../kit/components/HomeKey";
import { Text } from "../../kit/components/NativeText";
import { family, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import {
  getNotifications,
  subscribeMobileNotificationsChanges,
  updateMobileNotice,
} from "../../lib/gateway";
import type { MobileNotice } from "../../lib/gateway";

type State =
  | { kind: "loading" }
  | { kind: "ready"; rows: MobileNotice[] }
  | { kind: "error"; message: string };

export default function GatewayAlerts(props: {
  onLeave: () => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | undefined>();

  const load = useCallback(async (): Promise<void> => {
    try {
      const notifications = await getNotifications(true);
      setState({
        kind: "ready",
        rows: notifications.notices.filter(
          (notice) => notice.kind === "gateway-health"
        ),
      });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not load.",
      });
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    const controller = new AbortController();
    void subscribeMobileNotificationsChanges(
      () => void load(),
      controller.signal
    ).catch(() => undefined);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  const update = (noticeId: string, action: "read" | "archive"): void => {
    setBusy(noticeId);
    void updateMobileNotice(noticeId, action)
      .then(load)
      .finally(() => setBusy(undefined));
  };

  const rows = state.kind === "ready" ? state.rows : [];
  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <HomeKey variant="leave" onPress={props.onLeave} />
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Gateway alerts</Text>
          <Text style={styles.subtitle}>
            Health transitions and recovery updates
          </Text>
        </View>
      </View>
      <ScrollView
        contentContainerStyle={[
          styles.list,
          { paddingBottom: insets.bottom + spacing[5] },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
            tintColor={colors.textFaint}
          />
        }
      >
        {state.kind === "loading" ? (
          <Text style={styles.empty}>Loading gateway alerts…</Text>
        ) : state.kind === "error" ? (
          <Text style={styles.empty}>{state.message}</Text>
        ) : rows.length === 0 ? (
          <Text style={styles.empty}>No gateway alerts.</Text>
        ) : (
          rows.map((row) => (
            <View
              key={row.noticeId}
              style={[
                styles.card,
                row.readAt === null && { borderColor: colors.accent },
              ]}
            >
              <Text style={styles.cardTitle}>{row.headline}</Text>
              <Text style={styles.meta}>
                <Text style={[styles.meta, t("mono")]}>
                  {new Date(row.lastAt).toLocaleString()}
                </Text>
                {row.count > 1 ? (
                  <>
                    {" · "}
                    <Text style={[styles.meta, t("mono")]}>
                      {row.count}
                    </Text>{" "}
                    events
                  </>
                ) : null}
              </Text>
              <Text style={styles.detail} selectable>
                {gatewayAlertDetail(row.detail)}
              </Text>
              {row.archivedAt === null ? (
                <View style={styles.actions}>
                  {row.readAt === null ? (
                    <Button
                      label="Mark read"
                      disabled={busy === row.noticeId}
                      onPress={() => update(row.noticeId, "read")}
                      variant="secondary"
                      style={styles.button}
                    />
                  ) : null}
                  <Button
                    label="Archive"
                    disabled={busy === row.noticeId}
                    onPress={() => update(row.noticeId, "archive")}
                    variant="secondary"
                    style={styles.button}
                  />
                </View>
              ) : null}
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function gatewayAlertDetail(detail: Record<string, unknown>): string {
  const preferred = ["detail", "error", "gatewayLabel"]
    .map((key) => detail[key])
    .find((value): value is string => typeof value === "string");
  return preferred ?? "Open Gateway on desktop for live runtime diagnostics.";
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    actions: { flexDirection: "row", gap: spacing[2], marginTop: spacing[3] },
    button: { flex: 1 },
    card: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      padding: spacing[4],
    },
    cardTitle: { ...t("bodyStrong"), color: colors.text },
    detail: { ...t("body"), color: colors.textSoft, marginTop: spacing[3] },
    empty: {
      ...t("body"),
      color: colors.textFaint,
      paddingVertical: spacing[6],
    },
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[3],
      paddingHorizontal: spacing[5],
      paddingVertical: spacing[2],
    },
    headerCopy: { flex: 1 },
    list: { gap: spacing[3], padding: spacing[5] },
    meta: { ...t("small"), color: colors.textFaint, marginTop: spacing[1] },
    safe: { backgroundColor: colors.bg, flex: 1 },
    subtitle: { ...t("small"), color: colors.textFaint, marginTop: 2 },
    title: {
      color: colors.text,
      fontFamily: family.displayRegular,
      fontSize: 26,
      letterSpacing: -0.3,
    },
  });
