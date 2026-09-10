// SYSTEM ALERTS (#1015, Wave 2) — the health transitions and recovery updates
// the gateway posted, read from the Activity place's `alerts` tab.
//
// It used to draw its own place: a `TopSafeArea`, its own header row with a
// `display` title and a subtitle nothing else in the shell has, its own
// gutter, and three bare `Text` lines standing in for loading, error and
// empty. The error line was `state.message` — an exception, lowered through
// `memberFacingError` and then printed as the whole page (S14). All four are
// the ROOM's now: loading is a skeleton, error is one noun and one verb, and
// empty is the routine empty block.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import Button from "../../kit/components/Button";
import { Text } from "../../kit/components/NativeText";
import NoteBlock from "../../kit/components/NoteBlock";
import { memberFacingError } from "../../kit/member-error";
import { SystemPlace } from "../../kit/rooms";
import { radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import {
  getNotifications,
  subscribeMobileNotificationsChanges,
  updateMobileNotice,
} from "../../lib/gateway";
import type { MobileNotice } from "../../lib/gateway";

/** No `message`: what failed is not the member's vocabulary, and the room
 *  says the one true sentence about a read that did not land (S14). */
type State =
  | { kind: "loading" }
  | { kind: "ready"; rows: MobileNotice[] }
  | { kind: "error" };

export default function GatewayAlerts(props: {
  onLeave: () => void;
}): React.JSX.Element {
  const { colors } = useTheme();
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
    } catch {
      setState({ kind: "error" });
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
    <SystemPlace
      empty={
        state.kind === "ready" && rows.length === 0
          ? {
              body: "Health transitions and recovery updates land here when the gateway posts one.",
              routine: true,
              title: "No system alerts",
            }
          : undefined
      }
      error={
        state.kind === "error"
          ? {
              body: "The alert log is on the home machine, and this phone could not read it.",
              retry: { label: "Try again", onPress: () => void load() },
              title: "Could not read the alerts",
            }
          : undefined
      }
      loading={
        state.kind === "loading"
          ? { label: "Reading the system alerts" }
          : undefined
      }
      onHome={props.onLeave}
      onRefresh={() => {
        setRefreshing(true);
        void load().finally(() => setRefreshing(false));
      }}
      refreshing={refreshing}
      title="System alerts"
    >
      <NoteBlock text="Health transitions and recovery updates" />
      {rows.map((row) => (
        <View
          key={row.noticeId}
          style={[
            styles.card,
            row.readAt === null && { borderColor: colors.accent },
          ]}
        >
          <Text style={styles.cardTitle}>
            {memberFacingError(row.headline)}
          </Text>
          <Text style={styles.meta}>
            <Text style={[styles.meta, t("mono")]}>
              {new Date(row.lastAt).toLocaleString()}
            </Text>
            {row.count > 1 ? (
              <>
                {" · "}
                <Text style={[styles.meta, t("mono")]}>{row.count}</Text> events
              </>
            ) : null}
          </Text>
          <Text selectable style={styles.detail}>
            {gatewayAlertDetail(row.detail)}
          </Text>
          {row.archivedAt === null ? (
            <View style={styles.actions}>
              {row.readAt === null ? (
                <Button
                  disabled={busy === row.noticeId}
                  label="Mark read"
                  onPress={() => update(row.noticeId, "read")}
                  style={styles.button}
                  variant="secondary"
                />
              ) : null}
              <Button
                disabled={busy === row.noticeId}
                label="Archive"
                onPress={() => update(row.noticeId, "archive")}
                style={styles.button}
                variant="secondary"
              />
            </View>
          ) : null}
        </View>
      ))}
    </SystemPlace>
  );
}

function gatewayAlertDetail(detail: Record<string, unknown>): string {
  const preferred = ["detail", "error", "gatewayLabel"]
    .map((key) => detail[key])
    .find((value): value is string => typeof value === "string");
  return memberFacingError(
    preferred ?? "Open System on the home machine for live diagnostics."
  );
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
    meta: { ...t("small"), color: colors.textFaint, marginTop: spacing[1] },
  });
